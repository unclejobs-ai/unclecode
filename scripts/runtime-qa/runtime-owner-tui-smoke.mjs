#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RuntimeOwnerClient,
  probeRuntimeOwner,
  readRuntimeOwnerLease,
} from "../../apps/unclecode-server/src/index.ts";
import { responseText } from "./constants.mjs";
import { startGeminiServer } from "./fake-gemini-server.mjs";
import { run, shellQuote, sleep } from "./cli-helpers.mjs";
import { capturePane, killRuntimeTmuxServer, runTmux, typeKeys, waitForPane } from "./tmux-helpers.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const home = await mkdtemp(path.join(tmpdir(), "unclecode-owner-tui-"));
const paneFile = path.join(home, "pane.txt");
const sessionOne = `unclecode-owner-tui-a-${process.pid}`;
const sessionTwo = `unclecode-owner-tui-b-${process.pid}`;
const observations = [];
const provider = await startGeminiServer(value => observations.push(value));
let ownerPid;

async function waitUntil(read, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await read();
    if (value) return value;
    await sleep(25);
  }
  throw new Error("Timed out waiting for runtime owner state.");
}

async function waitForStableState(client, sessionId) {
  let previous;
  let stable = 0;
  return waitUntil(async () => {
    const value = await client.readEngineState(sessionId);
    if (!value.ok) return undefined;
    stable = value.revision === previous ? stable + 1 : 0;
    previous = value.revision;
    return stable >= 4 ? value : undefined;
  });
}

function tuiCommand(sessionId) {
  const args = [
    `HOME=${shellQuote(home)}`,
    "UNCLECODE_MODE=default",
    `GEMINI_API_BASE_URL=${shellQuote(`http://127.0.0.1:${provider.port}/v1beta`)}`,
    "GEMINI_API_KEY=local-provider-test-key",
    "NO_PROXY=127.0.0.1,localhost",
    `${shellQuote(process.execPath)} bin/unclecode.cjs tui --provider gemini --model gemini-2.5-flash`,
    ...(sessionId ? ["--session-id", shellQuote(sessionId)] : []),
  ];
  return `cd ${shellQuote(repoRoot)} && ${args.join(" ")}; status=$?; echo EXIT:$status; sleep 60`;
}

async function stopExactOwner(lease, leasePath) {
  if (!lease || !await probeRuntimeOwner(lease)) return;
  process.kill(lease.pid, "SIGTERM");
  await waitUntil(async () => !await probeRuntimeOwner(lease)
    && await readRuntimeOwnerLease(leasePath) === null, 5_000);
}

try {
  assert.equal((await run("sh", ["-lc", "command -v tmux"], process.env)).code, 0);
  await runTmux(["new-session", "-d", "-x", "100", "-y", "30", "-s", sessionOne, tuiCommand()]);
  await waitForPane(sessionOne, /prompt deck|UncleCode · Gemini/, paneFile);
  const leasePath = path.join(home, ".unclecode", "runtime-owner-v1.json");
  const lease = await waitUntil(() => readRuntimeOwnerLease(leasePath));
  ownerPid = lease.pid;
  const client = await RuntimeOwnerClient.connect(lease);
  const [owned] = await waitUntil(async () => {
    const sessions = await client.listRuntimeSessions();
    return sessions.length > 0 ? sessions : undefined;
  });

  await typeKeys(sessionOne, "ASCII 한글 draft");
  await waitForPane(sessionOne, /ASCII 한글 draft/, paneFile);
  await runTmux(["send-keys", "-t", sessionOne, "C-o"]);
  const afterToggle = await waitForPane(sessionOne, /ASCII 한글 draft/, paneFile);
  assert.doesNotMatch(afterToggle, /Sessions|세션 목록/);
  await runTmux(["send-keys", "-t", sessionOne, "C-u"]);
  await typeKeys(sessionOne, "한글 질문입니다");
  await runTmux(["send-keys", "-t", sessionOne, "C-m"]);
  const completed = await waitUntil(async () => {
    const value = await client.readEngineState(owned.sessionId);
    return value.ok && value.state.uiLocale === "ko" && JSON.stringify(value.state).includes(responseText)
      ? value
      : undefined;
  });
  const koreanPane = await waitForPane(sessionOne, /Enter 전송|준비 완료/, paneFile);
  assert.match(koreanPane, /한글 질문입니다/);
  const beforeDetach = await waitForStableState(client, owned.sessionId);

  await runTmux(["kill-session", "-t", sessionOne]);
  assert.equal(await probeRuntimeOwner(lease), true, "detached owner must survive TUI pane loss");
  assert.equal((await client.readEngineState(owned.sessionId)).revision, beforeDetach.revision);

  await runTmux(["new-session", "-d", "-x", "100", "-y", "30", "-s", sessionTwo, tuiCommand(owned.sessionId)]);
  await waitForPane(sessionTwo, /prompt deck|UncleCode · Gemini/, paneFile);
  const sameLease = await readRuntimeOwnerLease(leasePath);
  assert.equal(sameLease.pid, lease.pid);
  assert.equal(sameLease.endpoint, lease.endpoint);
  assert.equal(sameLease.ownerId, lease.ownerId);
  await typeKeys(sessionTwo, "reattach draft");
  await runTmux(["send-keys", "-t", sessionTwo, "C-o"]);
  const reattachedPane = await waitForPane(sessionTwo, /reattach draft/, paneFile);
  assert.doesNotMatch(reattachedPane, /Sessions|세션 목록/);
  const revisionAfterReattach = (await client.readEngineState(owned.sessionId)).revision;
  assert.equal(revisionAfterReattach >= beforeDetach.revision, true);

  await runTmux(["kill-session", "-t", sessionTwo]);
  await stopExactOwner(lease, leasePath);
  await assert.rejects(readFile(leasePath, "utf8"));
  await assert.rejects(fetch(`${lease.endpoint}/health`, { signal: AbortSignal.timeout(500) }));
  console.log(JSON.stringify({
    ok: true,
    chain: "bin -> Rust -> Node -> Ink -> detached owner",
    ownerPid: lease.pid,
    endpoint: lease.endpoint,
    sessionId: owned.sessionId,
    revisionBeforeDetach: beforeDetach.revision,
    revisionAfterReattach,
    promptInput: true,
    locale: "ko",
    ctrlO: "tool-history only; draft preserved",
    cleanup: "owner stopped; lease and listener removed",
  }, null, 2));
} finally {
  await runTmux(["kill-session", "-t", sessionOne], { allowFailure: true });
  await runTmux(["kill-session", "-t", sessionTwo], { allowFailure: true });
  if (ownerPid) {
    const lease = await readRuntimeOwnerLease(path.join(home, ".unclecode", "runtime-owner-v1.json"));
    await stopExactOwner(lease, path.join(home, ".unclecode", "runtime-owner-v1.json")).catch(() => undefined);
  }
  await provider.close();
  await killRuntimeTmuxServer();
}
