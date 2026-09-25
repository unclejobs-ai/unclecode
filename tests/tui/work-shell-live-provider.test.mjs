import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkShellLiveProvider } from "../../packages/tui/src/work-shell-view.tsx";

test("the header follows a /model <provider>/<model> switch", () => {
  assert.equal(resolveWorkShellLiveProvider("anthropic", "xai/grok-4.3"), "xai");
  assert.equal(resolveWorkShellLiveProvider("xai", "anthropic/claude-sonnet-5"), "anthropic");
  assert.equal(resolveWorkShellLiveProvider("anthropic", "claude-sonnet-5"), "anthropic");
  // Slashes inside a provider's own catalog ids are not a switch.
  assert.equal(resolveWorkShellLiveProvider("groq", "openai/gpt-oss-20b"), "groq");
  assert.equal(resolveWorkShellLiveProvider("ollama", "library/qwen3"), "ollama");
});
