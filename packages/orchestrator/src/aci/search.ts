/**
 * ACI Search — find_file / search_dir summarized output with a 50-result cap.
 * Empirical SWE-agent finding: iterative result paging hurts performance;
 * summarized cap + refine-query suggestion outperforms next/prev navigation.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { assertWithinWorkspace } from "./path-containment.js";

const execFileAsync = promisify(execFile);

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

const DEFAULT_EXCLUDE_GLOBS = ["!node_modules", "!dist"];

function buildGlobArgs(globs: ReadonlyArray<string> | undefined): string[] {
  const all = [...DEFAULT_EXCLUDE_GLOBS, ...(globs ?? [])];
  const args: string[] = [];
  for (const glob of all) {
    args.push("--glob", glob);
  }
  return args;
}

export async function findFile(input: FindFileInput): Promise<SearchResult> {
  const cap = input.cap ?? DEFAULT_SEARCH_CAP;
  const absRoot = resolve(input.cwd);
  const args = ["--files", "--hidden", ...buildGlobArgs(input.globs), absRoot];
  let stdout = "";
  try {
    const result = await execFileAsync("rg", args, { maxBuffer: 8 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
  }

  const allFiles = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const lowerPattern = input.pattern.toLowerCase();
  const matched = allFiles.filter((path) => path.toLowerCase().includes(lowerPattern));
  const truncated = matched.length > cap;
  const hits = matched.slice(0, cap).map((path) => ({ path }));
  return {
    truncated,
    totalHits: matched.length,
    hits,
    ...(truncated
      ? {
          suggestion: `Found ${matched.length} matches for "${input.pattern}"; only the first ${cap} returned. Refine the pattern (e.g., add a directory prefix or pass globs) and search again.`,
        }
      : {}),
  };
}

export async function searchDir(input: SearchDirInput): Promise<SearchResult> {
  const cap = input.cap ?? DEFAULT_SEARCH_CAP;
  // Containment guard — model-supplied `input.path` could escape the
  // workspace via `../../`, an absolute path, or a symlink. Refuse before
  // handing it to ripgrep so a misbehaving agent cannot read arbitrary
  // filesystem locations under the harness's privilege.
  const target = assertWithinWorkspace(input.cwd, input.path ?? ".");
  const maxCountPerFile = input.maxCountPerFile ?? Math.max(1, cap);
  // The "--" sentinel forces ripgrep's clap parser to treat every following
  // token as a positional argument, never a flag. Without it, a malicious
  // `input.query` such as `--follow` would re-enable symlink traversal
  // inside the workspace (a read-side escape), and `--type-add` /
  // `--pcre2` / `--multiline` would silently change search semantics.
  const args = [
    "-n",
    "--hidden",
    "--max-count",
    String(maxCountPerFile),
    ...buildGlobArgs(input.globs),
    "--",
    input.query,
    target,
  ];
  let stdout = "";
  try {
    const result = await execFileAsync("rg", args, { maxBuffer: 8 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
  }

  const lines = stdout.split("\n").filter(Boolean);
  const totalHits = lines.length;
  const truncated = totalHits > cap;
  const hits = lines.slice(0, cap).map((line) => {
    const match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!match) {
      return { path: line };
    }
    const [, path, lineNoRaw, text] = match;
    return {
      path: path ?? line,
      line: Number.parseInt(lineNoRaw ?? "0", 10),
      text: text ?? "",
    };
  });
  return {
    truncated,
    totalHits,
    hits,
    ...(truncated
      ? {
          suggestion: `Found ${totalHits} matches for "${input.query}"; only the first ${cap} returned. Refine the query (e.g., add a path filter, pass globs, or use a more specific token) and search again.`,
        }
      : {}),
  };
}
