import test from "node:test";
import assert from "node:assert/strict";

import {
  providerAdditionalModelOptions,
  providerLabel,
  providerModelCatalog,
  providerPromptSuggestions,
} from "../shared/providerModels.js";

test("providerLabel returns human readable provider names", () => {
  assert.equal(providerLabel("openai"), "OpenAI");
  assert.equal(providerLabel("gemini"), "Google Gemini");
});

test("providerModelCatalog includes active model and defaults", () => {
  const catalog = providerModelCatalog("openai", { OPENAI_MODEL: "gpt-5.4" });
  assert.equal(catalog[0], "gpt-5.4");
  assert.equal(catalog[1], "gpt-5.5");
  assert.ok(catalog.includes("gpt-5.4-mini"));
  assert.ok(catalog.includes("gpt-4.1"));
  assert.ok(catalog.includes("o4-mini"));
});

test("providerModelCatalog is backed by the Rust model registry ordering", () => {
  const catalog = providerModelCatalog("openai", {});
  assert.deepEqual(catalog.slice(0, 4), [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "o4-mini",
  ]);
});

test("providerModelCatalog merges custom environment models", () => {
  const catalog = providerModelCatalog("gemini", {
    GEMINI_MODEL: "gemini-2.5-pro",
    GEMINI_MODELS: "gemini-2.5-pro-exp,gemini-2.5-flash-lite-preview",
  });
  assert.ok(catalog.includes("gemini-2.5-pro-exp"));
  assert.ok(catalog.includes("gemini-2.5-flash-lite-preview"));
});

test("providerPromptSuggestions mirrors the provider catalog", () => {
  const suggestions = providerPromptSuggestions("zai", { ZAI_MODEL: "glm-5" });
  assert.deepEqual(suggestions, providerModelCatalog("zai", { ZAI_MODEL: "glm-5" }));
});

test("providerAdditionalModelOptions are picker-friendly", () => {
  const options = providerAdditionalModelOptions("openai", { OPENAI_MODEL: "gpt-5.4" });
  assert.ok(options.some((option) => option.value === "gpt-5.4" && option.description === "OpenAI model"));
});
