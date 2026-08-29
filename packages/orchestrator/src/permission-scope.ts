export type CanonicalPermissionScope = {
  readonly kind: "tool";
  readonly key: string;
  readonly label: string;
  readonly detail: string;
};

export type OneShotShellApprovalKind =
  | "git-push"
  | "git-merge"
  | "package-publish"
  | "deploy"
  | "release"
  | "ambiguous-wrapper";

export type OneShotShellApproval = {
  readonly kind: OneShotShellApprovalKind;
  readonly scope: CanonicalPermissionScope;
};

const SHELL_GRAMMAR_WORDS = new Set([
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while",
]);

const SIMPLE_COMMAND_WRAPPERS = new Set(["command", "exec", "nohup"]);
const SHELL_COMMAND_WRAPPERS = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
const AMBIGUOUS_COMMAND_WRAPPERS = new Set([".", "doas", "eval", "parallel", "source", "sudo", "xargs"]);
const DEPLOY_CLIENTS = new Set(["firebase", "fly", "netlify", "render", "vercel", "wrangler"]);
const TASK_RUNNERS = new Set(["just", "make", "task"]);
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const DYNAMIC_SHELL_PATTERN = /(?:`|\$\(|\$\{|\$[A-Za-z_])/;
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SAFE_LOCAL_TASK_PATTERN = /^(?:build|check|format|lint|test|typecheck|verify)(?::|$)/;
const RELEASE_TASK_PATTERN = /^(?:deploy|publish|release)(?::|$)/;

type TokenizedShellCommand = {
  readonly clauses: readonly (readonly string[])[];
  readonly ambiguous: boolean;
};

/**
 * Lexes enough shell syntax to recognize release boundaries without claiming
 * to be a complete shell parser. Unsupported grammar and dynamic expansion
 * are marked ambiguous so the caller can require a one-shot approval.
 */
function tokenizeShellCommand(command: string): TokenizedShellCommand {
  const clauses: string[][] = [];
  let clause: string[] = [];
  let token = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let ambiguous = false;

  const finishToken = () => {
    if (token.length > 0) clause.push(token);
    token = "";
  };
  const finishClause = () => {
    finishToken();
    if (clause.length > 0) clauses.push(clause);
    clause = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      else token += char;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = undefined;
      else {
        token += char;
        if (char === "`" || (char === "$" && /[({A-Za-z_]/.test(command[index + 1] ?? ""))) {
          ambiguous = true;
        }
      }
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === "#" && token.length === 0) {
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
      continue;
    }
    if (char === "`" || (char === "$" && /[({A-Za-z_]/.test(command[index + 1] ?? ""))) {
      ambiguous = true;
    }
    if (char === "(" || char === ")" || char === "{" || char === "}") {
      ambiguous = true;
    }
    if (/\s/.test(char)) {
      if (char === "\n") finishClause();
      else finishToken();
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      finishClause();
      if ((char === "|" || char === "&") && command[index + 1] === char) index += 1;
      continue;
    }
    if (char === ">" || char === "<") {
      finishToken();
      continue;
    }
    token += char;
  }
  if (escaped || quote !== undefined) ambiguous = true;
  finishClause();
  return { clauses, ambiguous };
}

function executableName(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function firstCommandIndex(tokens: readonly string[]): number {
  let index = 0;
  while (index < tokens.length && ASSIGNMENT_PATTERN.test(tokens[index] ?? "")) index += 1;
  return index;
}

function firstSubcommand(tokens: readonly string[], start: number): string | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]?.toLowerCase();
    if (!token) continue;
    if (token === "--") return tokens[index + 1]?.toLowerCase();
    if (!token.startsWith("-")) return token;
  }
  return undefined;
}

function packageSubcommandIndex(tokens: readonly string[], start: number): number | undefined {
  const optionsWithValue = new Set([
    "--cwd",
    "--dir",
    "--filter",
    "--prefix",
    "--workspace",
    "-C",
    "-F",
    "-w",
  ]);
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return index + 1 < tokens.length ? index + 1 : undefined;
    if (optionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return index;
  }
  return undefined;
}

function gitSubcommand(tokens: readonly string[], start: number): string | undefined {
  const optionsWithValue = new Set(["-c", "-C", "--exec-path", "--git-dir", "--namespace", "--work-tree"]);
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return tokens[index + 1]?.toLowerCase();
    if (optionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token.toLowerCase();
  }
  return undefined;
}

function directShellApproval(tokens: readonly string[]): OneShotShellApprovalKind | undefined {
  let commandIndex = firstCommandIndex(tokens);
  if (commandIndex >= tokens.length) return undefined;
  let executable = executableName(tokens[commandIndex] ?? "");

  if (executable === "env") {
    commandIndex += 1;
    while (commandIndex < tokens.length && ASSIGNMENT_PATTERN.test(tokens[commandIndex] ?? "")) commandIndex += 1;
    if (tokens[commandIndex]?.startsWith("-")) return "ambiguous-wrapper";
    executable = executableName(tokens[commandIndex] ?? "");
  }
  if (SIMPLE_COMMAND_WRAPPERS.has(executable)) {
    commandIndex += 1;
    if (tokens[commandIndex]?.startsWith("-")) return "ambiguous-wrapper";
    executable = executableName(tokens[commandIndex] ?? "");
  }
  if (!executable || DYNAMIC_SHELL_PATTERN.test(executable)) return "ambiguous-wrapper";
  if (SHELL_GRAMMAR_WORDS.has(executable) || AMBIGUOUS_COMMAND_WRAPPERS.has(executable)) {
    return "ambiguous-wrapper";
  }
  if (executable === "find" && tokens.slice(commandIndex + 1).some((token) => token === "-exec" || token === "-execdir")) {
    return "ambiguous-wrapper";
  }
  if (SHELL_COMMAND_WRAPPERS.has(executable)) {
    const commandFlag = tokens.findIndex((token, index) => index > commandIndex && (token === "-c" || token === "--command"));
    if (commandFlag < 0) return "ambiguous-wrapper";
    const nested = tokens[commandFlag + 1];
    if (!nested || DYNAMIC_SHELL_PATTERN.test(nested)) return "ambiguous-wrapper";
    return classifyShellCommand(nested) ?? undefined;
  }
  if (/^(?:deploy|publish|release)(?:\.[A-Za-z0-9]+)?$/.test(executable)) {
    return executable.startsWith("deploy") ? "deploy" : executable.startsWith("release") ? "release" : "package-publish";
  }
  if (/\.(?:bash|fish|ksh|sh|zsh)$/.test(executable)) return "ambiguous-wrapper";

  if (executable === "git") {
    const globalArguments = tokens.slice(commandIndex + 1);
    if (globalArguments.some((token) => token === "-c" || token.startsWith("--config-env"))) {
      return "ambiguous-wrapper";
    }
    const subcommand = gitSubcommand(tokens, commandIndex + 1);
    if (subcommand === "push") return "git-push";
    // The current branch is runtime state unavailable to this layer, so every
    // merge is guarded rather than guessing whether it updates main.
    if (subcommand === "merge") return "git-merge";
    return undefined;
  }

  const subcommand = firstSubcommand(tokens, commandIndex + 1);
  if (executable === "npx" || executable === "bunx") return "ambiguous-wrapper";
  if (PACKAGE_MANAGERS.has(executable)) {
    const packageCommandIndex = packageSubcommandIndex(tokens, commandIndex + 1);
    const packageSubcommand = packageCommandIndex === undefined
      ? undefined
      : tokens[packageCommandIndex]?.toLowerCase();
    if (["dlx", "exec", "x"].includes(packageSubcommand ?? "")) return "ambiguous-wrapper";
    if (packageSubcommand === "publish") return "package-publish";
    if (packageSubcommand === "run" || packageSubcommand === "run-script") {
      const script = firstSubcommand(tokens, (packageCommandIndex ?? commandIndex) + 1);
      if (script && RELEASE_TASK_PATTERN.test(script)) {
        return script.startsWith("deploy") ? "deploy" : script.startsWith("release") ? "release" : "package-publish";
      }
      if (!script || !SAFE_LOCAL_TASK_PATTERN.test(script)) return "ambiguous-wrapper";
    }
    if (executable === "yarn" && RELEASE_TASK_PATTERN.test(packageSubcommand ?? "")) {
      return packageSubcommand?.startsWith("deploy")
        ? "deploy"
        : packageSubcommand?.startsWith("release")
          ? "release"
          : "package-publish";
    }
    if (executable === "yarn" && packageSubcommand === "npm" && tokens.slice((packageCommandIndex ?? commandIndex) + 1).includes("publish")) {
      return "package-publish";
    }
  }
  if (
    (executable === "cargo" && subcommand === "publish")
    || (executable === "gem" && subcommand === "push")
    || (executable === "twine" && subcommand === "upload")
    || ((executable === "docker" || executable === "podman") && subcommand === "push")
    || (executable === "dotnet" && tokens.slice(commandIndex + 1, commandIndex + 4).map((token) => token.toLowerCase()).join(" ").startsWith("nuget push"))
  ) {
    return "package-publish";
  }
  if (executable === "python" || executable === "python3") {
    const tail = tokens.slice(commandIndex + 1).map((token) => token.toLowerCase());
    if (tail[0] === "-m" && tail[1] === "twine" && tail[2] === "upload") return "package-publish";
  }
  if (
    DEPLOY_CLIENTS.has(executable)
    && (
      subcommand === "deploy"
      || (executable === "fly" && subcommand === "release")
      || (executable === "vercel" && subcommand === undefined)
    )
  ) {
    return "deploy";
  }
  if (executable === "railway" && subcommand === "up") return "deploy";
  if (executable === "helm" && (subcommand === "install" || subcommand === "upgrade")) return "deploy";
  if (executable === "kubectl" && ["apply", "create", "delete", "patch", "replace", "rollout", "set"].includes(subcommand ?? "")) {
    return "deploy";
  }
  if (TASK_RUNNERS.has(executable)) {
    if (RELEASE_TASK_PATTERN.test(subcommand ?? "")) {
      return subcommand?.startsWith("deploy") ? "deploy" : subcommand?.startsWith("release") ? "release" : "package-publish";
    }
    if (!SAFE_LOCAL_TASK_PATTERN.test(subcommand ?? "")) return "ambiguous-wrapper";
  }
  if (executable === "gh" && subcommand === "release") return "release";
  if (executable === "semantic-release") return "release";
  if (executable === "changeset" && subcommand === "publish") return "package-publish";
  return undefined;
}

function classifyShellCommand(command: string): OneShotShellApprovalKind | undefined {
  const tokenized = tokenizeShellCommand(command);
  for (const clause of tokenized.clauses) {
    const classified = directShellApproval(clause);
    if (classified) return classified;
  }
  return tokenized.ambiguous ? "ambiguous-wrapper" : undefined;
}

/**
 * Returns a deliberately non-persistable approval boundary for shell actions
 * that can publish externally or irreversibly change release state.
 */
export function resolveOneShotShellApproval(input: {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}): OneShotShellApproval | undefined {
  if (input.toolName !== "run_shell" || typeof input.input.command !== "string") return undefined;
  const command = input.input.command;
  const kind = classifyShellCommand(command);
  if (!kind) return undefined;
  const labels: Record<OneShotShellApprovalKind, string> = {
    "git-push": "git push",
    "git-merge": "git merge",
    "package-publish": "package publish",
    deploy: "deployment",
    release: "release",
    "ambiguous-wrapper": "ambiguous shell wrapper",
  };
  const label = labels[kind];
  return {
    kind,
    scope: {
      kind: "tool",
      key: `shell-once:${kind}`,
      label,
      detail: kind === "ambiguous-wrapper"
        ? `The command structure cannot be proven free of external or irreversible actions. Exact command: ${JSON.stringify(command)}.`
        : `This ${label} action can change external or release state. Exact command: ${JSON.stringify(command)}.`,
    },
  };
}
