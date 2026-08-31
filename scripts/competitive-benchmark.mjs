#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RuntimeOwnerClient,
  defaultRuntimeOwnerPaths,
  probeRuntimeOwner,
  processStartIdentity,
  readRuntimeOwnerLease,
} from "@unclecode/server";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_SUITE_PATH = path.join(REPO_ROOT, "benchmarks", "competitive", "suite.json");
const DEFAULT_REPORT_PATH = path.join(
  REPO_ROOT,
  "benchmarks",
  "competitive",
  "results",
  "latest.json",
);
const OUTPUT_CAP_BYTES = 64 * 1024;
const OWNER_POLL_INTERVAL_MS = 50;
const OWNER_STOP_TIMEOUT_MS = 5_000;
const MAX_BENCHMARK_APPROVALS = 32;
const OWNER_SESSION_DISCOVERY_TIMEOUT_MS = 2_000;

export function buildWindowsTreeKillArgs(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid benchmark PID: ${pid}`);
  }
  return ["/PID", String(pid), "/T", "/F"];
}
const BLOCKED_OUTPUT_PATTERN =
  /api.?key|auth(?:entication|orization)?|credential|log[ -]?in|model[^\n]*(?:not found|unavailable)|provider[^\n]*(?:not found|unavailable)|pi-(?:bridge|ai)[^\n]*failed|http\\s+[45]\\d\\d/i;
const BENCHMARK_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "OMP_PROFILE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE_URL",
  "OPENAI_DEFAULT_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
];
const SECRET_ENV_NAME_PATTERN = /(?:key|token|secret|password|auth|credential)/i;

export function buildBenchmarkEnvironment(source = process.env, overrides = {}) {
  const env = {};
  for (const key of BENCHMARK_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return { ...env, ...overrides };
}
const SYSTEM_IDS = ["unclecode", "omp", "senpi", "prime-agent"];

export function validateBenchmarkSuite(suite) {
  if (suite?.version !== 1 || !Array.isArray(suite.tasks) || suite.tasks.length === 0) {
    throw new Error("Benchmark suite must use version 1 and contain at least one task");
  }
  const ids = new Set();
  for (const task of suite.tasks) {
    if (typeof task?.id !== "string" || task.id.length === 0) {
      throw new Error("Benchmark task is missing a non-empty id");
    }
    if (ids.has(task.id)) {
      throw new Error(`Benchmark suite has duplicate task id: ${task.id}`);
    }
    ids.add(task.id);
    if (typeof task.prompt !== "string" || task.prompt.length === 0) {
      throw new Error(`Benchmark task ${task.id} is missing a prompt`);
    }
    if (task.files === null || typeof task.files !== "object" || Array.isArray(task.files)) {
      throw new Error(`Benchmark task ${task.id} is missing fixture files`);
    }
    for (const [fixturePath, content] of Object.entries(task.files)) {
      validateRelativePath(fixturePath, `fixture path for ${task.id}`);
      if (typeof content !== "string") {
        throw new Error(`Benchmark fixture ${fixturePath} must contain text`);
      }
    }
    if (!Array.isArray(task.checks) || task.checks.length === 0) {
      throw new Error(`Benchmark task ${task.id} has no checks`);
    }
    for (const check of task.checks) {
      if (!check || !["fileEquals", "fileMatches", "fileNotMatches", "command"].includes(check.kind)) {
        throw new Error(`Benchmark task ${task.id} has an unsupported check`);
      }
      if (check.kind !== "command") {
        validateRelativePath(check.path, `check path for ${task.id}`);
      }
    }
    const approvalPolicy = task.approvalPolicy ?? { tools: [], shellCommands: [] };
    if (
      !Array.isArray(approvalPolicy.tools)
      || approvalPolicy.tools.some((tool) => tool !== "write_file")
      || !Array.isArray(approvalPolicy.shellCommands)
      || approvalPolicy.shellCommands.some((command) => typeof command !== "string")
    ) {
      throw new Error(`Benchmark task ${task.id} has an unsafe approval policy`);
    }
    const checkedCommands = new Set(task.checks
      .filter((check) => check.kind === "command")
      .map((check) => [check.command, ...(check.args ?? [])].join(" ")));
    const fixturePaths = new Set(Object.keys(task.files));
    if (
      approvalPolicy.shellCommands.some((command) =>
        !benchmarkShellCommandIsFixtureScoped(command, checkedCommands, fixturePaths)
      )
    ) {
      throw new Error(
        `Benchmark task ${task.id} may approve only exact checked commands or fixture-scoped hashes`,
      );
    }
  }
  return suite;
}

function benchmarkShellCommandIsFixtureScoped(command, checkedCommands, fixturePaths) {
  if (typeof command !== "string" || command.length === 0) return false;
  const clauses = command.split(" && ");
  if (clauses.join(" && ") !== command) return false;
  return clauses.every((clause) => {
    if (!/^[A-Za-z0-9_./-]+(?: [A-Za-z0-9_./-]+)*$/u.test(clause)) return false;
    if (checkedCommands.has(clause)) return true;
    const tokens = clause.split(" ");
    if (tokens.length < 2 || tokens.some((token) => token.length === 0)) return false;
    const [program, ...files] = tokens;
    if (program !== "sha256sum" && !(program === "shasum" && files.shift() === "-a" && files.shift() === "256")) {
      return false;
    }
    return files.length > 0 && files.every((file) => fixturePaths.has(file));
  });
}

export async function evaluateBenchmarkChecks(workspace, checks) {
  const results = [];
  for (const check of checks) {
    if (check.kind === "command") {
      const result = await runCommand(check.command, check.args ?? [], {
        cwd: workspace,
        timeoutMs: check.timeoutMs ?? 30_000,
      });
      results.push({
        kind: check.kind,
        command: [check.command, ...(check.args ?? [])],
        passed: result.code === 0 && !result.timedOut,
        detail: result.timedOut
          ? `timed out after ${result.durationMs}ms`
          : `exit=${result.code ?? "unavailable"}`,
      });
      continue;
    }
    const target = resolveInside(workspace, check.path);
    if (!existsSync(target)) {
      results.push({ kind: check.kind, path: check.path, passed: false, detail: "file missing" });
      continue;
    }
    const content = readFileSync(target, "utf8");
    if (check.kind === "fileEquals") {
      results.push({
        kind: check.kind,
        path: check.path,
        passed: content === check.value,
        detail: content === check.value ? "exact match" : "content mismatch",
      });
      continue;
    }
    const pattern = new RegExp(check.pattern, check.flags ?? "u");
    const matched = pattern.test(content);
    const passed = check.kind === "fileMatches" ? matched : !matched;
    results.push({
      kind: check.kind,
      path: check.path,
      passed,
      detail: passed ? "pattern contract satisfied" : "pattern contract failed",
    });
  }
  return results;
}

export function buildBenchmarkSummary(results) {
  const summary = { total: results.length, pass: 0, fail: 0, blocked: 0, unavailable: 0 };
  for (const result of results) {
    if (Object.hasOwn(summary, result.status) && result.status !== "total") {
      summary[result.status] += 1;
    }
  }
  return summary;
}

export function formatBenchmarkFailureSummary(report) {
  return report.results
    .filter((result) => result.status !== "pass")
    .map((result) => {
      const failedChecks = (result.checks ?? [])
        .filter((check) => !check.passed)
        .map((check) => check.detail)
        .filter(Boolean);
      const detail = failedChecks.length > 0 ? ` (${failedChecks.join("; ")})` : "";
      return `${result.system}/${result.taskId}: ${result.status}${detail}`;
    });
}

export function benchmarkProcessResult(report, reportPath) {
  const failureSummary = [];
  if (!existsSync(reportPath)) failureSummary.push(`report missing: ${reportPath}`);
  failureSummary.push(...formatBenchmarkFailureSummary(report));
  const cleanup = report.runtimeOwnerCleanup;
  if (
    cleanup?.status !== "pass"
    || cleanup.leaseRemoved !== true
    || cleanup.listenerClosed !== true
  ) {
    failureSummary.push(
      `runtime owner cleanup: ${cleanup?.detail ?? "cleanup evidence missing or incomplete"}`,
    );
  }
  const complete = report.summary.total > 0
    && report.summary.pass === report.summary.total
    && report.results.length === report.summary.total;
  if (!complete && failureSummary.length === 0) {
    failureSummary.push(
      `summary mismatch: ${report.summary.pass}/${report.summary.total} required cases passed`,
    );
  }
  return {
    exitCode: complete && failureSummary.length === 0 ? 0 : 1,
    failureSummary,
  };
}

function exactWorkspace(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function pendingDecisionFromState(state) {
  const pending = state?.agentConsole?.pendingDecision;
  return pending && typeof pending === "object" ? pending : undefined;
}

function terminalState(state) {
  const lifecycle = state?.turnLifecycle?.state;
  return pendingDecisionFromState(state) === undefined
    && state?.isBusy !== true
    && (lifecycle === "completed" || lifecycle === "cancelled");
}

function approvalIsAllowed(pending, approvalPolicy) {
  if (pending?.kind !== "security-approval" || typeof pending.id !== "string") return false;
  if (
    typeof pending.title === "string"
    && approvalPolicy.tools.some((tool) => pending.title === `Security approval · ${tool}`)
  ) {
    return true;
  }
  const question = pending.questions?.[0]?.question;
  return typeof question === "string"
    && approvalPolicy.shellCommands.some((command) =>
      question.includes(`Exact command: ${JSON.stringify(command)}.`)
    );
}

export async function driveUncleCodeBenchmarkApprovals(input) {
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + input.timeoutMs;
  const discoveryDeadline = Math.min(
    deadline,
    Date.now() + (input.sessionDiscoveryTimeoutMs ?? OWNER_SESSION_DISCOVERY_TIMEOUT_MS),
  );
  let approvals = 0;
  while (Date.now() <= deadline) {
    const sessions = await input.client.listRuntimeSessions();
    const session = sessions.find((candidate) => exactWorkspace(candidate.projectPath, input.workspace));
    if (!session) {
      if (Date.now() >= discoveryDeadline) {
        return {
          status: "completed",
          approvals,
          detail: "no active session remained for the exact benchmark workspace",
        };
      }
      await sleep(OWNER_POLL_INTERVAL_MS);
      continue;
    }
    const stateResult = await input.client.readEngineState(session.sessionId);
    if (!stateResult.ok || !stateResult.state) {
      return { status: "failed", detail: `benchmark owner session ${session.sessionId} became unavailable` };
    }
    const pending = pendingDecisionFromState(stateResult.state);
    if (pending) {
      if (!approvalIsAllowed(pending, input.approvalPolicy)) {
        return {
          status: "blocked",
          detail: `refused non-benchmark approval ${pending.id} (${pending.title ?? "untitled"})`,
          sessionId: session.sessionId,
        };
      }
      if (approvals >= MAX_BENCHMARK_APPROVALS) {
        return { status: "blocked", detail: "benchmark approval limit exceeded", sessionId: session.sessionId };
      }
      const approved = await input.client.control({
        sessionId: session.sessionId,
        action: "approve",
        expectedRevision: stateResult.revision,
        idempotencyKey: `benchmark-approval-${pending.id}`,
        payload: { decision: "approve_once", decisionId: pending.id },
      });
      if (!approved.ok) {
        if (approved.code === "revision_conflict") continue;
        return {
          status: "blocked",
          detail: `benchmark approval was rejected: ${approved.message}`,
          sessionId: session.sessionId,
        };
      }
      approvals += 1;
      continue;
    }
    if (terminalState(stateResult.state)) {
      await input.client.releaseRuntimeSession(session.sessionId);
      return {
        status: stateResult.state.turnLifecycle?.state === "cancelled" ? "cancelled" : "completed",
        approvals,
        sessionId: session.sessionId,
      };
    }
    await sleep(OWNER_POLL_INTERVAL_MS);
  }
  return { status: "not_found", detail: "timed out waiting for the exact benchmark owner session" };
}

async function connectBenchmarkOwner(home, timeoutMs = 2_000) {
  const { leasePath } = defaultRuntimeOwnerPaths(home);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const lease = await readRuntimeOwnerLease(leasePath);
    if (lease && await probeRuntimeOwner(lease)) {
      return RuntimeOwnerClient.connect(lease);
    }
    await new Promise((resolve) => setTimeout(resolve, OWNER_POLL_INTERVAL_MS));
  }
  return undefined;
}

export async function stopBenchmarkRuntimeOwner(home) {
  const { leasePath } = defaultRuntimeOwnerPaths(home);
  const lease = await readRuntimeOwnerLease(leasePath);
  if (!lease) {
    return { status: "pass", ownerFound: false, leaseRemoved: true, listenerClosed: true };
  }
  const exactProcess = await processStartIdentity(lease.pid) === lease.processStartId;
  if (!exactProcess && !await probeRuntimeOwner(lease)) {
    rmSync(leasePath, { force: true });
    return {
      status: "pass",
      ownerFound: true,
      leaseRemoved: !existsSync(leasePath),
      listenerClosed: true,
      detail: "removed a stale isolated benchmark-owner lease without signalling its mismatched PID",
    };
  }
  if (exactProcess) process.kill(lease.pid, "SIGTERM");
  const deadline = Date.now() + OWNER_STOP_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const alive = await processStartIdentity(lease.pid) === lease.processStartId;
    const current = await readRuntimeOwnerLease(leasePath);
    if (!alive && current === null && !await probeRuntimeOwner(lease)) {
      return { status: "pass", ownerFound: true, leaseRemoved: true, listenerClosed: true };
    }
    await new Promise((resolve) => setTimeout(resolve, OWNER_POLL_INTERVAL_MS));
  }
  if (await processStartIdentity(lease.pid) === lease.processStartId) {
    process.kill(lease.pid, "SIGKILL");
  }
  const killDeadline = Date.now() + OWNER_STOP_TIMEOUT_MS;
  while (Date.now() <= killDeadline) {
    const alive = await processStartIdentity(lease.pid) === lease.processStartId;
    const listenerClosed = !await probeRuntimeOwner(lease);
    if (!alive && listenerClosed) {
      rmSync(leasePath, { force: true });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, OWNER_POLL_INTERVAL_MS));
  }
  const leaseRemoved = await readRuntimeOwnerLease(leasePath) === null;
  const listenerClosed = !await probeRuntimeOwner(lease);
  return {
    status: leaseRemoved && listenerClosed ? "pass" : "fail",
    ownerFound: true,
    leaseRemoved,
    listenerClosed,
    detail: `leaseRemoved=${leaseRemoved} listenerClosed=${listenerClosed}`,
  };
}

export async function runCompetitiveBenchmark(options = {}) {
  const suitePath = path.resolve(options.suitePath ?? DEFAULT_SUITE_PATH);
  const reportPath = path.resolve(options.reportPath ?? DEFAULT_REPORT_PATH);
  const suiteText = readFileSync(suitePath, "utf8");
  const suite = validateBenchmarkSuite(JSON.parse(suiteText));
  const systems = options.systems ?? ["unclecode"];
  for (const system of systems) {
    if (!SYSTEM_IDS.includes(system)) {
      throw new Error(`Unknown benchmark system: ${system}`);
    }
  }
  const model = options.model ?? "gpt-5.6-sol";
  const startedAt = new Date().toISOString();
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-competitive-benchmark-"));
  const isolatedHome = path.join(root, "home");
  mkdirSync(isolatedHome, { recursive: true });
  const results = [];
  let runtimeOwnerCleanup = {
    status: "pass",
    ownerFound: false,
    leaseRemoved: true,
    listenerClosed: true,
  };
  try {
    for (const system of systems) {
      for (const task of suite.tasks) {
        const workspace = path.join(root, system, task.id);
        materializeFixture(workspace, task.files);
        const profile = buildSystemProfile(system, workspace, task, model, {
          isolatedHome,
          sessionStoreRoot: path.join(root, "state"),
        });
        const execution = await runCommand(profile.command, profile.args, {
          cwd: profile.cwd,
          env: profile.env,
          timeoutMs: task.timeoutMs,
        });
        let ownerSettlement;
        if (system === "unclecode" && execution.code === 0 && !execution.timedOut) {
          const client = await connectBenchmarkOwner(isolatedHome);
          ownerSettlement = client
            ? await driveUncleCodeBenchmarkApprovals({
                client,
                workspace,
                approvalPolicy: task.approvalPolicy ?? { tools: [], shellCommands: [] },
                timeoutMs: task.timeoutMs,
              })
            : {
                status: "completed",
                approvals: 0,
                detail: "no isolated runtime owner remained after the command completed",
              };
        }
        let status;
        let checks = [];
        if (execution.errorCode === "ENOENT") {
          status = "unavailable";
        } else if (execution.timedOut) {
          status = "blocked";
        } else if (execution.code !== 0) {
          status = BLOCKED_OUTPUT_PATTERN.test(`${execution.stdout}\n${execution.stderr}`)
            ? "blocked"
            : "fail";
        } else if (ownerSettlement && ownerSettlement.status !== "completed") {
          status = "blocked";
        } else {
          checks = await evaluateBenchmarkChecks(workspace, task.checks);
          status = checks.every((check) => check.passed) ? "pass" : "fail";
        }
        results.push({
          system,
          taskId: task.id,
          status,
          model: profile.model,
          durationMs: execution.durationMs,
          exitCode: execution.code,
          signal: execution.signal,
          timedOut: execution.timedOut,
          checks,
          ...(ownerSettlement ? { ownerSettlement } : {}),
          outputExcerpt: sanitizeBenchmarkOutput(
            `${execution.stdout}\n${execution.stderr}`,
            profile.env,
          ),
          ...(options.keepWorkspaces ? { workspace } : {}),
        });
      }
    }
  } finally {
    runtimeOwnerCleanup = await stopBenchmarkRuntimeOwner(isolatedHome);
    if (!options.keepWorkspaces) {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const report = {
    schemaVersion: 1,
    benchmark: suite.name,
    suitePath: path.relative(REPO_ROOT, suitePath),
    suiteSha256: createHash("sha256").update(suiteText).digest("hex"),
    methodology: suite.methodology,
    modelTarget: model,
    systems,
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    summary: buildBenchmarkSummary(results),
    results,
    runtimeOwnerCleanup,
    disclosure: [
      "Only executed systems are scored; unavailable or unauthenticated systems remain explicit.",
      "No score is inferred from feature lists, marketing claims, or an agent's prose response.",
      "Provider conformance is reported separately by scripts/provider-conformance.mjs.",
      "Benchmark children receive only runtime, locale, explicit provider-auth roots, and OpenAI transport variables; unrelated tool-specific parent environment is not inherited.",
    ],
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { report, reportPath };
}

export function buildSystemProfile(system, workspace, task, model, isolation = {}) {
  const prompt = task.prompt;
  if (system === "unclecode") {
    const codexHome = process.env.CODEX_HOME
      ?? (process.env.HOME ? path.join(process.env.HOME, ".codex") : undefined);
    const ompAgentDir = process.env.PI_CODING_AGENT_DIR?.trim()
      || (process.env.HOME ? path.join(process.env.HOME, ".omp", "agent") : undefined);
    const openAICredentialsPath = process.env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim()
      || (codexHome ? path.join(codexHome, "auth.json") : undefined);
    return {
      command: path.join(REPO_ROOT, "target", "debug", "unclecode"),
      args: [
        "work",
        "--engine",
        "pi",
        "--provider",
        "openai",
        "--model",
        model,
        "--cwd",
        workspace,
        prompt,
      ],
      cwd: workspace,
      env: buildBenchmarkEnvironment(process.env, {
        HOME: isolation.isolatedHome,
        USERPROFILE: isolation.isolatedHome,
        XDG_CONFIG_HOME: path.join(isolation.isolatedHome, ".config"),
        XDG_DATA_HOME: path.join(isolation.isolatedHome, ".local", "share"),
        XDG_CACHE_HOME: path.join(isolation.isolatedHome, ".cache"),
        UNCLECODE_SESSION_STORE_ROOT: isolation.sessionStoreRoot,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        ...(ompAgentDir ? { PI_CODING_AGENT_DIR: ompAgentDir } : {}),
        ...(openAICredentialsPath
          ? { UNCLECODE_OPENAI_CREDENTIALS_PATH: openAICredentialsPath }
          : {}),
        UNCLECODE_ALLOW_DESTRUCTIVE: "1",
        UNCLECODE_ALLOW_RUN_SHELL: "1",
      }),
      model: `openai/${model} (Codex OAuth when available)`,
    };
  }
  if (system === "omp") {
    return {
      command: "omp",
      args: [
        "-p",
        "--no-session",
        "--auto-approve",
        "--approval-mode",
        "yolo",
        "--model",
        `openai-codex/${model}`,
        "--cwd",
        workspace,
        prompt,
      ],
      cwd: workspace,
      env: buildBenchmarkEnvironment(),
      model: `openai-codex/${model}`,
    };
  }
  if (system === "senpi") {
    return {
      command: "senpi",
      args: [
        "-p",
        "--no-session",
        "--approve",
        "--permission-preset",
        "full-access",
        "--model",
        `openai-codex/${model}`,
        prompt,
      ],
      cwd: workspace,
      env: buildBenchmarkEnvironment(process.env, { PI_TELEMETRY: "0" }),
      model: `openai-codex/${model}`,
    };
  }
  return {
    command: "prime-agent",
    args: [
      "-p",
      "--no-session",
      "--cwd",
      workspace,
      "--provider",
      "openai-codex",
      "--model",
      model,
      prompt,
    ],
    cwd: workspace,
    env: buildBenchmarkEnvironment(),
    model: `openai-codex/${model}`,
  };
}

function materializeFixture(workspace, files) {
  mkdirSync(workspace, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = resolveInside(workspace, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function validateRelativePath(relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid ${label}: ${String(relativePath)}`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Invalid ${label}: ${relativePath}`);
  }
}

function resolveInside(root, relativePath) {
  validateRelativePath(relativePath, "benchmark path");
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Benchmark path escapes workspace: ${relativePath}`);
  }
  return target;
}

export function sanitizeBenchmarkOutput(value, env = {}) {
  let sanitized = value;
  for (const [key, secret] of Object.entries(env)) {
    if (
      SECRET_ENV_NAME_PATTERN.test(key)
      && typeof secret === "string"
      && secret.length >= 8
    ) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
  }
  return sanitized
    .replace(/(?:sk|sess|pat|ghp|xox[baprs])_[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(\b(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)[A-Z0-9_]*|api[_ -]?key)\b\s*[:=]\s*)[^\s]+/gi,
      "$1[REDACTED]",
    )
    .trim()
    .slice(0, 2_000);
}

export async function runCommand(command, args, options) {
  const started = performance.now();
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? buildBenchmarkEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let closed = false;
    const append = (current, chunk) => {
      if (current.length >= OUTPUT_CAP_BYTES) return current;
      return Buffer.concat([current, chunk]).subarray(0, OUTPUT_CAP_BYTES);
    };
    let timer;
    let forceKillTimer;
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      resolve({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        durationMs: Math.round(performance.now() - started),
        timedOut: false,
        errorCode: undefined,
        ...result,
      });
    };
    child.on("error", (error) => {
      closed = true;
      clearTimeout(forceKillTimer);
      finish({ code: null, signal: null, errorCode: error.code });
    });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(forceKillTimer);
      finish({ code, signal });
    });
    const signalProcessTree = (signal) => {
      if (child.pid === undefined) {
        child.kill(signal);
        return;
      }
      if (process.platform === "win32") {
        const taskkill = spawn("taskkill", buildWindowsTreeKillArgs(child.pid), {
          stdio: "ignore",
          windowsHide: true,
        });
        taskkill.once("error", () => child.kill(signal));
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") child.kill(signal);
      }
    };
    timer = setTimeout(() => {
      if (settled) return;
      signalProcessTree("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!closed) signalProcessTree("SIGKILL");
      }, 1_000);
      forceKillTimer.unref();
      settled = true;
      resolve({
        code: null,
        signal: "SIGTERM",
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        durationMs: Math.round(performance.now() - started),
        timedOut: true,
        errorCode: undefined,
      });
    }, options.timeoutMs ?? 180_000);
    timer.unref();
  });
}

function parseArgs(argv) {
  const options = {
    systems: ["unclecode"],
    model: "gpt-5.6-sol",
    suitePath: DEFAULT_SUITE_PATH,
    reportPath: DEFAULT_REPORT_PATH,
    keepWorkspaces: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--systems") {
      const value = argv[++index];
      if (!value) throw new Error("--systems requires a comma-separated value");
      options.systems = value === "all" ? [...SYSTEM_IDS] : value.split(",").filter(Boolean);
    } else if (arg === "--model") {
      options.model = argv[++index] ?? "";
      if (!options.model) throw new Error("--model requires a value");
    } else if (arg === "--suite") {
      options.suitePath = argv[++index] ?? "";
      if (!options.suitePath) throw new Error("--suite requires a path");
    } else if (arg === "--output") {
      options.reportPath = argv[++index] ?? "";
      if (!options.reportPath) throw new Error("--output requires a path");
    } else if (arg === "--keep-workspaces") {
      options.keepWorkspaces = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/competitive-benchmark.mjs [--systems unclecode,omp,senpi,prime-agent|all] [--model gpt-5.6-sol] [--suite path] [--output path] [--keep-workspaces] [--json]");
      return null;
    } else {
      throw new Error(`Unknown benchmark option: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) return;
  const { report, reportPath } = await runCompetitiveBenchmark(options);
  const processResult = benchmarkProcessResult(report, reportPath);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = processResult.exitCode;
    return;
  }
  console.log(`Competitive benchmark: ${report.summary.pass}/${report.summary.total} passed`);
  for (const result of report.results) {
    console.log(`${result.system.padEnd(12)} ${result.taskId.padEnd(34)} ${result.status.padEnd(11)} ${result.durationMs}ms`);
  }
  console.log(`Report: ${path.relative(REPO_ROOT, reportPath)}`);
  if (processResult.failureSummary.length > 0) {
    console.error("Competitive benchmark failed:");
    for (const failure of processResult.failureSummary) console.error(`- ${failure}`);
  }
  process.exitCode = processResult.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
