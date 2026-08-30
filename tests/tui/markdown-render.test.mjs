import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import React from "react";

import {
  getMarkdownRenderParseCountForTest,
  parseInlineForTest,
  renderMarkdown,
  resetMarkdownRenderCacheForTest,
} from "../../packages/tui/src/markdown-render.js";

const THEME = {
  heading: "#ff5f87",
  headingL2: "#ff5f87",
  headingL3: "#8a919f",
  bold: "#7aa2f7",
  inlineCode: "#7dcfff",
  inlineCodeBg: "#1a1b26",
  codeBlock: "#8a919f",
  bullet: "#7aa2f7",
  quote: "#8a919f",
  tableHeader: "#7aa2f7",
  tableBorder: "#3b4261",
  link: "#7dcfff",
  text: "#c0caf5",
  textMuted: "#8a919f",
};

function runLineRichMarkdownMemoryProbe(nodeEnv) {
  const probe = spawnSync(process.execPath, [
    "--expose-gc",
    "--disable-warning=ExperimentalWarning",
    "--conditions=source",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `
      import {
        getMarkdownRenderParseCountForTest,
        renderMarkdown,
        resetMarkdownRenderCacheForTest,
      } from "./packages/tui/src/markdown-render.js";
      const theme = ${JSON.stringify(THEME)};
      resetMarkdownRenderCacheForTest();
      globalThis.gc();
      globalThis.gc();
      const before = process.memoryUsage();
      let peakHeapUsed = before.heapUsed;
      let peakRss = before.rss;
      for (let index = 0; index < 64; index += 1) {
        renderMarkdown({ text: String(index) + "\\n" + "x\\n".repeat(4096), width: 80, theme });
        const usage = process.memoryUsage();
        peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed);
        peakRss = Math.max(peakRss, usage.rss);
      }
      globalThis.gc();
      globalThis.gc();
      const after = process.memoryUsage();
      const parsesBeforeReplay = getMarkdownRenderParseCountForTest();
      renderMarkdown({ text: "0\\n" + "x\\n".repeat(4096), width: 80, theme });
      process.stdout.write(JSON.stringify({
        heapDelta: after.heapUsed - before.heapUsed,
        rssDelta: after.rss - before.rss,
        peakHeapDelta: peakHeapUsed - before.heapUsed,
        peakRssDelta: peakRss - before.rss,
        replayWasCached: getMarkdownRenderParseCountForTest() === parsesBeforeReplay,
      }));
    `,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: nodeEnv },
    timeout: 90_000,
  });
  assert.equal(probe.status, 0, probe.stderr);
  return JSON.parse(probe.stdout);
}

function countReactElements(node) {
  const pending = [node];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    if (!React.isValidElement(current)) continue;
    count += 1;
    if (current.props.children !== undefined) pending.push(current.props.children);
  }
  return count;
}

test("renderMarkdown reparses nothing for repeated (text, width, theme) keys", () => {
  resetMarkdownRenderCacheForTest();
  const input = { text: "# Title\n\nbody **bold** `code`", width: 80, theme: THEME };
  const first = renderMarkdown(input);
  const before = getMarkdownRenderParseCountForTest();
  const second = renderMarkdown({ text: input.text, width: 80, theme: { ...THEME } });
  assert.equal(
    getMarkdownRenderParseCountForTest(),
    before,
    "identical text/width/theme (by value) must be served from the cache",
  );
  assert.equal(second, first, "cache returns the same rendered node");

  // A different width is a different layout: reparsed.
  renderMarkdown({ ...input, width: 60 });
  assert.equal(getMarkdownRenderParseCountForTest(), before + 1);
  // A different theme is a different palette: reparsed.
  renderMarkdown({ ...input, theme: { ...THEME, text: "#ffffff" } });
  assert.equal(getMarkdownRenderParseCountForTest(), before + 2);
});

test("renderMarkdown skips the cache for streaming text", () => {
  resetMarkdownRenderCacheForTest();
  const input = { text: "still growing reply", width: 80, theme: THEME };
  renderMarkdown({ ...input, isStreamingText: true });
  const before = getMarkdownRenderParseCountForTest();
  renderMarkdown({ ...input, isStreamingText: true });
  assert.equal(
    getMarkdownRenderParseCountForTest(),
    before + 1,
    "streaming text must reparse on every call (no cache applied)",
  );

  // The raw streaming-cursor suffix keeps the same exclusion for callers
  // that pass untrimmed text — the rule the view's Rust caches follow.
  renderMarkdown({ text: "growing▌", width: 80, theme: THEME });
  const rawBefore = getMarkdownRenderParseCountForTest();
  renderMarkdown({ text: "growing▌", width: 80, theme: THEME });
  assert.equal(getMarkdownRenderParseCountForTest(), rawBefore + 1);

  // Settled text lands in the cache right after streaming ends.
  renderMarkdown(input);
  const settledBefore = getMarkdownRenderParseCountForTest();
  renderMarkdown(input);
  assert.equal(getMarkdownRenderParseCountForTest(), settledBefore);
});

test("renderMarkdown bypasses the cache for a 1 MiB document", () => {
  resetMarkdownRenderCacheForTest();
  const input = { text: `\`\`\`text\n${"x".repeat(1024 * 1024)}\n\`\`\``, width: 80, theme: THEME };
  renderMarkdown(input);
  const before = getMarkdownRenderParseCountForTest();
  renderMarkdown(input);
  assert.equal(
    getMarkdownRenderParseCountForTest(),
    before + 1,
    "oversized source text and its React tree must not be retained",
  );
});

test("renderMarkdown 1 MiB churn stays within a bounded post-GC heap delta", () => {
  const probe = spawnSync(process.execPath, [
    "--expose-gc",
    "--disable-warning=ExperimentalWarning",
    "--conditions=source",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `
      import { renderMarkdown, resetMarkdownRenderCacheForTest } from "./packages/tui/src/markdown-render.js";
      const theme = ${JSON.stringify(THEME)};
      resetMarkdownRenderCacheForTest();
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      for (let index = 0; index < 24; index += 1) {
        const fence = String.fromCharCode(96).repeat(3);
        renderMarkdown({
          text: fence + "text\\n" + String(index) + "x".repeat(1024 * 1024) + "\\n" + fence,
          width: 80,
          theme,
        });
      }
      globalThis.gc();
      process.stdout.write(JSON.stringify({ heapDelta: process.memoryUsage().heapUsed - before }));
    `,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(probe.status, 0, probe.stderr);
  const report = JSON.parse(probe.stdout);
  assert.ok(
    report.heapDelta < 24 * 1024 * 1024,
    `post-GC heap delta must stay below 24 MiB, got ${report.heapDelta} bytes`,
  );
});

for (const nodeEnv of ["development", "production"]) {
  test(`renderMarkdown line-rich 8 KiB churn stays bounded in ${nodeEnv}`, () => {
    const report = runLineRichMarkdownMemoryProbe(nodeEnv);
    assert.equal(report.replayWasCached, false, "line-rich React trees must bypass the cache");
    assert.ok(
      report.heapDelta < 32 * 1024 * 1024,
      `post-GC heap delta must stay below 32 MiB, got ${report.heapDelta} bytes`,
    );
    assert.ok(
      report.rssDelta < 64 * 1024 * 1024,
      `post-GC RSS delta must stay below 64 MiB, got ${report.rssDelta} bytes`,
    );
    assert.ok(
      report.peakHeapDelta < 32 * 1024 * 1024,
      `peak heap delta must stay below 32 MiB, got ${report.peakHeapDelta} bytes`,
    );
    assert.ok(
      report.peakRssDelta < 64 * 1024 * 1024,
      `peak RSS delta must stay below 64 MiB, got ${report.peakRssDelta} bytes`,
    );
  });
}

test("line-rich plain markdown preserves every rendered line on the compact path", async () => {
  const { renderDebugFrame, waitForSettledFrame } = await import("./work-shell-render-harness.mjs");
  const text = Array.from({ length: 160 }, (_, index) => `plain line ${index}`).join("\n");
  const { instance, getOutput } = renderDebugFrame(
    renderMarkdown({ text, width: 80, theme: THEME }),
    { columns: 80, rows: 200 },
  );
  await waitForSettledFrame(getOutput);
  const frame = stripVTControlCharacters(getOutput()).trimEnd();
  instance.unmount();
  instance.cleanup();
  assert.equal(frame, text);
});

test("line-rich Markdown syntax always falls back to the structural renderer", () => {
  const cases = [
    ["underscore markup", "_em_"],
    ["link", "[label](url)"],
    ["plus list", "+ item"],
    ["HTML", "<em>value</em>"],
    ["fence", "~~~text"],
    ["escape", "\\_literal_"],
    ["no-space heading", "#heading"],
    ["ASCII punctuation", "sentence."],
  ];
  for (const [label, syntax] of cases) {
    const text = [syntax, ...Array.from({ length: 129 }, () => "plain")].join("\n");
    const rendered = renderMarkdown({ text, width: 80, theme: THEME });
    assert.ok(
      countReactElements(rendered) > 128,
      `${label} must not enter the compact plain-text path`,
    );
  }
});

test("line-rich whitespace and control inputs fall back to the structural renderer", () => {
  const cases = [
    ["tab", "\t"],
    ["vertical tab", "\u000b"],
    ["form feed", "\u000c"],
    ["NBSP", "\u00a0"],
    ["Ogham space", "\u1680"],
    ["en quad", "\u2000"],
    ["em space", "\u2003"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
    ["narrow NBSP", "\u202f"],
    ["medium mathematical space", "\u205f"],
    ["ideographic space", "\u3000"],
  ];
  for (const [label, prefix] of cases) {
    const text = [`${prefix}indented`, ...Array.from({ length: 128 }, () => "plain")].join("\n");
    const rendered = renderMarkdown({ text, width: 80, theme: THEME });
    assert.ok(
      countReactElements(rendered) > 128,
      `${label} must not enter the compact plain-text path`,
    );
  }

  const wrapped = ["x".repeat(25), ...Array.from({ length: 128 }, () => "plain")].join("\n");
  assert.ok(
    countReactElements(renderMarkdown({ text: wrapped, width: 20, theme: THEME })) > 128,
    "text requiring display wrapping must use the structural renderer",
  );
});

test("line-rich NBSP indentation is preserved byte-for-byte", async () => {
  const { renderDebugFrame, waitForSettledFrame } = await import("./work-shell-render-harness.mjs");
  const text = ["\u00a0indented", ...Array.from({ length: 128 }, () => "plain")].join("\n");
  const { instance, getOutput } = renderDebugFrame(
    renderMarkdown({ text, width: 80, theme: THEME }),
    { columns: 80, rows: 140 },
  );
  await waitForSettledFrame(getOutput);
  const frame = stripVTControlCharacters(getOutput()).trimEnd();
  instance.unmount();
  instance.cleanup();
  assert.equal(frame, text);
});

test("line-rich structural fallback preserves trimming and display wrapping", async () => {
  const { renderDebugFrame, waitForSettledFrame } = await import("./work-shell-render-harness.mjs");
  const text = ["  padded  ", ...Array.from({ length: 159 }, () => "x".repeat(25))].join("\n");
  const expected = [
    "padded",
    ...Array.from({ length: 159 }, () => ["x".repeat(20), "x".repeat(5)]).flat(),
  ].join("\n");
  const { instance, getOutput } = renderDebugFrame(
    renderMarkdown({ text, width: 20, theme: THEME }),
    { columns: 20, rows: 340 },
  );
  await waitForSettledFrame(getOutput);
  const frame = stripVTControlCharacters(getOutput()).trimEnd();
  instance.unmount();
  instance.cleanup();
  assert.equal(frame, expected);
});

test("renderMarkdown cache evicts least-recently-used entries past 64 keys", () => {
  resetMarkdownRenderCacheForTest();
  const first = { text: "oldest entry", width: 80, theme: THEME };
  renderMarkdown(first);
  for (let i = 0; i < 64; i += 1) {
    renderMarkdown({ text: `entry ${i}`, width: 80 + i, theme: THEME });
  }
  const before = getMarkdownRenderParseCountForTest();
  renderMarkdown(first);
  assert.equal(
    getMarkdownRenderParseCountForTest(),
    before + 1,
    "the oldest key must have been evicted by the 64-entry bound",
  );
});

test("renderMarkdown cache evicts by retained-byte budget before the entry cap", () => {
  resetMarkdownRenderCacheForTest();
  const first = { text: `\`\`\`text\nbudget-oldest\n${"x\n".repeat(100)}\`\`\``, width: 80, theme: THEME };
  renderMarkdown(first);
  for (let index = 1; index < 24; index += 1) {
    renderMarkdown({
      text: `\`\`\`text\nbudget-${index}\n${"x\n".repeat(100)}\`\`\``,
      width: 80,
      theme: THEME,
    });
  }
  const before = getMarkdownRenderParseCountForTest();
  renderMarkdown(first);
  assert.equal(
    getMarkdownRenderParseCountForTest(),
    before + 1,
    "the aggregate byte budget must evict large trees even with fewer than 64 entries",
  );
});

test("parseInline preserves snake_case QA markers", () => {
  const tokens = parseInlineForTest("UNCLECODE_FULL_TUI_QA_OK");
  assert.deepEqual(
    tokens.map((token) => `${token.kind}:${token.value}`),
    ["text:UNCLECODE_FULL_TUI_QA_OK"],
  );
});

test("parseInline still renders asterisk italics", () => {
  const tokens = parseInlineForTest("Use *emphasis* here");
  assert.deepEqual(
    tokens.map((token) => `${token.kind}:${token.value}`),
    ["text:Use ", "italic:emphasis", "text: here"],
  );
});
