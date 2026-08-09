import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LspJsonRpcClient,
  resolveDefaultLspServer,
  type LspServerResolver,
} from "./lsp-client.js";
import type { ToolDefinition, ToolHandler } from "./tools.js";
import type { ToolRegistry } from "./tool-executor.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const QUERY_ACTIONS = ["diagnostics", "definition", "references", "hover", "symbols"] as const;
type LspQueryAction = typeof QUERY_ACTIONS[number];

type ProtocolPosition = { readonly line: number; readonly character: number };
type ProtocolRange = { readonly start: ProtocolPosition; readonly end: ProtocolPosition };
type NormalizedRange = {
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
};
type ValidatedTextEdit = { readonly range: ProtocolRange; readonly newText: string };

export type LspToolRegistryOptions = {
  readonly resolveServer?: LspServerResolver;
};

function pathEscapesWorkspace(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function resolveWorkspaceFile(cwd: string, requestedPath: string): string {
  if (path.isAbsolute(requestedPath)) {
    throw new Error(`Path escapes working directory: ${requestedPath}`);
  }
  const workspace = realpathSync(cwd);
  const candidate = path.resolve(workspace, requestedPath);
  if (pathEscapesWorkspace(workspace, candidate)) {
    throw new Error(`Path escapes working directory: ${requestedPath}`);
  }
  const filePath = realpathSync(candidate);
  if (pathEscapesWorkspace(workspace, filePath)) {
    throw new Error(`Path escapes working directory: ${requestedPath}`);
  }
  return filePath;
}

function requiredPath(input: Record<string, unknown>): string {
  if (typeof input.path !== "string" || input.path.length === 0) {
    throw new Error("path is required");
  }
  return input.path;
}

function resolveTimeout(input: Record<string, unknown>): number {
  if (input.timeout_ms === undefined) return DEFAULT_TIMEOUT_MS;
  if (
    typeof input.timeout_ms !== "number"
    || !Number.isInteger(input.timeout_ms)
    || input.timeout_ms < 100
    || input.timeout_ms > MAX_TIMEOUT_MS
  ) {
    throw new Error(`timeout_ms must be an integer between 100 and ${MAX_TIMEOUT_MS}`);
  }
  return input.timeout_ms;
}

function resolveAction(input: Record<string, unknown>): LspQueryAction {
  if (typeof input.action !== "string" || !QUERY_ACTIONS.includes(input.action as LspQueryAction)) {
    throw new Error(`action must be one of: ${QUERY_ACTIONS.join(", ")}`);
  }
  return input.action as LspQueryAction;
}

function resolvePosition(text: string, input: Record<string, unknown>): ProtocolPosition {
  if (typeof input.line !== "number" || !Number.isInteger(input.line) || input.line < 1) {
    throw new Error("line must be a positive integer");
  }
  const lines = text.split("\n");
  const rawLine = lines[input.line - 1];
  if (rawLine === undefined) {
    throw new Error(`line ${input.line} is outside the file`);
  }
  const lineText = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (input.symbol !== undefined) {
    if (typeof input.symbol !== "string" || input.symbol.length === 0) {
      throw new Error("symbol must be a non-empty string");
    }
    const occurrence = input.occurrence === undefined ? 1 : input.occurrence;
    if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 1) {
      throw new Error("occurrence must be a positive integer");
    }
    let offset = -1;
    let from = 0;
    for (let index = 0; index < occurrence; index += 1) {
      offset = lineText.indexOf(input.symbol, from);
      if (offset < 0) {
        throw new Error(`symbol "${input.symbol}" occurrence ${occurrence} was not found on line ${input.line}`);
      }
      from = offset + input.symbol.length;
    }
    return { line: input.line - 1, character: offset };
  }
  const column = input.column === undefined ? 1 : input.column;
  if (typeof column !== "number" || !Number.isInteger(column) || column < 1 || column > lineText.length + 1) {
    throw new Error(`column must be between 1 and ${lineText.length + 1}`);
  }
  return { line: input.line - 1, character: column - 1 };
}

function parseProtocolRange(value: unknown): ProtocolRange | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const range = value as { start?: unknown; end?: unknown };
  if (
    typeof range.start !== "object" || range.start === null || Array.isArray(range.start)
    || typeof range.end !== "object" || range.end === null || Array.isArray(range.end)
  ) return undefined;
  const start = range.start as { line?: unknown; character?: unknown };
  const end = range.end as { line?: unknown; character?: unknown };
  if (
    typeof start.line !== "number" || typeof start.character !== "number"
    || typeof end.line !== "number" || typeof end.character !== "number"
  ) return undefined;
  return {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
  };
}

function normalizeRange(value: unknown): NormalizedRange | undefined {
  const range = parseProtocolRange(value);
  if (!range) return undefined;
  return {
    start: { line: range.start.line + 1, column: range.start.character + 1 },
    end: { line: range.end.line + 1, column: range.end.character + 1 },
  };
}

function normalizeUri(uri: string, cwd: string): string {
  if (!uri.startsWith("file:")) return uri;
  const workspace = realpathSync(cwd);
  const filePath = fileURLToPath(uri);
  const relative = path.relative(workspace, filePath);
  return pathEscapesWorkspace(workspace, filePath)
    ? filePath
    : (relative || ".").split(path.sep).join("/");
}

function normalizeLspValue(value: unknown, cwd: string, key?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeLspValue(entry, cwd));
  if (typeof value !== "object" || value === null) return value;
  if (key && ["range", "selectionRange", "targetRange", "targetSelectionRange"].includes(key)) {
    return normalizeRange(value) ?? value;
  }
  const normalized: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if ((entryKey === "uri" || entryKey === "targetUri") && typeof entryValue === "string") {
      normalized.path = normalizeUri(entryValue, cwd);
      continue;
    }
    normalized[entryKey] = normalizeLspValue(entryValue, cwd, entryKey);
  }
  return normalized;
}

function normalizeDiagnostics(items: unknown[], cwd: string): unknown[] {
  return items.map((item) => normalizeLspValue(item, cwd));
}

function positionToOffset(content: string, position: ProtocolPosition): number {
  if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) {
    throw new Error("language server returned an invalid edit position");
  }
  let line = 0;
  let lineStart = 0;
  while (line < position.line) {
    const newline = content.indexOf("\n", lineStart);
    if (newline < 0) throw new Error("language server edit line is outside the file");
    lineStart = newline + 1;
    line += 1;
  }
  const newline = content.indexOf("\n", lineStart);
  let lineEnd = newline < 0 ? content.length : newline;
  if (lineEnd > lineStart && content[lineEnd - 1] === "\r") lineEnd -= 1;
  if (position.character > lineEnd - lineStart) {
    throw new Error("language server edit character is outside the line");
  }
  return lineStart + position.character;
}

function applyTextEdits(content: string, edits: readonly ValidatedTextEdit[]): string {
  const resolved = edits.map((edit) => ({
    start: positionToOffset(content, edit.range.start),
    end: positionToOffset(content, edit.range.end),
    newText: edit.newText,
  })).sort((left, right) => right.start - left.start);
  let nextStart = content.length;
  let output = content;
  for (const edit of resolved) {
    if (edit.start > edit.end || edit.end > nextStart) {
      throw new Error("language server returned overlapping or reversed edits");
    }
    output = `${output.slice(0, edit.start)}${edit.newText}${output.slice(edit.end)}`;
    nextStart = edit.start;
  }
  return output;
}

function collectWorkspaceEdits(value: unknown): Map<string, ValidatedTextEdit[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("language server returned an invalid WorkspaceEdit");
  }
  const workspaceEdit = value as { changes?: unknown; documentChanges?: unknown };
  const editsByUri = new Map<string, ValidatedTextEdit[]>();
  const addEdits = (uri: unknown, rawEdits: unknown) => {
    if (typeof uri !== "string" || !Array.isArray(rawEdits)) {
      throw new Error("language server returned an invalid text edit group");
    }
    const target = editsByUri.get(uri) ?? [];
    for (const rawEdit of rawEdits) {
      if (typeof rawEdit !== "object" || rawEdit === null || Array.isArray(rawEdit)) {
        throw new Error("language server returned an invalid text edit");
      }
      const edit = rawEdit as { range?: unknown; newText?: unknown };
      const range = parseProtocolRange(edit.range);
      if (!range || typeof edit.newText !== "string") {
        throw new Error("language server returned an invalid text edit");
      }
      target.push({ range, newText: edit.newText });
    }
    editsByUri.set(uri, target);
  };

  if (workspaceEdit.documentChanges !== undefined) {
    if (!Array.isArray(workspaceEdit.documentChanges)) {
      throw new Error("language server returned invalid documentChanges");
    }
    for (const change of workspaceEdit.documentChanges) {
      if (typeof change !== "object" || change === null || Array.isArray(change)) {
        throw new Error("language server returned an invalid document change");
      }
      const documentChange = change as { kind?: unknown; textDocument?: unknown; edits?: unknown };
      if (documentChange.kind !== undefined) {
        throw new Error("language server resource operations are not supported by lsp_rename");
      }
      const textDocument = documentChange.textDocument as { uri?: unknown } | undefined;
      addEdits(textDocument?.uri, documentChange.edits);
    }
    return editsByUri;
  }
  if (typeof workspaceEdit.changes === "object" && workspaceEdit.changes !== null && !Array.isArray(workspaceEdit.changes)) {
    for (const [uri, edits] of Object.entries(workspaceEdit.changes)) addEdits(uri, edits);
  }
  return editsByUri;
}

async function replaceFileAtomically(filePath: string, content: string): Promise<void> {
  const metadata = await stat(filePath);
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: metadata.mode });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function applyWorkspaceEdit(cwd: string, value: unknown): Promise<{ changedFiles: string[]; editCount: number }> {
  const workspace = realpathSync(cwd);
  const editsByUri = collectWorkspaceEdits(value);
  const editsByFile = new Map<string, ValidatedTextEdit[]>();
  const originals = new Map<string, string>();
  const updates = new Map<string, string>();
  let editCount = 0;
  for (const [uri, edits] of editsByUri) {
    if (!uri.startsWith("file:")) throw new Error(`lsp_rename cannot edit non-file URI: ${uri}`);
    const filePath = realpathSync(fileURLToPath(uri));
    if (pathEscapesWorkspace(workspace, filePath)) {
      throw new Error(`Path escapes working directory: ${filePath}`);
    }
    editsByFile.set(filePath, [...(editsByFile.get(filePath) ?? []), ...edits]);
  }
  for (const [filePath, edits] of editsByFile) {
    const content = await readFile(filePath, "utf8");
    originals.set(filePath, content);
    updates.set(filePath, applyTextEdits(content, edits));
    editCount += edits.length;
  }

  const written: string[] = [];
  try {
    for (const [filePath, content] of updates) {
      await replaceFileAtomically(filePath, content);
      written.push(filePath);
    }
  } catch (error) {
    const unrestored: string[] = [];
    for (const filePath of written) {
      const original = originals.get(filePath);
      if (original === undefined) {
        unrestored.push(filePath);
        continue;
      }
      try {
        await replaceFileAtomically(filePath, original);
      } catch {
        unrestored.push(filePath);
      }
    }
    if (unrestored.length > 0) {
      throw new Error(
        `lsp_rename failed and could not restore: ${unrestored.join(", ")}`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    changedFiles: [...updates.keys()].map((filePath) => path.relative(workspace, filePath).split(path.sep).join("/")),
    editCount,
  };
}

export const lspToolDefinitions: readonly ToolDefinition[] = [
  {
    name: "lsp_query",
    description: "Query the language server for diagnostics, definitions, references, hover details, or document symbols.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: QUERY_ACTIONS, description: "Language-server query to run." },
        path: { type: "string", description: "Relative source file path." },
        line: { type: "integer", minimum: 1, description: "One-based source line for position queries." },
        column: { type: "integer", minimum: 1, description: "One-based source column; defaults to 1." },
        symbol: { type: "string", description: "Optional symbol text used to resolve the column on the selected line." },
        occurrence: { type: "integer", minimum: 1, description: "One-based symbol occurrence on the line." },
        timeout_ms: { type: "integer", minimum: 100, maximum: MAX_TIMEOUT_MS, description: "Language-server timeout." },
      },
      required: ["action", "path"],
    },
    metadata: {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        riskLevel: "low",
      },
      resources: [{ kind: "file", mode: "read", template: "file:{path}", declared: true }],
    },
  },
  {
    name: "lsp_rename",
    description: "Rename a symbol through the language server and apply every returned workspace text edit.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative source file path." },
        line: { type: "integer", minimum: 1, description: "One-based source line." },
        column: { type: "integer", minimum: 1, description: "One-based source column; defaults to 1." },
        symbol: { type: "string", description: "Optional symbol text used to resolve the column." },
        occurrence: { type: "integer", minimum: 1, description: "One-based symbol occurrence on the line." },
        new_name: { type: "string", description: "New symbol name." },
        timeout_ms: { type: "integer", minimum: 100, maximum: MAX_TIMEOUT_MS, description: "Language-server timeout." },
      },
      required: ["path", "line", "new_name"],
    },
    metadata: {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        riskLevel: "high",
        requiresConfirmation: true,
        reason: "Language-server rename can modify every reference across multiple workspace files.",
      },
      resources: [{ kind: "workspace", mode: "write", template: "workspace:*", declared: false }],
    },
  },
];

export function createLspToolRegistry(options: LspToolRegistryOptions = {}): ToolRegistry {
  const resolveServer = options.resolveServer ?? resolveDefaultLspServer;

  const lspQuery: ToolHandler = async (input, cwd, handlerOptions = {}) => {
    const action = resolveAction(input);
    const requestedPath = requiredPath(input);
    const filePath = resolveWorkspaceFile(cwd, requestedPath);
    const text = await readFile(filePath, "utf8");
    const config = resolveServer(filePath, path.extname(filePath), cwd);
    if (!config) throw new Error(`No native language server is configured for ${requestedPath}`);
    const timeoutMs = resolveTimeout(input);
    const client = new LspJsonRpcClient(config, cwd, timeoutMs, handlerOptions.signal);
    try {
      await client.start();
      const uri = pathToFileURL(filePath).href;
      client.openDocument(uri, config.languageId, text);
      if (action === "diagnostics") {
        if (client.capabilities.diagnosticProvider) {
          const report = await client.request("textDocument/diagnostic", { textDocument: { uri } }) as { items?: unknown };
          const items = Array.isArray(report?.items) ? report.items : [];
          return { content: JSON.stringify({ server: config.id, action, status: "ok", diagnostics: normalizeDiagnostics(items, cwd) }) };
        }
        const published = await client.waitForPublishedDiagnostics(uri);
        return {
          content: JSON.stringify({
            server: config.id,
            action,
            status: published.received ? "ok" : "timed_out",
            diagnostics: normalizeDiagnostics(published.items, cwd),
          }),
        };
      }
      if (action === "symbols") {
        const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
        return { content: JSON.stringify({ server: config.id, action, symbols: normalizeLspValue(symbols ?? [], cwd) }) };
      }
      const position = resolvePosition(text, input);
      if (action === "definition") {
        const result = await client.request("textDocument/definition", { textDocument: { uri }, position });
        return { content: JSON.stringify({ server: config.id, action, locations: normalizeLspValue(result ?? [], cwd) }) };
      }
      if (action === "references") {
        const result = await client.request("textDocument/references", {
          textDocument: { uri },
          position,
          context: { includeDeclaration: true },
        });
        return { content: JSON.stringify({ server: config.id, action, locations: normalizeLspValue(result ?? [], cwd) }) };
      }
      const hover = await client.request("textDocument/hover", { textDocument: { uri }, position });
      return { content: JSON.stringify({ server: config.id, action, hover: normalizeLspValue(hover, cwd) }) };
    } finally {
      await client.close();
    }
  };

  const lspRename: ToolHandler = async (input, cwd, handlerOptions = {}) => {
    const requestedPath = requiredPath(input);
    if (typeof input.new_name !== "string" || input.new_name.trim().length === 0) {
      throw new Error("new_name is required");
    }
    const filePath = resolveWorkspaceFile(cwd, requestedPath);
    const text = await readFile(filePath, "utf8");
    const config = resolveServer(filePath, path.extname(filePath), cwd);
    if (!config) throw new Error(`No native language server is configured for ${requestedPath}`);
    const client = new LspJsonRpcClient(config, cwd, resolveTimeout(input), handlerOptions.signal);
    try {
      await client.start();
      const uri = pathToFileURL(filePath).href;
      client.openDocument(uri, config.languageId, text);
      const edit = await client.request("textDocument/rename", {
        textDocument: { uri },
        position: resolvePosition(text, input),
        newName: input.new_name.trim(),
      });
      const applied = edit ? await applyWorkspaceEdit(cwd, edit) : { changedFiles: [], editCount: 0 };
      return { content: JSON.stringify({ server: config.id, ...applied }) };
    } finally {
      await client.close();
    }
  };

  return {
    definitions: lspToolDefinitions,
    handlers: { lsp_query: lspQuery, lsp_rename: lspRename },
  };
}
