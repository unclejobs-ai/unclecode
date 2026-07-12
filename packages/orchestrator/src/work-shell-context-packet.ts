import type { ContextPacketView } from "@unclecode/contracts";
import {
  buildWorkShellCompactContextPacketPreviewLines,
  composeWorkShellTurnPromptFromPacket,
  formatContextPacketIndicator,
  formatContextPacketPromptPrefix,
  formatContextPacketUsedReceipt,
} from "@unclecode/context-broker";

export {
  buildWorkShellCompactContextPacketPreviewLines as buildWorkShellContextPacketPreviewLines,
  composeWorkShellTurnPromptFromPacket,
  formatContextPacketIndicator as formatWorkShellContextPacketIndicator,
  formatContextPacketPromptPrefix as formatWorkShellContextPacketPromptPrefix,
  formatContextPacketUsedReceipt as formatWorkShellContextPacketUsedReceipt,
};

export type { ContextPacketView };
