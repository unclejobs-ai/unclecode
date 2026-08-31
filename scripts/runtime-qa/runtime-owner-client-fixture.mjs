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
const idempotencyKey = "first-client-mode";
let expectedRevision = created.session.revision;
let changed;
for (let attempt = 0; attempt < 3; attempt += 1) {
  changed = await client.invokeEngineMethod({
    sessionId,
    method: "setMode",
    args: ["deep"],
    expectedRevision,
    idempotencyKey,
  });
  if (changed.ok || changed.code !== "revision_conflict") break;
  const latest = await client.readEngineState(sessionId);
  if (!latest.ok) throw new Error(latest.message);
  expectedRevision = latest.revision;
}
if (!changed.ok) throw new Error(changed.message);
let providerText;
const providerPrompt = process.env.UNCLECODE_RUNTIME_OWNER_PROVIDER_PROMPT?.trim();
if (providerPrompt) {
  const providerResult = await client.invokeEngineMethod({
    sessionId,
    method: "handleSubmit",
    args: [providerPrompt],
    expectedRevision: changed.revision,
    idempotencyKey: "detached-owner-provider-probe",
  });
  if (!providerResult.ok) throw new Error(providerResult.message);
  const providerState = await client.readEngineState(sessionId);
  if (!providerState.ok) throw new Error(providerState.message);
  providerText = providerState.state.entries
    ?.filter(entry => entry?.role === "assistant")
    .at(-1)?.text;
  changed = providerResult;
}
process.stdout.write(`${JSON.stringify({ lease, sessionId, revision: changed.revision, providerText })}\n`);
setInterval(() => {}, 60_000);
