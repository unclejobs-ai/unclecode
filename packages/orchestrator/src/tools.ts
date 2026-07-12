import type {
  AskUserQuestion,
  AskUserQuestionOption,
  AskUserQuestionRequest,
  ToolMetadata,
} from "@unclecode/contracts";
import type { WorkShellInteractionBridge } from "./work-shell-interaction-bridge.js";
import { runRustCommand } from "./rust-command.js";
import {
  createWebSearchHandler,
  type WebSearchActiveProvider,
} from "./web-search.js";

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

async function runRustShell(command: string, cwd: string, options: ToolHandlerOptions = {}): Promise<string> {
  return await runRustCommand(["rust", "shell", "--", command], cwd, options.signal ? "" : undefined, process.env, options);
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
  if (process.env.UNCLECODE_ALLOW_RUN_SHELL !== "1") {
    throw new Error("run_shell is disabled by default. Set UNCLECODE_ALLOW_RUN_SHELL=1 to enable it.");
  }
  const stdout = await runRustShell(input.command, cwd, options);
  const content = stdout.trim();
  return { content: content || "(command produced no output)" };
}

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
    description: "Run a shell command in the current workspace when UNCLECODE_ALLOW_RUN_SHELL=1 is set.",
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
];

export const toolHandlers: Record<string, ToolHandler> = {
  list_files: listFiles,
  read_file: readFile,
  write_file: writeFile,
  delete_file: deleteFile,
  search_text: searchText,
  run_shell: runShell,
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

export type ToolRuntime = {
  readonly definitions: readonly ToolDefinition[];
  readonly handlers: Readonly<Record<string, ToolHandler>>;
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

export function createToolRuntime(input: {
  readonly interactionBridge: WorkShellInteractionBridge;
  readonly webSearch?: WebSearchActiveProvider;
}): ToolRuntime {
  const askUser: ToolHandler = async (rawInput, _cwd, options = {}) => {
    const request = parseAskUserQuestionRequest(rawInput);
    const result = await input.interactionBridge.ask(request, options.signal);
    return { content: JSON.stringify(result) };
  };
  const webSearch = createWebSearchHandler(input.webSearch);

  return {
    definitions: [
      ...toolDefinitions,
      createAskUserToolDefinition(),
      createWebSearchToolDefinition(),
    ],
    handlers: {
      ...toolHandlers,
      ask_user: askUser,
      web_search: webSearch,
    },
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
