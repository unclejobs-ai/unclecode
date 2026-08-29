#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_HELD_OUT_SUITE_ROOT = path.join(REPO_ROOT, "benchmarks", "held-out", "v1");
export const DEFAULT_HELD_OUT_CANDIDATE = path.join(DEFAULT_HELD_OUT_SUITE_ROOT, "candidate.fixture.json");
export const HELD_OUT_DOMAINS = Object.freeze(["code", "content", "analysis", "workflow"]);
export const HELD_OUT_V1_MANIFEST_SHA256 = "sha256:10ba37dc907baca72710e44a4aa7c34a481521b2548bf204894f9305b0cf88cd";
export const HELD_OUT_V1_EVALUATOR_ASSETS = Object.freeze([
  "scripts/held-out-benchmark.mjs",
]);
export const HELD_OUT_V1_SUITE_ASSETS = Object.freeze([
  "benchmarks/held-out/v1/manifest.json",
  "benchmarks/held-out/v1/baseline.json",
  "benchmarks/held-out/v1/cases.json",
  "benchmarks/held-out/v1/evaluator.json",
  "benchmarks/held-out/v1/thresholds.json",
]);
export const HELD_OUT_V1_PROTECTED_ASSETS = Object.freeze([
  ...HELD_OUT_V1_EVALUATOR_ASSETS,
  ...HELD_OUT_V1_SUITE_ASSETS,
]);

const EXPECTED_ASSETS = Object.freeze([
  "baseline.json",
  "cases.json",
  "evaluator.json",
  "thresholds.json",
]);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function verifyHeldOutManifest(suiteRoot = DEFAULT_HELD_OUT_SUITE_ROOT) {
  const resolvedRoot = realpathSync(path.resolve(suiteRoot));
  const manifestPath = path.join(resolvedRoot, "manifest.json");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Held-out manifest must be a regular, non-symlink file");
  }
  const manifestBytes = readFileSync(manifestPath);
  if (sha256(manifestBytes) !== HELD_OUT_V1_MANIFEST_SHA256) {
    throw new Error("Held-out manifest hash mismatch");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.suiteId !== "unclecode-held-out-v1") {
    throw new Error("Unsupported held-out manifest identity");
  }
  if (!COMMIT.test(manifest.baselineCommit ?? "")) {
    throw new Error("Held-out manifest baselineCommit must be a full 40-character commit");
  }
  if (!Array.isArray(manifest.assets)) throw new Error("Held-out manifest assets must be an array");

  const seen = new Set();
  const verifiedAssets = {};
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.path !== "string" || !SHA256.test(asset.sha256 ?? "")) {
      throw new Error("Held-out manifest contains an invalid asset entry");
    }
    const normalized = path.posix.normalize(asset.path.replaceAll("\\", "/"));
    if (normalized !== asset.path || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      throw new Error(`Held-out manifest asset escapes suite root: ${asset.path}`);
    }
    if (seen.has(normalized)) throw new Error(`Duplicate held-out manifest asset: ${normalized}`);
    seen.add(normalized);
    const assetPath = path.resolve(resolvedRoot, ...normalized.split("/"));
    if (!isWithin(resolvedRoot, assetPath)) throw new Error(`Held-out manifest asset escapes suite root: ${normalized}`);
    const stat = lstatSync(assetPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Held-out protected asset must be a regular, non-symlink file: ${normalized}`);
    }
    const bytes = readFileSync(assetPath);
    const actual = sha256(bytes);
    if (actual !== asset.sha256) {
      throw new Error(`Held-out protected asset hash mismatch: ${normalized}`);
    }
    verifiedAssets[normalized] = { path: assetPath, sha256: actual, size: bytes.length };
  }
  if (seen.size !== EXPECTED_ASSETS.length || EXPECTED_ASSETS.some((asset) => !seen.has(asset))) {
    throw new Error(`Held-out manifest must pin exactly: ${EXPECTED_ASSETS.join(", ")}`);
  }
  return { manifest, manifestPath, suiteRoot: resolvedRoot, assets: verifiedAssets };
}

export function loadHeldOutSuite(suiteRoot = DEFAULT_HELD_OUT_SUITE_ROOT) {
  const verified = verifyHeldOutManifest(suiteRoot);
  const cases = parseJsonFile(verified.assets["cases.json"].path);
  const evaluator = parseJsonFile(verified.assets["evaluator.json"].path);
  const thresholds = parseJsonFile(verified.assets["thresholds.json"].path);
  const baseline = parseJsonFile(verified.assets["baseline.json"].path);
  validateSuite(cases, evaluator, thresholds, baseline, verified.manifest);
  return { ...verified, cases, evaluator, thresholds, baseline };
}

export function runHeldOutComparison({
  suiteRoot = DEFAULT_HELD_OUT_SUITE_ROOT,
  candidatePath = DEFAULT_HELD_OUT_CANDIDATE,
  trustedProof,
} = {}) {
  const suite = loadHeldOutSuite(suiteRoot);
  const candidate = parseJsonFile(path.resolve(candidatePath));
  const caseDefinitions = suite.cases.cases;
  validateResult(candidate, caseDefinitions, "candidate");

  const baselineSummary = summarizeResult(suite.baseline, caseDefinitions);
  const candidateSummary = summarizeResult(candidate, caseDefinitions);
  const domainDeltas = Object.fromEntries(HELD_OUT_DOMAINS.map((domain) => [
    domain,
    round(candidateSummary.domains[domain] - baselineSummary.domains[domain]),
  ]));
  const qualityDelta = round(candidateSummary.qualityPercent - baselineSummary.qualityPercent);
  const frontierReduction = baselineSummary.frontierTokens === 0
    ? (candidateSummary.frontierTokens === 0 ? 100 : -100)
    : round((1 - candidateSummary.frontierTokens / baselineSummary.frontierTokens) * 100);
  const critic = validateCriticProof(candidate, caseDefinitions);
  const thresholds = suite.thresholds;
  const gates = {
    aggregateQuality: {
      passed: qualityDelta >= thresholds.minimumAggregateQualityDeltaPercentagePoints,
      actualPercentagePoints: qualityDelta,
      minimumPercentagePoints: thresholds.minimumAggregateQualityDeltaPercentagePoints,
    },
    domainRegression: {
      passed: Object.values(domainDeltas).every(
        (delta) => delta >= -thresholds.maximumDomainRegressionPercentagePoints,
      ),
      deltasPercentagePoints: domainDeltas,
      maximumRegressionPercentagePoints: thresholds.maximumDomainRegressionPercentagePoints,
    },
    frontierTokenReduction: {
      passed: frontierReduction >= thresholds.minimumFrontierTokenReductionPercent,
      actualPercent: frontierReduction,
      minimumPercent: thresholds.minimumFrontierTokenReductionPercent,
    },
    criticProof: {
      passed: !thresholds.requireCriticProof || critic.failures.length === 0,
      provenCases: critic.provenCases,
      requiredCases: caseDefinitions.length,
      failures: critic.failures,
    },
  };
  const comparisonPassed = Object.values(gates).every((gate) => gate.passed);
  const proof = integratedProof(candidate, suite.baseline, comparisonPassed, trustedProof);

  return {
    schemaVersion: 1,
    suite: {
      id: suite.manifest.suiteId,
      version: suite.manifest.version,
      caseCount: caseDefinitions.length,
      domainCaseCounts: Object.fromEntries(HELD_OUT_DOMAINS.map((domain) => [
        domain,
        caseDefinitions.filter((entry) => entry.domain === domain).length,
      ])),
      baselineCommit: suite.manifest.baselineCommit,
      protectedAssetHashes: Object.fromEntries(
        Object.entries(suite.assets).map(([name, asset]) => [name, asset.sha256]),
      ),
    },
    evidence: {
      baselineMode: suite.baseline.evidenceMode,
      candidateMode: candidate.evidenceMode,
      traceDerived: suite.baseline.traceDerived === true && candidate.traceDerived === true,
    },
    baseline: baselineSummary,
    candidate: candidateSummary,
    comparison: {
      qualityDeltaPercentagePoints: qualityDelta,
      domainDeltasPercentagePoints: domainDeltas,
      frontierTokenReductionPercent: frontierReduction,
      gates,
      passed: comparisonPassed,
    },
    integratedProof: proof,
    decision: proof.status === "proven"
      ? "proven"
      : comparisonPassed
        ? "fixture-gates-passed-integration-unproven"
        : "failed",
  };
}

function validateSuite(cases, evaluator, thresholds, baseline, manifest) {
  if (cases.schemaVersion !== 1 || cases.suiteId !== manifest.suiteId || !Array.isArray(cases.cases)) {
    throw new Error("Invalid held-out case corpus");
  }
  if (cases.cases.length !== 40) throw new Error("Held-out corpus must contain exactly 40 cases");
  const ids = new Set();
  for (const entry of cases.cases) {
    if (!entry || typeof entry.id !== "string" || !HELD_OUT_DOMAINS.includes(entry.domain)) {
      throw new Error("Held-out corpus contains an invalid case");
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate held-out case id: ${entry.id}`);
    ids.add(entry.id);
  }
  for (const domain of HELD_OUT_DOMAINS) {
    if (cases.cases.filter((entry) => entry.domain === domain).length !== 10) {
      throw new Error(`Held-out corpus must contain exactly 10 ${domain} cases`);
    }
  }
  if (
    evaluator.schemaVersion !== 1
    || evaluator.qualityAggregation !== "equal-case-mean"
    || evaluator.frontierUseMeasure !== "frontierTokens"
    || evaluator.criticProof?.requiredForEveryCandidateCase !== true
  ) {
    throw new Error("Unsupported held-out evaluator contract");
  }
  for (const field of [
    "minimumAggregateQualityDeltaPercentagePoints",
    "maximumDomainRegressionPercentagePoints",
    "minimumFrontierTokenReductionPercent",
  ]) {
    if (!Number.isFinite(thresholds[field]) || thresholds[field] < 0) {
      throw new Error(`Invalid held-out threshold: ${field}`);
    }
  }
  if (thresholds.requireCriticProof !== true) throw new Error("Held-out critic proof gate cannot be disabled");
  if (baseline.commit !== manifest.baselineCommit) throw new Error("Recorded baseline commit does not match manifest");
  validateResult(baseline, cases.cases, "baseline");
}

function validateResult(result, caseDefinitions, label) {
  if (
    result?.schemaVersion !== 1
    || result.suiteId !== "unclecode-held-out-v1"
    || !["offline-fixture", "live-provider"].includes(result.evidenceMode)
    || result.traceDerived !== true
    || !Array.isArray(result.cases)
  ) {
    throw new Error(`Invalid ${label} result envelope`);
  }
  const expectedIds = new Set(caseDefinitions.map((entry) => entry.id));
  const seen = new Set();
  for (const entry of result.cases) {
    if (!entry || !expectedIds.has(entry.id) || seen.has(entry.id)) {
      throw new Error(`${label} result has unknown or duplicate case: ${entry?.id ?? "<missing>"}`);
    }
    seen.add(entry.id);
    if (!Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1) {
      throw new Error(`${label} result has invalid score for ${entry.id}`);
    }
    for (const metric of ["frontierTokens", "totalTokens", "cacheHits", "cacheMisses", "latencyMs", "retainedMemoryBytes"]) {
      if (!Number.isSafeInteger(entry.metrics?.[metric]) || entry.metrics[metric] < 0) {
        throw new Error(`${label} result has invalid ${metric} for ${entry.id}`);
      }
    }
    if (entry.metrics.frontierTokens > entry.metrics.totalTokens) {
      throw new Error(`${label} result frontier tokens exceed total tokens for ${entry.id}`);
    }
  }
  if (seen.size !== expectedIds.size) throw new Error(`${label} result must cover every held-out case exactly once`);
}

function summarizeResult(result, caseDefinitions) {
  const byId = new Map(result.cases.map((entry) => [entry.id, entry]));
  const scores = result.cases.map((entry) => entry.score);
  const cacheHits = sum(result.cases.map((entry) => entry.metrics.cacheHits));
  const cacheMisses = sum(result.cases.map((entry) => entry.metrics.cacheMisses));
  const latencies = result.cases.map((entry) => entry.metrics.latencyMs).sort((left, right) => left - right);
  return {
    system: result.system,
    commit: result.commit,
    qualityPercent: round(mean(scores) * 100),
    domains: Object.fromEntries(HELD_OUT_DOMAINS.map((domain) => {
      const domainScores = caseDefinitions
        .filter((entry) => entry.domain === domain)
        .map((entry) => byId.get(entry.id).score);
      return [domain, round(mean(domainScores) * 100)];
    })),
    frontierTokens: sum(result.cases.map((entry) => entry.metrics.frontierTokens)),
    totalTokens: sum(result.cases.map((entry) => entry.metrics.totalTokens)),
    cacheHitRatePercent: cacheHits + cacheMisses === 0 ? 0 : round(cacheHits / (cacheHits + cacheMisses) * 100),
    latencyMs: {
      mean: round(mean(latencies)),
      p95: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)],
    },
    retainedMemoryBytes: Math.max(...result.cases.map((entry) => entry.metrics.retainedMemoryBytes)),
  };
}

function validateCriticProof(candidate, caseDefinitions) {
  const critic = candidate.critic;
  const failures = [];
  if (
    !critic
    || critic.independent !== true
    || typeof critic.reviewerId !== "string"
    || critic.reviewerId.length === 0
    || typeof critic.workerId !== "string"
    || critic.workerId.length === 0
    || critic.reviewerId === critic.workerId
  ) {
    failures.push("CRITIC_REVIEWER_NOT_INDEPENDENT");
  }
  if (critic?.verdict !== "pass") failures.push("CRITIC_VERDICT_NOT_PASSING");
  const proofs = Array.isArray(critic?.proofs) ? critic.proofs : [];
  const byCase = new Map();
  const reviewerRuns = new Set();
  for (const proof of proofs) {
    if (!proof || byCase.has(proof.caseId)) {
      failures.push(`CRITIC_PROOF_DUPLICATE:${proof?.caseId ?? "<missing>"}`);
      continue;
    }
    byCase.set(proof.caseId, proof);
  }
  let provenCases = 0;
  for (const entry of caseDefinitions) {
    const proof = byCase.get(entry.id);
    if (!proof) {
      failures.push(`CRITIC_PROOF_MISSING:${entry.id}`);
      continue;
    }
    const currentBinding = SHA256.test(proof.artifactHash ?? "")
      && proof.reviewedArtifactHash === proof.artifactHash;
    const uniqueRun = typeof proof.reviewerRunId === "string"
      && proof.reviewerRunId.length > 0
      && !reviewerRuns.has(proof.reviewerRunId);
    if (!currentBinding) failures.push(`CRITIC_ARTIFACT_BINDING_INVALID:${entry.id}`);
    if (!uniqueRun) failures.push(`CRITIC_REVIEWER_RUN_INVALID:${entry.id}`);
    if (currentBinding && uniqueRun) provenCases += 1;
    if (uniqueRun) reviewerRuns.add(proof.reviewerRunId);
  }
  for (const caseId of byCase.keys()) {
    if (!caseDefinitions.some((entry) => entry.id === caseId)) failures.push(`CRITIC_PROOF_UNKNOWN_CASE:${caseId}`);
  }
  return { failures: [...new Set(failures)].sort(), provenCases };
}

function integratedProof(candidate, baseline, comparisonPassed, trustedProof) {
  const reasons = [];
  if (baseline.evidenceMode !== "live-provider") reasons.push("BASELINE_IS_OFFLINE_FIXTURE");
  if (candidate.evidenceMode !== "live-provider") reasons.push("CANDIDATE_IS_OFFLINE_FIXTURE");
  if (!comparisonPassed) reasons.push("COMPARISON_GATES_FAILED");
  if (typeof trustedProof?.providerRunId !== "string" || trustedProof.providerRunId.length === 0) {
    reasons.push("LIVE_PROVIDER_RUN_NOT_RECORDED");
  }
  if (trustedProof?.fullVerificationMatrix?.status !== "passed" || !SHA256.test(trustedProof?.fullVerificationMatrix?.artifactHash ?? "")) {
    reasons.push("FULL_VERIFICATION_MATRIX_NOT_PROVEN");
  }
  if (
    trustedProof?.independentFinalReview?.status !== "passed"
    || typeof trustedProof?.independentFinalReview?.reviewerId !== "string"
    || !SHA256.test(trustedProof?.independentFinalReview?.artifactHash ?? "")
  ) {
    reasons.push("INDEPENDENT_FINAL_REVIEW_NOT_PROVEN");
  }
  return {
    status: reasons.length === 0 ? "proven" : "unproven",
    reasons,
  };
}

function parseJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values) {
  return sum(values) / values.length;
}

function round(value) {
  return Number(value.toFixed(6));
}

function parseArgs(argv) {
  const options = { suiteRoot: DEFAULT_HELD_OUT_SUITE_ROOT, candidatePath: DEFAULT_HELD_OUT_CANDIDATE, json: false, requireProven: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--suite") options.suiteRoot = path.resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--candidate") options.candidatePath = path.resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--json") options.json = true;
    else if (argument === "--require-proven") options.requireProven = true;
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown held-out benchmark option: ${argument}`);
  }
  return options;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function printHuman(report) {
  console.log(`Held-out benchmark ${report.suite.id}: ${report.suite.caseCount} cases`);
  console.log(`Quality: ${report.baseline.qualityPercent}% -> ${report.candidate.qualityPercent}% (${report.comparison.qualityDeltaPercentagePoints >= 0 ? "+" : ""}${report.comparison.qualityDeltaPercentagePoints}pp)`);
  console.log(`Frontier tokens: ${report.baseline.frontierTokens} -> ${report.candidate.frontierTokens} (${report.comparison.frontierTokenReductionPercent}% reduction)`);
  console.log(`Comparison gates: ${report.comparison.passed ? "passed" : "failed"}`);
  console.log(`Integrated proof: ${report.integratedProof.status}`);
  if (report.integratedProof.reasons.length > 0) console.log(`Unproven reasons: ${report.integratedProof.reasons.join(", ")}`);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/held-out-benchmark.mjs [--suite path] [--candidate path] [--json] [--require-proven]");
      return;
    }
    const report = runHeldOutComparison(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (!report.comparison.passed || (options.requireProven && report.integratedProof.status !== "proven")) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Held-out benchmark failed closed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
