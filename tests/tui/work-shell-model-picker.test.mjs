import assert from "node:assert/strict";
import test from "node:test";

import { buildSlashSuggestionPanel } from "../../packages/tui/src/work-shell-panels.ts";

function modelCatalog() {
  const models = [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "o4-mini",
    "o3",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
  ];
  return [
    {
      command: "/model",
      description: "Show the current model and available model picks.",
    },
    {
      command: "/model list",
      description: "List available models and reasoning support.",
    },
    ...models.map((id, index) => ({
      command: `/model ${id}`,
      description:
        index === 0
          ? "Current · reasoning default medium · supports low, medium, high"
          : "Available · reasoning default medium · supports low, medium, high",
    })),
  ];
}

function selectedCommandFromPanel(panel) {
  const selected = panel.lines.find((line) => line.startsWith("› "));
  if (!selected) {
    return undefined;
  }
  const match = selected.match(/^›\s+(\/model(?:\s+\S+)?)/);
  return match?.[1];
}

function pickModelLines(panel) {
  return panel.lines.filter((line) => /^\s*\/model\s+\S+/.test(line) || /^›\s+\/model\s+\S+/.test(line));
}

test("model picker keeps rendered selection equal to submit selection for every catalog index", () => {
  const suggestions = modelCatalog();
  assert.equal(suggestions.length, 10, "catalog must include /model, /model list, and 8 models");

  for (let selectedIndex = 0; selectedIndex < suggestions.length; selectedIndex += 1) {
    const submitSelection = suggestions[selectedIndex]?.command;
    const panel = buildSlashSuggestionPanel("/model", suggestions, selectedIndex);
    const renderedSelection = selectedCommandFromPanel(panel);

    assert.equal(panel.title, "Model picker");
    assert.ok(
      !panel.lines.some((line) => line.includes("› /model list") || line.trimStart().startsWith("/model list")),
      `/model list must never be highlighted or listed as a pickable row (index ${selectedIndex})`,
    );

    if (submitSelection === "/model list") {
      assert.equal(
        renderedSelection,
        undefined,
        "selecting /model list must not highlight another command",
      );
      continue;
    }

    if (submitSelection === "/model") {
      assert.equal(
        renderedSelection,
        "/model gpt-5.4",
        "root /model selection still lands on the first model row",
      );
      continue;
    }

    assert.equal(
      renderedSelection,
      submitSelection,
      `rendered › must match submit selection at index ${selectedIndex}`,
    );
    assert.ok(
      pickModelLines(panel).some((line) => line.includes(submitSelection)),
      `selected model ${submitSelection} must stay visible in the window`,
    );
  }
});

test("model picker windows long catalogs around the selected model instead of clamping early", () => {
  const suggestions = modelCatalog();
  const lastModelIndex = suggestions.length - 1;
  const lastModel = suggestions[lastModelIndex]?.command;
  const firstModel = "/model gpt-5.4";

  const panel = buildSlashSuggestionPanel("/model", suggestions, lastModelIndex);
  const modelLines = pickModelLines(panel);

  assert.equal(selectedCommandFromPanel(panel), lastModel);
  assert.ok(modelLines.some((line) => line.includes(lastModel)), "late selection must be visible");
  assert.ok(
    modelLines.every((line) => !line.includes(firstModel)),
    "early models must scroll out so the catalog movement is visible",
  );
  assert.ok(modelLines.length <= 6, "picker still shows at most six model rows");
});

test("model picker preserves current/thinking/support and no-match copy", () => {
  const suggestions = modelCatalog();
  const matched = buildSlashSuggestionPanel("/model", suggestions, 2);
  assert.deepEqual(matched.lines.slice(0, 5), [
    "Current model",
    "Model · gpt-5.4",
    "Thinking · default medium",
    "Thinking choices · low / medium / high / default",
    "Supports · low, medium, high",
  ]);

  const noMatch = buildSlashSuggestionPanel(
    "/model gkdl",
    [
      {
        command: "/model list",
        description: "List available models and reasoning support.",
      },
    ],
    0,
    undefined,
    true,
    undefined,
    "gpt-5.4",
  );
  const text = noMatch.lines.join("\n");
  assert.match(text, /Current model\nModel · gpt-5\.4/);
  assert.match(text, /Query · gkdl/);
  assert.match(text, /No model id matches gkdl\. Current model unchanged\./);
  assert.match(text, /\/model list shows the catalog\./);
  assert.equal(noMatch.lines.at(-1), "Backspace edit · Enter keeps current · Esc close");
  assert.equal(selectedCommandFromPanel(noMatch), undefined);
});
