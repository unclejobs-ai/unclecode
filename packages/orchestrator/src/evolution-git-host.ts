import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  CreatorEvolutionHost,
  CreatorEvolutionResult,
  EvolutionAssetDigest,
  EvolutionCandidateSnapshot,
  EvolutionCleanupProjection,
  EvolutionCleanupResource,
  EvolutionRepositoryIdentity,
  PreparedEvolutionCandidate,
} from "./evolution-runtime.js";

const execFile = promisify(execFileCallback);
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 50_000;
const MAX_HASHED_FILE_BYTES = 8 * 1024 * 1024;
const CANONICAL_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type CreateGitCreatorEvolutionHostInput = {
  readonly workspaceRoot: string;
  readonly runCreator: CreatorEvolutionHost["runCreator"];
  readonly runEvaluator: CreatorEvolutionHost["runEvaluator"];
  readonly recordAgentOps?: ((result: CreatorEvolutionResult) => void) | undefined;
  readonly now?: (() => Date) | undefined;
};

type TreeEntry = EvolutionAssetDigest & { readonly fingerprint: string };

/**
 * Concrete local-Git boundary for the evolution service. It uses only local
 * branches/worktrees and Git plumbing; no remote, merge, publish, or checkout
 * of the operator's current worktree is reachable from this adapter.
 */
export function createGitCreatorEvolutionHost(
  options: CreateGitCreatorEvolutionHostInput,
): CreatorEvolutionHost {
  const now = options.now ?? (() => new Date());
  return {
    async loadRecord({ runId }) {
      const workspaceRoot = await requireRepositoryRoot(options.workspaceRoot, options.workspaceRoot);
      const recordPath = evolutionArtifactPath(workspaceRoot, runId);
      try {
        const raw = await readFile(recordPath, "utf8");
        if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) return undefined;
        const parsed = JSON.parse(raw) as { result?: CreatorEvolutionResult };
        const result = parsed.result;
        if (
          !result
          || result.recorded !== true
          || result.projection?.runId !== runId
          || result.status !== result.projection.state
        ) {
          return undefined;
        }
        return { result };
      } catch {
        return undefined;
      }
    },

    async verifyRecordedCandidate(input) {
      const failures = new Set<string>();
      const root = await requireRepositoryRoot(input.workspaceRoot, options.workspaceRoot);
      const projection = input.result.projection;
      const proposal = input.result.proposal;
      const context = input.result.context;
      const branch = projection.isolatedBranch;
      const worktree = projection.isolatedWorktree;
      const baseCommit = projection.hashes.baseCommit;
      const candidateCommit = projection.hashes.candidateCommit;
      const expectedPaths = evolutionWorktreePaths(root, projection.runId);
      if (
        !proposal
        || !context?.isolation
        || !branch
        || !worktree
        || !baseCommit
        || !candidateCommit
        || branch !== `unclecode/evolve/${projection.candidateId}`
        || worktree !== expectedPaths.candidate
        || proposal.candidateId !== projection.candidateId
        || proposal.isolatedBranch !== branch
        || proposal.isolatedWorktree !== worktree
      ) {
        failures.add("EVOLUTION_CANDIDATE_STALE");
        return [...failures];
      }

      try {
        const branchRef = `refs/heads/${branch}`;
        if (!(await gitSucceeds(root, ["show-ref", "--verify", branchRef]))) {
          failures.add("ISOLATED_BRANCH_NOT_FOUND");
        }
        if (!(await pathExists(worktree))) failures.add("ISOLATED_WORKTREE_NOT_FOUND");
        if (failures.size > 0) return [...failures];

        const candidateRoot = await requireRepositoryRoot(worktree, root);
        const [head, actualBranch, branchCommit, worktrees] = await Promise.all([
          git(candidateRoot, ["rev-parse", "HEAD"]),
          currentBranch(candidateRoot, candidateCommit),
          git(root, ["rev-parse", branchRef]),
          listWorktrees(root),
        ]);
        if (head !== candidateCommit || branchCommit !== candidateCommit || actualBranch !== branch) {
          failures.add("EVOLUTION_CANDIDATE_STALE");
        }
        if (!worktrees.some((entry) => entry.path === worktree && entry.branch === branchRef)) {
          failures.add("ISOLATED_WORKTREE_NOT_FOUND");
        }
        if (!(await gitSucceeds(candidateRoot, ["diff", "--quiet", candidateCommit, "--"]))) {
          failures.add("EVOLUTION_CANDIDATE_STALE");
        }

        const [candidateTree, trackedPaths, changedPaths] = await Promise.all([
          scanTree(candidateRoot),
          gitRaw(candidateRoot, ["ls-tree", "-r", "--name-only", "-z", candidateCommit]).then(splitNul),
          gitRaw(candidateRoot, ["diff", "--name-only", "-z", baseCommit, candidateCommit]).then(splitNul),
        ]);
        const actualPaths = [...candidateTree.keys()].sort();
        if (canonicalJson(actualPaths) !== canonicalJson([...trackedPaths].sort())) {
          failures.add("EVOLUTION_CANDIDATE_STALE");
        }
        const projectedPaths = projection.changedAssets.map((asset) => asset.path).sort();
        if (
          canonicalJson([...changedPaths].sort()) !== canonicalJson(projectedPaths)
          || projectedPaths.some((path) => !input.mutableTargets.some((target) => pathMatchesTarget(path, target)))
        ) {
          failures.add("EVOLUTION_CANDIDATE_STALE");
        }
        const changedAssets = await Promise.all(projectedPaths.map((path) => inspectAsset(candidateRoot, path)));
        if (changedAssets.some((asset) => asset.kind !== "file")) failures.add("EVOLUTION_CANDIDATE_STALE");
        for (const projected of projection.changedAssets) {
          if (changedAssets.find((asset) => asset.path === projected.path)?.sha256 !== projected.sha256) {
            failures.add("EVOLUTION_CANDIDATE_STALE");
          }
        }
        const snapshot: EvolutionCandidateSnapshot = {
          baseCommit,
          candidateCommit,
          patchHash: sha256(canonicalJson({
            baseCommit,
            candidateCommit,
            changedAssets: changedAssets.map(({ path, sha256, kind, size }) => ({ path, sha256, kind, size })),
          })),
          changedAssets,
        };
        if (
          snapshot.patchHash !== projection.hashes.patch
          || candidateArtifactHash(snapshot) !== projection.hashes.candidateArtifact
        ) {
          failures.add("EVOLUTION_CANDIDATE_STALE");
        }

        const protectedAssets = [...new Set([
          ...input.evaluator.assets,
          ...input.policyAssets,
          ...input.suite.assets,
        ])].sort();
        const protectedSnapshot = {
          entries: await Promise.all(protectedAssets.map((asset) => inspectAsset(candidateRoot, asset))),
        };
        const evaluatorHash = metadataHash({
          definition: input.evaluator,
          assets: protectedGroupHash(protectedSnapshot.entries, input.evaluator.assets),
        });
        const policyHash = protectedGroupHash(protectedSnapshot.entries, input.policyAssets);
        const suiteHash = metadataHash({
          definition: input.suite,
          assets: protectedGroupHash(protectedSnapshot.entries, input.suite.assets),
        });
        if (evaluatorHash !== projection.hashes.evaluator) failures.add("EVOLUTION_EVALUATOR_ASSET_MUTATED");
        if (policyHash !== projection.hashes.policy) failures.add("EVOLUTION_POLICY_ASSET_MUTATED");
        if (suiteHash !== projection.hashes.suite) failures.add("EVOLUTION_BENCHMARK_ASSET_MUTATED");
        if (metadataHash(input.suite.thresholds) !== projection.comparison?.thresholdsHash) {
          failures.add("EVOLUTION_THRESHOLDS_MUTATED");
        }
      } catch {
        failures.add("EVOLUTION_CANDIDATE_STALE");
      }

      const isolation = context.isolation;
      const checkedAt = canonicalNow(now);
      const attestedAtMs = Date.parse(isolation.timestamp);
      const checkedAtMs = Date.parse(checkedAt);
      if (
        isolation.attestorId !== input.attestorId
        || isolation.candidateId !== projection.candidateId
        || isolation.candidateBranch !== branch
        || isolation.candidateWorktree !== worktree
        || !CANONICAL_UTC_MILLISECONDS.test(isolation.timestamp)
        || !Number.isFinite(attestedAtMs)
        || attestedAtMs > checkedAtMs
      ) {
        failures.add("INVALID_ISOLATION_ATTESTATION");
      } else if (checkedAtMs - attestedAtMs > input.maxAttestationAgeMs) {
        failures.add("STALE_ISOLATION_ATTESTATION");
      }
      return [...failures];
    },

    async resolveBase({ runId, workspaceRoot, snapshotTargets }) {
      const root = await requireRepositoryRoot(workspaceRoot, workspaceRoot);
      const head = await git(root, ["rev-parse", "HEAD"]);
      const branch = await currentBranch(root, head);
      const baseCommit = await createImmutableBaseCommit(root, runId, head, snapshotTargets);
      const paths = evolutionWorktreePaths(root, runId);
      return {
        baseCommit,
        baseBranch: branch,
        baseWorktree: paths.baseline,
        hostCurrentBranch: branch,
        hostCurrentWorktree: root,
      };
    },

    async prepareCandidate({ runId, workspaceRoot, candidateId, branch, base }) {
      const root = await requireRepositoryRoot(workspaceRoot, workspaceRoot);
      const paths = evolutionWorktreePaths(root, runId);
      await mkdir(paths.root, { recursive: true, mode: 0o700 });
      await ensureWorktree(root, paths.baseline, base.baseCommit, undefined);
      await ensureWorktree(root, paths.candidate, base.baseCommit, branch);
      return {
        candidateId,
        branch,
        worktree: paths.candidate,
        baselineWorktree: paths.baseline,
        resources: [
          { kind: "branch", identity: branch },
          { kind: "worktree", identity: paths.candidate },
          { kind: "baseline-worktree", identity: paths.baseline },
        ],
      };
    },

    async snapshotProtectedAssets({ candidate, assets }) {
      const entries = await Promise.all(assets.map((asset) => inspectAsset(candidate.worktree, asset)));
      return { entries };
    },

    runCreator: options.runCreator,

    async inspectCandidate({ candidate, base }) {
      return inspectCandidateSnapshot(candidate, base);
    },

    async sealCandidate({ candidate, changedAssets }) {
      const paths = [...new Set(changedAssets.map((entry) => entry.path))].sort();
      if (paths.length === 0) throw new Error("Cannot seal an empty evolution candidate.");
      await git(candidate.worktree, ["add", "-A", "--", ...paths]);
      const staged = await gitRaw(candidate.worktree, ["diff", "--cached", "--name-only", "-z"]);
      if (splitNul(staged).length === 0) {
        throw new Error("Candidate changes were not representable in the isolated Git commit.");
      }
      await git(candidate.worktree, [
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--no-gpg-sign",
        "-m",
        `UncleCode evolution ${candidate.candidateId}`,
      ], {
        GIT_AUTHOR_NAME: "UncleCode Evolution",
        GIT_AUTHOR_EMAIL: "evolution@unclecode.local",
        GIT_COMMITTER_NAME: "UncleCode Evolution",
        GIT_COMMITTER_EMAIL: "evolution@unclecode.local",
      });
    },

    runEvaluator: options.runEvaluator,

    async resolveIsolation({ workspaceRoot, base, candidate }) {
      const root = await requireRepositoryRoot(workspaceRoot, workspaceRoot);
      const branchExists = await gitSucceeds(root, ["show-ref", "--verify", `refs/heads/${candidate.branch}`]);
      const worktrees = await listWorktrees(root);
      const worktreeExists = worktrees.some((entry) => entry.path === candidate.worktree
        && entry.branch === `refs/heads/${candidate.branch}`);
      return {
        candidateId: candidate.candidateId,
        candidateBranch: candidate.branch,
        candidateWorktree: candidate.worktree,
        branchExists,
        worktreeExists,
        baseBranch: base.baseBranch,
        baseWorktree: base.baseWorktree,
        hostCurrentBranch: base.hostCurrentBranch,
        hostCurrentWorktree: base.hostCurrentWorktree,
        attestorId: "unclecode-git-attestor",
        timestamp: canonicalNow(now),
      };
    },

    async cleanup({ workspaceRoot, candidate, resources, retainCandidate, reason }) {
      return cleanupCandidate(workspaceRoot, candidate, resources, retainCandidate, reason);
    },

    async record({ result }) {
      const root = await requireRepositoryRoot(options.workspaceRoot, options.workspaceRoot);
      const recordPath = evolutionArtifactPath(root, result.projection.runId);
      const body = `${JSON.stringify({ version: 1, result }, null, 2)}\n`;
      if (Buffer.byteLength(body) > MAX_RECORD_BYTES) {
        throw new Error("Evolution proposal record exceeds its metadata bound.");
      }
      await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
      const temporary = `${recordPath}.tmp-${process.pid}`;
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, recordPath);
      try {
        options.recordAgentOps?.(result);
      } catch {
        // AgentOps is observability; the session-owned artifact is authoritative.
      }
    },
  };
}

async function createImmutableBaseCommit(
  root: string,
  runId: string,
  head: string,
  snapshotTargets: readonly string[],
): Promise<string> {
  const safeRun = safeIdentity(runId);
  const indexRoot = join(root, ".unclecode", "evolution-indexes");
  const indexPath = join(indexRoot, `${safeRun}.index`);
  await mkdir(indexRoot, { recursive: true, mode: 0o700 });
  await rm(indexPath, { force: true });
  const indexEnvironment = { GIT_INDEX_FILE: indexPath };
  try {
    await git(root, ["read-tree", head], indexEnvironment);
    await git(root, ["add", "-A", "--", ...snapshotTargets], indexEnvironment);
    const tree = await git(root, ["write-tree"], indexEnvironment);
    const headTree = await git(root, ["rev-parse", `${head}^{tree}`]);
    if (tree === headTree) return head;
    return git(root, ["commit-tree", tree, "-p", head, "-m", `UncleCode immutable evolution base ${safeRun}`], {
      ...indexEnvironment,
      GIT_AUTHOR_NAME: "UncleCode Evolution",
      GIT_AUTHOR_EMAIL: "evolution@unclecode.local",
      GIT_COMMITTER_NAME: "UncleCode Evolution",
      GIT_COMMITTER_EMAIL: "evolution@unclecode.local",
    });
  } finally {
    await rm(indexPath, { force: true });
  }
}

async function inspectCandidateSnapshot(
  candidate: PreparedEvolutionCandidate,
  base: EvolutionRepositoryIdentity,
): Promise<EvolutionCandidateSnapshot> {
  const [baselineTree, candidateTree] = await Promise.all([
    scanTree(candidate.baselineWorktree),
    scanTree(candidate.worktree),
  ]);
  const changedPaths = new Set<string>();
  for (const path of new Set([...baselineTree.keys(), ...candidateTree.keys()])) {
    if (baselineTree.get(path)?.fingerprint !== candidateTree.get(path)?.fingerprint) {
      changedPaths.add(path);
    }
  }
  const gitChanged = await gitRaw(candidate.worktree, ["diff", "--name-only", "-z", base.baseCommit]);
  const untracked = await gitRaw(candidate.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const path of [...splitNul(gitChanged), ...splitNul(untracked)]) changedPaths.add(path);
  const changedAssets = [...changedPaths].sort().map((path) =>
    candidateTree.get(path) ?? missingAsset(path));
  const candidateCommit = await git(candidate.worktree, ["rev-parse", "HEAD"]);
  return {
    baseCommit: base.baseCommit,
    candidateCommit,
    patchHash: sha256(canonicalJson({
      baseCommit: base.baseCommit,
      candidateCommit,
      changedAssets: changedAssets.map(({ path, sha256, kind, size }) => ({ path, sha256, kind, size })),
    })),
    changedAssets: changedAssets.map(({ fingerprint: _fingerprint, ...entry }) => entry),
  };
}

async function scanTree(root: string): Promise<Map<string, TreeEntry>> {
  const output = new Map<string, TreeEntry>();
  let visited = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (prefix.length === 0 && entry.name === ".git") continue;
      visited += 1;
      if (visited > MAX_TREE_ENTRIES) throw new Error("Evolution candidate tree exceeds its scan bound.");
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      output.set(relativePath, await digestEntry(absolutePath, relativePath, stats));
    }
  };
  await visit(root, "");
  return output;
}

async function inspectAsset(root: string, relativePath: string): Promise<EvolutionAssetDigest> {
  if (!isSafeRelativePath(relativePath)) return missingAsset(relativePath);
  const absolutePath = resolve(root, ...relativePath.split("/"));
  if (!isContained(root, absolutePath)) return missingAsset(relativePath);
  try {
    let current = root;
    for (const segment of relativePath.split("/")) {
      current = join(current, segment);
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        return { path: relativePath, sha256: sha256(`symlink:${relativePath}`), kind: "symlink", size: stats.size };
      }
    }
    const stats = await lstat(absolutePath);
    const entry = await digestEntry(absolutePath, relativePath, stats);
    return { path: entry.path, sha256: entry.sha256, kind: entry.kind, size: entry.size };
  } catch {
    return missingAsset(relativePath);
  }
}

async function digestEntry(
  absolutePath: string,
  relativePath: string,
  stats: Awaited<ReturnType<typeof lstat>>,
): Promise<TreeEntry> {
  const size = Number(stats.size);
  if (stats.isSymbolicLink()) {
    const digest = sha256(`symlink:${relativePath}:${size}`);
    return { path: relativePath, sha256: digest, kind: "symlink", size, fingerprint: digest };
  }
  if (!stats.isFile()) {
    const digest = sha256(`special:${relativePath}:${stats.mode}:${size}`);
    return { path: relativePath, sha256: digest, kind: "special", size, fingerprint: digest };
  }
  if (size > MAX_HASHED_FILE_BYTES) {
    const digest = sha256(`unreadable:${relativePath}:${size}:${stats.mtimeMs}`);
    return { path: relativePath, sha256: digest, kind: "unreadable", size, fingerprint: digest };
  }
  try {
    const contents = await readFile(absolutePath);
    const digest = sha256(contents);
    return { path: relativePath, sha256: digest, kind: "file", size: contents.byteLength, fingerprint: digest };
  } catch {
    const digest = sha256(`unreadable:${relativePath}:${size}`);
    return { path: relativePath, sha256: digest, kind: "unreadable", size, fingerprint: digest };
  }
}

function missingAsset(path: string): TreeEntry {
  const digest = sha256(`missing:${path}`);
  return { path, sha256: digest, kind: "unreadable", size: 0, fingerprint: digest };
}

async function cleanupCandidate(
  workspaceRoot: string,
  candidate: PreparedEvolutionCandidate,
  resources: readonly EvolutionCleanupResource[],
  retainCandidate: boolean,
  reason: string,
): Promise<EvolutionCleanupProjection> {
  const root = await requireRepositoryRoot(workspaceRoot, workspaceRoot);
  const failures = new Set<string>();
  const statuses = new Map<string, "removed" | "retained" | "cleanup-failed">();
  const removeWorktree = async (path: string): Promise<void> => {
    if (!(await pathExists(path))) {
      statuses.set(path, "removed");
      return;
    }
    try {
      await git(root, ["worktree", "remove", "--force", path]);
      statuses.set(path, "removed");
    } catch {
      statuses.set(path, "cleanup-failed");
      failures.add(path);
    }
  };
  await removeWorktree(candidate.baselineWorktree);
  if (retainCandidate) {
    statuses.set(candidate.worktree, "retained");
    statuses.set(candidate.branch, "retained");
  } else {
    await removeWorktree(candidate.worktree);
    if (await gitSucceeds(root, ["show-ref", "--verify", `refs/heads/${candidate.branch}`])) {
      try {
        await git(root, ["branch", "-D", candidate.branch]);
        statuses.set(candidate.branch, "removed");
      } catch {
        statuses.set(candidate.branch, "cleanup-failed");
        failures.add(candidate.branch);
      }
    } else {
      statuses.set(candidate.branch, "removed");
    }
  }
  return {
    status: failures.size > 0 ? "failed" : retainCandidate ? "retained" : "completed",
    resources: resources.map((resource) => ({
      ...resource,
      status: statuses.get(resource.identity) ?? "removed",
    })),
    ...(failures.size > 0
      ? { summary: `Cleanup failed for ${failures.size} retained resource(s): ${reason.slice(0, 240)}` }
      : {}),
  };
}

async function ensureWorktree(
  root: string,
  path: string,
  commit: string,
  branch: string | undefined,
): Promise<void> {
  if (await pathExists(path)) {
    const worktreeRoot = await requireRepositoryRoot(path, root);
    const actualCommit = await git(worktreeRoot, ["rev-parse", "HEAD"]);
    const actualBranch = await currentBranch(worktreeRoot, actualCommit);
    if (actualCommit !== commit || (branch !== undefined && actualBranch !== branch)) {
      throw new Error(`Existing evolution worktree identity mismatch: ${path}`);
    }
    return;
  }
  if (branch === undefined) {
    await git(root, ["worktree", "add", "--detach", path, commit]);
    return;
  }
  const branchRef = `refs/heads/${branch}`;
  if (await gitSucceeds(root, ["show-ref", "--verify", branchRef])) {
    const branchCommit = await git(root, ["rev-parse", branchRef]);
    if (branchCommit !== commit) throw new Error(`Existing evolution branch identity mismatch: ${branch}`);
    await git(root, ["worktree", "add", path, branch]);
    return;
  }
  await git(root, ["worktree", "add", "-b", branch, path, commit]);
}

async function listWorktrees(root: string): Promise<readonly { readonly path: string; readonly branch?: string }[]> {
  const output = await git(root, ["worktree", "list", "--porcelain"]);
  const entries: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

async function requireRepositoryRoot(cwd: string, expectedRoot: string): Promise<string> {
  const top = await git(resolve(cwd), ["rev-parse", "--show-toplevel"]);
  const [actual, expected] = await Promise.all([realpath(top), realpath(expectedRoot)]);
  if (actual !== expected && !isContained(expected, actual) && !isContained(actual, expected)) {
    throw new Error("Evolution path does not belong to the requested Git repository.");
  }
  return actual;
}

async function currentBranch(root: string, head: string): Promise<string> {
  try {
    return await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    return `detached:${head.slice(0, 12)}`;
  }
}

async function git(
  cwd: string,
  args: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<string> {
  return (await gitRaw(cwd, args, extraEnvironment)).trim();
}

async function gitRaw(
  cwd: string,
  args: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<string> {
  const { stdout } = await execFile("git", [...args], {
    cwd,
    env: { ...process.env, ...extraEnvironment },
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT,
    timeout: 30_000,
    windowsHide: true,
  });
  return stdout;
}

async function gitSucceeds(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function evolutionWorktreePaths(root: string, runId: string): {
  readonly root: string;
  readonly baseline: string;
  readonly candidate: string;
} {
  const worktreeRoot = join(root, ".unclecode", "evolution-worktrees", safeIdentity(runId));
  return {
    root: worktreeRoot,
    baseline: join(worktreeRoot, "baseline"),
    candidate: join(worktreeRoot, "candidate"),
  };
}

function evolutionArtifactPath(root: string, runId: string): string {
  return join(root, ".unclecode", "artifacts", safeIdentity(runId), "evolution-proposal.json");
}

function safeIdentity(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return safe || "evolution-run";
}

function splitNul(value: string): readonly string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function pathMatchesTarget(path: string, target: string): boolean {
  const normalizedTarget = target.endsWith("/") ? target.slice(0, -1) : target;
  return path === normalizedTarget || path.startsWith(`${normalizedTarget}/`);
}

function protectedGroupHash(entries: readonly EvolutionAssetDigest[], assets: readonly string[]): string {
  return metadataHash(entries
    .filter((entry) => assets.includes(entry.path))
    .map(({ path, sha256, kind, size }) => ({ path, sha256, kind, size }))
    .sort((left, right) => left.path.localeCompare(right.path)));
}

function candidateArtifactHash(snapshot: EvolutionCandidateSnapshot): string {
  return metadataHash({
    baseCommit: snapshot.baseCommit,
    candidateCommit: snapshot.candidateCommit,
    patchHash: snapshot.patchHash,
    changedAssets: snapshot.changedAssets
      .map(({ path, sha256 }) => ({ path, sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
}

function metadataHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0
    && !value.includes("\\")
    && !value.includes("\0")
    && !value.startsWith("/")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Unsupported canonical Git host metadata.");
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Evolution Git host clock returned an invalid date.");
  }
  return value.toISOString();
}
