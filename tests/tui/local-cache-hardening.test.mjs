import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "unclecode-tui-cache-"));
const fakeRust = path.join(fixtureRoot, "fake-rust.sh");
const callLog = path.join(fixtureRoot, "calls.log");
writeFileSync(fakeRust, `#!/bin/sh
payload=$(cat)
printf '%s\\t%s\\n' "$*" "$payload" >> "$UNCLECODE_CACHE_TEST_LOG"
case "$*" in
  "rust ux text attachment-preview") printf '%s\\n' '["Attachments cached"]' ;;
  "rust ux text inline-image-support") printf '%s\\n' "support:$TERM:$TERM_PROGRAM:$KITTY_WINDOW_ID" ;;
  "rust ux text error-message") printf '%s\\n' 'formatted-error' ;;
  "rust ux text trace-line") printf '%s\\n' 'formatted-trace' ;;
  "rust ux panel inline-command") printf '%s\\n' '{"title":"Cached panel","lines":["cached"]}' ;;
  "rust ux text inline-command-summary") printf '%s\\n' 'cached-summary' ;;
  *) printf '%s\\n' 'unsupported fake Rust command' >&2; exit 2 ;;
esac
`, "utf8");
chmodSync(fakeRust, 0o700);

const previousRustBin = process.env.UNCLECODE_RUST_BIN;
const previousCallLog = process.env.UNCLECODE_CACHE_TEST_LOG;
process.env.UNCLECODE_RUST_BIN = fakeRust;
process.env.UNCLECODE_CACHE_TEST_LOG = callLog;

const {
  buildAttachmentPreviewLines,
  formatInlineImageSupportLine,
} = await import("../../packages/tui/src/work-shell-attachments.ts");
const {
  formatAgentTraceLine,
  formatWorkShellError,
} = await import("../../packages/tui/src/work-shell-formatters.ts");
const {
  buildInlineCommandPanel,
  formatInlineCommandResultSummary,
} = await import("../../packages/tui/src/work-shell-panels.ts");

test.after(() => {
  if (previousRustBin === undefined) delete process.env.UNCLECODE_RUST_BIN;
  else process.env.UNCLECODE_RUST_BIN = previousRustBin;
  if (previousCallLog === undefined) delete process.env.UNCLECODE_CACHE_TEST_LOG;
  else process.env.UNCLECODE_CACHE_TEST_LOG = previousCallLog;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function loggedCalls(command) {
  try {
    return readFileSync(callLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith(`${command}\t`));
  } catch {
    return [];
  }
}

function attachment(displayName, dataUrl) {
  return {
    type: "image",
    mimeType: "image/png",
    dataUrl,
    path: `/tmp/${displayName}`,
    displayName,
  };
}

test("attachment previews omit large data URLs from cache keys, hit by display metadata, and evict at 32 entries", () => {
  const largeA = `data:image/png;base64,${"A".repeat(2 * 1024 * 1024)}`;
  const largeB = `data:image/png;base64,${"B".repeat(2 * 1024 * 1024)}`;
  const firstAttachment = attachment("same.png", largeA);
  const first = buildAttachmentPreviewLines([firstAttachment]);
  const metadataHit = buildAttachmentPreviewLines([
    { ...firstAttachment, dataUrl: largeB, path: "/different/source.png" },
  ]);

  assert.strictEqual(metadataHit, first, "preview identity must depend only on rendered metadata");
  let calls = loggedCalls("rust ux text attachment-preview");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0],
    'rust ux text attachment-preview\t[{"displayName":"same.png","mimeType":"image/png"}]',
  );
  assert.ok(!calls[0].includes("data:image"), "the retained key and Rust payload must omit data URLs");
  assert.ok(calls[0].length < 200, "a multi-megabyte attachment must produce a bounded preview key");

  for (let index = 1; index <= 32; index += 1) {
    buildAttachmentPreviewLines([attachment(`image-${index}.png`, `data:image/png;base64,${index}`)]);
  }
  assert.equal(loggedCalls("rust ux text attachment-preview").length, 33);

  const newest = buildAttachmentPreviewLines([attachment("image-32.png", "data:image/png;base64,replaced")]);
  assert.deepEqual(newest, ["Attachments cached"]);
  assert.equal(loggedCalls("rust ux text attachment-preview").length, 33, "the newest entry must remain a hit");

  const reloaded = buildAttachmentPreviewLines([firstAttachment]);
  assert.notStrictEqual(reloaded, first, "the oldest preview must be evicted after 32 newer keys");
  assert.equal(loggedCalls("rust ux text attachment-preview").length, 34);
});

test("inline support cache hits and evicts terminal environments after 16 entries", () => {
  const firstEnv = { TERM: "xterm-0", TERM_PROGRAM: "terminal-0", KITTY_WINDOW_ID: "0" };
  const first = formatInlineImageSupportLine(firstEnv);
  assert.equal(formatInlineImageSupportLine(firstEnv), first);
  assert.equal(loggedCalls("rust ux text inline-image-support").length, 1);

  for (let index = 1; index <= 16; index += 1) {
    formatInlineImageSupportLine({
      TERM: `xterm-${index}`,
      TERM_PROGRAM: `terminal-${index}`,
      KITTY_WINDOW_ID: String(index),
    });
  }
  assert.equal(loggedCalls("rust ux text inline-image-support").length, 17);

  formatInlineImageSupportLine({ TERM: "xterm-16", TERM_PROGRAM: "terminal-16", KITTY_WINDOW_ID: "16" });
  assert.equal(loggedCalls("rust ux text inline-image-support").length, 17, "the newest environment must remain a hit");
  formatInlineImageSupportLine(firstEnv);
  assert.equal(loggedCalls("rust ux text inline-image-support").length, 18, "the oldest environment must be evicted");
});

test("formatter caches hit and enforce their error and trace entry limits", () => {
  assert.equal(formatWorkShellError("error-0"), "formatted-error");
  assert.equal(formatWorkShellError("error-0"), "formatted-error");
  assert.equal(loggedCalls("rust ux text error-message").length, 1);
  for (let index = 1; index <= 64; index += 1) {
    formatWorkShellError(`error-${index}`);
  }
  assert.equal(loggedCalls("rust ux text error-message").length, 65);
  formatWorkShellError("error-64");
  assert.equal(loggedCalls("rust ux text error-message").length, 65);
  formatWorkShellError("error-0");
  assert.equal(loggedCalls("rust ux text error-message").length, 66, "error retention must stay within 64 entries");

  const traceEvent = (index) => ({
    type: "reasoning.delta",
    level: "default",
    provider: "openai",
    model: "gpt-5.6-sol",
    kind: "summary",
    itemId: `reasoning-${index}`,
    delta: `trace-${index}`,
  });
  assert.equal(formatAgentTraceLine(traceEvent(0)), "formatted-trace");
  assert.equal(formatAgentTraceLine(traceEvent(0)), "formatted-trace");
  assert.equal(loggedCalls("rust ux text trace-line").length, 1);
  for (let index = 1; index <= 512; index += 1) {
    formatAgentTraceLine(traceEvent(index));
  }
  assert.equal(loggedCalls("rust ux text trace-line").length, 513);
  formatAgentTraceLine(traceEvent(512));
  assert.equal(loggedCalls("rust ux text trace-line").length, 513);
  formatAgentTraceLine(traceEvent(0));
  assert.equal(loggedCalls("rust ux text trace-line").length, 514, "trace retention must stay within 512 entries");
});

test("inline command panel and summary caches hit and evict after 64 entries", () => {
  const firstPanel = buildInlineCommandPanel(["command-0"], ["line-0"]);
  assert.strictEqual(buildInlineCommandPanel(["command-0"], ["line-0"]), firstPanel);
  assert.equal(loggedCalls("rust ux panel inline-command").length, 1);
  for (let index = 1; index <= 64; index += 1) {
    buildInlineCommandPanel([`command-${index}`], [`line-${index}`]);
  }
  assert.equal(loggedCalls("rust ux panel inline-command").length, 65);
  buildInlineCommandPanel(["command-64"], ["line-64"]);
  assert.equal(loggedCalls("rust ux panel inline-command").length, 65);
  const reloadedPanel = buildInlineCommandPanel(["command-0"], ["line-0"]);
  assert.notStrictEqual(reloadedPanel, firstPanel);
  assert.equal(loggedCalls("rust ux panel inline-command").length, 66);

  assert.equal(formatInlineCommandResultSummary(["summary-0"], ["line-0"]), "cached-summary");
  assert.equal(formatInlineCommandResultSummary(["summary-0"], ["line-0"]), "cached-summary");
  assert.equal(loggedCalls("rust ux text inline-command-summary").length, 1);
  for (let index = 1; index <= 64; index += 1) {
    formatInlineCommandResultSummary([`summary-${index}`], [`line-${index}`]);
  }
  assert.equal(loggedCalls("rust ux text inline-command-summary").length, 65);
  formatInlineCommandResultSummary(["summary-64"], ["line-64"]);
  assert.equal(loggedCalls("rust ux text inline-command-summary").length, 65);
  formatInlineCommandResultSummary(["summary-0"], ["line-0"]);
  assert.equal(loggedCalls("rust ux text inline-command-summary").length, 66, "summary retention must stay within 64 entries");
});
