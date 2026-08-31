import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { currentBootIdentity, processStartIdentity } from "@unclecode/server";

export async function stopRuntimeOwnersUnder(root, dependencies = {}) {
  const bootIdentity = dependencies.currentBootIdentity ?? currentBootIdentity;
  const startIdentity = dependencies.processStartIdentity ?? processStartIdentity;
  const signal = dependencies.kill ?? process.kill.bind(process);
  const pidAlive = dependencies.isPidAlive ?? isPidAlive;
  const timeoutMs = dependencies.timeoutMs ?? 2_000;
  const pollMs = dependencies.pollMs ?? 50;
  const leasePaths = findRuntimeOwnerLeases(root);
  for (const leasePath of leasePaths) {
    let lease;
    try {
      lease = JSON.parse(readFileSync(leasePath, "utf8"));
    } catch {
      continue;
    }
    if (
      !Number.isSafeInteger(lease.pid)
      || typeof lease.processStartId !== "string"
      || lease.bootId !== bootIdentity()
    ) {
      continue;
    }
    const identityDeadline = Date.now() + timeoutMs;
    let observedIdentity = await startIdentity(lease.pid);
    while (observedIdentity === null && pidAlive(lease.pid) && Date.now() < identityDeadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      observedIdentity = await startIdentity(lease.pid);
    }
    if (observedIdentity !== lease.processStartId) {
      if (observedIdentity === null && pidAlive(lease.pid)) {
        throw new Error(`Runtime owner ${lease.pid} has a live but indeterminate lease identity.`);
      }
      continue;
    }
    signal(lease.pid, "SIGTERM");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && pidAlive(lease.pid)) {
      const identity = await startIdentity(lease.pid);
      // A non-null mismatch proves PID reuse. A transient null proves nothing:
      // keep waiting so cleanup cannot race a still-running owner's final write.
      if (identity !== null && identity !== lease.processStartId) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!pidAlive(lease.pid)) continue;
    const forceDeadline = deadline + timeoutMs;
    let remainingIdentity = await startIdentity(lease.pid);
    while (
      remainingIdentity === null
      && pidAlive(lease.pid)
      && Date.now() < forceDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (!pidAlive(lease.pid)) break;
      remainingIdentity = await startIdentity(lease.pid);
    }
    // Normal exit after the liveness probe and PID reuse are both successful
    // cleanup outcomes. Never signal a process whose identity no longer
    // matches the owner lease.
    if (!pidAlive(lease.pid)) continue;
    if (remainingIdentity !== null && remainingIdentity !== lease.processStartId) continue;
    if (remainingIdentity === null) {
      throw new Error(`Runtime owner ${lease.pid} stayed live with indeterminate identity during cleanup.`);
    }

    signal(lease.pid, "SIGKILL");
    while (Date.now() < forceDeadline) {
      if (!pidAlive(lease.pid)) break;
      const liveIdentity = await startIdentity(lease.pid);
      if (liveIdentity !== null && liveIdentity !== lease.processStartId) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!pidAlive(lease.pid)) continue;
    const finalIdentity = await startIdentity(lease.pid);
    if (!pidAlive(lease.pid)) continue;
    if (finalIdentity !== null && finalIdentity !== lease.processStartId) continue;
    throw new Error(
      finalIdentity === null
        ? `Runtime owner ${lease.pid} stayed live with indeterminate identity during cleanup.`
        : `Runtime owner ${lease.pid} did not stop after SIGKILL.`,
    );
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function findRuntimeOwnerLeases(root) {
  if (!existsSync(root)) return [];
  const leases = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) leases.push(...findRuntimeOwnerLeases(resolved));
    else if (entry.isFile() && entry.name === "runtime-owner-v1.json") leases.push(resolved);
  }
  return leases;
}
