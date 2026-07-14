import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildContextPacketSourceRefs,
  buildMandatorySourceIds,
  classifyContextPacketChange,
  WorkShellEngine,
  persistWorkShellSessionSnapshot,
} from "@unclecode/orchestrator";
import {
  listProjectBridgeLines,
  listScopedMemoryEntries,
  listScopedMemoryLines,
  promoteScopedMemory,
  publishContextBridge,
  writeScopedMemory,
} from "@unclecode/context-broker";
import { createCrpRuntime } from "../../apps/unclecode-cli/src/work-runtime-crp.ts";
import { loadWorkCliBootstrap } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";
import { createContextPacketView } from "../../packages/context-broker/src/context-packet-view.ts";

const RAW_SECRET = `sk-proj-${"s".repeat(48)}`;

function readLifecycleTableText(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const values = [];
    for (const table of [
      "context_sources",
      "context_packet_receipts",
      "context_policy_suggestions",
      "memory_lineage",
    ]) {
      const columns = db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .filter((column) => String(column.type).toUpperCase() === "TEXT");
      for (const column of columns) {
        for (const row of db
          .prepare(`SELECT "${column.name}" AS value FROM "${table}"`)
          .all()) {
          if (row.value !== null) values.push(String(row.value));
        }
      }
    }
    return values.join("\n");
  } finally {
    db.close();
  }
}

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

function packetInput(cwd, sessionId) {
  return {
    cwd,
    sessionId,
    contextSummaryLines: [
      "Critical source: src/context-ledger.ts must remain auditable",
      "Supporting source: tests/context-lifecycle.e2e.test.mjs",
      `Credential fixture: ${RAW_SECRET}`,
    ],
    bridgeLines: [],
    memoryLines: [],
    traceLines: [],
  };
}

const reasoning = {
  effort: "high",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  },
};

function buildContextPanel(
  contextSummaryLines,
  bridgeLines,
  memoryLines,
  traceLines,
  expanded = false,
) {
  return {
    title: expanded ? "Context expanded" : "Context",
    lines: [...contextSummaryLines, ...bridgeLines, ...memoryLines, ...traceLines],
  };
}

test("context lifecycle proves preview, submit, optimizer, lineage, resume, and secrecy", async () => {
  const originalEnv = { ...process.env };
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-lifecycle-e2e-"));
  const userHomeDir = path.join(cwd, "home");
  const storeHome = path.join(userHomeDir, ".unclecode", "agentops");
  const sessionStoreRoot = path.join(cwd, ".state");
  const sessionId = "context-lifecycle-e2e";
  let runtime;
  const env = {
    ...process.env,
    HOME: userHomeDir,
    UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
    LLM_PROVIDER: "openai",
    OPENAI_MODEL: "gpt-5.6-sol",
    OPENAI_API_KEY: "sk-test-123",
  };

  try {
    mkdirSync(userHomeDir, { recursive: true });
    process.env = env;
    delete process.env.OPENAI_AUTH_TOKEN;

    runtime = createCrpRuntime(
      async () => createLegacyPacket(),
      {
        sourceMetadata: [],
        crpConfig: { enabled: true, tokenBudget: 10_000, modelWindow: 200_000 },
        userHomeDir,
        storeHome,
        workspaceRoot: cwd,
      },
    );
    const input = packetInput(cwd, sessionId);
    let frozenProviderPacket;
    const resolveProviderPacket = async () => {
      if (frozenProviderPacket !== undefined) {
        return frozenProviderPacket;
      }
      const packet = await runtime.resolveContextPacket(input);
      return {
        ...packet,
        tokenEstimate: 30_000,
        tokenEstimateState: "exact",
        included: packet.included.map((item) => ({
          ...item,
          trustTier: "runtime",
          tokenEstimate: 10_000,
        })),
      };
    };
    let previewB;
    let submittedB;
    let providerInvoked = false;
    const engine = new WorkShellEngine({
      agent: {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn() {
          providerInvoked = true;
          submittedB = previewB === undefined
            ? undefined
            : runtime.contextLedger.getReceipt(previewB.id);
          assert.equal(submittedB?.state, "submitted");
          return { text: "Lifecycle complete." };
        },
      },
      options: {
        provider: "openai",
        model: "gpt-5.6-sol",
        mode: "build",
        authLabel: "api-key-env",
        reasoning,
        cwd,
        contextProfile: "build",
        contextSummaryLines: input.contextSummaryLines,
      },
      buildContextPanel,
      buildHelpPanel: () => ({ title: "Help", lines: [] }),
      buildStatusPanel: () => ({ title: "Status", lines: [] }),
      buildInlineCommandPanel: (args, lines) => ({
        title: args.join(" "),
        lines,
      }),
      formatInlineCommandResultSummary: (_args, lines) => lines[0] ?? "",
      formatAgentTraceLine: () => "",
      formatWorkShellError: (message) => message,
      listProjectBridgeLines: () =>
        listProjectBridgeLines(cwd, env),
      listScopedMemoryLines: (memoryInput) =>
        listScopedMemoryLines({ ...memoryInput, env }),
      listSessionLines: async () => [],
      persistWorkShellSessionSnapshot: (snapshot) =>
        persistWorkShellSessionSnapshot({ ...snapshot, env }),
      resolveReasoningCommand: (_value, _current, modeDefault) => ({
        nextReasoning: modeDefault,
        message: "reset",
      }),
      resolveWorkShellSlashCommand: () => undefined,
      resolveWorkShellInlineCommand: async () => ({ lines: [], failed: false }),
      resolveComposerInput: async (value) => ({
        prompt: value.trim(),
        attachments: [],
        transcriptText: value.trim(),
      }),
      publishContextBridge: (bridgeInput) =>
        publishContextBridge({ ...bridgeInput, env }),
      writeScopedMemory: (memoryInput) =>
        writeScopedMemory({ ...memoryInput, env }),
      memoryLineage: runtime.contextLedger.memoryLineage,
      promoteScopedMemory: (memoryInput) =>
        promoteScopedMemory({ ...memoryInput, env }),
      resolveContextPacket: resolveProviderPacket,
      mutateContextSource: runtime.mutateContextSource,
      previewContextPacket: ({ sessionId: activeSessionId, packet, profile }) =>
        runtime.contextLedger.previewPacket({
          sessionId: activeSessionId,
          packet,
          profile,
        }),
      revalidateContextPacket: ({ preview, packet }) =>
        classifyContextPacketChange({
          before: preview.sourceRefs,
          after: buildContextPacketSourceRefs(packet),
          protectedSourceIds: runtime.contextLedger.protectedSourceIds(),
          mandatorySourceIds: buildMandatorySourceIds(packet),
        }),
      submitContextPacketReceipt: (receiptInput) =>
        runtime.contextLedger.submitPreview(receiptInput),
      generateContextSuggestions: async (suggestionInput) =>
        runtime.contextLedger.generateSuggestions(suggestionInput),
      resolveContextSuggestion: (suggestionId, status) =>
        runtime.contextLedger.resolveSuggestion(suggestionId, status),
      invalidateContextSuggestions: (receiptId) =>
        runtime.contextLedger.invalidateSuggestions(receiptId),
      sessionId,
      onExit() {},
    });

    await engine.initialize();
    await engine.handleSubmit("/context");
    const previewA = runtime.contextLedger.getActivePreview(sessionId);
    assert.equal(previewA?.state, "previewed");
    assert.equal(engine.getState().panel.title, "Context expanded");
    assert.ok(
      engine.getState().contextPacket?.included.some(
        (item) => item.id === "workspace-context-1",
      ),
    );

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = engine.getState();
      const sources = [
        ...(state.contextPacket?.included ?? []),
        ...(state.contextPacket?.excluded ?? []),
      ];
      if (sources[state.contextInspectorCursor]?.id === "workspace-context-1") {
        break;
      }
      engine.moveContextInspectorCursor(1);
    }
    await engine.toggleContextInspectorPin();
    assert.equal(engine.getState().contextActionReceipt?.action, "pin");
    assert.equal(
      runtime.contextLedger.getReceipt(previewA.id)?.state,
      "invalidated",
    );
    previewB = runtime.contextLedger.getActivePreview(sessionId);
    assert.equal(previewB?.state, "previewed");
    frozenProviderPacket = engine.getState().contextPacket;

    await engine.handleSubmit("finish the lifecycle");
    assert.equal(providerInvoked, true);
    assert.equal(submittedB?.id, previewB.id);
    assert.ok(
      engine.getState().entries.some(
        (entry) =>
          entry.role === "assistant"
          && entry.text === "Lifecycle complete.",
      ),
      JSON.stringify(engine.getState().entries),
    );

    const activeAfterTurn = await listScopedMemoryEntries({
      scope: "session",
      cwd,
      env,
      sessionId,
      lineage: runtime.contextLedger.memoryLineage,
    });
    assert.equal(activeAfterTurn.length, 1);
    assert.match(activeAfterTurn[0]?.summary ?? "", /Lifecycle complete/);
    assert.equal(
      runtime.contextLedger.memoryLineage.get(activeAfterTurn[0].memoryId)
        ?.originPacketReceiptId,
      submittedB.id,
    );

    const suggestions = engine.getState().contextPolicySuggestions;
    assert.ok(suggestions.length >= 2);
    assert.ok(suggestions.every((suggestion) => suggestion.action === "hold-back"));
    const mutationCountBeforeReject =
      runtime.listContextSourceActionReceipts().length;
    const suggestionToReject = suggestions[0];
    await engine.rejectContextSuggestion(suggestionToReject.id);
    assert.equal(
      runtime.contextLedger.listSuggestions(submittedB.id)
        .find((suggestion) => suggestion.id === suggestionToReject.id)
        ?.status,
      "rejected",
    );
    assert.equal(
      runtime.listContextSourceActionReceipts().length,
      mutationCountBeforeReject,
    );
    assert.ok(
      engine.getState().contextPacket?.included.some(
        (item) => item.id === suggestionToReject.sourceId,
      ),
    );

    frozenProviderPacket = undefined;
    const suggestionToAccept = suggestions[1];
    await engine.acceptContextSuggestion(suggestionToAccept.id);
    assert.equal(
      runtime.contextLedger.listSuggestions(submittedB.id)
        .find((suggestion) => suggestion.id === suggestionToAccept.id)
        ?.status,
      "accepted",
    );
    assert.equal(engine.getState().contextActionReceipt?.action, "hold-back");
    assert.ok(
      engine.getState().contextPacket?.excluded.some(
        (item) => item.id === suggestionToAccept.sourceId,
      ),
    );
    const previewC = runtime.contextLedger.getActivePreview(sessionId);
    assert.equal(previewC?.state, "previewed");

    const brokenMemory = await writeScopedMemory({
      scope: "session",
      cwd,
      env,
      sessionId,
      summary: "Memory with unsubmitted packet provenance",
    });
    runtime.contextLedger.memoryLineage.record({
      memoryId: brokenMemory.memoryId,
      sourceId: "assistant-summary",
      originTurnId: "turn-after-preview-c",
      originPacketReceiptId: previewC.id,
      state: "active",
      confidence: 0.9,
    });
    assert.equal(
      runtime.contextLedger.memoryLineage.isActive(brokenMemory.memoryId),
      true,
    );


    const resumed = await loadWorkCliBootstrap({
      argv: ["--cwd", cwd, "--session-id", sessionId],
      env,
      userHomeDir,
    });
    assert.equal(
      runtime.contextLedger.getReceipt(previewC.id)?.state,
      "invalidated",
    );
    assert.equal(runtime.contextLedger.getActivePreview(sessionId), undefined);
    assert.match(resumed.options.initialSessionSummary ?? "", /^Chat:/);
    assert.deepEqual(resumed.options.initialEntries, [
      { role: "user", text: "finish the lifecycle" },
      { role: "assistant", text: "Lifecycle complete." },
    ]);
    assert.equal(
      resumed.options.initialLastSubmittedContextReceiptId,
      submittedB.id,
    );

    const activeAfterResume = await listScopedMemoryEntries({
      scope: "session",
      cwd,
      env,
      sessionId,
      lineage: resumed.options.memoryLineage,
    });
    assert.deepEqual(
      activeAfterResume.map((entry) => entry.memoryId),
      activeAfterTurn.map((entry) => entry.memoryId),
    );
    assert.equal(
      resumed.options.memoryLineage?.isActive(activeAfterTurn[0].memoryId),
      true,
    );
    assert.equal(
      resumed.options.memoryLineage?.isActive(brokenMemory.memoryId),
      false,
    );
    assert.ok(
      !activeAfterResume.some((entry) => entry.memoryId === brokenMemory.memoryId),
    );
    assert.doesNotMatch(
      readLifecycleTableText(path.join(storeHome, "agentops.db")),
      new RegExp(RAW_SECRET),
    );
  } finally {
    process.env = originalEnv;
    rmSync(cwd, { recursive: true, force: true });
  }
});
