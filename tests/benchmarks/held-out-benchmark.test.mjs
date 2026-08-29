import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_HELD_OUT_CANDIDATE,
  DEFAULT_HELD_OUT_SUITE_ROOT,
  HELD_OUT_V1_EVALUATOR_ASSETS,
  HELD_OUT_V1_PROTECTED_ASSETS,
  HELD_OUT_V1_SUITE_ASSETS,
  loadHeldOutSuite,
  runHeldOutComparison,
  verifyHeldOutManifest,
} from "../../scripts/held-out-benchmark.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "held-out-benchmark.mjs");

test("held-out v1 is an immutable 40-case, four-domain suite", () => {
  const suite = loadHeldOutSuite();

  assert.equal(suite.manifest.baselineCommit, "d8027bb0d17327528a7b95ed84f50a9eb89ce5f2");
  assert.deepEqual(
    suite.manifest.assets.map((entry) => entry.path).sort(),
    ["baseline.json", "cases.json", "evaluator.json", "thresholds.json"],
  );
  assert.equal(suite.cases.cases.length, 40);
  assert.deepEqual(HELD_OUT_V1_EVALUATOR_ASSETS, ["scripts/held-out-benchmark.mjs"]);
  assert.deepEqual(HELD_OUT_V1_SUITE_ASSETS, [
    "benchmarks/held-out/v1/manifest.json",
    "benchmarks/held-out/v1/baseline.json",
    "benchmarks/held-out/v1/cases.json",
    "benchmarks/held-out/v1/evaluator.json",
    "benchmarks/held-out/v1/thresholds.json",
  ]);
  assert.deepEqual(HELD_OUT_V1_PROTECTED_ASSETS, [
    ...HELD_OUT_V1_EVALUATOR_ASSETS,
    ...HELD_OUT_V1_SUITE_ASSETS,
  ]);
  assert.deepEqual(
    Object.fromEntries(["code", "content", "analysis", "workflow"].map((domain) => [
      domain,
      suite.cases.cases.filter((entry) => entry.domain === domain).length,
    ])),
    { code: 10, content: 10, analysis: 10, workflow: 10 },
  );
});

test("offline fixture compares trace-derived quality and resource measurements deterministically", () => {
  const first = runHeldOutComparison();
  const second = runHeldOutComparison();

  assert.deepEqual(second, first);
  assert.equal(first.baseline.qualityPercent, 70.45);
  assert.equal(first.candidate.qualityPercent, 79.25);
  assert.equal(first.comparison.qualityDeltaPercentagePoints, 8.8);
  assert.deepEqual(first.comparison.domainDeltasPercentagePoints, {
    code: 9.1,
    content: 8.4,
    analysis: 9.4,
    workflow: 8.3,
  });
  assert.equal(first.comparison.frontierTokenReductionPercent, 60.00244);
  assert.equal(first.baseline.cacheHitRatePercent, 28.5);
  assert.equal(first.candidate.cacheHitRatePercent, 69.25);
  assert.deepEqual(first.baseline.latencyMs, { mean: 1219.875, p95: 1510 });
  assert.deepEqual(first.candidate.latencyMs, { mean: 914.75, p95: 1120 });
  assert.equal(first.baseline.retainedMemoryBytes, 580000);
  assert.equal(first.candidate.retainedMemoryBytes, 448000);
  assert.equal(first.comparison.gates.criticProof.provenCases, 40);
  assert.equal(first.comparison.passed, true);
});

test("offline fixture gates never claim live integrated proof", () => {
  const report = runHeldOutComparison();

  assert.equal(report.decision, "fixture-gates-passed-integration-unproven");
  assert.equal(report.integratedProof.status, "unproven");
  assert.deepEqual(report.integratedProof.reasons, [
    "BASELINE_IS_OFFLINE_FIXTURE",
    "CANDIDATE_IS_OFFLINE_FIXTURE",
    "LIVE_PROVIDER_RUN_NOT_RECORDED",
    "FULL_VERIFICATION_MATRIX_NOT_PROVEN",
    "INDEPENDENT_FINAL_REVIEW_NOT_PROVEN",
  ]);

  const required = spawnSync(process.execPath, [RUNNER, "--require-proven"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(required.status, 1);
  assert.match(required.stdout, /Integrated proof: unproven/);
});

test("candidate-owned live proof fields cannot attest the integrated result", () => {
  const selfAttested = copyCandidate((candidate) => {
    candidate.liveProof = {
      providerRunId: "candidate-selected-run",
      fullVerificationMatrix: { status: "passed", artifactHash: `sha256:${"a".repeat(64)}` },
      independentFinalReview: {
        status: "passed",
        reviewerId: "candidate-selected-reviewer",
        artifactHash: `sha256:${"b".repeat(64)}`,
      },
    };
  });
  const report = runHeldOutComparison({ candidatePath: selfAttested });
  assert.equal(report.integratedProof.status, "unproven");
  assert.ok(report.integratedProof.reasons.includes("LIVE_PROVIDER_RUN_NOT_RECORDED"));
  assert.ok(report.integratedProof.reasons.includes("FULL_VERIFICATION_MATRIX_NOT_PROVEN"));
  assert.ok(report.integratedProof.reasons.includes("INDEPENDENT_FINAL_REVIEW_NOT_PROVEN"));
});

test("protected corpus, evaluator, threshold, and baseline mutations fail closed", async (t) => {
  for (const asset of ["cases.json", "evaluator.json", "thresholds.json", "baseline.json"]) {
    await t.test(asset, () => {
      const suiteRoot = copySuite();
      const assetPath = path.join(suiteRoot, asset);
      writeFileSync(assetPath, `${readFileSync(assetPath, "utf8")}\n`, "utf8");
      assert.throws(
        () => verifyHeldOutManifest(suiteRoot),
        new RegExp(`protected asset hash mismatch: ${asset.replace(".", "\\.")}`),
      );
    });
  }

  await t.test("manifest.json", () => {
    const suiteRoot = copySuite();
    const manifestPath = path.join(suiteRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.assets[0].sha256 = `sha256:${"0".repeat(64)}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    assert.throws(() => verifyHeldOutManifest(suiteRoot), /Held-out manifest hash mismatch/);
  });
});

test("candidate cannot pass by omitting cases or critic proof", () => {
  const missingCase = copyCandidate((candidate) => {
    candidate.cases.pop();
  });
  assert.throws(
    () => runHeldOutComparison({ candidatePath: missingCase }),
    /must cover every held-out case exactly once/,
  );

  const staleCritic = copyCandidate((candidate) => {
    candidate.critic.proofs[0].reviewedArtifactHash = `sha256:${"f".repeat(64)}`;
  });
  const report = runHeldOutComparison({ candidatePath: staleCritic });
  assert.equal(report.comparison.gates.criticProof.passed, false);
  assert.deepEqual(report.comparison.gates.criticProof.failures, [
    "CRITIC_ARTIFACT_BINDING_INVALID:code-01",
  ]);
  assert.equal(report.comparison.passed, false);

  const selfReviewed = copyCandidate((candidate) => {
    candidate.critic.reviewerId = candidate.critic.workerId;
  });
  assert.ok(
    runHeldOutComparison({ candidatePath: selfReviewed })
      .comparison.gates.criticProof.failures.includes("CRITIC_REVIEWER_NOT_INDEPENDENT"),
  );
});

test("candidate-owned evaluator and threshold selections are ignored", () => {
  const selected = copyCandidate((candidate) => {
    candidate.evaluator = { criticProof: { requiredForEveryCandidateCase: false } };
    candidate.thresholds = {
      minimumAggregateQualityDeltaPercentagePoints: -100,
      maximumDomainRegressionPercentagePoints: 100,
      minimumFrontierTokenReductionPercent: -100,
      requireCriticProof: false,
    };
  });
  const report = runHeldOutComparison({ candidatePath: selected });
  assert.equal(report.comparison.gates.aggregateQuality.minimumPercentagePoints, 5);
  assert.equal(report.comparison.gates.domainRegression.maximumRegressionPercentagePoints, 2);
  assert.equal(report.comparison.gates.frontierTokenReduction.minimumPercent, 50);
  assert.equal(report.comparison.gates.criticProof.requiredCases, 40);
});

test("aggregate, per-domain, and frontier token gates are enforced independently", () => {
  const lowQuality = copyCandidate((candidate) => {
    for (const entry of candidate.cases) entry.score = 0.7;
  });
  assert.equal(
    runHeldOutComparison({ candidatePath: lowQuality }).comparison.gates.aggregateQuality.passed,
    false,
  );

  const domainRegression = copyCandidate((candidate) => {
    for (const entry of candidate.cases.filter((entry) => entry.id.startsWith("code-"))) entry.score = 0.65;
  });
  assert.equal(
    runHeldOutComparison({ candidatePath: domainRegression }).comparison.gates.domainRegression.passed,
    false,
  );

  const frontierRegression = copyCandidate((candidate) => {
    for (const entry of candidate.cases) entry.metrics.frontierTokens = 900;
  });
  assert.equal(
    runHeldOutComparison({ candidatePath: frontierRegression }).comparison.gates.frontierTokenReduction.passed,
    false,
  );
});

test("JSON CLI output is a machine-readable deterministic report", () => {
  const stdout = execFileSync(process.execPath, [RUNNER, "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const report = JSON.parse(stdout);
  assert.equal(report.suite.caseCount, 40);
  assert.equal(report.comparison.passed, true);
  assert.equal(report.integratedProof.status, "unproven");
});

function copySuite() {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-held-out-suite-"));
  const suiteRoot = path.join(root, "v1");
  cpSync(DEFAULT_HELD_OUT_SUITE_ROOT, suiteRoot, { recursive: true });
  return suiteRoot;
}

function copyCandidate(mutate) {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-held-out-candidate-"));
  const candidatePath = path.join(root, "candidate.json");
  const candidate = JSON.parse(readFileSync(DEFAULT_HELD_OUT_CANDIDATE, "utf8"));
  mutate(candidate);
  writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  return candidatePath;
}
