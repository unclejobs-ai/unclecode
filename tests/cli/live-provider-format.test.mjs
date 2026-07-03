import assert from "node:assert/strict";
import test from "node:test";

import {
  formatLiveProviderCompactReport,
  redactSecrets,
} from "../../scripts/unclecode-live-provider-qa-lib.mjs";

test("redacts provider secrets from live provider QA command output", () => {
  assert.equal(
    redactSecrets("OPENAI_API_KEY=sk-proj_abcdefghijklmnopqrstuvwxyz ANTHROPIC_API_KEY=sk-ant-1234567890"),
    "OPENAI_API_KEY=[REDACTED] ANTHROPIC_API_KEY=[REDACTED]",
  );
});

test("formats blocked live provider QA compactly without raw command output", () => {
  const compact = formatLiveProviderCompactReport({
    status: "blocked",
    provider: "openai",
    reportPath: "/repo/.unclecode/qa/live-provider-latest.json",
    textSmoke: { status: "blocked" },
    toolCallSmoke: { status: "skipped", markerMatched: false },
    credentialRecovery: {
      reason: "openai-oauth-codex-runtime-not-api-ready",
      apiReady: false,
    },
    work: {
      stdout: "OPENAI_API_KEY=sk-proj_should_not_render",
      stderr: "raw auth failure detail should not render",
    },
  }, "/repo");

  assert.match(compact, /UncleCode live provider QA: blocked/);
  assert.match(compact, /provider=openai; text=blocked; tool=skipped; markerMatched=false/);
  assert.match(compact, /reason=openai-oauth-codex-runtime-not-api-ready; apiReady=false/);
  assert.match(compact, /report: \.unclecode\/qa\/live-provider-latest\.json/);
  assert.doesNotMatch(compact, /sk-proj_should_not_render/);
  assert.doesNotMatch(compact, /raw auth failure detail/);
});

test("formats passing live provider QA compactly with marker proof", () => {
  const compact = formatLiveProviderCompactReport({
    status: "pass",
    provider: "openai",
    reportPath: "/repo/.unclecode/qa/live-provider-latest.json",
    textSmoke: { status: "pass" },
    toolCallSmoke: { status: "pass", markerMatched: true },
    credentialRecovery: null,
  }, "/repo");

  assert.match(compact, /UncleCode live provider QA: pass/);
  assert.match(compact, /provider=openai; text=pass; tool=pass; markerMatched=true/);
  assert.doesNotMatch(compact, /reason=/);
});
