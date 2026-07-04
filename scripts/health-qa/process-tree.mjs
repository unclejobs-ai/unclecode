import { execFileSync } from "node:child_process";

export function terminateProcessTree(child, signal, knownDescendantPids = []) {
  const rootPid = child.pid;
  if (!Number.isInteger(rootPid)) {
    child.kill(signal);
    return;
  }

  killImmediateChildren(rootPid, signal);
  if (shouldUseProcessGroup()) {
    killPid(-rootPid, signal);
  }
  killPid(rootPid, signal);

  const pids = [...new Set([...collectProcessTree(rootPid), ...collectProcessGroup(rootPid), ...knownDescendantPids])];
  for (const pid of pids.filter((pid) => pid !== rootPid).reverse()) {
    killPid(pid, signal);
  }
}

export function collectProcessTreePids(child) {
  const rootPid = child.pid;
  return Number.isInteger(rootPid) ? collectProcessTree(rootPid) : [];
}

function shouldUseProcessGroup() {
  return process.platform !== "win32";
}

function collectProcessTree(rootPid) {
  if (process.platform === "win32") {
    return [rootPid];
  }

  const childrenByParent = new Map();
  for (const row of readProcessRows()) {
    const childPids = childrenByParent.get(row.ppid) ?? [];
    childPids.push(row.pid);
    childrenByParent.set(row.ppid, childPids);
  }

  const pids = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (!pid || pids.includes(pid)) {
      continue;
    }
    pids.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return pids;
}

function collectProcessGroup(rootPid) {
  if (process.platform === "win32") {
    return [rootPid];
  }

  const rows = readProcessRows();
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) {
    return [];
  }
  return rows.filter((row) => row.pgid === root.pgid).map((row) => row.pid);
}

function readProcessRows() {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8" });
    return output
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, ppid, pgid]) => Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid))
      .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
  } catch {
    return [];
  }
}

function killImmediateChildren(rootPid, signal) {
  if (process.platform === "win32") {
    return;
  }
  for (const pid of readImmediateChildPids(rootPid)) {
    killPid(-pid, signal);
    killPid(pid, signal);
  }
}

function readImmediateChildPids(rootPid) {
  try {
    const output = execFileSync("pgrep", ["-P", String(rootPid)], { encoding: "utf8" });
    return output
      .trim()
      .split(/\r?\n/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid));
  } catch {
    return [];
  }
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error instanceof Error && error.code === "ESRCH") {
      return;
    }
    if (error instanceof Error && error.code === "EPERM") {
      return;
    }
    throw error;
  }
}
