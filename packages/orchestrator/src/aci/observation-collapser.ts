/**
 * Collapse old tool observations down to a 1-line summary so context stays
 * informative-but-concise (SWE-agent ACI principle, NeurIPS 2024).
 *
 * - Last `keepFull` tool observations remain verbatim.
 * - Earlier tool observations get collapsed to a single line that records
 *   the tool name, exit code, and stdout/stderr length so cite chains hold.
 * - Already-collapsed messages pass through unchanged.
 * - Non-tool messages (system/user/assistant/exit) are never modified.
 */

import type { MiniLoopMessage } from "@unclecode/contracts";

const COLLAPSE_PREFIX = "Output collapsed for brevity";

export function collapseOlderObservations(
  messages: ReadonlyArray<MiniLoopMessage>,
  keepFull = 5,
): ReadonlyArray<MiniLoopMessage> {
  const toolIndices: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "tool") {
      toolIndices.push(index);
    }
  }
  if (toolIndices.length <= keepFull) {
    return messages;
  }

  const collapseSet = new Set(toolIndices.slice(0, toolIndices.length - keepFull));
  return messages.map((message, index) => {
    if (!collapseSet.has(index) || message.collapsed) {
      return message;
    }
    return collapseMessage(message);
  });
}

function collapseMessage(message: MiniLoopMessage): MiniLoopMessage {
  const stdoutLength = message.observation?.stdout.length ?? 0;
  const stderrLength = message.observation?.stderr.length ?? 0;
  const exitCode = message.observation?.exitCode ?? 0;
  const tool = message.action?.tool ?? "tool";
  const summary = `${COLLAPSE_PREFIX} (tool=${tool} exit=${exitCode} stdout=${stdoutLength}B stderr=${stderrLength}B)`;
  return {
    ...message,
    content: summary,
    collapsed: true,
  };
}
