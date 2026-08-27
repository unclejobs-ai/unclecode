import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePiModel,
  resolvePiProviderBaseUrl,
} from "@unclecode/pi-bridge";

test("pi bridge maps DeepSeek onto its OpenAI-compatible API", () => {
  const model = resolvePiModel("deepseek", "deepseek-chat");
  assert.equal(model.provider, "deepseek");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://api.deepseek.com");
});

test("pi bridge converts a DeepSeek completion endpoint to the provider base URL", () => {
  assert.equal(
    resolvePiProviderBaseUrl("deepseek", {
      DEEPSEEK_BASE_URL: "https://gateway.example/v1/chat/completions/",
    }),
    "https://gateway.example/v1",
  );
});
