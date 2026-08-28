import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CreatorEvolutionService,
  createGitCreatorEvolutionHost,
} from "@unclecode/orchestrator";
import { PluginHost, registerBuiltInSccQualityEngine } from "@unclecode/plugin-host";

const NOW = "2026-08-28T12:00:00.000Z";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function createRepository() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "uc-evolution-git-")));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "evolution@example.test"]);
  git(root, ["config", "user.name", "Evolution Test"]);
  mkdirSync(path.join(root, "skills"), { recursive: true });
  mkdirSync(path.join(root, "host"), { recursive: true });
  mkdirSync(path.join(root, "bench"), { recursive: true });
  writeFileSync(path.join(root, ".gitignore"), ".unclecode/\n");
  writeFileSync(path.join(root, "skills", "creator.md"), "creator v1\n");
  writeFileSync(path.join(root, "host", "evaluator.json"), "{\"version\":1}\n");
  writeFileSync(path.join(root, "bench", "held-out.json"), "{\"suite\":1}\n");
  writeFileSync(path.join(root, "AGENTS.md"), "policy v1\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  return root;
}

function config() {
  const environment = { locale: "C", timezone: "UTC", network: "disabled" };
  return {
    evaluator: {
      id: "git-held-out-evaluator",
      definition: "same immutable executable checks",
      version: "1.0.0",
      assets: ["host/evaluator.json"],
    },
    policyAssets: ["AGENTS.md"],
    evaluatorEnvironmentHash: sha(JSON.stringify(environment)),
    suite: {
      id: "git-held-out-suite",
      version: "1.0.0",
      assets: ["bench/held-out.json"],
      checks: [{ id: "content", weight: 1 }],
      thresholds: {
        minimumCandidateScore: 0.8,
        minimumDelta: 0.1,
        maximumRegression: 0,
      },
      environment,
    },
    attestorId: "unclecode-git-attestor",
    maxAttestationAgeMs: 300_000,
    bounds: {
      creatorTimeoutMs: 30_000,
      evaluatorTimeoutMs: 30_000,
      maxOutputBytes: 8_192,
      maxChangedAssets: 8,
    },
  };
}

function dispatch() {
  const plugins = new PluginHost();
  registerBuiltInSccQualityEngine(plugins, { workspaceRoot: process.cwd() });
  let count = 0;
  plugins.register("git-evolution-observer", {
    evolutionProposed() {
      count += 1;
      return { action: "proceed" };
    },
  });
  return {
    get count() { return count; },
    run: (event) => plugins.dispatchEvolutionProposed(event),
  };
}

test("the Git host creates one isolated local proposal, persists it, and never changes or pushes host-current state", async () => {
  const root = createRepository();
  const initialHead = git(root, ["rev-parse", "HEAD"]);
  const initialBranch = git(root, ["branch", "--show-current"]);
  writeFileSync(path.join(root, "skills", "creator.md"), "creator reviewed v1.1\n");
  writeFileSync(path.join(root, "AGENTS.md"), "current policy v1.1\n");
  const initialStatus = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const agentOps = [];
  const lifecycleDispatch = dispatch();
  const host = createGitCreatorEvolutionHost({
    workspaceRoot: root,
    now: () => new Date(NOW),
    async generateCreatorEdits(input) {
      assert.deepEqual(input.mutableTargets, ["skills/creator.md"]);
      assert.equal("candidate" in input, false, "the no-tools creator broker must not receive a host path");
      return {
        status: "completed",
        summary: "creator returned a bounded edit",
        edits: [{ path: "skills/creator.md", content: "creator v2\n" }],
      };
    },
    async runEvaluator(input) {
      assert.equal(readFileSync(path.join(input.baselineWorktree, "skills", "creator.md"), "utf8"), "creator reviewed v1.1\n");
      assert.equal(readFileSync(path.join(input.baselineWorktree, "AGENTS.md"), "utf8"), "current policy v1.1\n");
      assert.equal(readFileSync(path.join(input.candidateWorktree, "skills", "creator.md"), "utf8"), "creator v2\n");
      const check = (score) => [{ id: "content", status: "passed", score, durationMs: 1 }];
      return {
        status: "completed",
        environmentHash: sha(JSON.stringify(input.suite.environment)),
        baseline: { score: 0.7, summary: "baseline", checks: check(0.7) },
        candidate: { score: 0.9, summary: "candidate", checks: check(0.9) },
      };
    },
    recordAgentOps(result) {
      agentOps.push(result.projection);
    },
  });
  const service = new CreatorEvolutionService({
    config: config(),
    host,
    now: () => new Date(NOW),
  });

  try {
    const result = await service.run({
      runId: "git-run-1",
      workspaceRoot: root,
      prompt: "Create a stronger creator skill.",
      creatorId: "isolated-creator",
      mutableTargets: ["skills/creator.md"],
      dispatchEvolutionProposed: lifecycleDispatch.run,
      signal: new AbortController().signal,
    });

    assert.equal(result.status, "pr-ready");
    assert.equal(result.recorded, true);
    assert.equal(lifecycleDispatch.count, 1);
    assert.equal(agentOps.length, 1);
    assert.equal(result.projection.humanApproval, "pending");
    assert.equal(result.projection.cleanup.status, "retained");
    assert.equal(git(root, ["rev-parse", "HEAD"]), initialHead);
    assert.equal(git(root, ["branch", "--show-current"]), initialBranch);
    assert.equal(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), initialStatus);
    assert.equal(git(root, ["rev-parse", result.projection.isolatedBranch]), result.projection.hashes.candidateCommit);
    assert.equal(existsSync(result.projection.isolatedWorktree), true);
    assert.equal(
      result.projection.cleanup.resources.find((resource) => resource.kind === "baseline-worktree")?.status,
      "removed",
    );
    const artifact = JSON.parse(readFileSync(
      path.join(root, ".unclecode", "artifacts", "git-run-1", "evolution-proposal.json"),
      "utf8",
    ));
    assert.equal(artifact.result.projection.id, result.projection.id);
    assert.equal(artifact.result.projection.rawCandidateOutput, undefined);
    assert.equal(git(root, ["remote"]), "", "the host never configures or pushes a remote");

    writeFileSync(path.join(result.projection.isolatedWorktree, "skills", "creator.md"), "mutated after recording\n");
    const resumedService = new CreatorEvolutionService({
      config: config(),
      host,
      now: () => new Date(NOW),
    });
    const resumed = await resumedService.run({
      runId: "git-run-1",
      workspaceRoot: root,
      prompt: "Create a stronger creator skill.",
      creatorId: "isolated-creator",
      mutableTargets: ["skills/creator.md"],
      dispatchEvolutionProposed: lifecycleDispatch.run,
      signal: new AbortController().signal,
    });
    assert.equal(resumed.status, "stale");
    assert.ok(resumed.projection.failures.includes("EVOLUTION_CANDIDATE_STALE"));
    assert.equal(resumed.projection.cleanup.status, "completed");
    assert.equal(existsSync(result.projection.isolatedWorktree), false);
    assert.equal(
      git(root, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${result.projection.isolatedBranch}`]),
      "",
    );
    assert.equal(lifecycleDispatch.count, 1, "resume verification must not redispatch a recorded proposal");
  } finally {
    try {
      const worktrees = git(root, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
      for (const worktree of worktrees) {
        if (worktree !== root) git(root, ["worktree", "remove", "--force", worktree]);
      }
      for (const branch of git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/unclecode/evolve/"])
        .split("\n").filter(Boolean)) {
        git(root, ["branch", "-D", branch]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the host write API rejects creator path escapes and removes branch/worktree resources", async () => {
  const root = createRepository();
  const lifecycleDispatch = dispatch();
  const host = createGitCreatorEvolutionHost({
    workspaceRoot: root,
    now: () => new Date(NOW),
    async generateCreatorEdits() {
      return {
        status: "completed",
        summary: "creator attempted an escape",
        edits: [{ path: "../outside.txt", content: "escaped" }],
      };
    },
    async runEvaluator() {
      throw new Error("evaluator must not run for an unsafe candidate");
    },
  });
  const service = new CreatorEvolutionService({ config: config(), host, now: () => new Date(NOW) });

  try {
    const result = await service.run({
      runId: "git-run-unsafe",
      workspaceRoot: root,
      prompt: "Create a stronger creator skill.",
      creatorId: "isolated-creator",
      mutableTargets: ["skills"],
      dispatchEvolutionProposed: lifecycleDispatch.run,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "failed");
    assert.ok(result.projection.failures.includes("EVOLUTION_CREATOR_FAILED"));
    assert.equal(result.projection.cleanup.status, "completed");
    assert.equal(lifecycleDispatch.count, 0);
    assert.equal(existsSync(result.projection.isolatedWorktree), false);
    assert.equal(
      git(root, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${result.projection.isolatedBranch}`]),
      "",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe Git filter attributes fail closed before a clean filter can execute", async () => {
  const root = createRepository();
  const marker = path.join(root, "filter-executed.txt");
  git(root, ["config", "filter.evil.clean", `sh -c 'touch ${marker}; cat'`]);
  git(root, ["config", "filter.evil.smudge", "cat"]);
  writeFileSync(path.join(root, ".gitattributes"), "skills/creator.md filter=evil\n");
  const host = createGitCreatorEvolutionHost({
    workspaceRoot: root,
    now: () => new Date(NOW),
    async generateCreatorEdits() {
      return {
        status: "completed",
        summary: "creator edit",
        edits: [{ path: "skills/creator.md", content: "creator v2\n" }],
      };
    },
    async runEvaluator() {
      throw new Error("unsafe Git attributes must block before evaluation");
    },
  });
  try {
    const result = await new CreatorEvolutionService({ config: config(), host, now: () => new Date(NOW) }).run({
      runId: "git-run-filter",
      workspaceRoot: root,
      prompt: "Create a stronger creator skill.",
      creatorId: "isolated-creator",
      mutableTargets: ["skills/creator.md"],
      dispatchEvolutionProposed: dispatch().run,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "failed");
    assert.equal(existsSync(marker), false, "Git clean/smudge filters must never execute");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource acquisition is durably journaled before baseline, branch, and candidate creation", async () => {
  const root = createRepository();
  const runId = "git-run-journal";
  const candidateId = "candidate-journal";
  const branch = `unclecode/evolve/${candidateId}`;
  const journalPath = path.join(root, ".unclecode", "artifacts", runId, "evolution-preparation.json");
  const checkpoints = [];
  const host = createGitCreatorEvolutionHost({
    workspaceRoot: root,
    async onPreparationCheckpoint(checkpoint) {
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const resource = journal.resources.find((entry) => entry.kind === checkpoint.kind);
      assert.equal(resource.status, "acquiring");
      checkpoints.push(checkpoint.kind);
      if (checkpoint.kind === "branch") {
        assert.throws(() => git(root, ["show-ref", "--verify", `refs/heads/${branch}`]));
      } else {
        assert.equal(existsSync(checkpoint.identity), false);
      }
    },
    async generateCreatorEdits() {
      return { status: "failed", summary: "unused" };
    },
    async runEvaluator() {
      return { status: "failed", summary: "unused" };
    },
  });
  try {
    const base = await host.resolveBase({
      runId,
      workspaceRoot: root,
      snapshotTargets: ["skills/creator.md", "AGENTS.md", "host/evaluator.json", "bench/held-out.json"],
    });
    const candidate = await host.prepareCandidate({
      runId,
      workspaceRoot: root,
      candidateId,
      branch,
      base,
    });
    assert.deepEqual(checkpoints, ["baseline-worktree", "branch", "worktree"]);
    await host.cleanup({
      runId,
      workspaceRoot: root,
      candidate,
      resources: candidate.resources,
      retainCandidate: false,
      reason: "test cleanup",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retry adopts every journaled partial-preparation boundary deterministically", async (t) => {
  for (const phase of ["baseline-worktree", "branch", "worktree"]) {
    await t.test(phase, async () => {
      const root = createRepository();
      const runId = `git-run-retry-${phase}`;
      const candidateId = `candidate-retry-${phase}`;
      const branch = `unclecode/evolve/${candidateId}`;
      const baseHostOptions = {
        workspaceRoot: root,
        async generateCreatorEdits() {
          return { status: "failed", summary: "unused" };
        },
        async runEvaluator() {
          return { status: "failed", summary: "unused" };
        },
      };
      const recoveryHost = createGitCreatorEvolutionHost(baseHostOptions);
      let recovered;
      let recoveryStarted = false;
      const interruptedHost = createGitCreatorEvolutionHost({
        ...baseHostOptions,
        async onPreparationCheckpoint(checkpoint) {
          if (checkpoint.kind !== phase || recoveryStarted) return;
          recoveryStarted = true;
          recovered = await recoveryHost.prepareCandidate({
            runId,
            workspaceRoot: root,
            candidateId,
            branch,
            base,
          });
        },
      });
      let base;
      try {
        base = await interruptedHost.resolveBase({
          runId,
          workspaceRoot: root,
          snapshotTargets: ["skills/creator.md", "AGENTS.md", "host/evaluator.json", "bench/held-out.json"],
        });
        const adopted = await interruptedHost.prepareCandidate({
          runId,
          workspaceRoot: root,
          candidateId,
          branch,
          base,
        });
        assert.equal(recoveryStarted, true);
        assert.equal(recovered.worktree, adopted.worktree);
        assert.equal(git(adopted.worktree, ["rev-parse", "HEAD"]), base.baseCommit);
        await interruptedHost.cleanup({
          runId,
          workspaceRoot: root,
          candidate: adopted,
          resources: adopted.resources,
          retainCandidate: false,
          reason: "test cleanup",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("a proposal record failure removes the retained candidate and branch", async () => {
  const root = createRepository();
  const runId = "git-run-record-failure";
  mkdirSync(path.join(root, ".unclecode", "artifacts", runId, "evolution-proposal.json"), { recursive: true });
  const host = createGitCreatorEvolutionHost({
    workspaceRoot: root,
    now: () => new Date(NOW),
    async generateCreatorEdits() {
      return {
        status: "completed",
        summary: "creator edit",
        edits: [{ path: "skills/creator.md", content: "creator v2\n" }],
      };
    },
    async runEvaluator(input) {
      const check = (score) => [{ id: "content", status: "passed", score, durationMs: 1 }];
      return {
        status: "completed",
        environmentHash: input.expectedEnvironmentHash,
        baseline: { score: 0.7, summary: "baseline", checks: check(0.7) },
        candidate: { score: 0.9, summary: "candidate", checks: check(0.9) },
      };
    },
  });
  try {
    const result = await new CreatorEvolutionService({ config: config(), host, now: () => new Date(NOW) }).run({
      runId,
      workspaceRoot: root,
      prompt: "Create a stronger creator skill.",
      creatorId: "isolated-creator",
      mutableTargets: ["skills/creator.md"],
      dispatchEvolutionProposed: dispatch().run,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "failed");
    assert.ok(result.projection.failures.includes("EVOLUTION_RECORD_FAILED"));
    assert.equal(existsSync(result.projection.isolatedWorktree), false);
    assert.equal(
      git(root, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${result.projection.isolatedBranch}`]),
      "",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
