import assert from "node:assert/strict";
import test from "node:test";

import { MAX_TOOL_ACTIVITY_PREVIEW_CHARS } from "../../packages/contracts/src/agent-console.ts";
import { applyTraceEventToAgentConsole } from "../../packages/orchestrator/src/work-shell-agent-console.ts";

const PATCH = [
  "@@ -8,7 +8,9 @@",
  "   resetProbedTerminalBackground,",
  "+// Restores env and the probe cache after `run` finishes.",
  "-  try {",
].join("\n");

// Trace fields sit directly on the event; the reducer reads the event itself
// rather than a nested `trace` object.
function completeToolCall(input) {
  const started = applyTraceEventToAgentConsole(
    { profileId: "build", activity: [] },
    {
      type: "tool.started",
      toolCallId: "call-1",
      toolName: input.toolName,
      startedAt: 1,
      input: input.toolInput,
    },
  );
  return applyTraceEventToAgentConsole(started, {
    type: "tool.completed",
    toolCallId: "call-1",
    toolName: input.toolName,
    startedAt: 1,
    completedAt: 13,
    input: input.toolInput,
    ...(input.output === undefined ? {} : { output: input.output }),
  });
}

test("a write tool carries its patch through as a bounded preview", () => {
  const snapshot = completeToolCall({
    toolName: "apply_patch",
    toolInput: { patch: PATCH, path: "src/theme.ts" },
  });

  const activity = snapshot.activity.at(-1);
  assert.equal(activity.kind, "write");
  assert.equal(activity.preview, PATCH);
});

test("a patch echoed on stdout is picked up when the input carries none", () => {
  const snapshot = completeToolCall({
    toolName: "write_file",
    toolInput: { path: "src/theme.ts" },
    output: PATCH,
  });

  assert.equal(snapshot.activity.at(-1).preview, PATCH);
});

test("non-patch output is never carried, so snapshots stay resume-safe", () => {
  const readSnapshot = completeToolCall({
    toolName: "read_file",
    toolInput: { path: "src/theme.ts" },
    output: PATCH,
  });
  // A read is not a change; its output has no business in the snapshot.
  assert.equal(readSnapshot.activity.at(-1).preview, undefined);

  const noisySnapshot = completeToolCall({
    toolName: "write_file",
    toolInput: { path: "src/theme.ts" },
    output: "wrote 4000 lines\nOK\n",
  });
  // Arbitrary stdout is not a diff and must not ride along.
  assert.equal(noisySnapshot.activity.at(-1).preview, undefined);
});

test("an oversized patch is truncated to the snapshot budget", () => {
  const huge = ["@@ -1,9999 +1,9999 @@", ...Array.from({ length: 5_000 }, (_, i) => `+line ${i}`)].join("\n");
  const snapshot = completeToolCall({
    toolName: "apply_patch",
    toolInput: { patch: huge },
  });

  const preview = snapshot.activity.at(-1).preview;
  assert.ok(preview.length <= MAX_TOOL_ACTIVITY_PREVIEW_CHARS + 32);
  assert.match(preview, /preview truncated/);
});
