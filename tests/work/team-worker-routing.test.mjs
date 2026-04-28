import test from "node:test";
import assert from "node:assert/strict";

import { detectProviderForModel } from "../../apps/unclecode-cli/src/team-worker.ts";

test("detectProviderForModel routes claude-* models to Anthropic", () => {
  assert.equal(detectProviderForModel("claude-sonnet-4-6"), "anthropic");
  assert.equal(detectProviderForModel("claude-opus-4-7"), "anthropic");
  assert.equal(detectProviderForModel("Claude-Sonnet"), "anthropic");
});

test("detectProviderForModel routes gemini-* models to Gemini", () => {
  assert.equal(detectProviderForModel("gemini-3.1-pro"), "gemini");
  assert.equal(detectProviderForModel("gemini-2.5-flash"), "gemini");
  assert.equal(detectProviderForModel("Gemini-3.1"), "gemini");
});

test("detectProviderForModel falls back to OpenAI for everything else", () => {
  assert.equal(detectProviderForModel("gpt-4.1-mini"), "openai");
  assert.equal(detectProviderForModel("gpt-5.4"), "openai");
  assert.equal(detectProviderForModel("o3-mini"), "openai");
  assert.equal(detectProviderForModel(""), "openai");
});
