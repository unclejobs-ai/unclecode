import { createHash } from "node:crypto";

import type {
  ContextPacketReceipt,
  ContextPacketReceiptSourceRef,
  ContextPacketView,
  ContextPacketViewItem,
  ContextPacketViewTrustTier,
  ContextPolicyAction,
  ContextPolicySuggestion,
} from "@unclecode/contracts";

import { buildMandatorySourceIds } from "./context-packet-change.js";

export type EvaluateContextPolicyInput = {
  readonly receipt: ContextPacketReceipt;
  readonly packet: ContextPacketView;
};

type SuggestionRule = {
  readonly action: ContextPolicyAction;
  readonly reasonCode: string;
  readonly reasonText: string;
};

const ACTION_PRIORITY: Readonly<Record<ContextPolicyAction, number>> = {
  refresh: 0,
  summarize: 1,
  "hold-back": 2,
  keep: 3,
};
const LOW_TRUST_BY_TIER: Readonly<Record<ContextPacketViewTrustTier, boolean>> = {
  builtin: false,
  project: false,
  user: false,
  external: true,
  runtime: true,
};

const MANDATORY_GUIDANCE: SuggestionRule = {
  action: "keep",
  reasonCode: "mandatory-guidance",
  reasonText: "Mandatory guidance must remain active.",
};
const EXPIRED_SOURCE: SuggestionRule = {
  action: "refresh",
  reasonCode: "expired-source",
  reasonText: "Source metadata is expired and must be refreshed.",
};
const STALE_CONDENSED_HISTORY: SuggestionRule = {
  action: "summarize",
  reasonCode: "stale-condensed-history",
  reasonText: "Condensed history is stale and should be summarized.",
};
const DUPLICATE_FINGERPRINT: SuggestionRule = {
  action: "hold-back",
  reasonCode: "duplicate-fingerprint",
  reasonText: "Source duplicates an earlier packet fingerprint.",
};
const LOW_TRUST_TOKEN_HOTSPOT: SuggestionRule = {
  action: "hold-back",
  reasonCode: "low-trust-token-hotspot",
  reasonText: "Low-trust source exceeds 20% of packet tokens.",
};

export function evaluateContextPolicy(
  input: EvaluateContextPolicyInput,
): readonly ContextPolicySuggestion[] {
  if (input.receipt.state !== "submitted") {
    throw new Error(`Context policy requires a submitted receipt: ${input.receipt.id}`);
  }
  if (input.receipt.packetId !== input.packet.id) {
    throw new Error(
      `Submitted receipt packet does not match evaluator packet: ${input.receipt.packetId} != ${input.packet.id}`,
    );
  }

  const itemById = new Map(
    [...input.packet.included, ...input.packet.excluded].map((entry) => [entry.id, entry]),
  );
  const mandatorySourceIds = buildMandatorySourceIds(input.packet);
  const includedRefs = input.receipt.sourceRefs.filter((ref) => ref.includedInModel);
  const seenFingerprints = new Set<string>();
  const suggestions: ContextPolicySuggestion[] = [];
  const packetTokenEstimate = receiptTokenEstimate(input.receipt);

  for (const ref of includedRefs) {
    const item = itemById.get(ref.sourceId);
    const duplicateFingerprint = ref.sha256 !== undefined && seenFingerprints.has(ref.sha256);
    if (ref.sha256 !== undefined) {
      seenFingerprints.add(ref.sha256);
    }

    const rule = resolveSuggestionRule({
      ref,
      item,
      mandatory: mandatorySourceIds.has(ref.sourceId),
      duplicateFingerprint,
      packetTokenEstimate,
    });
    if (rule === undefined) continue;

    const estimatedTokenSaving = resolveEstimatedTokenSaving(rule.action, item);
    suggestions.push({
      id: createSuggestionId(input.receipt.id, ref.sourceId, rule.action),
      packetReceiptId: input.receipt.id,
      sourceId: ref.sourceId,
      action: rule.action,
      reasonCode: rule.reasonCode,
      reasonText: rule.reasonText,
      ...(estimatedTokenSaving === undefined ? {} : { estimatedTokenSaving }),
      status: "proposed",
      createdAt: input.receipt.createdAt,
    });
  }

  return suggestions.sort(compareSuggestions);
}

function createSuggestionId(
  receiptId: string,
  sourceId: string,
  action: ContextPolicyAction,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([receiptId, sourceId, action]))
    .digest("hex")
    .slice(0, 24);
  return `suggestion-${digest}`;
}

function resolveSuggestionRule(input: {
  readonly ref: ContextPacketReceiptSourceRef;
  readonly item: ContextPacketViewItem | undefined;
  readonly mandatory: boolean;
  readonly duplicateFingerprint: boolean;
  readonly packetTokenEstimate: number | undefined;
}): SuggestionRule | undefined {
  if (input.mandatory) {
    return MANDATORY_GUIDANCE;
  }
  if (input.item?.freshness?.state === "expired") {
    return EXPIRED_SOURCE;
  }
  if (
    input.ref.category === "condensed-history"
    && input.item?.freshness?.state === "stale"
  ) {
    return STALE_CONDENSED_HISTORY;
  }
  if (input.duplicateFingerprint) {
    return DUPLICATE_FINGERPRINT;
  }
  if (isLowTrustTokenHotspot(input.ref, input.item, input.packetTokenEstimate)) {
    return LOW_TRUST_TOKEN_HOTSPOT;
  }
  return undefined;
}

function isLowTrustTokenHotspot(
  ref: ContextPacketReceiptSourceRef,
  item: ContextPacketViewItem | undefined,
  packetTokenEstimate: number | undefined,
): boolean {
  const trustTier = ref.trustTier ?? item?.trustTier;
  if (trustTier === undefined || !LOW_TRUST_BY_TIER[trustTier]) {
    return false;
  }
  const sourceTokens = normalizedTokenEstimate(item?.tokenEstimate);
  return (
    sourceTokens !== undefined
    && packetTokenEstimate !== undefined
    && packetTokenEstimate > 0
    && BigInt(sourceTokens) * 5n > BigInt(packetTokenEstimate)
  );
}

function receiptTokenEstimate(receipt: ContextPacketReceipt): number | undefined {
  if (receipt.tokenEstimateState === "unknown") return undefined;
  return normalizedTokenEstimate(receipt.tokenEstimate);
}

function resolveEstimatedTokenSaving(
  action: ContextPolicyAction,
  item: ContextPacketViewItem | undefined,
): number | undefined {
  if (action !== "summarize" && action !== "hold-back") return undefined;
  return normalizedTokenEstimate(item?.tokenEstimate);
}

function normalizedTokenEstimate(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function compareSuggestions(
  left: ContextPolicySuggestion,
  right: ContextPolicySuggestion,
): number {
  const actionDifference = ACTION_PRIORITY[left.action] - ACTION_PRIORITY[right.action];
  if (actionDifference !== 0) return actionDifference;

  const leftSaving = left.estimatedTokenSaving;
  const rightSaving = right.estimatedTokenSaving;
  if (leftSaving !== undefined && rightSaving !== undefined && leftSaving !== rightSaving) {
    return rightSaving - leftSaving;
  }
  if (leftSaving !== undefined) return -1;
  if (rightSaving !== undefined) return 1;

  const sourceDifference = compareStrings(left.sourceId, right.sourceId);
  return sourceDifference !== 0 ? sourceDifference : compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
