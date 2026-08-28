import { AsyncLocalStorage } from "node:async_hooks";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
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
  EvolutionCreatorEditResult,
  EvolutionRepositoryIdentity,
  PreparedEvolutionCandidate,
} from "./evolution-runtime.js";

const execFile = promisify(execFileCallback);
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 50_000;
const MAX_HASHED_FILE_BYTES = 8 * 1024 * 1024;
const PREPARATION_LOCK_TIMEOUT_MS = 30_000;
const PREPARATION_LOCK_RETRY_MS = 20;
const INCOMPLETE_LOCK_GRACE_MS = 5_000;
const CANONICAL_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type CreateGitCreatorEvolutionHostInput = {
  readonly workspaceRoot: string;
  readonly generateCreatorEdits: (input: {
    readonly runId: string;
    readonly prompt: string;
    readonly creatorId: string;
    readonly mutableTargets: readonly string[];
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal: AbortSignal;
  }) => Promise<EvolutionCreatorEditResult>;
  readonly runEvaluator: CreatorEvolutionHost["runEvaluator"];
  readonly recordAgentOps?: ((result: CreatorEvolutionResult) => void) | undefined;
  readonly onPreparationCheckpoint?: ((checkpoint: {
    readonly kind: EvolutionCleanupResource["kind"];
    readonly identity: string;
  }) => void | Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
};

type TreeEntry = EvolutionAssetDigest & { readonly fingerprint: string };
type PreparationResource = EvolutionCleanupResource & {
  status: "planned" | "acquiring" | "acquired";
};
type PreparationJournal = {
  readonly version: 1;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly candidateId: string;
  readonly baseCommit: string;
  readonly branch: string;
  readonly resources: PreparationResource[];
};

/**
 * Concrete local-Git boundary for the evolution service. It uses only local
 * branches/worktrees and Git plumbing; no remote, merge, publish, or checkout
 * of the operator's current worktree is reachable from this adapter.
 */
export function createGitCreatorEvolutionHost(
  options: CreateGitCreatorEvolutionHostInput,
): CreatorEvolutionHost {
  const now = options.now ?? (() => new Date());
  const lockContext = new AsyncLocalStorage<ReadonlySet<string>>();
  const withRunLock = async <T>(root: string, runId: string, operation: () => Promise<T>): Promise<T> => {
    const lockPath = evolutionPreparationLockPath(root, runId);
    if (lockContext.getStore()?.has(lockPath)) return operation();
    const lease = await acquirePreparationLock(lockPath);
    const held = new Set(lockContext.getStore() ?? []);
    held.add(lockPath);
    return lockContext.run(held, async () => {
      try {
        return await operation();
      } finally {
        await lease.release();
      }
    });
  };
  return {
    async withLifecycleLock(input, operation) {
      const root = await requireRepositoryRoot(input.workspaceRoot, options.workspaceRoot);
      return withRunLock(root, input.runId, operation);
    },

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
        await rm(evolutionPreparationPath(workspaceRoot, runId), { force: true });
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
        || projection.hashes.evaluatorEnvironment !== input.evaluatorEnvironmentHash
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
          || proposal.validationEvidence.length !== 1
          || proposal.validationEvidence[0]?.artifactHash
            !== evaluationEvidenceArtifactHash(snapshot, input.evaluatorEnvironmentHash)
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
      await assertSafeGitBoundary(root, head);
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
      return withRunLock(root, runId, async () => {
        const paths = evolutionWorktreePaths(root, runId);
        const journalPath = evolutionPreparationPath(root, runId);
        const expectedResources: PreparationResource[] = [
          { kind: "branch", identity: branch, status: "planned" },
          { kind: "worktree", identity: paths.candidate, status: "planned" },
          { kind: "baseline-worktree", identity: paths.baseline, status: "planned" },
        ];
        const loaded = await loadPreparationJournal(journalPath);
        const existing = loaded.status === "valid" ? loaded.journal : undefined;
        const expectedJournal = {
          runId,
          workspaceRoot: root,
          candidateId,
          baseCommit: base.baseCommit,
          branch,
          resources: expectedResources,
        };
        if (!existing || !preparationJournalMatches(existing, expectedJournal)
          || !(await preparationResourcesMatch(root, paths, branch, base.baseCommit))) {
          if (existing) {
            const prior = validatePreparationJournalResources(root, runId, existing);
            await removePreparationResources(root, prior.paths, prior.branch);
          } else {
            await recoverDeterministicPreparationResources(root, paths);
          }
        }
        const journal: PreparationJournal = {
          version: 1,
          ...expectedJournal,
        };
        await writePreparationJournal(journalPath, journal);
        const acquire = async (
          kind: EvolutionCleanupResource["kind"],
          acquireResource: () => Promise<void>,
        ): Promise<void> => {
          const resource = journal.resources.find((entry) => entry.kind === kind);
          if (!resource) throw new Error(`Evolution preparation journal omitted ${kind}.`);
          resource.status = "acquiring";
          await writePreparationJournal(journalPath, journal);
          await options.onPreparationCheckpoint?.({ kind, identity: resource.identity });
          await acquireResource();
          resource.status = "acquired";
          await writePreparationJournal(journalPath, journal);
        };
        try {
          await mkdir(paths.root, { recursive: true, mode: 0o700 });
          await acquire("baseline-worktree", () => ensureWorktree(root, paths.baseline, base.baseCommit, undefined));
          await acquire("branch", () => ensureBranch(root, branch, base.baseCommit));
          await acquire("worktree", () => ensureWorktree(root, paths.candidate, base.baseCommit, branch));
          return {
            candidateId,
            branch,
            worktree: paths.candidate,
            baselineWorktree: paths.baseline,
            resources: expectedResources.map(({ kind, identity }) => ({ kind, identity })),
          };
        } catch (error) {
          try {
            await removePreparationResources(root, paths, branch);
            await rm(journalPath, { force: true });
          } catch {
            // Keep the journal when cleanup cannot complete so the next retry can recover it.
          }
          throw error;
        }
      });
    },

    async snapshotProtectedAssets({ candidate, assets }) {
      const entries = await Promise.all(assets.map((asset) => inspectAsset(candidate.worktree, asset)));
      return { entries };
    },

    async runCreator(request) {
      const generated = await options.generateCreatorEdits({
        runId: request.runId,
        prompt: request.prompt,
        creatorId: request.creatorId,
        mutableTargets: request.mutableTargets,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        signal: request.signal,
      });
      if (generated.status !== "completed") return generated;
      await applyCreatorEdits(
        request.candidate.worktree,
        request.mutableTargets,
        generated.edits,
        request.maxOutputBytes,
        request.signal,
      );
      return { status: "completed", summary: generated.summary };
    },

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

    async cleanup({ runId, workspaceRoot, candidate, resources, retainCandidate, reason }) {
      const root = await requireRepositoryRoot(workspaceRoot, options.workspaceRoot);
      return withRunLock(root, runId, () => cleanupCandidate(
        runId,
        workspaceRoot,
        candidate,
        resources,
        retainCandidate,
        reason,
      ));
    },

    async record({ result }) {
      const root = await requireRepositoryRoot(options.workspaceRoot, options.workspaceRoot);
      return withRunLock(root, result.projection.runId, async () => {
        const recordPath = evolutionArtifactPath(root, result.projection.runId);
        const body = `${JSON.stringify({ version: 1, result }, null, 2)}\n`;
        if (Buffer.byteLength(body) > MAX_RECORD_BYTES) {
          throw new Error("Evolution proposal record exceeds its metadata bound.");
        }
        await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
        const temporary = `${recordPath}.tmp-${process.pid}-${randomUUID()}`;
        try {
          await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
          await rename(temporary, recordPath);
        } finally {
          await rm(temporary, { force: true });
        }
        await rm(evolutionPreparationPath(root, result.projection.runId), { force: true });
        try {
          options.recordAgentOps?.(result);
        } catch {
          // AgentOps is observability; the session-owned artifact is authoritative.
        }
      });
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

async function applyCreatorEdits(
  candidateRoot: string,
  mutableTargets: readonly string[],
  edits: readonly { readonly path: string; readonly content: string }[],
  maximumBytes: number,
  signal: AbortSignal,
): Promise<void> {
  if (edits.length === 0 || edits.length > 64) {
    throw new Error("Creator edit count is outside the host bound.");
  }
  const root = await realpath(candidateRoot);
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const edit of edits) {
    signal.throwIfAborted();
    if (
      !isSafeRelativePath(edit.path)
      || !mutableTargets.some((target) => pathMatchesTarget(edit.path, target))
      || seen.has(edit.path)
    ) {
      throw new Error(`Creator edit is outside the mutable target allowlist: ${edit.path}`);
    }
    seen.add(edit.path);
    const contents = Buffer.from(edit.content, "utf8");
    totalBytes += contents.byteLength;
    if (totalBytes > maximumBytes) throw new Error("Creator edits exceed the host output bound.");
    const absolute = resolve(root, ...edit.path.split("/"));
    if (!isContained(root, absolute)) throw new Error("Creator edit escaped the candidate worktree.");
    await ensureSafeParentDirectories(root, dirname(absolute));
    try {
      const stats = await lstat(absolute);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Creator edit target is not a regular file: ${edit.path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handle = await open(
      absolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function ensureSafeParentDirectories(root: string, directory: string): Promise<void> {
  const relativeDirectory = relative(root, directory);
  if (!relativeDirectory || relativeDirectory === ".") return;
  if (!isContained(root, directory)) throw new Error("Creator edit parent escaped the candidate worktree.");
  let current = root;
  for (const segment of relativeDirectory.split(sep)) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Creator edit parent is unsafe: ${relative(root, current)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
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
  runId: string,
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
  const projection: EvolutionCleanupProjection = {
    status: failures.size > 0 ? "failed" : retainCandidate ? "retained" : "completed",
    resources: resources.map((resource) => ({
      ...resource,
      status: statuses.get(resource.identity) ?? "removed",
    })),
    ...(failures.size > 0
      ? { summary: `Cleanup failed for ${failures.size} retained resource(s): ${reason.slice(0, 240)}` }
      : {}),
  };
  if (!retainCandidate && failures.size === 0) {
    await rm(evolutionPreparationPath(root, runId), { force: true });
  }
  return projection;
}

async function ensureBranch(root: string, branch: string, commit: string): Promise<void> {
  const branchRef = `refs/heads/${branch}`;
  if (await gitSucceeds(root, ["show-ref", "--verify", branchRef])) {
    const branchCommit = await git(root, ["rev-parse", branchRef]);
    if (branchCommit !== commit) throw new Error(`Existing evolution branch identity mismatch: ${branch}`);
    return;
  }
  await git(root, ["branch", branch, commit]);
}

async function preparationResourcesMatch(
  root: string,
  paths: ReturnType<typeof evolutionWorktreePaths>,
  branch: string,
  commit: string,
): Promise<boolean> {
  try {
    if (await pathExists(paths.baseline)) {
      const baselineRoot = await requireRepositoryRoot(paths.baseline, root);
      if (await git(baselineRoot, ["rev-parse", "HEAD"]) !== commit) return false;
    }
    const branchRef = `refs/heads/${branch}`;
    if (await gitSucceeds(root, ["show-ref", "--verify", branchRef])) {
      if (await git(root, ["rev-parse", branchRef]) !== commit) return false;
    }
    if (await pathExists(paths.candidate)) {
      const candidateRoot = await requireRepositoryRoot(paths.candidate, root);
      if (
        await git(candidateRoot, ["rev-parse", "HEAD"]) !== commit
        || await currentBranch(candidateRoot, commit) !== branch
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function removePreparationResources(
  root: string,
  paths: ReturnType<typeof evolutionWorktreePaths>,
  branch: string | undefined,
): Promise<void> {
  if (branch !== undefined && !isSafeEvolutionBranch(branch)) {
    throw new Error("Evolution preparation branch identity is unsafe.");
  }
  for (const worktree of [paths.candidate, paths.baseline]) {
    if (!(await pathExists(worktree))) continue;
    await assertSafePreparationWorktree(root, paths.root, worktree);
    try {
      await git(root, ["worktree", "remove", "--force", worktree]);
    } catch {
      await rm(worktree, { recursive: true, force: true });
      await git(root, ["worktree", "prune"]);
    }
  }
  if (branch && await gitSucceeds(root, ["show-ref", "--verify", `refs/heads/${branch}`])) {
    await git(root, ["branch", "-D", branch]);
  }
}

type LoadedPreparationJournal =
  | { readonly status: "missing" | "corrupt" }
  | { readonly status: "valid"; readonly journal: PreparationJournal };

async function loadPreparationJournal(path: string): Promise<LoadedPreparationJournal> {
  try {
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) throw new Error("Evolution preparation journal is oversized.");
    const parsed = JSON.parse(raw) as Partial<PreparationJournal>;
    if (
      parsed.version !== 1
      || typeof parsed.runId !== "string"
      || typeof parsed.workspaceRoot !== "string"
      || typeof parsed.candidateId !== "string"
      || typeof parsed.baseCommit !== "string"
      || typeof parsed.branch !== "string"
      || !Array.isArray(parsed.resources)
      || parsed.resources.length !== 3
      || parsed.resources.some((resource) =>
        !resource
        || !["branch", "worktree", "baseline-worktree"].includes(resource.kind)
        || typeof resource.identity !== "string"
        || !["planned", "acquiring", "acquired"].includes(resource.status))
    ) {
      throw new Error("Evolution preparation journal is invalid.");
    }
    return { status: "valid", journal: parsed as PreparationJournal };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt" };
  }
}

function validatePreparationJournalResources(
  root: string,
  requestedRunId: string,
  journal: PreparationJournal,
): { readonly paths: ReturnType<typeof evolutionWorktreePaths>; readonly branch: string } {
  if (journal.workspaceRoot !== root || journal.runId !== requestedRunId
    || !isSafeEvolutionBranch(journal.branch)
    || journal.branch !== `unclecode/evolve/${journal.candidateId}`) {
    throw new Error("Evolution preparation journal identity is unsafe.");
  }
  const paths = evolutionWorktreePaths(root, journal.runId);
  const expected: Array<Pick<EvolutionCleanupResource, "kind" | "identity">> = [
    { kind: "branch", identity: journal.branch },
    { kind: "worktree", identity: paths.candidate },
    { kind: "baseline-worktree", identity: paths.baseline },
  ];
  expected.sort(compareResources);
  const actual: Array<Pick<EvolutionCleanupResource, "kind" | "identity">> = journal.resources
    .map(({ kind, identity }) => ({ kind, identity }));
  actual.sort(compareResources);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("Evolution preparation journal resource identity is unsafe.");
  }
  return { paths, branch: journal.branch };
}

async function recoverDeterministicPreparationResources(
  root: string,
  paths: ReturnType<typeof evolutionWorktreePaths>,
): Promise<void> {
  const entries = await listWorktrees(root);
  const candidateEntry = entries.find((entry) => resolve(entry.path) === paths.candidate);
  const baselineEntry = entries.find((entry) => resolve(entry.path) === paths.baseline);
  if (baselineEntry?.branch !== undefined) {
    throw new Error("Deterministic baseline worktree unexpectedly owns a branch.");
  }
  let checkedOutBranch: string | undefined;
  if (candidateEntry?.branch !== undefined) {
    if (!candidateEntry.branch.startsWith("refs/heads/")) {
      throw new Error("Deterministic candidate worktree has an unsafe branch identity.");
    }
    checkedOutBranch = candidateEntry.branch.slice("refs/heads/".length);
    if (!isSafeEvolutionBranch(checkedOutBranch)) {
      throw new Error("Deterministic candidate worktree has an unsafe branch identity.");
    }
  }
  await removePreparationResources(root, paths, checkedOutBranch);
}

async function assertSafePreparationWorktree(root: string, worktreeRoot: string, worktree: string): Promise<void> {
  if (!isContained(root, worktreeRoot) || !isContained(worktreeRoot, worktree)) {
    throw new Error("Evolution preparation worktree escapes its deterministic root.");
  }
  const stats = await lstat(worktree);
  if (stats.isSymbolicLink()) throw new Error("Evolution preparation worktree cannot be a symbolic link.");
  const actual = await realpath(worktree);
  if (!isContained(root, actual) || !isContained(worktreeRoot, actual)) {
    throw new Error("Evolution preparation worktree resolves outside its deterministic root.");
  }
}

function isSafeEvolutionBranch(branch: string): boolean {
  return /^unclecode\/evolve\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(branch);
}

function preparationJournalMatches(
  actual: PreparationJournal,
  expected: Omit<PreparationJournal, "version">,
): boolean {
  return actual.runId === expected.runId
    && actual.workspaceRoot === expected.workspaceRoot
    && actual.candidateId === expected.candidateId
    && actual.baseCommit === expected.baseCommit
    && actual.branch === expected.branch
    && canonicalJson(actual.resources.map(({ kind, identity }) => ({ kind, identity })).sort(compareResources))
      === canonicalJson(expected.resources.map(({ kind, identity }) => ({ kind, identity })).sort(compareResources));
}

function compareResources(
  left: Pick<EvolutionCleanupResource, "kind" | "identity">,
  right: Pick<EvolutionCleanupResource, "kind" | "identity">,
): number {
  return `${left.kind}:${left.identity}`.localeCompare(`${right.kind}:${right.identity}`);
}

async function writePreparationJournal(path: string, journal: PreparationJournal): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  try {
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Some filesystems do not support directory fsync; the file itself is synced.
  }
}

type PreparationLockOwner = {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
};

async function acquirePreparationLock(lockPath: string): Promise<{ readonly release: () => Promise<void> }> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + PREPARATION_LOCK_TIMEOUT_MS;
  const owner: PreparationLockOwner = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };
  const ownerPath = join(lockPath, "owner.json");
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        const handle = await open(ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return {
        release: async (): Promise<void> => {
          let current: PreparationLockOwner | undefined;
          try {
            current = await readPreparationLockOwner(ownerPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          if (current?.token !== owner.token) {
            throw new Error("Evolution preparation lock ownership changed before release.");
          }
          const released = `${lockPath}.released-${owner.token}`;
          await rename(lockPath, released);
          await rm(released, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const current = await readPreparationLockOwner(ownerPath).catch(() => undefined);
    const stale = current ? !isProcessAlive(current.pid) : await incompleteLockIsStale(lockPath);
    if (stale) {
      const quarantine = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, quarantine);
        await rm(quarantine, { recursive: true, force: true });
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the evolution lifecycle lock.");
    await delay(PREPARATION_LOCK_RETRY_MS);
  }
}

async function readPreparationLockOwner(path: string): Promise<PreparationLockOwner> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PreparationLockOwner>;
  if (parsed.version !== 1 || !Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0
    || typeof parsed.token !== "string" || parsed.token.length > 128
    || !Number.isFinite(parsed.createdAt)) {
    throw new Error("Evolution preparation lock owner is invalid.");
  }
  return parsed as PreparationLockOwner;
}

async function incompleteLockIsStale(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await lstat(lockPath)).mtimeMs >= INCOMPLETE_LOCK_GRACE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
  const safeConfiguration = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.attributesFile=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "diff.external=",
    "-c", "submodule.recurse=false",
    "-c", "checkout.recurseSubmodules=false",
  ];
  const environment: NodeJS.ProcessEnv = { ...process.env, ...extraEnvironment };
  delete environment.GIT_CONFIG_PARAMETERS;
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) delete environment[key];
  }
  Object.assign(environment, {
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
  });
  const { stdout } = await execFile("git", [...safeConfiguration, ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT,
    timeout: 30_000,
    windowsHide: true,
  });
  return stdout;
}

async function assertSafeGitBoundary(root: string, head: string): Promise<void> {
  const attributeFiles = new Set<string>();
  let visited = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".unclecode") continue;
      visited += 1;
      if (visited > MAX_TREE_ENTRIES) {
        throw new Error("Evolution repository attribute scan exceeds its bound.");
      }
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.name === ".gitattributes") {
        const stats = await lstat(absolutePath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error(`Unsafe Git attribute source: ${relativePath}`);
        }
        attributeFiles.add(relativePath);
        assertSafeAttributeContents(await readFile(absolutePath, "utf8"), relativePath);
      }
    }
  };
  await visit(root, "");

  const tracked = splitNul(await gitRaw(root, ["ls-tree", "-r", "--name-only", "-z", head]));
  for (const path of tracked) {
    if (path.split("/").at(-1) !== ".gitattributes" || attributeFiles.has(path)) continue;
    const contents = await gitRaw(root, ["show", `${head}:${path}`]);
    assertSafeAttributeContents(contents, `${head}:${path}`);
  }

  const gitPath = (await git(root, ["rev-parse", "--git-path", "info/attributes"]));
  const infoAttributes = resolve(root, gitPath);
  if (await pathExists(infoAttributes)) {
    const stats = await lstat(infoAttributes);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Unsafe Git info attribute source.");
    }
    assertSafeAttributeContents(await readFile(infoAttributes, "utf8"), "info/attributes");
  }
}

function assertSafeAttributeContents(contents: string, source: string): void {
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const attributes = line.split(/\s+/u).slice(1);
    if (attributes.some((attribute) => /^(?:-|!)?(?:filter|diff|merge)(?:=|$)/iu.test(attribute))) {
      throw new Error(`Unsafe external Git driver attribute in ${source}.`);
    }
  }
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

function evolutionPreparationPath(root: string, runId: string): string {
  return join(root, ".unclecode", "artifacts", safeIdentity(runId), "evolution-preparation.json");
}

function evolutionPreparationLockPath(root: string, runId: string): string {
  return join(root, ".unclecode", "artifacts", safeIdentity(runId), "evolution-lifecycle.lock");
}

function safeIdentity(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return safe || "evolution-run";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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

function evaluationEvidenceArtifactHash(
  snapshot: EvolutionCandidateSnapshot,
  evaluatorEnvironmentHash: string,
): string {
  return metadataHash({
    candidateArtifact: candidateArtifactHash(snapshot),
    evaluatorEnvironmentHash,
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
