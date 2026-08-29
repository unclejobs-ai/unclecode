import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { currentBootIdentity, processStartIdentity } from "@unclecode/server";

export async function stopRuntimeOwnersUnder(root) {
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
      || lease.bootId !== currentBootIdentity()
      || await processStartIdentity(lease.pid) !== lease.processStartId
    ) {
      continue;
    }
    process.kill(lease.pid, "SIGTERM");
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && await processStartIdentity(lease.pid) === lease.processStartId) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (await processStartIdentity(lease.pid) === lease.processStartId) {
      process.kill(lease.pid, "SIGKILL");
    }
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
