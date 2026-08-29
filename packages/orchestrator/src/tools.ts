import type {
  AskUserQuestion,
  AskUserQuestionOption,
  AskUserQuestionRequest,
  ExecutionPolicyProfile,
  ToolMetadata,
} from "@unclecode/contracts";
import type { WorkShellInteractionBridge } from "./work-shell-interaction-bridge.js";
import { runRustCommand } from "./rust-command.js";
import {
  createWebSearchHandler,
  type WebSearchActiveProvider,
} from "./web-search.js";
import { createAstToolRegistry } from "./ast-tools.js";
import { createLspToolRegistry } from "./lsp-tools.js";
import {
  createPolicyAwareToolExecutor,
  resolveModeExecutionPolicyProfile,
  type ToolExecutor,
  type ToolRegistry,
} from "./tool-executor.js";

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  metadata?: ToolMetadata;
};

export type ToolResult = {
  isError?: boolean;
  content: string;
};

export type ToolHandlerOptions = {
  readonly signal?: AbortSignal | undefined;
};

export type ToolHandler = (input: Record<string, unknown>, cwd: string, options?: ToolHandlerOptions) => Promise<ToolResult>;

async function runRustAci(args: readonly string[], cwd: string, stdin?: string, options: ToolHandlerOptions = {}): Promise<string> {
  return await runRustCommand(["rust", "aci", ...args], cwd, stdin ?? (options.signal ? "" : undefined), process.env, options);
}

const MODEL_SHELL_PRIVATE_ENV_PATTERN = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|AUTH(?:ORIZATION)?|AUTH_?TOKEN|CLIENT_?SECRET|COOKIE|CREDENTIALS?|JWT|PASSWORD|PASSWD|PRIVATE_?KEY|SECRET|SESSION|SIGNING_?KEY|TOKEN)(?:_|$)/i;
const MODEL_SHELL_PRIVATE_ENV_VALUE_PATTERN = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@|\b(?:sk|ghp|github_pat|xox[baprs])-[A-Za-z0-9_-]{8,}\b)/i;
const MODEL_SHELL_CONTROL_ENV = new Set([
  "CODEX_HOME",
  "UNCLECODE_DATA_ROOT",
  "UNCLECODE_OWNER_ATTACH_TIMEOUT_MS",
  "UNCLECODE_RPC_PROTOCOL",
  "UNCLECODE_RPC_TRANSPORT",
  "UNCLECODE_SERVER_URL",
  "UNCLECODE_SESSION_STORE_ROOT",
]);
const MODEL_SHELL_EXECUTION_CONTROL_ENV = new Set([
  "_JAVA_OPTIONS",
  "BASHOPTS",
  "BASH_ENV",
  "BUN_OPTIONS",
  "CLASSPATH",
  "DOTNET_STARTUP_HOOKS",
  "EDITOR",
  "ENV",
  "GIT_ASKPASS",
  "GIT_DIFF_OPTS",
  "GIT_EDITOR",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_PROXY_COMMAND",
  "GIT_SEQUENCE_EDITOR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GNUMAKEFLAGS",
  "GRADLE_OPTS",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "LESS",
  "LESSCLOSE",
  "LESSOPEN",
  "LUA_CPATH",
  "LUA_INIT",
  "LUA_PATH",
  "MAKEFILES",
  "MAKEFLAGS",
  "MANPAGER",
  "MAVEN_OPTS",
  "MFLAGS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PAGER",
  "PERL5LIB",
  "PERL5OPT",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "PROMPT_COMMAND",
  "PYTHONHOME",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONWARNINGS",
  "R_ENVIRON",
  "R_PROFILE",
  "R_PROFILE_USER",
  "RIPGREP_CONFIG_PATH",
  "RUBYLIB",
  "RUBYOPT",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTC_WRAPPER",
  "SHELLOPTS",
  "SSH_ASKPASS",
  "TAR_OPTIONS",
  "VISUAL",
  "ZDOTDIR",
]);

function isModelShellExecutionControlEnvironment(name: string): boolean {
  if (MODEL_SHELL_EXECUTION_CONTROL_ENV.has(name)) return true;
  if (name.startsWith("DYLD_")) return true;
  if (["LD_AUDIT", "LD_LIBRARY_PATH", "LD_PRELOAD"].includes(name)) return true;
  if (name.startsWith("GIT_CONFIG")) return true;
  if (["CORECLR_ENABLE_PROFILING", "CORECLR_PROFILER", "CORECLR_PROFILER_PATH"].includes(name)) return true;
  return /^NPM_CONFIG_(?:GLOBALCONFIG|NODE_OPTIONS|ONLOAD_SCRIPT|SCRIPT_SHELL|USERCONFIG)$/.test(name);
}

/**
 * Shell children inherit ordinary build configuration but never the runtime
 * owner's credentials, discovery endpoints, or ambient authentication agents.
 */
export function createModelShellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalizedName = name.toUpperCase();
    if (MODEL_SHELL_PRIVATE_ENV_PATTERN.test(name)) continue;
    if (MODEL_SHELL_PRIVATE_ENV_VALUE_PATTERN.test(value)) continue;
    if (MODEL_SHELL_CONTROL_ENV.has(normalizedName)) continue;
    // Authorization binds the displayed command, not ambient process state.
    // Drop variables that can source code, install callbacks, inject tool
    // options, or replace a pager/filter after policy evaluation.
    if (isModelShellExecutionControlEnvironment(normalizedName)) continue;
    if (normalizedName.startsWith("UNCLECODE_CONFIG__") || normalizedName.startsWith("UNCLECODE_SUBMIT__")) continue;
    environment[name] = value;
  }
  environment.UNCLECODE_ALLOW_RUN_SHELL = "1";
  return environment;
}

async function runRustShell(command: string, cwd: string, options: ToolHandlerOptions = {}): Promise<string> {
  // Reaching this handler means the executor already authorized shell.run, so
  // the Rust child gets a request-scoped grant. Owner/control credentials are
  // removed and replaceEnv prevents runRustCommand from adding them back.
  const env = createModelShellEnvironment(process.env);
  return await runRustCommand(
    ["rust", "shell", "--", command],
    cwd,
    options.signal ? "" : undefined,
    env,
    { ...options, replaceEnv: true },
  );
}

function normalizeRustPathError(error: unknown, requestedPath: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/path (contains traversal segment|escapes workspace)|absolute path rejected/i.test(message)) {
    throw new Error(`Path escapes working directory: ${requestedPath}`);
  }
  throw error;
}

async function listFiles(input: Record<string, unknown>, cwd: string, options: ToolHandlerOptions = {}): Promise<ToolResult> {
  const target = typeof input.path === "string" ? input.path : ".";
  try {
    const stdout = await runRustAci(["list", target], cwd, undefined, options);
    return { content: stdout.trim() || "(empty directory)" };
  } catch (error) {
    normalizeRustPathError(error, target);
  }
}

async function readFile(input: Record<string, unknown>, cwd: string, options: ToolHandlerOptions = {}): Promise<ToolResult> {
  if (typeof input.path !== "string") {
    throw new Error("path is required");
  }
  try {
    const content = await runRustAci(["read", input.path], cwd, undefined, options);
    return { content };
  } catch (error) {
    normalizeRustPathError(error, input.path);
  }
}

async function writeFile(input: Record<string, unknown>, cwd: string, options: ToolHandlerOptions = {}): Promise<ToolResult> {
  if (typeof input.path !== "string") {
    throw new Error("path is required");
  }
  if (typeof input.content !== "string") {
    throw new Error("content is required");
  }
  try {
    const stdout = await runRustAci(["write", input.path], cwd, input.content, options);
    return { content: stdout.trim() || `Wrote ${input.path}` };
  } catch (error) {
    normalizeRustPathError(error, input.path);
  }
}

async function deleteFile(input: Record<string, unknown>, cwd: string, options: ToolHandlerOptions = {}): Promise<ToolResult> {
  if (typeof input.path !== "string") {
    throw new Error("path is required");
  }
  try {
    const stdout = await runRustAci(["delete", input.path], cwd, undefined, options);
    return { content: stdout.trim() || `Deleted ${input.path}` };
  } catch (error) {
    normalizeRustPathError(error, input.path);
  }
}

async function searchText(input: Record<string, unknown>, cwd: string, options: ToolHandlerOptions = {}): Promise<ToolResult> {
  if (typeof input.query !== "string" || input.query.length === 0) {
    throw new Error("query is required");
  }
  const target = typeof input.path === "string" ? input.path : ".";
  try {
    const stdout = await runRustAci(["search", input.query, target], cwd, undefined, options);
    return { content: stdout.trim() || "(no matches)" };
  } catch (error) {
    normalizeRustPathError(error, target);
  }
}

async function runShell(input: Record<string, unknown>, cwd: string, options: ToolHandlerOptions = {}): Promise<ToolResult> {
  if (typeof input.command !== "string" || input.command.length === 0) {
    throw new Error("command is required");
  }
  // Authorization lives in the policy-aware executor, not in this handler.
  const stdout = await runRustShell(input.command, cwd, options);
  const content = stdout.trim();
  return { content: content || "(command produced no output)" };
}
const astTools = createAstToolRegistry();
const lspTools = createLspToolRegistry();


export const toolDefinitions: ToolDefinition[] = [
  {
    name: "list_files",
    description: "List files and directories inside a path relative to the current workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to inspect." },
      },
    },
    metadata: {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        riskLevel: "low",
      },
      resources: [{
        kind: "directory",
        mode: "read",
        template: "directory:{path:-.}",
        declared: true,
      }],
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path." },
      },
      required: ["path"],
    },
    metadata: {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        riskLevel: "low",
      },
      resources: [{
        kind: "file",
        mode: "read",
        template: "file:{path}",
        declared: true,
      }],
    },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 text file inside the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
    },
    metadata: {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        riskLevel: "high",
        requiresConfirmation: true,
        reason: "Overwrites workspace file content.",
      },
      resources: [{
        kind: "file",
        mode: "write",
        template: "file:{path}",
        declared: true,
      }],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file inside the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path to delete." },
      },
      required: ["path"],
    },
    metadata: {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        riskLevel: "high",
        requiresConfirmation: true,
        reason: "Deletes workspace file content.",
      },
      resources: [{
        kind: "file",
        mode: "delete",
        template: "file:{path}",
        declared: true,
      }],
    },
  },
  {
    name: "search_text",
    description: "Search for text using ripgrep in the workspace.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text." },
        path: { type: "string", description: "Optional relative path to narrow the search." },
      },
      required: ["query"],
    },
    metadata: {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        riskLevel: "low",
      },
      resources: [{
        kind: "workspace",
        mode: "read",
        template: "workspace:{path:-.}",
        declared: true,
      }],
    },
  },
  {
    name: "run_shell",
    description: "Run a shell command in the current workspace when execution policy grants shell access.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute after explicit opt-in." },
      },
      required: ["command"],
    },
    metadata: {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        riskLevel: "unknown",
        requiresConfirmation: true,
        reason: "Shell commands can read or mutate arbitrary workspace state.",
      },
      resources: [{
        kind: "shell",
        mode: "execute",
        template: "shell:*",
        declared: false,
      }],
    },
  },
  ...lspTools.definitions,
  ...astTools.definitions,
];

const toolHandlers: Record<string, ToolHandler> = {
  list_files: listFiles,
  read_file: readFile,
  write_file: writeFile,
  delete_file: deleteFile,
  search_text: searchText,
  run_shell: runShell,
  ...lspTools.handlers,
  ...astTools.handlers,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAskUserQuestionOption(value: unknown): AskUserQuestionOption {
  if (!isRecord(value) || typeof value.label !== "string" || value.label.trim().length === 0) {
    throw new Error("ask_user options require non-empty labels.");
  }
  if (value.label.trim().toLowerCase() === "other") {
    throw new Error("ask_user options must not use reserved label \"Other\".");
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error("ask_user option descriptions must be strings.");
  }
  return {
    label: value.label.trim(),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
  };
}

function parseAskUserQuestion(value: unknown, questionIds: Set<string>): AskUserQuestion {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error("ask_user questions require non-empty ids.");
  }
  const id = value.id.trim();
  if (questionIds.has(id)) {
    throw new Error(`ask_user question id is duplicated: ${id}`);
  }
  if (typeof value.question !== "string" || value.question.trim().length === 0) {
    throw new Error("ask_user questions require non-empty question text.");
  }
  if (!Array.isArray(value.options) || value.options.length === 0) {
    throw new Error("ask_user questions require at least one option.");
  }
  if (value.multi !== undefined && typeof value.multi !== "boolean") {
    throw new Error("ask_user multi must be boolean.");
  }
  const recommended = value.recommended;
  if (
    recommended !== undefined
    && (
      typeof recommended !== "number"
      || !Number.isInteger(recommended)
      || recommended < 0
      || recommended >= value.options.length
    )
  ) {
    throw new Error("ask_user recommended index must select an option.");
  }

  questionIds.add(id);
  return {
    id,
    question: value.question.trim(),
    options: value.options.map(parseAskUserQuestionOption),
    ...(typeof value.multi === "boolean" ? { multi: value.multi } : {}),
    ...(typeof recommended === "number" ? { recommended } : {}),
  };
}

export function parseAskUserQuestionRequest(input: Record<string, unknown>): AskUserQuestionRequest {
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    throw new Error("ask_user requires a non-empty id.");
  }
  if (input.title !== undefined && typeof input.title !== "string") {
    throw new Error("ask_user title must be a string.");
  }
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    throw new Error("ask_user requires at least one question.");
  }

  const questionIds = new Set<string>();
  return {
    kind: "user-decision",
    id: input.id.trim(),
    ...(typeof input.title === "string" && input.title.trim().length > 0 ? { title: input.title.trim() } : {}),
    questions: input.questions.map((question) => parseAskUserQuestion(question, questionIds)),
  };
}

function createAskUserToolDefinition(): ToolDefinition {
  return {
    name: "ask_user",
    description: "Ask the Work Shell user to choose between explicit options before continuing.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "Stable interaction id for this request." },
        title: { type: "string", description: "Optional short decision title." },
        questions: {
          type: "array",
          minItems: 1,
          description: "One or more questions with explicit options.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, description: "Stable question id." },
              question: { type: "string", minLength: 1, description: "Question shown to the user." },
              options: {
                type: "array",
                minItems: 1,
                description: "Explicit choices for this question.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", minLength: 1, description: "Option label." },
                    description: { type: "string", description: "Optional option detail." },
                  },
                  required: ["label"],
                },
              },
              multi: { type: "boolean", description: "Whether multiple options may be selected." },
              recommended: {
                type: "integer",
                minimum: 0,
                description: "Optional zero-based recommended option index.",
              },
            },
            required: ["id", "question", "options"],
          },
        },
      },
      required: ["id", "questions"],
    },
    metadata: {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        riskLevel: "medium",
      },
      resources: [{
        kind: "context",
        mode: "write",
        template: "context:decision",
        declared: true,
      }],
    },
  };
}

/**
 * The public runtime handed to provider and Pi turn loops. Handlers are never
 * exposed: every call goes through the policy-aware executor.
 */
export type ToolRuntime = {
  readonly definitions: readonly ToolDefinition[];
  readonly executor: ToolExecutor;
};

function createWebSearchToolDefinition(): ToolDefinition {
  return {
    name: "web_search",
    description:
      "Search the public web through the active model provider native search tool and return URL-bearing sources. Distinct from search_text (workspace text search) and /research (local artifact flow).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Web search query." },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Optional recency preference for sources.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum number of URL sources to return.",
        },
      },
      required: ["query"],
    },
    metadata: {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        riskLevel: "medium",
      },
      resources: [{
        kind: "network",
        mode: "read",
        template: "url:*",
        declared: false,
      }],
    },
  };
}

/**
 * Builds the internal raw registry. Kept private so no caller can reach a
 * handler without a policy decision.
 */
function createToolRegistry(input: {
  readonly interactionBridge?: WorkShellInteractionBridge | undefined;
  readonly webSearch?: WebSearchActiveProvider;
  readonly allowedTools?: readonly string[] | undefined;
}): ToolRegistry {
  const definitions: ToolDefinition[] = [...toolDefinitions, createWebSearchToolDefinition()];
  const handlers: Record<string, ToolHandler> = {
    ...toolHandlers,
    web_search: createWebSearchHandler(input.webSearch),
  };

  const bridge = input.interactionBridge;
  if (bridge !== undefined) {
    definitions.push(createAskUserToolDefinition());
    handlers.ask_user = async (rawInput, _cwd, options = {}) => {
      const request = parseAskUserQuestionRequest(rawInput);
      const result = await bridge.ask(request, options.signal);
      return { content: JSON.stringify(result) };
    };
  }

  if (input.allowedTools === undefined) {
    return { definitions, handlers };
  }

  const allowed = new Set(input.allowedTools);
  return {
    definitions: definitions.filter((definition) => allowed.has(definition.name)),
    handlers: Object.fromEntries(
      Object.entries(handlers).filter(([name]) => allowed.has(name)),
    ),
  };
}

export function createToolRuntime(input: {
  readonly interactionBridge?: WorkShellInteractionBridge | undefined;
  readonly webSearch?: WebSearchActiveProvider;
  readonly allowedTools?: readonly string[] | undefined;
  readonly policyProfile?: ExecutionPolicyProfile | (() => ExecutionPolicyProfile) | undefined;
  readonly runtimeMode?: string | (() => string) | undefined;
  readonly permissionRuleStore?: import("./permission-scope.js").CanonicalPermissionRuleStore | undefined;
}): ToolRuntime {
  const registry = createToolRegistry(input);
  return {
    definitions: registry.definitions,
    executor: createPolicyAwareToolExecutor({
      definitions: registry.definitions,
      handlers: registry.handlers,
      policyProfile: input.policyProfile ?? resolveModeExecutionPolicyProfile({
        mode: "default",
        envShellOptIn: process.env.UNCLECODE_ALLOW_RUN_SHELL === "1",
      }),
      runtimeMode: input.runtimeMode ?? "local",
      ...(input.permissionRuleStore ? { permissionRuleStore: input.permissionRuleStore } : {}),
      ...(input.interactionBridge ? { interactionBridge: input.interactionBridge } : {}),
    }),
  };
}

export function formatToolDefinitionLine(tool: ToolDefinition | undefined): string {
  if (!tool) {
    return "unknown: tool metadata unavailable";
  }
  const metadata = tool.metadata;
  if (!metadata) {
    return `${tool.name}: ${tool.description}`;
  }
  const risk = metadata.annotations.riskLevel;
  const resources = metadata.resources.map((resource) => {
    const opaque = resource.declared ? "" : " (opaque)";
    return `${resource.mode} ${resource.template}${opaque}`;
  }).join(", ");
  return `${tool.name}: ${tool.description} · risk ${risk} · resources ${resources}`;
}
