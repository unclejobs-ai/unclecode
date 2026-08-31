import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDER_CAPABILITIES, PROVIDER_IDS } from "@unclecode/contracts";

test("provider-capability fixtures expose canonical provider metadata", () => {
  assert.deepEqual(PROVIDER_IDS, [
    "anthropic",
    "gemini",
    "openai",
    "deepseek",
    "groq",
    "ollama",
    "copilot",
    "zai",
    "omp",
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

  assert.deepEqual(PROVIDER_CAPABILITIES.deepseek, {
    id: "deepseek",
    label: "DeepSeek",
    transport: "compat",
    defaultModel: "deepseek-chat",
    envKeys: ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL"],
    supportsToolCalls: true,
    supportsSessionMemory: true,
    supportsPromptCaching: false,
  });

  assert.equal(PROVIDER_CAPABILITIES.ollama.transport, "compat");
  assert.equal(
    PROVIDER_CAPABILITIES.copilot.defaultModel,
    "openai/gpt-4.1-mini",
  );

  // OMP is a delegated work-executor route: it owns its own credentials, picks
  // no model on UncleCode's behalf, and runs each turn in a fresh session. So it
  // exposes no UncleCode env keys at all — no bearer token, and no model
  // override — and no cross-turn session memory.
  assert.deepEqual(PROVIDER_CAPABILITIES.omp, {
    id: "omp",
    label: "OMP",
    transport: "native",
    defaultModel: "kimi-code/k3",
    envKeys: [],
    supportsToolCalls: true,
    supportsSessionMemory: false,
    supportsPromptCaching: true,
  });
});
