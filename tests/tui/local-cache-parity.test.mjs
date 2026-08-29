import assert from "node:assert/strict";
import test from "node:test";

import { runRustCommandSync } from "@unclecode/orchestrator";
import { buildAttachmentPreviewLines, formatInlineImageSupportLine } from "../../packages/tui/src/work-shell-attachments.ts";
import { formatAgentTraceLine, formatWorkShellError } from "../../packages/tui/src/work-shell-formatters.ts";
import { buildInlineCommandPanel, formatInlineCommandResultSummary } from "../../packages/tui/src/work-shell-panels.ts";

test("cached TUI wrappers preserve Rust attachment, formatter, and panel behavior", () => {
  const attachment = {
    type: "image",
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${"A".repeat(256 * 1024)}`,
    path: "/tmp/cache-parity.png",
    displayName: "cache-parity.png",
  };
  const attachmentKey = JSON.stringify([{ displayName: attachment.displayName, mimeType: attachment.mimeType }]);
  const expectedPreview = JSON.parse(
    runRustCommandSync(["rust", "ux", "text", "attachment-preview"], process.cwd(), attachmentKey),
  );
  assert.deepEqual(buildAttachmentPreviewLines([attachment]), expectedPreview);

  const terminalEnv = { TERM: "xterm-kitty", TERM_PROGRAM: "cache-parity", KITTY_WINDOW_ID: "77" };
  const expectedSupport = runRustCommandSync(
    ["rust", "ux", "text", "inline-image-support"],
    process.cwd(),
    undefined,
    terminalEnv,
  ).trimEnd();
  assert.equal(formatInlineImageSupportLine(terminalEnv), expectedSupport);

  const error = "cache parity error 59871";
  const expectedError = runRustCommandSync(
    ["rust", "ux", "text", "error-message"],
    process.cwd(),
    error,
  ).trimEnd();
  assert.equal(formatWorkShellError(error), expectedError);

  const trace = {
    type: "reasoning.delta",
    level: "default",
    provider: "openai",
    model: "gpt-5.6-sol",
    kind: "summary",
    itemId: "cache-parity-trace",
    delta: "cache parity trace",
  };
  const traceKey = JSON.stringify(trace);
  const expectedTrace = runRustCommandSync(
    ["rust", "ux", "text", "trace-line"],
    process.cwd(),
    traceKey,
  ).trimEnd();
  assert.equal(formatAgentTraceLine(trace), expectedTrace);

  const args = ["doctor", "--cache-parity"];
  const lines = ["cache parity ok"];
  const panelKey = JSON.stringify({ args, lines });
  const expectedPanel = JSON.parse(
    runRustCommandSync(["rust", "ux", "panel", "inline-command"], process.cwd(), panelKey),
  );
  assert.deepEqual(buildInlineCommandPanel(args, lines), expectedPanel);

  const expectedSummary = runRustCommandSync(
    ["rust", "ux", "text", "inline-command-summary"],
    process.cwd(),
    panelKey,
  ).trimEnd();
  assert.equal(formatInlineCommandResultSummary(args, lines), expectedSummary);
});
