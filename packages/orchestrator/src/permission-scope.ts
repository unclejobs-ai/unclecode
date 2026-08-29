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
  | "project-code"
  | "external-client"
  | "unknown-executable"
  | "ambiguous-wrapper";

export type OneShotShellApproval = {
  readonly kind: OneShotShellApprovalKind;
  readonly scope: CanonicalPermissionScope;
};

export type CanonicalPermissionRule = {
  readonly key: string;
  readonly kind: "tool";
};

export type CanonicalPermissionRuleStore = {
  has(rule: CanonicalPermissionRule): boolean;
  add(rule: CanonicalPermissionRule): void;
  list(): readonly CanonicalPermissionRule[];
};

export function isCanonicalPermissionRule(value: unknown): value is CanonicalPermissionRule {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly kind?: unknown; readonly key?: unknown };
  return candidate.kind === "tool"
    && typeof candidate.key === "string"
    && candidate.key.length > 0
    && candidate.key.length <= 128
    && /^[A-Za-z0-9_.:-]+$/.test(candidate.key);
}

export function createCanonicalPermissionRuleStore(
  initialRules: readonly unknown[] = [],
): CanonicalPermissionRuleStore {
  const rules = new Map<string, CanonicalPermissionRule>();
  for (const rule of initialRules) {
    if (isCanonicalPermissionRule(rule)) {
      rules.set(`${rule.kind}:${rule.key}`, { ...rule });
    }
  }
  return {
    has(rule) {
      return rules.has(`${rule.kind}:${rule.key}`);
    },
    add(rule) {
      if (isCanonicalPermissionRule(rule)) {
        rules.set(`${rule.kind}:${rule.key}`, { ...rule });
      }
    },
    list() {
      return [...rules.values()].map((rule) => ({ ...rule }));
    },
  };
}

export function createPermissionPolicyPanel(
  rules: readonly CanonicalPermissionRule[],
): { readonly title: "Security policy"; readonly lines: readonly string[] } {
  const lines = [`Session approvals · ${rules.length}`];
  for (const rule of rules) {
    lines.push(rule.key === "bash"
      ? "- bash · tool-wide · all shell commands through bash"
      : `- ${rule.key} · tool-wide`);
  }
  if (rules.length === 0) lines.push("- none · risky actions still require approval");
  lines.push("Security approval only · quality gates and user decisions are separate.");
  return { title: "Security policy", lines };
}

/**
 * One permission vocabulary for the policy question, stored rule, matcher and
 * `/policy` projection. Shell confirmation is intentionally tool-wide: the
 * runtime executes the complete compound command through one bash boundary,
 * so pretending an `&&`/pipe/redirection can be safely reduced to one inner
 * executable would display a narrower grant than the action actually runs.
 */
export function resolveCanonicalPermissionScope(input: {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}): CanonicalPermissionScope {
  void input.input;
  if (input.toolName === "run_shell") {
    return {
      kind: "tool",
      key: "bash",
      label: "bash",
      detail: "All shell commands executed by bash in this workspace session.",
    };
  }
  return {
    kind: "tool",
    key: input.toolName,
    label: input.toolName,
    detail: `All ${input.toolName} actions in this workspace session.`,
  };
}

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
const INLINE_CODE_INTERPRETERS: Readonly<Record<string, ReadonlySet<string>>> = {
  bun: new Set(["-e", "--eval", "-p", "--print"]),
  deno: new Set(["eval"]),
  node: new Set(["-e", "--eval", "-p", "--print"]),
  nodejs: new Set(["-e", "--eval", "-p", "--print"]),
  python: new Set(["-c"]),
  python3: new Set(["-c"]),
  perl: new Set(["-e"]),
  php: new Set(["-r"]),
  ruby: new Set(["-e"]),
};
const AMBIGUOUS_COMMAND_WRAPPERS = new Set([".", "doas", "eval", "parallel", "source", "sudo", "xargs"]);
const EXECUTION_COMMAND_WRAPPERS = new Set([
  "busybox", "chroot", "gtimeout", "ionice", "nice", "setsid", "stdbuf", "timeout", "watch",
]);
const EXTERNAL_CLIENTS = new Set([
  "az", "aws", "curl", "ftp", "gcloud", "http", "httpie", "nc", "ncat", "netcat",
  "rsync", "scp", "sftp", "socat", "ssh", "telnet", "wget",
]);
const DEPLOY_CLIENTS = new Set(["firebase", "fly", "netlify", "render", "vercel", "wrangler"]);
const TASK_RUNNERS = new Set(["just", "make", "task"]);
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const LOCAL_GIT_SUBCOMMANDS = new Set([
  "add", "am", "apply", "archive", "bisect", "blame", "branch", "checkout",
  "cherry-pick", "clean", "clone", "commit", "config", "describe", "diff",
  "fetch", "grep", "init", "log", "ls-files", "mv", "pull", "rebase",
  "reflog", "remote", "reset", "restore", "revert", "rev-parse", "rm", "show",
  "sparse-checkout", "stash", "status", "switch", "tag", "worktree",
]);
const GIT_NETWORK_SUBCOMMANDS = new Set(["clone", "fetch", "pull"]);
const GIT_HOOK_SUBCOMMANDS = new Set([
  "am", "checkout", "cherry-pick", "commit", "rebase", "switch", "worktree",
]);
const DYNAMIC_SHELL_PATTERN = /(?:`|\$\(|\$\{|\$[A-Za-z_])/;
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RELEASE_TASK_PATTERN = /^(?:deploy|publish|release)(?::|$)/;
const MAX_NESTED_COMMAND_DEPTH = 8;
const SAFE_LOCAL_EXECUTABLES = new Set([
  "[", "basename", "cargo", "cat", "chmod", "cksum", "cmp", "comm", "cp", "cut", "date",
  "diff", "dirname", "du", "echo", "false", "fd", "find", "fmt", "git", "grep", "head",
  "install", "jq", "ln", "ls", "md5sum", "mkdir", "mv", "patch", "printf", "pwd", "readlink",
  "realpath", "rg", "rm", "rmdir", "sed", "sha256sum", "sort", "stat", "tail", "tar", "tee",
  "test", "touch", "tr", "true", "tsc", "uname", "uniq", "wc", "which",
]);

export type RuntimeControlPlaneShellDenial = {
  readonly code: "runtime-control-plane";
  readonly reason: string;
};

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
      escaped = false;
      // POSIX shells remove a backslash-newline pair before tokenization. Keep
      // the classifier's token identical so a split release verb cannot evade
      // recognition (for example `git pu\\\nsh`).
      if (char !== "\n") token += char;
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
      // Redirections have filesystem and, in bash, network semantics that are
      // not represented by the argv-like clause tokens below. Keep the
      // command visible for exact one-shot approval instead of silently
      // discarding the operator.
      ambiguous = true;
      finishToken();
      continue;
    }
    if (char === "*" || char === "?" || char === "[") {
      // Unquoted pathname expansion can select private runtime state or files
      // whose names were never shown to policy. A partial lexer cannot prove
      // that expansion local, so it must fail closed.
      ambiguous = true;
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

function nestedCommandPayload(
  tokens: readonly string[],
  flagIndex: number,
): string | undefined {
  const payloadIndex = tokens[flagIndex + 1] === "--" ? flagIndex + 2 : flagIndex + 1;
  return tokens[payloadIndex];
}

function inlineCodePayload(
  tokens: readonly string[],
  start: number,
  flags: ReadonlySet<string>,
): string | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const normalized = token.toLowerCase();
    if (flags.has(normalized)) return nestedCommandPayload(tokens, index);
    for (const flag of flags) {
      if (normalized.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
      if (flag.length === 2 && normalized.startsWith(flag) && token.length > flag.length) {
        return token.slice(flag.length);
      }
    }
  }
  return undefined;
}

function directShellApproval(
  tokens: readonly string[],
  nestedDepth: number,
): OneShotShellApprovalKind | undefined {
  let commandIndex = firstCommandIndex(tokens);
  if (commandIndex >= tokens.length) return undefined;
  if (commandIndex > 0) {
    // Prefix assignments can replace PATH or activate executable callbacks
    // (for example GIT_EXTERNAL_DIFF), changing the effect of an otherwise
    // recognizable command. The assignment and command are approved together.
    return "project-code";
  }
  let executable = executableName(tokens[commandIndex] ?? "");

  let wrapperDepth = 0;
  while (executable === "env" || SIMPLE_COMMAND_WRAPPERS.has(executable)) {
    wrapperDepth += 1;
    if (wrapperDepth > MAX_NESTED_COMMAND_DEPTH) return "ambiguous-wrapper";
    commandIndex += 1;
    if (executable === "env") {
      while (commandIndex < tokens.length && ASSIGNMENT_PATTERN.test(tokens[commandIndex] ?? "")) commandIndex += 1;
    }
    if (tokens[commandIndex]?.startsWith("-")) return "ambiguous-wrapper";
    executable = executableName(tokens[commandIndex] ?? "");
  }
  if (!executable || DYNAMIC_SHELL_PATTERN.test(executable)) return "ambiguous-wrapper";
  if (SHELL_GRAMMAR_WORDS.has(executable) || AMBIGUOUS_COMMAND_WRAPPERS.has(executable)) {
    return "ambiguous-wrapper";
  }
  if (EXECUTION_COMMAND_WRAPPERS.has(executable)) return "ambiguous-wrapper";
  if (EXTERNAL_CLIENTS.has(executable)) return "external-client";
  if (["awk", "gawk", "mawk", "nawk"].includes(executable)) return "ambiguous-wrapper";
  if (executable === "find" && tokens.slice(commandIndex + 1).some((token) => token === "-exec" || token === "-execdir")) {
    return "ambiguous-wrapper";
  }
  if (SHELL_COMMAND_WRAPPERS.has(executable)) {
    const commandFlag = tokens.findIndex((token, index) => index > commandIndex && (token === "-c" || token === "--command"));
    if (commandFlag < 0) return "ambiguous-wrapper";
    const nested = nestedCommandPayload(tokens, commandFlag);
    if (!nested || DYNAMIC_SHELL_PATTERN.test(nested)) return "ambiguous-wrapper";
    return classifyShellCommand(nested, nestedDepth + 1) ?? undefined;
  }
  const inlineCodeFlags = INLINE_CODE_INTERPRETERS[executable]
    ?? (/^python3(?:\.\d+)*$/.test(executable) ? INLINE_CODE_INTERPRETERS.python3 : undefined);
  if (inlineCodeFlags) {
    const inlineCode = inlineCodePayload(tokens, commandIndex + 1, inlineCodeFlags);
    if (inlineCode !== undefined) {
      if (!inlineCode || DYNAMIC_SHELL_PATTERN.test(inlineCode)) return "ambiguous-wrapper";
      // Inline interpreter code is not shell grammar, but recursively checking
      // it still identifies a plain wrapped release command. Anything else is
      // executable code whose effects cannot be proven local at this layer.
      return classifyShellCommand(inlineCode, nestedDepth + 1) ?? "ambiguous-wrapper";
    }
    const interpreterArguments = tokens.slice(commandIndex + 1).map((token) => token.toLowerCase());
    if (interpreterArguments.length === 1 && ["-h", "--help", "-v", "--version"].includes(interpreterArguments[0] ?? "")) {
      return undefined;
    }
    // A script, module, REPL, stdin program, or unrecognized interpreter mode
    // is another executable-code boundary. Its effects cannot be inferred from
    // the outer shell tokens, so autonomy and stored bash grants cannot apply.
    return "ambiguous-wrapper";
  }
  if (/^(?:deploy|publish|release)(?:\.[A-Za-z0-9]+)?$/.test(executable)) {
    return executable.startsWith("deploy") ? "deploy" : executable.startsWith("release") ? "release" : "package-publish";
  }
  if (/\.(?:bash|fish|ksh|sh|zsh)$/.test(executable)) return "ambiguous-wrapper";
  if (/[\\/]/.test(tokens[commandIndex] ?? "")) return "unknown-executable";

  if (executable === "git") {
    const globalArguments = tokens.slice(commandIndex + 1);
    if (globalArguments.some((token) => token === "-c" || token.startsWith("--config-env"))) {
      return "ambiguous-wrapper";
    }
    const subcommand = gitSubcommand(tokens, commandIndex + 1);
    if (subcommand === "push") return "git-push";
    if (subcommand === "send-pack") return "git-push";
    // The current branch is runtime state unavailable to this layer, so every
    // merge is guarded rather than guessing whether it updates main.
    if (subcommand === "merge") return "git-merge";
    if (subcommand && GIT_NETWORK_SUBCOMMANDS.has(subcommand)) return "external-client";
    if (subcommand && GIT_HOOK_SUBCOMMANDS.has(subcommand)) return "project-code";
    if (subcommand === "archive" && globalArguments.some((token) => token.startsWith("--remote"))) {
      return "external-client";
    }
    return subcommand && LOCAL_GIT_SUBCOMMANDS.has(subcommand) ? undefined : "ambiguous-wrapper";
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
      // Script names are labels, not capabilities. `build`, `test`, and
      // `lint` can all contain publish/deploy/push commands or lifecycle hooks.
      return "project-code";
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
    // Package-manager verbs such as install/add/test/start may execute package
    // lifecycle hooks or project-defined aliases. Only non-executing help and
    // version inspection can inherit a persistent bash grant.
    const packageTail = tokens.slice(commandIndex + 1).map((token) => token.toLowerCase());
    const inspectionOnly = packageTail.length > 0
      && packageTail.every((token) => ["-h", "--help", "-v", "--version", "help"].includes(token));
    if (!inspectionOnly) return "project-code";
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
  if (executable === "cargo") {
    const cargoTail = tokens.slice(commandIndex + 1).map((token) => token.toLowerCase());
    const inspectionOnly = cargoTail.length > 0
      && cargoTail.every((token) => ["-h", "--help", "-v", "-vv", "--version", "version"].includes(token));
    if (!inspectionOnly) return "project-code";
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
    // Makefiles and task manifests are executable project input. Target names
    // such as `test` or `build` cannot prove the recipe has no release action.
    return "project-code";
  }
  if (executable === "gh") {
    const tail = tokens.slice(commandIndex + 1).map((token) => token.toLowerCase());
    if (tail.includes("api") || tail.includes("alias")) return "ambiguous-wrapper";
    const releaseIndex = tail.indexOf("release");
    if (releaseIndex >= 0) return "release";
    const pullRequestIndex = tail.findIndex((token) => token === "pr" || token === "pull-request");
    if (pullRequestIndex >= 0 && tail.slice(pullRequestIndex + 1).includes("merge")) return "git-merge";
  }
  if (executable === "glab") {
    const tail = tokens.slice(commandIndex + 1).map((token) => token.toLowerCase());
    if (tail.includes("api") || tail.includes("alias")) return "ambiguous-wrapper";
    if (tail.includes("release")) return "release";
    const mergeRequestIndex = tail.findIndex((token) => token === "mr" || token === "merge-request");
    if (mergeRequestIndex >= 0 && tail.slice(mergeRequestIndex + 1).includes("merge")) return "git-merge";
  }
  if (executable === "hub" && (subcommand === "merge" || subcommand === "release")) {
    return subcommand === "merge" ? "git-merge" : "release";
  }
  if (executable === "semantic-release") return "release";
  if (executable === "changeset" && subcommand === "publish") return "package-publish";
  const knownExecutable = SAFE_LOCAL_EXECUTABLES.has(executable)
    || PACKAGE_MANAGERS.has(executable)
    || TASK_RUNNERS.has(executable)
    || DEPLOY_CLIENTS.has(executable)
    || [
      "changeset", "docker", "dotnet", "firebase", "fly", "gem", "gh", "glab", "helm", "hub",
      "kubectl", "podman", "railway", "semantic-release", "twine", "vercel", "wrangler",
    ].includes(executable);
  return knownExecutable ? undefined : "unknown-executable";
}

function classifyShellCommand(
  command: string,
  nestedDepth = 0,
): OneShotShellApprovalKind | undefined {
  if (nestedDepth > MAX_NESTED_COMMAND_DEPTH) return "ambiguous-wrapper";
  const tokenized = tokenizeShellCommand(command);
  for (const clause of tokenized.clauses) {
    const classified = directShellApproval(clause, nestedDepth);
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
    "project-code": "project-defined code",
    "external-client": "external shell client",
    "unknown-executable": "unknown shell executable",
    "ambiguous-wrapper": "ambiguous shell wrapper",
  };
  const label = labels[kind];
  return {
    kind,
    scope: {
      kind: "tool",
      key: `bash:once:${command}`,
      label,
      detail: kind === "ambiguous-wrapper" || kind === "unknown-executable"
        ? `The command structure cannot be proven free of external or irreversible actions. Exact command: ${JSON.stringify(command)}.`
        : kind === "project-code"
          ? `Project scripts, task recipes, and build hooks can contain external or irreversible actions. Exact command: ${JSON.stringify(command)}.`
        : `This ${label} action can change external or release state. Exact command: ${JSON.stringify(command)}.`,
    },
  };
}

/**
 * The runtime owner is the authority that settles approvals. Shell execution
 * must never be able to recover its token/lease or call that authority through
 * loopback, even when the operator previously granted the generic bash scope.
 */
export function resolveRuntimeControlPlaneShellDenial(input: {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}): RuntimeControlPlaneShellDenial | undefined {
  if (input.toolName !== "run_shell" || typeof input.input.command !== "string") return undefined;
  const command = input.input.command;
  // Removing quoting and escaping catches simple shell concatenation such as
  // `.uncl"ecode"/server.token`; the whole `.unclecode` owner directory is
  // reserved because wildcard reads would otherwise recover the same secrets.
  const compact = command.toLowerCase().replace(/[\\'"\s]/g, "");
  if (
    compact.includes(".unclecode")
    || /(?:^|[~/])\.uncl/.test(compact)
    || compact.includes("runtime-owner-v1.json")
    || compact.includes("runtime-owner-v1.lock")
    || compact.includes("server.token")
    || compact.includes("server.tok")
  ) {
    return {
      code: "runtime-control-plane",
      reason: "run_shell cannot access the runtime owner's token, lease, or private state directory.",
    };
  }

  if (compact.includes("/dev/tcp/") || compact.includes("/dev/udp/")) {
    return {
      code: "runtime-control-plane",
      reason: "run_shell cannot open raw network pseudo-devices outside the governed network tool boundary.",
    };
  }

  const clientPattern = /(?:^|[;&|\s'"`()])\/?(?:[^\s/;&|'"`()]+\/)*(?:curl|wget|http|httpie|nc|ncat|netcat|socat|telnet)\b/i;
  const loopbackPattern = /(?:https?:\/\/)?(?:localhost\.?|0\.0\.0\.0|127(?:\.\d{1,3}){3}|\[?(?:::1|::ffff:127\.0\.0\.1|0:0:0:0:0:0:0:1)\]?)(?::\d+)?(?:[\s/'";]|$)/i;
  if (clientPattern.test(command) && loopbackPattern.test(command)) {
    return {
      code: "runtime-control-plane",
      reason: "run_shell cannot use a loopback client to reach the runtime control plane.",
    };
  }
  return undefined;
}

export function createCanonicalPermissionRule(
  scope: CanonicalPermissionScope,
): CanonicalPermissionRule {
  return { kind: scope.kind, key: scope.key };
}

export function matchesCanonicalPermissionRule(
  rule: CanonicalPermissionRule,
  request: { readonly toolName: string; readonly input: Readonly<Record<string, unknown>> },
): boolean {
  return rule.kind === "tool" && rule.key === resolveCanonicalPermissionScope(request).key;
}
