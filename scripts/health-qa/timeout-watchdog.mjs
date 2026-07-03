import { spawn } from "node:child_process";

export function startTimeoutWatchdog(rootPid, timeoutMs, killGraceMs) {
  if (!Number.isInteger(rootPid) || process.platform === "win32") {
    return null;
  }
  const script = buildTimeoutWatchdogScript(rootPid, timeoutMs, killGraceMs);
  const watchdog = spawn("sh", ["-c", script], {
    detached: true,
    stdio: "ignore",
  });
  watchdog.unref();
  return watchdog;
}

export function terminateWatchdog(watchdog) {
  if (!watchdog || !Number.isInteger(watchdog.pid)) {
    return;
  }
  ignoreMissingProcess(() => process.kill(-watchdog.pid, "SIGTERM"));
  ignoreMissingProcess(() => watchdog.kill("SIGTERM"));
}

function buildTimeoutWatchdogScript(rootPid, timeoutMs, killGraceMs) {
  const timeoutSeconds = Math.max(0.001, timeoutMs / 1000).toFixed(3);
  const killGraceSeconds = Math.max(0.001, killGraceMs / 1000).toFixed(3);
  return [
    `root=${String(rootPid)}`,
    "kill_tree() {",
    "  sig=\"$1\"",
    "  if command -v pgrep >/dev/null 2>&1; then",
    "    pgrep -P \"$root\" | while IFS= read -r pid; do",
    "      kill -\"$sig\" -\"$pid\" 2>/dev/null || true",
    "      kill -\"$sig\" \"$pid\" 2>/dev/null || true",
    "    done",
    "  fi",
    "  kill -\"$sig\" -\"$root\" 2>/dev/null || true",
    "  kill -\"$sig\" \"$root\" 2>/dev/null || true",
    "}",
    `sleep ${timeoutSeconds}`,
    "kill_tree TERM",
    `sleep ${killGraceSeconds}`,
    "kill_tree KILL",
  ].join("\n");
}

function ignoreMissingProcess(action) {
  try {
    action();
  } catch (error) {
    if (!(error instanceof Error) || (error.code !== "ESRCH" && error.code !== "EPERM")) {
      throw error;
    }
  }
}
