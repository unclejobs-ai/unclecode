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

function createCrpTestRuntime(fakeHome) {
  return createCrpRuntime(
    async () => createLegacyPacket(),
    {
      sourceMetadata: [],
      crpConfig: { enabled: true, tokenBudget: 10_000, modelWindow: 200_000 },
      userHomeDir: fakeHome,
      storeHome: path.join(fakeHome, ".unclecode", "agentops"),
    },
  );
}

function packetInput(workspaceRoot, sessionId, contextLine) {
  return {
    cwd: workspaceRoot,
    sessionId,
    contextSummaryLines: [contextLine],
    bridgeLines: [],
    memoryLines: [],
    traceLines: [],
  };
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

test("CRP runtime persists preview replacement and submission", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-crp-ledger-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const contextLine = "Critical source: src/payment.ts must be considered";
  const input = packetInput(workspaceRoot, "work-crp-ledger", contextLine);

  try {
    const runtime = createCrpTestRuntime(fakeHome);
    assert.throws(
      () => runtime.contextLedger.previewPacket({ sessionId: input.sessionId, packet: createLegacyPacket(), profile: "build" }),
      /context packet has been resolved|Context ledger is unavailable/i,
    );
    assert.equal(runtime.getProjectId(), undefined);

    const first = await runtime.resolveContextPacket(input);
    assert.ok(runtime.getProjectId());
    const firstReceipt = runtime.contextLedger.previewPacket({
      sessionId: input.sessionId,
      packet: first,
      profile: "build",
    });
    assert.equal(firstReceipt.state, "previewed");
    assert.equal(firstReceipt.packetId, first.id);
    assert.equal(firstReceipt.projectId, runtime.getProjectId());
    assert.equal(runtime.contextLedger.getActivePreview(input.sessionId)?.id, firstReceipt.id);
    assert.equal(runtime.contextLedger.getReceipt(firstReceipt.id)?.id, firstReceipt.id);

    const reused = runtime.contextLedger.previewPacket({
      sessionId: input.sessionId,
      packet: first,
      profile: "build",
    });
    assert.equal(reused.id, firstReceipt.id);

    runtime.mutateContextSource({ kind: "pin", id: first.included[0].id });

    const second = await runtime.resolveContextPacket(input);
    const secondReceipt = runtime.contextLedger.previewPacket({
      sessionId: input.sessionId,
      packet: second,
      profile: "build",
    });
    assert.equal(runtime.contextLedger.getReceipt(firstReceipt.id)?.state, "invalidated");
    assert.equal(secondReceipt.replacesReceiptId, firstReceipt.id);
    assert.equal(runtime.contextLedger.getActivePreview(input.sessionId)?.id, secondReceipt.id);
    assert.equal(
      runtime.contextLedger.submitPreview({
        receiptId: secondReceipt.id,
        sessionId: input.sessionId,
        turnId: "turn-1",
      }).state,
      "submitted",
    );
    assert.equal(runtime.contextLedger.getActivePreview(input.sessionId), undefined);

    for (const ref of secondReceipt.sourceRefs) {
      assert.equal("content" in ref, false);
      assert.equal("preview" in ref, false);
      assert.equal("reason" in ref, false);
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("CRP runtime ledger reads stay project-scoped and track protected action state", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-crp-protect-"));
  const otherRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-crp-protect-other-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const otherHome = path.join(otherRoot, "home");
  const contextLine = "Critical source: src/auth.ts must stay pinned";

  try {
    const runtime = createCrpTestRuntime(fakeHome);
    const other = createCrpTestRuntime(otherHome);
    const input = packetInput(workspaceRoot, "work-crp-protect", contextLine);
    const otherInput = packetInput(otherRoot, "work-crp-protect-other", contextLine);

    const packet = await runtime.resolveContextPacket(input);
    const otherPacket = await other.resolveContextPacket(otherInput);
    const sourceId = packet.included[0].id;

    const receipt = runtime.contextLedger.previewPacket({
      sessionId: input.sessionId,
      packet,
      profile: "build",
    });
    const otherReceipt = other.contextLedger.previewPacket({
      sessionId: otherInput.sessionId,
      packet: otherPacket,
      profile: "build",
    });

    assert.notEqual(runtime.getProjectId(), other.getProjectId());
    assert.equal(runtime.contextLedger.getReceipt(otherReceipt.id), undefined);
    assert.equal(other.contextLedger.getReceipt(receipt.id), undefined);
    assert.equal(runtime.contextLedger.getActivePreview(otherInput.sessionId), undefined);

    assert.equal(runtime.contextLedger.protectedSourceIds().has(sourceId), false);

    runtime.mutateContextSource({ kind: "pin", id: sourceId });
    assert.equal(runtime.contextLedger.protectedSourceIds().has(sourceId), true);

    runtime.mutateContextSource({ kind: "unpin", id: sourceId });
    assert.equal(runtime.contextLedger.protectedSourceIds().has(sourceId), false);

    runtime.mutateContextSource({ kind: "include", id: sourceId });
    assert.equal(runtime.contextLedger.protectedSourceIds().has(sourceId), true);

    runtime.mutateContextSource({ kind: "hold-back", id: sourceId });
    assert.equal(runtime.contextLedger.protectedSourceIds().has(sourceId), false);

    runtime.mutateContextSource({ kind: "pin", id: sourceId });
    assert.equal(runtime.contextLedger.protectedSourceIds().has(sourceId), true);
    runtime.undoLastContextSourceAction();
    assert.equal(runtime.contextLedger.protectedSourceIds().has(sourceId), false);

    runtime.mutateContextSource({ kind: "pin", id: sourceId });
    runtime.mutateContextSource({ kind: "unpin", id: sourceId });
    assert.equal(runtime.contextLedger.protectedSourceIds().has(sourceId), false);
    runtime.undoLastContextSourceAction();
    assert.equal(runtime.contextLedger.protectedSourceIds().has(sourceId), true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});
