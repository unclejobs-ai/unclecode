import type {
  ContextPacketTokenEstimateState,
  ContextPacketView,
  ContextPacketViewItem,
  CreateContextPacketViewInput,
} from "@unclecode/contracts";

function hasTokenEstimate(item: ContextPacketViewItem): boolean {
  return item.tokenEstimate !== undefined;
}

export function resolveContextPacketTokenEstimateState(
  input: CreateContextPacketViewInput,
  included: readonly ContextPacketViewItem[],
): ContextPacketTokenEstimateState {
  if (input.tokenEstimateState !== undefined) {
    return input.tokenEstimateState;
  }
  if (included.length === 0) {
    return "exact";
  }
  return included.every(hasTokenEstimate) ? "estimated" : "unknown";
}

export function formatContextPacketTokenEstimateSuffix(packet: ContextPacketView): string {
  if (packet.tokenEstimateState === "unknown") {
    return " · token estimate unknown";
  }
  if (packet.tokenEstimate <= 0) {
    return "";
  }
  return packet.tokenEstimateState === "exact"
    ? ` · ${packet.tokenEstimate} tokens exact`
    : ` · ~${packet.tokenEstimate} tokens`;
}
