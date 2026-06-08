import {
  captureClipboardImage as defaultCaptureClipboardImage,
  type ClipboardImageAttachment,
  type ClipboardImageResult,
} from "@unclecode/orchestrator";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";

import { getDisplayWidth, segmentDisplayGraphemes } from "./text-width.js";

// `ClipboardImageResult` is re-exported only because it is part of
// `handleComposerClipboardPaste`'s public signature (an internal test seam).
// Composer itself never receives a result type from props anymore.
export type { ClipboardImageResult };

const COMPOSER_PASTE_THRESHOLD = 48;
const PASTE_SETTLE_MS = 120;
const BRACKETED_PASTE_ARTIFACT_PATTERN = /(?:\u001b\[(?:200|201|990)~|\[(?:200|201|990)~)/g;
const NON_TEXT_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const COMPOSER_DEFAULT_VISIBLE_WIDTH = 72;

export function sanitizeComposerInput(value: string): string {
  return value
    .replace(BRACKETED_PASTE_ARTIFACT_PATTERN, "")
    .replace(NON_TEXT_CONTROL_PATTERN, "");
}

export function shouldTreatComposerChangeAsPaste(
  previousValue: string,
  nextValue: string,
): boolean {
  if (nextValue.length <= previousValue.length) {
    return false;
  }

  const delta = nextValue.length - previousValue.length;
  if (delta >= COMPOSER_PASTE_THRESHOLD) {
    return true;
  }

  return nextValue.includes("\n") && !previousValue.includes("\n");
}

export function applyComposerEdit(input: {
  readonly value: string;
  readonly cursorOffset: number;
  readonly input: string;
  readonly key: {
    readonly leftArrow?: boolean;
    readonly rightArrow?: boolean;
    readonly backspace?: boolean;
    readonly delete?: boolean;
    readonly return?: boolean;
    readonly shift?: boolean;
  };
  readonly allowLineBreaks: boolean;
}): {
  readonly nextValue: string;
  readonly nextCursorOffset: number;
  readonly submitted: boolean;
} {
  const cursorOffset = normalizeComposerCursorOffset(input.value, input.cursorOffset);

  if (input.key.return) {
    if (input.key.shift && input.allowLineBreaks) {
      return {
        nextValue: `${input.value.slice(0, cursorOffset)}\n${input.value.slice(cursorOffset)}`,
        nextCursorOffset: cursorOffset + 1,
        submitted: false,
      };
    }

    return {
      nextValue: input.value,
      nextCursorOffset: cursorOffset,
      submitted: true,
    };
  }

  if (input.key.leftArrow) {
    return {
      nextValue: input.value,
      nextCursorOffset: previousComposerCursorOffset(input.value, cursorOffset),
      submitted: false,
    };
  }

  if (input.key.rightArrow) {
    return {
      nextValue: input.value,
      nextCursorOffset: nextComposerCursorOffset(input.value, cursorOffset),
      submitted: false,
    };
  }

  if (input.key.backspace || input.key.delete) {
    if (cursorOffset === 0) {
      return {
        nextValue: input.value,
        nextCursorOffset: cursorOffset,
        submitted: false,
      };
    }

    const previousOffset = previousComposerCursorOffset(input.value, cursorOffset);
    return {
      nextValue: `${input.value.slice(0, previousOffset)}${input.value.slice(cursorOffset)}`,
      nextCursorOffset: previousOffset,
      submitted: false,
    };
  }

  const sanitizedInput = sanitizeComposerInput(input.input);
  if (!sanitizedInput) {
    return {
      nextValue: input.value,
      nextCursorOffset: cursorOffset,
      submitted: false,
    };
  }

  return {
    nextValue: `${input.value.slice(0, cursorOffset)}${sanitizedInput}${input.value.slice(cursorOffset)}`,
    nextCursorOffset: cursorOffset + sanitizedInput.length,
    submitted: false,
  };
}

function composerCharacterBoundaries(value: string): number[] {
  const boundaries = [0];
  let offset = 0;
  for (const grapheme of segmentDisplayGraphemes(value)) {
    offset += grapheme.length;
    boundaries.push(offset);
  }
  return boundaries;
}

function normalizeComposerCursorOffset(value: string, cursorOffset: number): number {
  const clamped = Math.max(0, Math.min(cursorOffset, value.length));
  let previous = 0;
  for (const boundary of composerCharacterBoundaries(value)) {
    if (boundary === clamped) {
      return boundary;
    }
    if (boundary > clamped) {
      return previous;
    }
    previous = boundary;
  }
  return value.length;
}

function previousComposerCursorOffset(value: string, cursorOffset: number): number {
  const normalized = normalizeComposerCursorOffset(value, cursorOffset);
  let previous = 0;
  for (const boundary of composerCharacterBoundaries(value)) {
    if (boundary >= normalized) {
      return previous;
    }
    previous = boundary;
  }
  return previous;
}

function nextComposerCursorOffset(value: string, cursorOffset: number): number {
  const normalized = normalizeComposerCursorOffset(value, cursorOffset);
  for (const boundary of composerCharacterBoundaries(value)) {
    if (boundary > normalized) {
      return boundary;
    }
  }
  return value.length;
}

export function resolveComposerCursorOffsetAfterValueChange(input: {
  readonly nextValue: string;
  readonly currentCursorOffset: number;
  readonly pendingLocalValue?: string | undefined;
}): number {
  if (input.pendingLocalValue === input.nextValue) {
    return normalizeComposerCursorOffset(input.nextValue, input.currentCursorOffset);
  }

  return input.nextValue.length;
}

function maskComposerValue(value: string, mask?: string): string {
  if (!mask) {
    return value;
  }

  return segmentDisplayGraphemes(value).map((grapheme) => (grapheme === "\n" ? "\n" : mask)).join("");
}

function getCursorPosition(value: string, cursorOffset: number): {
  readonly lineIndex: number;
  readonly columnIndex: number;
} {
  const clampedOffset = Math.max(0, Math.min(cursorOffset, value.length));
  const beforeCursor = value.slice(0, clampedOffset);
  const lines = beforeCursor.split("\n");
  const lastLine = lines.at(-1) ?? "";
  return {
    lineIndex: Math.max(0, lines.length - 1),
    columnIndex: getDisplayWidth(lastLine),
  };
}

function splitLineAtDisplayColumn(line: string, displayColumn: number): {
  readonly before: string;
  readonly atCursor: string;
  readonly after: string;
} {
  let width = 0;
  let beforeEnd = 0;
  for (const grapheme of segmentDisplayGraphemes(line)) {
    const charWidth = getDisplayWidth(grapheme);
    if (width >= displayColumn) {
      const cursorEnd = beforeEnd + grapheme.length;
      return {
        before: line.slice(0, beforeEnd),
        atCursor: grapheme,
        after: line.slice(cursorEnd),
      };
    }
    width += charWidth;
    beforeEnd += grapheme.length;
  }
  return { before: line, atCursor: "", after: "" };
}

function padComposerLine(value: string, width: number): string {
  const padding = Math.max(0, width - getDisplayWidth(value));
  return `${value}${" ".repeat(padding)}`;
}

export function resolveComposerVisibleWidth(terminalColumns?: number): number {
  const columns = terminalColumns ?? process.stdout.columns ?? COMPOSER_DEFAULT_VISIBLE_WIDTH + 10;
  return Math.max(12, Math.min(COMPOSER_DEFAULT_VISIBLE_WIDTH, columns - 10));
}

/**
 * Pure handler for the Ctrl+V branch — extracted so unit tests can exercise
 * the routing without mounting an Ink component. Returns "handled" when an
 * image was captured (caller should skip default text-paste handling) and
 * "fallthrough" otherwise so the existing text path keeps working.
 */
export function handleComposerClipboardPaste(input: {
  readonly capture: () => ClipboardImageResult;
  readonly onClipboardImage?:
    | ((attachment: ClipboardImageAttachment) => void)
    | undefined;
  readonly onClipboardImageError?:
    | ((reason: string, status: "no-image" | "unsupported" | "failed") => void)
    | undefined;
}): "handled" | "fallthrough" {
  if (!input.onClipboardImage) {
    return "fallthrough";
  }
  const result = input.capture();
  if (result.status === "ok") {
    input.onClipboardImage(result.attachment);
    return "handled";
  }
  input.onClipboardImageError?.(result.reason, result.status);
  return "fallthrough";
}

function renderComposerLine(
  line: string,
  cursorColumn: number | undefined,
  terminalColumns?: number,
): React.ReactNode {
  const visibleWidth = resolveComposerVisibleWidth(terminalColumns);
  if (cursorColumn === undefined) {
    return <Text>{padComposerLine(line.length > 0 ? line : " ", visibleWidth)}</Text>;
  }

  const lineWidth = getDisplayWidth(line);
  if (cursorColumn >= lineWidth) {
    const paddingWidth = Math.max(0, visibleWidth - lineWidth - 1);
    return (
      <Text>
        {line}
        <Text inverse> </Text>
        {" ".repeat(paddingWidth)}
      </Text>
    );
  }

  const { before, atCursor, after } = splitLineAtDisplayColumn(line, cursorColumn);
  const renderedWidth = getDisplayWidth(`${before}${atCursor}${after}`);
  return (
    <Text>
      {before}
      <Text inverse>{atCursor}</Text>
      {after}
      {" ".repeat(Math.max(0, visibleWidth - renderedWidth))}
    </Text>
  );
}

export function Composer(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void | Promise<void>;
  readonly onPaste?: ((text: string) => void) | undefined;
  readonly onIsPastingChange?: ((isPasting: boolean) => void) | undefined;
  readonly onClipboardImage?:
    | ((attachment: ClipboardImageAttachment) => void)
    | undefined;
  readonly onClipboardImageError?:
    | ((reason: string, status: "no-image" | "unsupported" | "failed") => void)
    | undefined;
  readonly mask?: string | undefined;
  readonly terminalColumns?: number | undefined;
}) {
  const [isPasting, setIsPasting] = useState(false);
  const [cursorOffset, setCursorOffset] = useState(props.value.length);
  const cursorOffsetRef = useRef(props.value.length);
  const pendingLocalValueRef = useRef<string | undefined>(undefined);
  const pasteTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressNextSubmitRef = useRef(false);

  useEffect(() => {
    props.onIsPastingChange?.(isPasting);
  }, [isPasting, props.onIsPastingChange]);

  useEffect(() => {
    const nextCursorOffset = resolveComposerCursorOffsetAfterValueChange({
      nextValue: props.value,
      currentCursorOffset: cursorOffsetRef.current,
      pendingLocalValue: pendingLocalValueRef.current,
    });
    cursorOffsetRef.current = nextCursorOffset;
    setCursorOffset(nextCursorOffset);
    if (pendingLocalValueRef.current === props.value) {
      pendingLocalValueRef.current = undefined;
    }
  }, [props.value]);

  useEffect(
    () => () => {
      if (pasteTimeoutRef.current) {
        clearTimeout(pasteTimeoutRef.current);
      }
    },
    [],
  );

  const armPasteWindow = (text: string): void => {
    suppressNextSubmitRef.current = true;
    setIsPasting(true);
    props.onPaste?.(text);
    if (pasteTimeoutRef.current) {
      clearTimeout(pasteTimeoutRef.current);
    }
    pasteTimeoutRef.current = setTimeout(() => {
      suppressNextSubmitRef.current = false;
      setIsPasting(false);
    }, PASTE_SETTLE_MS);
  };

  useInput((input, key) => {
    if (
      key.upArrow ||
      key.downArrow ||
      key.tab ||
      (key.shift && key.tab) ||
      key.escape ||
      (key.ctrl && input === "c")
    ) {
      return;
    }

    if (key.ctrl && input === "v") {
      const outcome = handleComposerClipboardPaste({
        capture: defaultCaptureClipboardImage,
        onClipboardImage: props.onClipboardImage,
        onClipboardImageError: props.onClipboardImageError,
      });
      if (outcome === "handled") {
        return;
      }
    }

    if (key.ctrl) {
      return;
    }

    const currentValue = pendingLocalValueRef.current ?? props.value;
    const currentCursorOffset = cursorOffsetRef.current;
    const carriageReturnIndex = input.indexOf("\r");
    if (!key.return && carriageReturnIndex >= 0) {
      const textBeforeReturn = input.slice(0, carriageReturnIndex);
      const submittedValue = textBeforeReturn.length > 0
        ? `${currentValue.slice(0, currentCursorOffset)}${sanitizeComposerInput(textBeforeReturn)}${currentValue.slice(currentCursorOffset)}`
        : currentValue;
      cursorOffsetRef.current = submittedValue.length;
      setCursorOffset(submittedValue.length);
      pendingLocalValueRef.current = undefined;
      if (suppressNextSubmitRef.current || isPasting) {
        return;
      }
      void Promise.resolve(props.onSubmit(sanitizeComposerInput(submittedValue))).catch(() => undefined);
      return;
    }

    const result = applyComposerEdit({
      value: currentValue,
      cursorOffset: currentCursorOffset,
      input,
      key,
      allowLineBreaks: props.mask === undefined,
    });

    cursorOffsetRef.current = result.nextCursorOffset;
    setCursorOffset(result.nextCursorOffset);

    if (result.submitted) {
      if (suppressNextSubmitRef.current || isPasting) {
        return;
      }
      void Promise.resolve(props.onSubmit(sanitizeComposerInput(result.nextValue))).catch(() => undefined);
      return;
    }

    if (result.nextValue !== currentValue) {
      if (shouldTreatComposerChangeAsPaste(currentValue, result.nextValue)) {
        armPasteWindow(result.nextValue);
      }
      pendingLocalValueRef.current = result.nextValue;
      props.onChange(result.nextValue);
    }
  }, { isActive: true });

  const visibleValue = maskComposerValue(props.value, props.mask);
  const cursorPosition = getCursorPosition(visibleValue, cursorOffset);
  const lines = (visibleValue.length > 0 ? visibleValue : "").split("\n");

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Box key={index}>
          {renderComposerLine(
            line,
            index === cursorPosition.lineIndex ? cursorPosition.columnIndex : undefined,
            props.terminalColumns,
          )}
        </Box>
      ))}
    </Box>
  );
}
