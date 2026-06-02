import { runRustCommand } from "../rust-command.js";
import { PathContainmentError } from "./path-containment.js";

export const DEFAULT_SEARCH_CAP = 50;

export type SearchHit = {
  readonly path: string;
  readonly line?: number;
  readonly text?: string;
};

export type SearchResult = {
  readonly truncated: boolean;
  readonly totalHits: number;
  readonly hits: ReadonlyArray<SearchHit>;
  readonly suggestion?: string;
};

export type FindFileInput = {
  readonly cwd: string;
  readonly pattern: string;
  readonly cap?: number;
  readonly globs?: ReadonlyArray<string>;
};

export type SearchDirInput = {
  readonly cwd: string;
  readonly query: string;
  readonly path?: string;
  readonly cap?: number;
  readonly globs?: ReadonlyArray<string>;
  readonly maxCountPerFile?: number;
};

export async function findFile(input: FindFileInput): Promise<SearchResult> {
  const cap = input.cap ?? DEFAULT_SEARCH_CAP;
  const stdout = await runRustCommand(
    ["rust", "aci", "find-json", input.pattern, String(cap), ...(input.globs ?? [])],
    input.cwd,
  );
  return parseSearchResult(stdout, "findFile");
}

export async function searchDir(input: SearchDirInput): Promise<SearchResult> {
  const cap = input.cap ?? DEFAULT_SEARCH_CAP;
  const target = input.path ?? ".";
  const maxCountPerFile = input.maxCountPerFile ?? Math.max(1, cap);
  try {
    const stdout = await runRustCommand(
      [
        "rust",
        "aci",
        "search-json",
        input.query,
        target,
        String(cap),
        String(maxCountPerFile),
        ...(input.globs ?? []),
      ],
      input.cwd,
    );
    return parseSearchResult(stdout, "searchDir");
  } catch (error) {
    normalizePathContainmentError(error, target, input.cwd);
  }
}

function parseSearchResult(stdout: string, label: string): SearchResult {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isSearchResult(parsed)) {
    throw new Error(`${label}: invalid Rust result`);
  }
  return parsed;
}

function normalizePathContainmentError(error: unknown, path: string, workspaceRoot: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /absolute path rejected|path contains traversal segment|path escapes workspace|path is empty/i.test(
      message,
    )
  ) {
    throw new PathContainmentError(message, path, workspaceRoot);
  }
  throw error;
}

function isSearchResult(value: unknown): value is SearchResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.truncated === "boolean" &&
    Number.isInteger(value.totalHits) &&
    Array.isArray(value.hits) &&
    value.hits.every(isSearchHit) &&
    (value.suggestion === undefined || typeof value.suggestion === "string")
  );
}

function isSearchHit(value: unknown): value is SearchHit {
  if (!isRecord(value) || typeof value.path !== "string") {
    return false;
  }
  return (
    (value.line === undefined || Number.isInteger(value.line)) &&
    (value.text === undefined || typeof value.text === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
