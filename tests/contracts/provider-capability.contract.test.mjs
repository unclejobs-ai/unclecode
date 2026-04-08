import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDER_CAPABILITIES, PROVIDER_IDS } from "@unclecode/contracts";

test("provider-capability fixtures expose canonical provider metadata", () => {
  assert.deepEqual(PROVIDER_IDS, [
    "anthropic",
    "gemini",
    "openai-api",
    "openai-codex",
    "groq",
    "ollama",
    "copilot",
    "zai",
  ]);

  assert.deepEqual(PROVIDER_CAPABILITIES.anthropic, {
    id: "anthropic",
    label: "Anthropic",
    transport: "native",
    defaultModel: "claude-sonnet-4-20250514",
    envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: true,
  });

  assert.deepEqual(PROVIDER_CAPABILITIES.gemini, {
    id: "gemini",
    label: "Gemini",
    transport: "native",
    defaultModel: "gemini-2.5-flash",
    envKeys: ["GEMINI_API_KEY", "GEMINI_MODEL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: false,
  });

  assert.deepEqual(PROVIDER_CAPABILITIES["openai-api"], {
    id: "openai-api",
    label: "OpenAI API",
    transport: "compat",
    defaultModel: "gpt-5.4",
    envKeys: ["OPENAI_API_KEY", "OPENAI_MODEL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: false,
  });

  assert.deepEqual(PROVIDER_CAPABILITIES["openai-codex"], {
    id: "openai-codex",
    label: "OpenAI Codex",
    transport: "compat",
    defaultModel: "gpt-5.4",
    envKeys: ["OPENAI_AUTH_TOKEN", "OPENAI_MODEL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: false,
  });

  assert.equal(PROVIDER_CAPABILITIES.ollama.transport, "compat");
  assert.equal(
    PROVIDER_CAPABILITIES.copilot.defaultModel,
    "openai/gpt-4.1-mini",
  );
});
