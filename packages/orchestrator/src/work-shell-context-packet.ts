import type { ContextPacketView } from "@unclecode/contracts";
import {
  buildWorkShellCompactContextPacketPreviewLines,
  composeWorkShellTurnPromptFromPacket,
  formatContextPacketIndicator,
  formatContextPacketPromptPrefix,
} from "@unclecode/context-broker";

export {
  buildWorkShellCompactContextPacketPreviewLines as buildWorkShellContextPacketPreviewLines,
  composeWorkShellTurnPromptFromPacket,
  formatContextPacketIndicator as formatWorkShellContextPacketIndicator,
  formatContextPacketPromptPrefix as formatWorkShellContextPacketPromptPrefix,
};

export type { ContextPacketView };
