import assert from "node:assert/strict";
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentOpsStore } from "@unclecode/agentops-db";
import {
  createCondensedHistoryProvider,
  selectContextPacketFromStore,
} from "@unclecode/context-broker";

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = join(tmpdir(), `unclecode-condensed-stale-${prefix}-${process.pid}-${tempDirs.length}`);
  tempDirs.push(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

test.afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore() {
  const home = makeTempDir("home");
  const store = createAgentOpsStore({ home });
  store.addProject({ id: "proj_test", name: "Test", repoPath: "/repos/test" });
  return store;
}

test("selectContextPacketFromStore warns when a condensed history summary is stale", () => {
  const store = makeStore();
  store.upsertContextSource({
    id: "condensed-history-s1",
    projectId: "proj_test",
    category: "condensed-history",
    label: "Session history compact",
    content: "History compressed by recent-window summary.",
    reason: "compressed session history; CRP controls inclusion",
    sha256: "digest",
    salience: 0.68,
    tokenEstimate: 11,
    badges: [
      { label: "compressed", tone: "info" },
      { label: "recent-window", tone: "muted" },
    ],
    metadata: {
      kind: "condensed-history",
      sourceEventIds: ["trace-a", "trace-b"],
      summary: "2 earlier trace lines summarized; 8 recent trace lines stay as runtime rows.",
      recomputeReason: "history exceeded recent-window threshold",
      compactedEventCount: 2,
      recentEventCount: 8,
      compression: {
        method: "recent-window",
        inputTokensEstimate: 20,
        outputTokensEstimate: 11,
      },
    },
  });
  store.markContextSourceTurnSeen("proj_test", ["condensed-history-s1"], 1);

  const packet = selectContextPacketFromStore({
    store,
    projectId: "proj_test",
    tokenBudget: 10000,
    turnIndex: 4,
  });

  const item = packet.included.find((entry) => entry.id === "condensed-history-s1");
  assert.ok(item);
  assert.equal(item.freshness?.state, "stale");
  assert.ok(item.actions?.includes("refresh"));
  assert.deepEqual(packet.warnings, [
    {
      code: "context.condensed-history.stale",
      message: "Compressed history summary is stale: Session history compact. Refresh /context before relying on it.",
      severity: "warning",
    },
  ]);
});

test("CondensedHistoryProvider stores bounded raw compacted trace previews in local metadata", async () => {
  const store = makeStore();
  const provider = createCondensedHistoryProvider();
  for (let index = 0; index < 12; index += 1) {
    provider.pushTraceLine(`raw compacted trace ${index}`);
  }

  await provider.sync({
    store,
    projectId: "proj_test",
    cwd: "/repos/test",
    sessionId: "s1",
  });

  const result = store.selectContextSources({
    projectId: "proj_test",
    tokenBudget: 10000,
    turnIndex: 1,
  });
  const record = result.selected.find((item) => item.category === "condensed-history");

  assert.ok(record);
  assert.equal(record.metadata?.kind, "condensed-history");
  assert.deepEqual(record.metadata.sourceEventPreviews, [
    "raw compacted trace 0",
    "raw compacted trace 1",
    "raw compacted trace 2",
    "raw compacted trace 3",
  ]);

  const packet = selectContextPacketFromStore({
    store,
    projectId: "proj_test",
    tokenBudget: 10000,
    turnIndex: 1,
  });
  const item = packet.included.find((entry) => entry.id === record.id);
  assert.deepEqual(item?.metadata?.sourceEventPreviews, record.metadata.sourceEventPreviews);
});

test("CondensedHistoryProvider masks sensitive compacted traces before storing preview metadata", async () => {
  const store = makeStore();
  const provider = createCondensedHistoryProvider();
  provider.pushTraceLine("tool output OPENAI_API_KEY=sk-proj-1234567890abcdef");
  for (let index = 0; index < 11; index += 1) {
    provider.pushTraceLine(`safe recent trace ${index}`);
  }

  await provider.sync({
    store,
    projectId: "proj_test",
    cwd: "/repos/test",
    sessionId: "s1",
  });

  const result = store.selectContextSources({
    projectId: "proj_test",
    tokenBudget: 10000,
    turnIndex: 1,
  });
  const record = result.selected.find((item) => item.category === "condensed-history");

  assert.ok(record);
  assert.equal(record.metadata?.kind, "condensed-history");
  assert.equal(record.metadata.compression.method, "masking");
  assert.ok(record.badges?.some((badge) => badge.label === "masking" && badge.tone === "warning"));
  assert.match(record.content ?? "", /OPENAI_API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(record.content ?? "", /sk-proj-1234567890abcdef/);
  assert.deepEqual(record.metadata.sourceEventPreviews?.[0], "tool output OPENAI_API_KEY=[REDACTED]");
});
