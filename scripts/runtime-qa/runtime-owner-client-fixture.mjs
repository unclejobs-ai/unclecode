import { randomUUID } from "node:crypto";

import {
  RuntimeOwnerClient,
  defaultRuntimeOwnerPaths,
  ensureRuntimeOwner,
  probeRuntimeOwner,
} from "../../apps/unclecode-server/src/index.ts";
import { spawnDetachedRuntimeOwner } from "../../apps/unclecode-cli/src/runtime-owner-launcher.ts";

const projectPath = process.argv[2];
if (!projectPath) throw new Error("workspace path is required");
const paths = defaultRuntimeOwnerPaths(process.env.HOME);
const lease = await ensureRuntimeOwner({
  leasePath: paths.leasePath,
  lockPath: paths.lockPath,
  health: probeRuntimeOwner,
  startOwner: () => spawnDetachedRuntimeOwner({ leasePath: paths.leasePath, tokenPath: paths.tokenPath }),
});
const client = await RuntimeOwnerClient.connect(lease);
const sessionId = `detach-${randomUUID()}`;
const created = await client.createRuntimeSession({
  sessionId,
  projectPath,
  provider: "gemini",
  model: "gemini-2.5-flash",
  idempotencyKey: `create-${sessionId}`,
});
if (!created.ok) throw new Error(created.message);
const changed = await client.invokeEngineMethod({
  sessionId,
  method: "setMode",
  args: ["deep"],
  expectedRevision: created.session.revision,
  idempotencyKey: "first-client-mode",
});
if (!changed.ok) throw new Error(changed.message);
process.stdout.write(`${JSON.stringify({ lease, sessionId, revision: changed.revision })}\n`);
setInterval(() => {}, 60_000);
