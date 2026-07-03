import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLiveProviderResult,
  classifyLiveToolSmokeResult,
} from "../../scripts/unclecode-live-provider-qa-lib.mjs";

test("live provider text smoke cannot pass after timing out", () => {
  const status = classifyLiveProviderResult(
    {
      code: 0,
      timedOut: true,
      stdout: "final: UNCLECODE_LIVE_QA_OK",
      stderr: "",
    },
    null,
    "UNCLECODE_LIVE_QA_OK",
  );

  assert.equal(status, "failed");
});

test("live provider tool smoke cannot pass after timing out", () => {
  const status = classifyLiveToolSmokeResult({
    work: {
      code: 0,
      timedOut: true,
      stdout: "UNCLECODE_LIVE_TOOL_QA_OK",
      stderr: "",
    },
    markerText: "UNCLECODE_LIVE_TOOL_QA_OK",
    expectedText: "UNCLECODE_LIVE_TOOL_QA_OK",
  });

  assert.equal(status, "failed");
});
