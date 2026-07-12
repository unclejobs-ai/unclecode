import assert from "node:assert/strict";
import test from "node:test";

import { formatWorkShellStatusLine } from "../../packages/tui/src/index.tsx";
import { formatWorkShellSessionFactsGroup } from "../../packages/tui/src/work-shell-footer-fast-paths.ts";

const MODE_LABELS = [
  ["default", "작업 모드"],
  ["yolo", "YOLO 모드"],
  ["ultrawork", "집중 작업 모드"],
  ["search", "탐색 모드"],
  ["analyze", "분석 모드"],
  ["plan", "계획 모드"],
  ["build", "구현 모드"],
];

test("Work Shell presents Rust-owned Korean mode labels", () => {
  for (const [mode, label] of MODE_LABELS) {
    assert.equal(
      formatWorkShellSessionFactsGroup({ model: "gpt-5.4", mode }),
      `gpt-5.4 · ${label}`,
    );
  }

  assert.equal(
    formatWorkShellStatusLine({
      model: "gpt-5.4",
      reasoningLabel: "medium (mode-default)",
      mode: "default",
      authLabel: "Browser OAuth · file",
    }),
    "gpt-5.4 · 작업 모드 · Saved OAuth · work context",
  );
});
