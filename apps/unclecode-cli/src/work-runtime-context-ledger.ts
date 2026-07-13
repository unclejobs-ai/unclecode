import { randomUUID } from "node:crypto";

import type { createAgentOpsStore } from "@unclecode/agentops-db";
import {
  buildContextPacketSourceRefs,
  evaluateContextPolicy,
} from "@unclecode/orchestrator";
import type {
  ContextPacketReceipt,
  ContextPacketReceiptSourceRef,
  ContextPacketView,
  ContextPacketViewActionReceipt,
  ContextPolicySuggestion,
  ContextPolicySuggestionState,
  SubmitContextPacketReceiptInput,
} from "@unclecode/contracts";

type AgentOpsStore = ReturnType<typeof createAgentOpsStore>;

export type ContextLedgerRuntime = {
  previewPacket(input: {
    sessionId: string;
    packet: ContextPacketView;
    profile: string;
  }): ContextPacketReceipt;
  invalidatePreview(receiptId: string): ContextPacketReceipt;
  submitPreview(input: Omit<SubmitContextPacketReceiptInput, "projectId">): ContextPacketReceipt;
  getReceipt(receiptId: string): ContextPacketReceipt | undefined;
  getActivePreview(sessionId: string): ContextPacketReceipt | undefined;
  protectedSourceIds(): ReadonlySet<string>;
  generateSuggestions(input: {
    receipt: ContextPacketReceipt;
    packet: ContextPacketView;
  }): readonly ContextPolicySuggestion[];
  resolveSuggestion(
    suggestionId: string,
    status: Extract<ContextPolicySuggestionState, "accepted" | "rejected">,
  ): ContextPolicySuggestion;
  invalidateSuggestions(receiptId: string): number;
  listSuggestions(receiptId: string): readonly ContextPolicySuggestion[];
};

export type ContextLedgerStoreHandle = {
  readonly store: AgentOpsStore;
  readonly projectId: string;
};

function sourceRefsEquivalent(
  left: readonly ContextPacketReceiptSourceRef[],
  right: readonly ContextPacketReceiptSourceRef[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a === undefined
      || b === undefined
      || a.sourceId !== b.sourceId
      || a.category !== b.category
      || a.sha256 !== b.sha256
      || a.trustTier !== b.trustTier
      || a.salience !== b.salience
      || a.includedInModel !== b.includedInModel
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Derive protected source IDs from in-session CRP action receipts.
 * pin/include protect; unpin/hold-back clear; undo reverses the prior
 * protection-affecting action for that source.
 */
export function deriveProtectedSourceIds(
  receipts: readonly ContextPacketViewActionReceipt[],
): ReadonlySet<string> {
  const events: Array<{ readonly sourceId: string; readonly protects: boolean }> = [];

  for (const receipt of receipts) {
    switch (receipt.action) {
      case "pin":
      case "include":
        events.push({ sourceId: receipt.sourceId, protects: true });
        break;
      case "unpin":
      case "hold-back":
        events.push({ sourceId: receipt.sourceId, protects: false });
        break;
      case "undo": {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          if (events[index]?.sourceId === receipt.sourceId) {
            events.splice(index, 1);
            break;
          }
        }
        break;
      }
    }
  }

  const protectedIds = new Set<string>();
  for (const event of events) {
    if (event.protects) {
      protectedIds.add(event.sourceId);
    } else {
      protectedIds.delete(event.sourceId);
    }
  }
  return protectedIds;
}

export function createContextLedgerRuntime(access: {
  readonly requireStore: () => ContextLedgerStoreHandle;
  readonly listActionReceipts: () => readonly ContextPacketViewActionReceipt[];
}): ContextLedgerRuntime {
  const previewPacket = (input: {
    sessionId: string;
    packet: ContextPacketView;
    profile: string;
  }): ContextPacketReceipt => {
    const { store, projectId } = access.requireStore();
    const sourceRefs = buildContextPacketSourceRefs(input.packet);
    const active = store.getActiveContextPacketPreview(projectId, input.sessionId);
    if (
      active !== undefined
      && active.packetId === input.packet.id
      && sourceRefsEquivalent(active.sourceRefs, sourceRefs)
    ) {
      return active;
    }

    if (active !== undefined) {
      store.invalidateContextPacketReceipt(projectId, active.id);
      store.markContextPolicySuggestionsStale(active.id);
    }

    const recordInput: {
      id: string;
      projectId: string;
      sessionId: string;
      packetId: string;
      profile: string;
      tokenEstimate: number;
      tokenEstimateState: ContextPacketView["tokenEstimateState"];
      sourceCount: number;
      sourceRefs: readonly ContextPacketReceiptSourceRef[];
      replacesReceiptId?: string;
    } = {
      id: randomUUID(),
      projectId,
      sessionId: input.sessionId,
      packetId: input.packet.id,
      profile: input.profile,
      tokenEstimate: input.packet.tokenEstimate,
      tokenEstimateState: input.packet.tokenEstimateState,
      sourceCount: sourceRefs.length,
      sourceRefs,
    };
    if (active !== undefined) {
      recordInput.replacesReceiptId = active.id;
    }
    return store.recordContextPacketPreview(recordInput);
  };

  return {
    previewPacket,
    invalidatePreview(receiptId) {
      const { store, projectId } = access.requireStore();
      const receipt = store.invalidateContextPacketReceipt(projectId, receiptId);
      store.markContextPolicySuggestionsStale(receiptId);
      return receipt;
    },
    submitPreview(input) {
      const { store, projectId } = access.requireStore();
      return store.submitContextPacketReceipt({
        projectId,
        receiptId: input.receiptId,
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
    },
    getReceipt(receiptId) {
      const { store, projectId } = access.requireStore();
      return store.getContextPacketReceipt(projectId, receiptId);
    },
    getActivePreview(sessionId) {
      const { store, projectId } = access.requireStore();
      return store.getActiveContextPacketPreview(projectId, sessionId);
    },
    generateSuggestions(input) {
      const { store } = access.requireStore();
      const suggestions = evaluateContextPolicy(input);
      return store.addContextPolicySuggestions(suggestions);
    },
    resolveSuggestion(suggestionId, status) {
      const { store } = access.requireStore();
      return store.resolveContextPolicySuggestion(suggestionId, status);
    },
    invalidateSuggestions(receiptId) {
      const { store } = access.requireStore();
      return store.markContextPolicySuggestionsStale(receiptId);
    },
    listSuggestions(receiptId) {
      const { store } = access.requireStore();
      return store.listContextPolicySuggestions(receiptId);
    },
    protectedSourceIds() {
      access.requireStore();
      return deriveProtectedSourceIds(access.listActionReceipts());
    },
  };
}
