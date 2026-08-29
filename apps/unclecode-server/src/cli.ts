#!/usr/bin/env node

import {
  defaultRuntimeOwnerPaths,
  probeRuntimeOwner,
  readRuntimeOwnerLease,
  type RuntimeOwnerLease,
} from "./index.js";
import { boundedRuntimeRpcError } from "./runtime-error-redaction.js";

async function waitForOwner(timeoutMs: number): Promise<RuntimeOwnerLease> {
  const { leasePath } = defaultRuntimeOwnerPaths(process.env.HOME);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const lease = await readRuntimeOwnerLease(leasePath);
    if (lease && await probeRuntimeOwner(lease)) return lease;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("No healthy runtime owner is available. Start `unclecode work` and retry.");
}

async function main(): Promise<void> {
  const configured = Number.parseInt(process.env.UNCLECODE_OWNER_ATTACH_TIMEOUT_MS ?? "10000", 10);
  const lease = await waitForOwner(Number.isFinite(configured) && configured >= 0 ? configured : 10_000);
  process.stdout.write(`unclecode-server attached to runtime owner at ${lease.endpoint}\n`);
  process.stdout.write(`Owner PID ${lease.pid}; protocol ${lease.protocol}. No second listener was created.\n`);
  process.stdout.write("Use ~/.unclecode/server.token for authenticated HTTP/SSE.\n");
  await new Promise<void>(() => {
    process.once("SIGTERM", () => process.exit(0));
    process.once("SIGINT", () => process.exit(0));
  });
}

main().catch((error) => {
  process.stderr.write(`unclecode-server failed: ${boundedRuntimeRpcError(error)}\n`);
  process.exitCode = 1;
});
