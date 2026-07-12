import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCrpRuntime } from "../../apps/unclecode-cli/src/work-runtime-crp.ts";
import {
  createContextPacketView,
  formatContextPacketPromptPrefix,
} from "../../packages/context-broker/src/context-packet-view.ts";

function createLegacyPacket() {
  return createContextPacketView({
    id: "legacy-context-packet",
    generatedAt: new Date().toISOString(),
    included: [],
    excluded: [],
    warnings: [],
    preview: ["legacy context"],
  });
}

test("createCrpRuntime mutates source visibility for the next provider prompt", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-crp-runtime-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const contextLine = "Critical source: src/payment.ts must be considered";

  try {
    const runtime = createCrpRuntime(
      async () => createLegacyPacket(),
      {
        sourceMetadata: [],
        crpConfig: { enabled: true, tokenBudget: 10_000, modelWindow: 200_000 },
        userHomeDir: fakeHome,
        storeHome: path.join(fakeHome, ".unclecode", "agentops"),
      },
    );

    const first = await runtime.resolveContextPacket({
      cwd: workspaceRoot,
      sessionId: "work-crp-mutation",
      contextSummaryLines: [contextLine],
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
    });
    assert.ok(first.included.some((item) => item.id === "workspace-context-1"));
    assert.match(formatContextPacketPromptPrefix(first), /src\/payment\.ts/);

    runtime.mutateContextSource({ kind: "forget", id: "workspace-context-1" });
    const heldBack = await runtime.resolveContextPacket({
      cwd: workspaceRoot,
      sessionId: "work-crp-mutation",
      contextSummaryLines: [contextLine],
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
    });
    assert.equal(heldBack.included.some((item) => item.id === "workspace-context-1"), false);
    assert.ok(heldBack.excluded.some((item) => item.id === "workspace-context-1"));
    assert.doesNotMatch(formatContextPacketPromptPrefix(heldBack), /src\/payment\.ts/);

    runtime.mutateContextSource({ kind: "include", id: "workspace-context-1" });
    const restored = await runtime.resolveContextPacket({
      cwd: workspaceRoot,
      sessionId: "work-crp-mutation",
      contextSummaryLines: [contextLine],
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
    });
    assert.ok(restored.included.some((item) => item.id === "workspace-context-1"));
    assert.match(formatContextPacketPromptPrefix(restored), /src\/payment\.ts/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("createCrpRuntime records source action receipts and undo restores the provider prompt", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-crp-runtime-undo-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const contextLine = "Critical source: src/context-ledger.ts must remain auditable";

  try {
    const runtime = createCrpRuntime(
      async () => createLegacyPacket(),
      {
        sourceMetadata: [],
        crpConfig: { enabled: true, tokenBudget: 10_000, modelWindow: 200_000 },
        userHomeDir: fakeHome,
        storeHome: path.join(fakeHome, ".unclecode", "agentops"),
      },
    );

    const first = await runtime.resolveContextPacket({
      cwd: workspaceRoot,
      sessionId: "work-crp-undo",
      contextSummaryLines: [contextLine],
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
    });
    assert.match(formatContextPacketPromptPrefix(first), /src\/context-ledger\.ts/);

    const holdReceipt = runtime.mutateContextSource({ kind: "hold-back", id: "workspace-context-1" });
    assert.equal(holdReceipt?.action, "hold-back");
    assert.equal(holdReceipt?.before?.includedInModel, true);
    assert.equal(holdReceipt?.after?.includedInModel, false);
    assert.equal(holdReceipt?.canUndo, true);
    assert.equal(runtime.listContextSourceActionReceipts().at(-1), holdReceipt);

    const heldBack = await runtime.resolveContextPacket({
      cwd: workspaceRoot,
      sessionId: "work-crp-undo",
      contextSummaryLines: [contextLine],
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
    });
    assert.doesNotMatch(formatContextPacketPromptPrefix(heldBack), /src\/context-ledger\.ts/);

    const undoReceipt = runtime.undoLastContextSourceAction();
    assert.equal(undoReceipt?.action, "undo");
    assert.equal(undoReceipt?.before?.includedInModel, false);
    assert.equal(undoReceipt?.after?.includedInModel, true);
    assert.equal(runtime.listContextSourceActionReceipts().at(-1), undoReceipt);

    const restored = await runtime.resolveContextPacket({
      cwd: workspaceRoot,
      sessionId: "work-crp-undo",
      contextSummaryLines: [contextLine],
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
    });
    assert.match(formatContextPacketPromptPrefix(restored), /src\/context-ledger\.ts/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
