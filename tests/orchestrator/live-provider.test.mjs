import assert from "node:assert/strict";
import test from "node:test";

import { resolveLiveProvider, routeAuthStatusToLiveProvider } from "@unclecode/orchestrator";

test("the live provider follows /model <provider>/<model> within the switchable set", () => {
  assert.equal(resolveLiveProvider("anthropic", "xai/grok-4.3"), "xai");
  assert.equal(resolveLiveProvider("anthropic", "claude-sonnet-5"), "anthropic");
  assert.equal(resolveLiveProvider("groq", "openai/gpt-oss-20b"), "groq");
});

test("/auth status reports the provider actually answering", () => {
  assert.deepEqual(routeAuthStatusToLiveProvider(["auth", "status"], "xai"), ["auth", "status", "xai"]);
  assert.deepEqual(routeAuthStatusToLiveProvider(["auth", "status"], "openai"), ["auth", "status"]);
  assert.deepEqual(routeAuthStatusToLiveProvider(["auth", "logout"], "xai"), ["auth", "logout"]);
});
