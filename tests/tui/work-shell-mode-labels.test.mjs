import assert from "node:assert/strict";
import test from "node:test";

import { formatWorkShellStatusLine } from "../../packages/tui/src/index.tsx";
import { formatWorkShellSessionFactsGroup } from "../../packages/tui/src/work-shell-footer-fast-paths.ts";

const MODE_LABELS = [
  ["default", "Work mode", "작업 모드"],
  ["yolo", "YOLO mode", "YOLO 모드"],
  ["ultrawork", "Focus mode", "집중 작업 모드"],
  ["search", "Search mode", "탐색 모드"],
  ["analyze", "Analyze mode", "분석 모드"],
  ["plan", "Plan mode", "계획 모드"],
  ["build", "Build mode", "구현 모드"],
];

test("Work Shell follows the explicit session locale for mode chrome", () => {
  for (const [mode, englishLabel, koreanLabel] of MODE_LABELS) {
    assert.equal(
      formatWorkShellSessionFactsGroup({ model: "gpt-5.4", mode }),
      `gpt-5.4 · ${englishLabel}`,
    );
    assert.equal(
      formatWorkShellSessionFactsGroup({ model: "gpt-5.4", mode, uiLocale: "ko" }),
      `gpt-5.4 · ${koreanLabel}`,
    );
  }

  assert.equal(
    formatWorkShellStatusLine({
      model: "gpt-5.4",
      reasoningLabel: "medium (mode-default)",
      mode: "default",
      authLabel: "Browser OAuth · file",
    }),
    "gpt-5.4 · Work mode · Saved OAuth · work context",
  );
  assert.equal(
    formatWorkShellStatusLine({
      model: "gpt-5.4",
      reasoningLabel: "medium (mode-default)",
      mode: "default",
      authLabel: "Browser OAuth · file",
      uiLocale: "ko",
    }),
    "gpt-5.4 · 작업 모드 · Saved OAuth · work context",
  );
});
