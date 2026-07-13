import type {
  ContextPacketSourceCategory,
  ContextPacketTokenEstimateState,
  ContextPacketViewTrustTier,
} from "./context-packet-view.js";

export const CONTEXT_PACKET_RECEIPT_STATES = ["previewed", "submitted", "invalidated"] as const;
export type ContextPacketReceiptState = (typeof CONTEXT_PACKET_RECEIPT_STATES)[number];

export type ContextPacketReceiptSourceRef = {
  readonly sourceId: string;
  readonly category: ContextPacketSourceCategory;
  readonly sha256?: string | undefined;
  readonly trustTier?: ContextPacketViewTrustTier | undefined;
  readonly salience: number;
  readonly includedInModel: boolean;
};

export type ContextPacketReceipt = {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly packetId: string;
  readonly state: ContextPacketReceiptState;
  readonly replacesReceiptId?: string | undefined;
  readonly profile: string;
  readonly tokenEstimate?: number | undefined;
  readonly tokenEstimateState: ContextPacketTokenEstimateState;
  readonly sourceCount: number;
  readonly sourceRefs: readonly ContextPacketReceiptSourceRef[];
  readonly createdAt: string;
};

export type RecordContextPacketPreviewInput = Omit<
  ContextPacketReceipt,
  "state" | "turnId" | "createdAt"
> & { readonly createdAt?: string | undefined };

export type SubmitContextPacketReceiptInput = {
  readonly projectId: string;
  readonly receiptId: string;
  readonly sessionId: string;
  readonly turnId: string;
};

export type ContextPacketChangeClassification = {
  readonly kind: "unchanged" | "safety-refresh" | "meaning-change";
  readonly removedSourceIds: readonly string[];
  readonly addedSourceIds: readonly string[];
  readonly protectedSourceIds: readonly string[];
  readonly reason: string;
};

export const CONTEXT_POLICY_ACTIONS = ["keep", "summarize", "hold-back", "refresh"] as const;
export type ContextPolicyAction = (typeof CONTEXT_POLICY_ACTIONS)[number];
export const CONTEXT_POLICY_SUGGESTION_STATES = ["proposed", "accepted", "rejected", "stale"] as const;
export type ContextPolicySuggestionState = (typeof CONTEXT_POLICY_SUGGESTION_STATES)[number];

export type ContextPolicySuggestion = {
  readonly id: string;
  readonly packetReceiptId: string;
  readonly sourceId: string;
  readonly action: ContextPolicyAction;
  readonly reasonCode: string;
  readonly reasonText: string;
  readonly estimatedTokenSaving?: number | undefined;
  readonly status: ContextPolicySuggestionState;
  readonly createdAt: string;
  readonly resolvedAt?: string | undefined;
};

export type AddContextPolicySuggestionInput = Omit<
  ContextPolicySuggestion,
  "status" | "createdAt" | "resolvedAt"
> & { readonly createdAt?: string | undefined };

export const MEMORY_LINEAGE_STATES = ["active", "superseded", "expired"] as const;
export type MemoryLineageState = (typeof MEMORY_LINEAGE_STATES)[number];
export type MemoryLineageRecord = {
  readonly memoryId: string;
  readonly sourceId: string;
  readonly originTurnId: string;
  readonly originPacketReceiptId: string;
  readonly supersedesMemoryId?: string | undefined;
  readonly state: MemoryLineageState;
  readonly confidence: number;
  readonly createdAt: string;
  readonly expiresAt?: string | undefined;
};

export type RecordMemoryLineageInput = Omit<
  MemoryLineageRecord,
  "createdAt"
> & { readonly createdAt?: string | undefined };

export function isContextPacketReceiptState(value: unknown): value is ContextPacketReceiptState {
  return typeof value === "string" && CONTEXT_PACKET_RECEIPT_STATES.some((state) => state === value);
}
