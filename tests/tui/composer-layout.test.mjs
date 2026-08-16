import assert from "node:assert/strict";
import test from "node:test";

import * as composer from "../../packages/tui/src/composer.tsx";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";

function layout(input) {
  return typeof composer.layoutComposerViewport === "function"
    ? composer.layoutComposerViewport(input)
    : null;
}

test("composer viewport wraps Korean graphemes by terminal display width", () => {
  assert.deepEqual(
    layout({ value: "가나다라마바사", cursorOffset: 7, width: 6, maxRows: 4 }),
    {
      lines: ["가나다", "라마바", "사"],
      cursor: { row: 2, column: 2 },
      hiddenAbove: 0,
      hiddenBelow: 0,
    },
  );
});

test("composer viewport keeps emoji and Japanese graphemes intact while wrapping", () => {
  assert.deepEqual(
    layout({ value: "A🙂日B", cursorOffset: "A🙂日B".length, width: 4, maxRows: 4 }),
    {
      lines: ["A🙂", "日B"],
      cursor: { row: 1, column: 3 },
      hiddenAbove: 0,
      hiddenBelow: 0,
    },
  );
});

test("composer viewport moves an end cursor to the next row at an exact width boundary", () => {
  assert.deepEqual(
    layout({ value: "한글", cursorOffset: 2, width: 4, maxRows: 4 }),
    {
      lines: ["한글", ""],
      cursor: { row: 1, column: 0 },
      hiddenAbove: 0,
      hiddenBelow: 0,
    },
  );
});

test("composer viewport keeps the cursor visible and reports clipped rows", () => {
  const value = "하나\n둘\n셋\n넷\n다섯\n여섯";
  const cursorOffset = value.indexOf("다섯") + "다섯".length;

  assert.deepEqual(
    layout({ value, cursorOffset, width: 12, maxRows: 4 }),
    {
      lines: ["셋", "넷", "다섯", "여섯"],
      cursor: { row: 2, column: 4 },
      hiddenAbove: 2,
      hiddenBelow: 0,
    },
  );
});

test("native composer cursor includes the viewport overflow indicator offset", () => {
  const viewport = layout({
    value: "하나\n둘\n셋\n넷\n다섯\n여섯",
    cursorOffset: "하나\n둘\n셋\n넷\n다섯".length,
    width: 12,
    maxRows: 4,
  });
  const position = typeof composer.resolveComposerTerminalCursor === "function"
    ? composer.resolveComposerTerminalCursor({
        origin: { x: 3, y: 10 },
        viewport,
        visible: true,
      })
    : null;

  assert.deepEqual(position, { x: 7, y: 13 });
  assert.equal(
    typeof composer.resolveComposerTerminalCursor === "function"
      ? composer.resolveComposerTerminalCursor({
          origin: { x: 3, y: 10 },
          viewport,
          visible: false,
        })
      : null,
    undefined,
  );
});

test("composer overflow labels remain one terminal row at the minimum width", () => {
  assert.equal(typeof composer.formatComposerOverflowLine, "function");
  const line = composer.formatComposerOverflowLine("above", 123_456, 12);

  assert.equal(line.includes("\n"), false);
  assert.equal(getDisplayWidth(line), 12);
});
