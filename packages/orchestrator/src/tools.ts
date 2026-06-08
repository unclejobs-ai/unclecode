import { runRustCommand } from "./rust-command.js";

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
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
