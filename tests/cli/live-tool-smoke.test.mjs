import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLiveToolSmoke,
  classifyLiveToolSmokeResult,
  combineLiveProviderStatus,
} from "../../scripts/unclecode-live-provider-qa-lib.mjs";

test("requires the live provider tool smoke marker before reporting pass", () => {
  const textStatus = "pass";
  const missingMarker = classifyLiveToolSmokeResult({
    work: { code: 0, timedOut: false, stdout: "UNCLECODE_LIVE_TOOL_QA_OK", stderr: "" },
    markerText: "",
    expectedText: "UNCLECODE_LIVE_TOOL_QA_OK",
  });
  const markerWritten = classifyLiveToolSmokeResult({
    work: { code: 0, timedOut: false, stdout: "UNCLECODE_LIVE_TOOL_QA_OK", stderr: "" },
    markerText: "UNCLECODE_LIVE_TOOL_QA_OK",
    expectedText: "UNCLECODE_LIVE_TOOL_QA_OK",
  });

  assert.equal(missingMarker, "failed");
  assert.equal(combineLiveProviderStatus(textStatus, missingMarker), "failed");
  assert.equal(markerWritten, "pass");
  assert.equal(combineLiveProviderStatus(textStatus, markerWritten), "pass");
});

test("does not pass live provider tool smoke from prompt echo plus stale-looking marker", () => {
  const status = classifyLiveToolSmokeResult({
    work: {
      code: 0,
      timedOut: false,
      stdout: [
        "Use the run_shell tool exactly once to run this command:",
        "After the command succeeds, respond with exactly UNCLECODE_LIVE_TOOL_QA_OK.",
      ].join("\n"),
      stderr: "",
    },
    markerText: "UNCLECODE_LIVE_TOOL_QA_OK",
    expectedText: "UNCLECODE_LIVE_TOOL_QA_OK",
  });

  assert.equal(status, "failed");
});

test("builds a live tool smoke prompt that writes a marker through run_shell", () => {
  const smoke = buildLiveToolSmoke("/tmp/unclecode repo");

  assert.match(smoke.prompt, /run_shell/);
  assert.match(smoke.prompt, /live-tool-call-marker\.txt/);
  assert.equal(smoke.expectedText, "UNCLECODE_LIVE_TOOL_QA_OK");
  assert.match(smoke.markerPath, /live-tool-call-marker\.txt$/);
});

test("buildLiveToolSmoke binds marker proof to a run nonce", () => {
  const smoke = buildLiveToolSmoke("/tmp/unclecode repo", "2026-06-28T01:02:03.004Z");

  assert.equal(smoke.runId, "2026-06-28T01_02_03_004Z");
  assert.equal(smoke.expectedText, "UNCLECODE_LIVE_TOOL_QA_OK_2026-06-28T01_02_03_004Z");
  assert.match(smoke.markerPath, /live-tool-call-marker-2026-06-28T01_02_03_004Z\.txt$/);
  assert.match(smoke.prompt, /UNCLECODE_LIVE_TOOL_QA_OK_2026-06-28T01_02_03_004Z/);
});
