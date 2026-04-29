import test from "node:test";
import assert from "node:assert/strict";

import { runPromptTurnSuccessSequence } from "@unclecode/orchestrator";

/**
 * Regression — memo §4 step 4 / Q5. Before this commit the
 * permission-stall continuation passed `[]` for attachments, dropping
 * vision/file context from the auto-continue turn. The fix threads
 * `input.attachments` into the continuation runTurn callback so the
 * agent's second pass still has access to the same images / file refs
 * as the original turn.
 */

const STALL_REPLY =
  "Found the auth middleware. Should I refactor it now? Let me know if you want me to proceed.";
const NEUTRAL_REPLY = "Refactor complete. Tests pass.";

const ATTACHMENT = Object.freeze({
  type: "image",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,QQ==",
  path: "(clipboard)",
  displayName: "screenshot.png",
});

function noopPostTurnEffects() {
  return {
    publishContextBridge: async () => ({ bridgeId: "b", line: "ok" }),
    writeScopedMemory: async () => ({ memoryId: "m" }),
    listScopedMemoryLines: async () => [],
  };
}

test("permission-stall continuation preserves the original turn's attachments", async () => {
  const calls = [];
  const runAgentTurn = async (prompt, attachments) => {
    calls.push({ prompt, attachments: attachments ? [...attachments] : [] });
    return calls.length === 1 ? { text: STALL_REPLY } : { text: NEUTRAL_REPLY };
  };

  const result = await runPromptTurnSuccessSequence({
    prompt: "review the auth flow",
    transcriptText: "review the auth flow",
    attachments: [ATTACHMENT],
    turnStartedAt: Date.now() - 100,
    autoContinueOnPermissionStall: true,
    runAgentTurn,
    cwd: "/tmp/uc-test",
    sessionId: "sess-1",
    currentBridgeLines: [],
    ...noopPostTurnEffects(),
  });

  assert.equal(calls.length, 2, "stall must trigger one continuation call");
  assert.deepEqual(
    calls[0].attachments.map((a) => a.dataUrl),
    [ATTACHMENT.dataUrl],
    "first turn must receive the user's attachments",
  );
  assert.deepEqual(
    calls[1].attachments.map((a) => a.dataUrl),
    [ATTACHMENT.dataUrl],
    "continuation turn must re-receive the same attachments — Q5 regression guard",
  );
  assert.equal(result.assistantText, NEUTRAL_REPLY, "continuation reply replaces the stalled outro");
});

test("non-stalled reply skips the continuation entirely (no extra call)", async () => {
  const calls = [];
  const runAgentTurn = async (prompt, attachments) => {
    calls.push({ prompt, attachments: attachments ? [...attachments] : [] });
    return { text: "Refactor complete. All tests pass." };
  };

  const result = await runPromptTurnSuccessSequence({
    prompt: "refactor login",
    transcriptText: "refactor login",
    attachments: [ATTACHMENT],
    turnStartedAt: Date.now() - 100,
    autoContinueOnPermissionStall: true,
    runAgentTurn,
    cwd: "/tmp/uc-test",
    sessionId: "sess-2",
    currentBridgeLines: [],
    ...noopPostTurnEffects(),
  });

  assert.equal(calls.length, 1, "no continuation when the reply is not a permission-stall");
  assert.equal(result.assistantText, "Refactor complete. All tests pass.");
});
