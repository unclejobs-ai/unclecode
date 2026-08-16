import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import React from "react";

import { WorkShellView } from "../../packages/tui/src/work-shell-view.tsx";
import { renderDebugFrame } from "./work-shell-render-harness.mjs";

process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";

test("WorkShellView gives conversation roles a clear compact hierarchy", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "default",
      authLabel: "env-key",
      entries: [
        { role: "user", text: "디자인을 개선해줘" },
        { role: "assistant", text: "대화 구조를 정돈했습니다." },
        { role: "system", text: "Context saved." },
      ],
      isBusy: false,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/workspace/unclecode",
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  const output = stripVTControlCharacters(getOutput());
  instance.unmount();
  instance.cleanup();

  // The user's turn is an inverted chip, not a "◇ You ·" label. In a long
  // transcript a label competes with the words around it for attention; a
  // block of reversed ground marks where the turn began without being read.
  assert.match(output, /› 디자인을 개선해줘/u);
  assert.doesNotMatch(output, /◇ You ·/u);
  assert.match(output, /◈ UncleCode\s+대화 구조를 정돈했습니다\./u);
  assert.match(output, /· Context saved\./u);
  assert.doesNotMatch(output, /●\s+대화 구조를 정돈했습니다\./u);
});
