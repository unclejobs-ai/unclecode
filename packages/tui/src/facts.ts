import { execFileSync, execSync } from "node:child_process";
import os from "node:os";

import React from "react";

/**
 * Structured workspace facts, read from `git status --porcelain=v1 --branch`.
 *
 * The footer needs four numbers, not a sentence: which branch is checked out
 * and how much work is staged, unstaged, and untracked. `branch` is absent
 * outside a repository, in which case every count is zero.
 */
export type GitFacts = {
  readonly branch?: string;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
};

export const EMPTY_GIT_FACTS: GitFacts = { staged: 0, unstaged: 0, untracked: 0 };

/**
 * How long one read answers for a workspace. The footer repaints on every
 * keystroke, so without a window the shell would fork `git` per character.
 */
export const GIT_FACTS_TTL_MS = 1_000;

/** The command seam. Injected by tests so no test forks a real `git`. */
export type GitStatusReader = (cwd: string) => string;

const readGitStatusText: GitStatusReader = (cwd) => execFileSync(
  "git",
  ["status", "--porcelain=v1", "--branch"],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
);

const gitFactsCache = new Map<string, { readonly readAt: number; readonly facts: GitFacts }>();

/**
 * Workspace facts for `cwd`, at most one `git` process per {@link GIT_FACTS_TTL_MS}.
 *
 * A broken or absent repository resolves to {@link EMPTY_GIT_FACTS} rather than
 * throwing: this is chrome, and a footer must never take the shell down.
 */
export function readGitFacts(
  cwd: string,
  now = Date.now(),
  readStatus: GitStatusReader = readGitStatusText,
): GitFacts {
  const cached = gitFactsCache.get(cwd);
  const cacheAge = cached === undefined ? undefined : now - cached.readAt;
  if (cached !== undefined && cacheAge !== undefined && cacheAge >= 0 && cacheAge < GIT_FACTS_TTL_MS) {
    return cached.facts;
  }
  let facts = EMPTY_GIT_FACTS;
  try {
    facts = parseGitFacts(readStatus(cwd));
  } catch {
    // Not a repository, no `git` on PATH, or a locked index. All the same
    // answer: nothing to report about this workspace.
  }
  gitFactsCache.set(cwd, { readAt: now, facts });
  return facts;
}

/**
 * Parse porcelain v1 with `--branch`.
 *
 * The `XY` columns are the index and the worktree, so a file changed in both
 * counts once as staged and once as unstaged — that is what `MM` and every
 * conflict pair (`UU`, `AA`, `DU`, …) mean. `??` is untracked and `!!` is
 * ignored, and neither is a change to either tree.
 */
export function parseGitFacts(porcelain: string): GitFacts {
  let branch: string | undefined;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of porcelain.split("\n")) {
    if (line.startsWith("## ")) {
      branch = parseBranchHeader(line.slice(3).trim());
      continue;
    }
    if (line.length < 3) {
      continue;
    }
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    if (index === "!" || worktree === "!") {
      continue;
    }
    if (index === "?" || worktree === "?") {
      untracked += 1;
      continue;
    }
    if (index !== " ") {
      staged += 1;
    }
    if (worktree !== " ") {
      unstaged += 1;
    }
  }

  return { ...(branch === undefined ? {} : { branch }), staged, unstaged, untracked };
}

function parseBranchHeader(header: string): string | undefined {
  if (header === "HEAD (no branch)") {
    return "detached";
  }
  const initial = /^No commits yet on (.+)$/.exec(header);
  const named = (initial?.[1] ?? header).split("...")[0] ?? "";
  const local = named.replace(/\s+\[[^\]]*\]$/, "").trim();
  return local.length > 0 ? local : undefined;
}

/**
 * Keep {@link GitFacts} in React state, synced from the working tree.
 *
 * `git` is a child process, so it must never run during render. This is the one
 * effect that owns it: a read on every workspace change, then a refresh once per
 * {@link GIT_FACTS_TTL_MS} for as long as `active` — the main turn or any
 * delegated agent or job — could still be touching files. Unchanged facts keep
 * their previous object so a quiet workspace never repaints the frame.
 *
 * It lives beside the reader rather than in the pane because the whole Git seam
 * — command, parse, cache, and the sync that keeps it out of render — is one
 * concern.
 */
export function useGitFacts(
  cwd: string,
  active: boolean,
  readStatus: GitStatusReader = readGitStatusText,
): GitFacts {
  const [snapshot, setSnapshot] = React.useState<{
    readonly cwd: string;
    readonly facts: GitFacts;
  }>(() => ({ cwd, facts: EMPTY_GIT_FACTS }));
  React.useEffect(() => {
    let cancelled = false;
    const sync = () => {
      if (cancelled) return;
      const next = readGitFacts(cwd, Date.now(), readStatus);
      setSnapshot((previous) => (
        previous.cwd === cwd
          && previous.facts.branch === next.branch
          && previous.facts.staged === next.staged
          && previous.facts.unstaged === next.unstaged
          && previous.facts.untracked === next.untracked
          ? previous
          : { cwd, facts: next }
      ));
    };
    sync();
    if (!active) {
      return () => { cancelled = true; };
    }
    const interval = setInterval(sync, GIT_FACTS_TTL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cwd, active, readStatus]);
  return snapshot.cwd === cwd ? snapshot.facts : EMPTY_GIT_FACTS;
}

/**
 * Branch name for the session dashboard, which reports it as prose rather than
 * as structured facts. Delegates so the shell has exactly one `git` seam.
 */
export function getGitBranch(cwd: string): string {
  return readGitFacts(cwd).branch ?? "no git repo";
}

export function getGitStatus(cwd: string): string {
  try {
    const status = execSync("git status --porcelain", { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    if (!status) return "clean";
    const lines = status.split("\n").length;
    return `${lines} modified`;
  } catch {
    return "no git repo";
  }
}

export function getRuntimeFacts() {
  return {
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
  };
}
