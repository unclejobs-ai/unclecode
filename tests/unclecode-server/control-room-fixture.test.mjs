import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("../../scripts/runtime-qa/control-room-fixture.mjs", import.meta.url),
);

function waitForFixtureUrl(child, stderr) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const onData = (chunk) => {
      stdout += chunk.toString("utf8");
      const [line] = stdout.split(/\r?\n/, 1);
      if (!line) return;
      child.stdout.off("data", onData);
      resolve(line);
    };
    child.stdout.on("data", onData);
    child.once("exit", (code, signal) => {
      reject(new Error(
        `control-room fixture exited before readiness (${String(code ?? signal)}): ${stderr.join("")}`,
      ));
    });
    child.once("error", reject);
  });
}

async function readSseEvent(response, eventName) {
  const reader = response.body?.getReader();
  assert.ok(reader, "SSE response must expose a readable body");
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(`event: ${eventName}\n`)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

test("control-room runtime-QA fixture serves canonical System evidence and cleans up", {
  timeout: 15_000,
}, async (t) => {
  const token = "fixture-smoke-token-0123456789abcdef";
  const stderr = [];
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--conditions=source", "--import", "tsx", fixturePath],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        BROWSER: "/definitely-not-a-browser",
        UNCLECODE_FIXTURE_PORT: "0",
        UNCLECODE_FIXTURE_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.on("data", chunk => stderr.push(chunk.toString("utf8")));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  const endpoint = await waitForFixtureUrl(child, stderr);
  const parsedEndpoint = new URL(endpoint);
  assert.equal(parsedEndpoint.hostname, "127.0.0.1");

  const unauthorized = await fetch(`${endpoint}/control-room`);
  assert.equal(unauthorized.status, 401);

  const headers = { authorization: `Bearer ${token}` };
  const snapshotResponse = await fetch(`${endpoint}/control-room`, { headers });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.deepEqual(snapshot.system.evidenceSources, {
    owner: "available",
    cacheTelemetry: "available",
  });
  assert.equal(snapshot.system.providers[0]?.provider, "openai");
  assert.equal(snapshot.system.mcpServers[0]?.transport, "stdio");
  assert.equal(snapshot.system.pluginHosts[0]?.registrations[0]?.trustLane, "workspace-trusted");
  assert.equal(snapshot.system.cleanup[0]?.kind, "plugin-host");
  assert.equal(snapshot.system.caches[0]?.name, "control-room-fixture");
  assert.deepEqual(snapshot.runs[0]?.system.diagnostics[0], {
    runId: "run-ko-scc-001",
    source: "workspace",
    trust: "workspace-trusted",
    pluginId: "legacy-external-plugin",
    hook: "Stop",
    status: "error",
    exitStatus: "2",
    error: "Stop hook failed: incompatible zod/v3 adapter",
    dedupeKey: `sha256:${"d".repeat(64)}`,
  });

  const sseResponse = await fetch(`${endpoint}/sessions/run-ko-scc-001/events`, { headers });
  assert.equal(sseResponse.status, 200);
  assert.match(sseResponse.headers.get("content-type") ?? "", /^text\/event-stream/);
  const eventPromise = readSseEvent(sseResponse, "run.updated");
  const actionResponse = await fetch(`${endpoint}/sessions/run-ko-scc-001/actions/pause`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "idempotency-key": "fixture-smoke-pause",
    },
    body: JSON.stringify({ expectedRevision: 12 }),
  });
  assert.equal(actionResponse.status, 200);
  assert.deepEqual(await actionResponse.json(), { ok: true, revision: 13, state: "paused" });
  assert.match(await eventPromise, /"revision":13/);

  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(stderr.join(""), "");
  await assert.rejects(fetch(`${endpoint}/health`));
});
