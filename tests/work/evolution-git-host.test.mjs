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
  return {
    evaluator: {
      id: "git-held-out-evaluator",
      definition: "same immutable executable checks",
      version: "1.0.0",
      assets: ["host/evaluator.json"],
    },
    policyAssets: ["AGENTS.md"],
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
      environment: { locale: "C", timezone: "UTC", network: "disabled" },
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
    async runCreator(input) {
      assert.deepEqual(input.mutableTargets, ["skills/creator.md"]);
      writeFileSync(path.join(input.candidate.worktree, "skills", "creator.md"), "creator v2\n");
      return { status: "completed", summary: "creator completed in isolated worktree" };
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

test("unsupported candidate entries fail closed and remove branch/worktree resources", async () => {
  const root = createRepository();
  const lifecycleDispatch = dispatch();
  const host = createGitCreatorEvolutionHost({
    workspaceRoot: root,
    now: () => new Date(NOW),
    async runCreator(input) {
      symlinkSync("creator.md", path.join(input.candidate.worktree, "skills", "unsafe-link"));
      return { status: "completed", summary: "creator made an unsafe link" };
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
    assert.ok(result.projection.failures.includes("EVOLUTION_UNSUPPORTED_ASSET"));
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
