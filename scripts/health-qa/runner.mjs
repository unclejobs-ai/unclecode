import { spawn } from "node:child_process";

import { collectProcessTreePids, terminateProcessTree } from "./process-tree.mjs";
import { startTimeoutWatchdog, terminateWatchdog } from "./timeout-watchdog.mjs";

export const DEFAULT_CHECK_TIMEOUT_MS = 300_000;
export const DEFAULT_KILL_GRACE_MS = 2_000;
const PROCESS_TREE_SAMPLE_INTERVAL_MS = 100;

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAtMs = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: shouldUseProcessGroup(),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const watchdog = shouldUseProcessGroup()
      ? startTimeoutWatchdog(child.pid, timeoutMs, killGraceMs)
      : null;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;
    let treeSampler = null;
    let settled = false;
    const knownDescendantPids = new Set();
    const sampleProcessTree = () => {
      for (const pid of collectProcessTreePids(child)) {
        if (pid !== child.pid) {
          knownDescendantPids.add(pid);
        }
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (treeSampler) clearInterval(treeSampler);
      terminateWatchdog(watchdog);
      resolve(result);
    };
    if (shouldUseProcessGroup()) {
      treeSampler = setInterval(sampleProcessTree, PROCESS_TREE_SAMPLE_INTERVAL_MS);
    }
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM", knownDescendantPids);
      killTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL", knownDescendantPids);
      }, killGraceMs);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        code: 1,
        signal: null,
        stdout,
        stderr: appendLine(stderr, formatSpawnError(error)),
        startedAtMs,
        timedOut,
        timeoutMs,
      });
    });
    child.on("close", (code, signal) => {
      const didTimeOut = timedOut || Date.now() - startedAtMs >= timeoutMs;
      if (didTimeOut) {
        sampleProcessTree();
        terminateProcessTree(child, "SIGKILL", knownDescendantPids);
      }
      finish({
        code: didTimeOut ? normalizeTimedOutCode(code, signal) : code ?? (signal ? 1 : 0),
        signal,
        stdout,
        stderr,
        startedAtMs,
        timedOut: didTimeOut,
        timeoutMs,
      });
    });
  });
}

function appendLine(value, line) {
  return value ? `${value}\n${line}` : line;
}

function normalizeTimedOutCode(code, _signal) {
  return code || 1;
}

function formatSpawnError(error) {
  return error instanceof Error ? error.message : String(error);
}

function shouldUseProcessGroup() {
  return process.platform !== "win32";
}
