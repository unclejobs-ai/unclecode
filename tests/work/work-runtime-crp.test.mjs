import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentOpsStore } from "@unclecode/agentops-db";
import { createCrpRuntime } from "../../apps/unclecode-cli/src/work-runtime-crp.ts";
import { createBuiltinProviderRegistry } from "../../packages/context-broker/src/crp-providers.ts";
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
    assert.throws(
      () => runtime.contextLedger.protectedSourceIds(),
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

test("runbook intent, constraints and evidence survive the work graph, the CRP store and packet selection", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-crp-runbook-"));
  const fakeHome = path.join(workspaceRoot, "home");

  try {
    const runtime = createCrpTestRuntime(fakeHome);
    const packet = await runtime.resolveContextPacket({
      cwd: workspaceRoot,
      sessionId: "work-crp-runbook",
      contextSummaryLines: [],
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
      workGraph: {
        id: "graph-desk",
        goal: "Ship the context desk",
        constraints: ["no new dependencies"],
        approval: "approved",
        nodes: [
          {
            id: "node-desk",
            title: "Wire the desk",
            prompt: "PRIVATE_PROMPT wire the Context Desk to the runbook lane",
            status: "requires_action",
            dependsOn: [],
            fileOwnership: ["packages/tui/src/work-shell-view.tsx"],
            acceptanceCriteria: ["Runbook lane renders"],
            evidenceRefs: ["evidence/desk-render.txt"],
          },
        ],
      },
    });

    const item = [...packet.included, ...packet.excluded].find(
      (entry) => entry.id === "goal-loop-graph-desk-node-desk",
    );
    assert.deepEqual(item?.metadata, {
      kind: "work-node",
      graphId: "graph-desk",
      nodeId: "node-desk",
      title: "Wire the desk",
      goal: "Ship the context desk",
      constraints: ["no new dependencies"],
      status: "requires_action",
      acceptanceCriteria: ["Runbook lane renders"],
      evidenceRefs: ["evidence/desk-render.txt"],
    });
    assert.match(item?.preview ?? "", /Aim: Wire the desk/);
    assert.match(item?.preview ?? "", /Done when: Runbook lane renders/);
    assert.match(item?.preview ?? "", /Evidence: evidence\/desk-render\.txt/);
    assert.doesNotMatch(JSON.stringify(item), /PRIVATE_PROMPT|work-shell-view\.tsx/);

    const replacementPacket = await runtime.resolveContextPacket({
      cwd: workspaceRoot,
      sessionId: "work-crp-runbook",
      contextSummaryLines: [],
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
      workGraph: {
        id: "graph-replacement",
        goal: "Ship the replacement plan",
        constraints: [],
        approval: "approved",
        nodes: [{
          id: "node-replacement",
          title: "Verify the replacement",
          prompt: "PRIVATE_PROMPT verify replacement",
          status: "ready",
          dependsOn: [],
          fileOwnership: [],
          acceptanceCriteria: ["Only current work remains"],
          evidenceRefs: [],
        }],
      },
    });
    const replacementItems = [...replacementPacket.included, ...replacementPacket.excluded];
    assert.equal(
      replacementItems.some((entry) => entry.id === "goal-loop-graph-desk-node-desk"),
      false,
      "work nodes from the previous graph must not survive into the next packet",
    );
    assert.ok(
      replacementItems.some(
        (entry) => entry.id === "goal-loop-graph-replacement-node-replacement",
      ),
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("a failed undo reports a human failure and keeps the action recoverable", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-crp-undo-failure-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const storeHome = path.join(fakeHome, ".unclecode", "agentops");
  const contextLine = "Critical source: src/context-desk.ts must stay visible";

  try {
    const runtime = createCrpTestRuntime(fakeHome);
    const input = packetInput(workspaceRoot, "work-crp-undo-failure", contextLine);
    await runtime.resolveContextPacket(input);

    const hold = runtime.mutateContextSource({ kind: "hold-back", id: "workspace-context-1" });
    assert.equal(hold?.canUndo, true);
    assert.equal(hold?.succeeded, true);

    const projectId = runtime.getProjectId();
    const evictor = createAgentOpsStore({ home: storeHome });
    try {
      assert.equal(
        evictor.deleteContextSourcesByIdPrefix({ projectId, idPrefix: "workspace-context-1" }),
        1,
      );
    } finally {
      evictor.close();
    }

    const failed = runtime.undoLastContextSourceAction();
    assert.equal(failed?.action, "undo");
    assert.match(failed?.message ?? "", /Could not undo hold-back on/);
    assert.match(failed?.message ?? "", /Nothing changed, and the undo is still waiting/);
    assert.equal(failed?.canUndo, true);
    assert.equal(failed?.succeeded, false);
    assert.equal(
      runtime.listContextSourceActionReceipts().some((receipt) => receipt.action === "undo"),
      false,
      "a failed undo applies nothing, so it must stay out of the applied-mutation log",
    );

    // The source comes back on the next turn, and the retained entry still
    // carries the state the hold-back replaced.
    await runtime.resolveContextPacket(input);
    const suppressor = createAgentOpsStore({ home: storeHome });
    try {
      suppressor.forgetContextSource(projectId, "workspace-context-1");
    } finally {
      suppressor.close();
    }

    const recovered = runtime.undoLastContextSourceAction();
    assert.equal(recovered?.action, "undo");
    assert.equal(recovered?.before?.includedInModel, false);
    assert.equal(recovered?.after?.includedInModel, true);
    assert.equal(recovered?.canUndo, false);
    assert.equal(runtime.listContextSourceActionReceipts().at(-1), recovered);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("a resolved CRP packet carries the live built-in provider registry as sanitized manifests", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-crp-runtime-registry-"));
  const fakeHome = path.join(workspaceRoot, "home");

  try {
    const runtime = createCrpTestRuntime(fakeHome);
    const packet = await runtime.resolveContextPacket(
      packetInput(workspaceRoot, "work-crp-registry", "Context Desk needs provider attribution"),
    );

    assert.ok(packet.registry, "a production CRP packet must carry the provider registry");
    const providers = packet.registry.providers;
    assert.ok(Array.isArray(providers) && providers.length > 0, "registry providers must be nonempty");
    assert.equal(providers.length, 6, "the projection must carry exactly the six built-in providers");

    for (const provider of providers) {
      assert.equal(typeof provider.providerId, "string", "every projected manifest must carry a provider id");
      assert.ok(provider.providerId.length > 0, "every projected manifest must carry a non-empty provider id");
    }

    const byId = new Map(providers.map((provider) => [provider.providerId, provider]));
    assert.equal(byId.size, providers.length, "projected provider ids must be unique");
    assert.deepEqual(
      [...byId.keys()].sort(),
      ["bridge", "condensed-history", "loop-trail", "memory", "runtime", "workspace-guidance"],
    );
    assert.deepEqual(byId.get("workspace-guidance").categories, ["workspace-guidance", "workspace"]);
    assert.deepEqual(byId.get("bridge").categories, ["bridge"]);
    assert.deepEqual(byId.get("loop-trail").categories, ["loop-trail"]);
    assert.deepEqual(byId.get("memory").categories, ["memory"]);
    assert.deepEqual(byId.get("condensed-history").categories, ["condensed-history"]);
    assert.deepEqual(byId.get("runtime").categories, ["runtime"]);

    for (const provider of providers) {
      assert.deepEqual(
        Object.keys(provider).sort(),
        ["categories", "providerId", "refresh", "trustTier"],
        `provider ${provider.providerId} must expose manifest fields only`,
      );
      assert.equal(typeof provider.sync, "undefined");
      assert.equal(provider.trustTier, "builtin");
      assert.ok(["on-turn", "on-change", "manual"].includes(provider.refresh));
    }

    // The live built-in registry itself must wire exactly these six providers;
    // a silently dropped registration must fail here even if the packet
    // projection above is rebuilt from another source.
    const registryStore = createAgentOpsStore({ home: path.join(fakeHome, ".unclecode", "agentops") });
    try {
      const liveProviders = createBuiltinProviderRegistry(
        registryStore,
        runtime.getProjectId(),
        async () => [],
      ).listProviders();
      const liveIds = liveProviders.map((provider) => provider.providerId);
      assert.deepEqual(
        [...liveIds].sort(),
        ["bridge", "condensed-history", "loop-trail", "memory", "runtime", "workspace-guidance"],
        "createBuiltinProviderRegistry must register exactly the six built-in providers",
      );
      for (const provider of liveProviders) {
        assert.equal(typeof provider.providerId, "string");
        assert.ok(provider.providerId.length > 0, "a live built-in provider must carry a non-empty id");
      }
    } finally {
      registryStore.close();
    }

    // Every packet item attributed to a live provider must resolve inside the manifest.
    for (const item of packet.included) {
      const attributed = item.provenance?.providerId;
      if (typeof attributed === "string" && byId.has(attributed)) {
        assert.ok(byId.get(attributed).categories.length > 0);
      }
    }

    const serialized = JSON.stringify(packet.registry);
    assert.equal(serialized.includes(fakeHome), false, "the registry must not leak store paths");
    assert.equal(/"(sync|store|projectId|listScopedMemoryLines)"/.test(serialized), false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("CRP runtime fallback hides provider and selection diagnostics", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-crp-runtime-fallback-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const injectedPath = "/tmp/fake-project/.unclecode/credentials/openai.json";
  const injectedCredential = "sk-injected-for-test";
  const injectedDiagnostic =
    `${injectedPath} credential=${injectedCredential}\n\u001b[31mprovider selection failed\u001b[0m\r`;
  const expectedStderr = "[crp] Context refresh unavailable; using previous context.\n";
  let stderr = "";
  let selectionFailureAttempted = false;
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };

  try {
    const runtime = createCrpRuntime(
      async () => createLegacyPacket(),
      {
        sourceMetadata: [],
        crpConfig: { enabled: true, tokenBudget: 10_000, modelWindow: 200_000 },
        userHomeDir: fakeHome,
        storeHome: path.join(fakeHome, ".unclecode", "agentops"),
        recordPerformanceSample: (sample) => {
          if (sample.label === "packet-select") {
            selectionFailureAttempted = true;
            throw new Error(injectedDiagnostic);
          }
        },
      },
    );

    const packet = await runtime.resolveContextPacket(
      packetInput(workspaceRoot, "work-crp-runtime-fallback", "context refresh fallback"),
    );

    assert.equal(selectionFailureAttempted, true);
    assert.equal(packet.id, "legacy-context-packet");
    assert.deepEqual(packet.preview, formatContextPacketPromptPrefix(packet).split("\n"));
    assert.equal(stderr, expectedStderr);
    assert.equal(stderr.includes(injectedPath), false);
    assert.equal(stderr.includes(injectedCredential), false);
    assert.doesNotMatch(stderr, /\u001b|\r/);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});