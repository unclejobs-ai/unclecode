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
const HANGUL_PATTERN = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
const HANGUL_JAMO_PATTERN = /^[\u1100-\u11ff\u3130-\u318f]+$/u;
const COMPOSER_DEFAULT_VISIBLE_WIDTH = 72;
const COMPOSER_CURSOR_GLYPH = "▏";

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

function commonPrefixOffset(left: string, right: string): number {
  let offset = 0;
  const maxOffset = Math.min(left.length, right.length);
  while (offset < maxOffset) {
    const leftCodePoint = left.codePointAt(offset);
    const rightCodePoint = right.codePointAt(offset);
    if (leftCodePoint === undefined || leftCodePoint !== rightCodePoint) {
      break;
    }
    offset += leftCodePoint > 0xffff ? 2 : 1;
  }
  return offset;
}

function graphemeBeforeCursor(value: string, cursorOffset: number): string {
  const normalized = normalizeComposerCursorOffset(value, cursorOffset);
  const previousOffset = previousComposerCursorOffset(value, normalized);
  return value.slice(previousOffset, normalized);
}

function resolveHangulCompositionReplacement(input: {
  readonly value: string;
  readonly cursorOffset: number;
  readonly sanitizedInput: string;
}): {
  readonly nextValue: string;
  readonly nextCursorOffset: number;
} | undefined {
  if (
    input.value.length === 0 ||
    input.sanitizedInput.length === 0 ||
    input.sanitizedInput.includes("\n") ||
    !HANGUL_PATTERN.test(input.value) ||
    !HANGUL_PATTERN.test(input.sanitizedInput)
  ) {
    return undefined;
  }

  const cursorOffset = normalizeComposerCursorOffset(input.value, input.cursorOffset);
  const beforeCursor = graphemeBeforeCursor(input.value, cursorOffset);

  if (beforeCursor.length > 0 && HANGUL_JAMO_PATTERN.test(beforeCursor)) {
    const head = input.value.slice(0, cursorOffset - beforeCursor.length);
    const tail = input.value.slice(cursorOffset);
    const nextValue = `${head}${input.sanitizedInput}${tail}`;
    return {
      nextValue,
      nextCursorOffset: head.length + input.sanitizedInput.length,
    };
  }

  const head = input.value.slice(0, cursorOffset);
  if (input.sanitizedInput.startsWith(head) && input.sanitizedInput.length > head.length) {
    const inserted = input.sanitizedInput.slice(head.length);
    const tail = input.value.slice(cursorOffset);
    const overlap = commonPrefixOffset(inserted, tail);
    const shorterLength = Math.min(inserted.length, tail.length);
    const minimumOverlap =
      shorterLength === 0 ? 0 : Math.max(1, Math.floor(shorterLength * 0.6));
    if (tail.length === 0 || overlap >= minimumOverlap) {
      const nextValue = `${head}${inserted}${tail.slice(overlap)}`;
      return {
        nextValue,
        nextCursorOffset: head.length + inserted.length,
      };
    }
  }

  if (cursorOffset !== input.value.length) {
    return undefined;
  }

  if (input.sanitizedInput.length <= 1) {
    return undefined;
  }

  const prefixOffset = commonPrefixOffset(input.value, input.sanitizedInput);
  const shorterLength = Math.min(input.value.length, input.sanitizedInput.length);
  const minimumOverlap = Math.max(2, Math.floor(shorterLength * 0.6));
  if (prefixOffset >= shorterLength || prefixOffset >= minimumOverlap) {
    return {
      nextValue: input.sanitizedInput,
      nextCursorOffset: input.sanitizedInput.length,
    };
  }

  return undefined;
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

  const compositionReplacement = resolveHangulCompositionReplacement({
    value: input.value,
    cursorOffset,
    sanitizedInput,
  });
  if (compositionReplacement) {
    return {
      ...compositionReplacement,
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
  return Math.max(12, columns - 10);
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
  textColor?: string,
): React.ReactNode {
  const colorProps = textColor ? { color: textColor } : {};
  const visibleWidth = resolveComposerVisibleWidth(terminalColumns);
  if (cursorColumn === undefined) {
    return <Text {...colorProps}>{padComposerLine(line.length > 0 ? line : " ", visibleWidth)}</Text>;
  }

  const lineWidth = getDisplayWidth(line);
  const cursorWidth = getDisplayWidth(COMPOSER_CURSOR_GLYPH);
  if (cursorColumn >= lineWidth) {
    const paddingWidth = Math.max(0, visibleWidth - lineWidth - cursorWidth);
    return (
      <Text {...colorProps}>
        {line}
        {COMPOSER_CURSOR_GLYPH}
        {" ".repeat(paddingWidth)}
      </Text>
    );
  }

  const { before, atCursor, after } = splitLineAtDisplayColumn(line, cursorColumn);
  const renderedWidth = getDisplayWidth(`${before}${atCursor}${after}`) + cursorWidth;
  return (
    <Text {...colorProps}>
      {before}
      {COMPOSER_CURSOR_GLYPH}
      {atCursor}
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
  /**
   * Injectable clipboard image capture. Production defaults to the platform
   * capture from `@unclecode/orchestrator`; tests inject a synthetic PNG
   * capture so the Ctrl+V path never mutates the OS clipboard.
   */
  readonly captureClipboardImage?: (() => ClipboardImageResult) | undefined;
  readonly mask?: string | undefined;
  readonly terminalColumns?: number | undefined;
  /**
   * Explicit text color for typed input. Critical for dark terminals: without
   * it the Composer inherits terminal default fg and typed text vanishes on
   * black/dark backgrounds. Pass a high-contrast palette color (e.g. W.text).
   */
  readonly textColor?: string | undefined;
  /**
   * Context Inspector (Sprint 2): when true AND the composer value is empty,
   * the inspector overlay captures its single-char keys before they become
   * draft text. Mutation keys (Enter/f/i) are gated separately so read-only
   * context panes do not silently swallow input they cannot act on.
   */
  readonly suppressInspectorKeys?: boolean | undefined;
  readonly suppressInspectorMutationKeys?: boolean | undefined;
}) {
  const [isPasting, setIsPasting] = useState(false);
  const [cursorOffset, setCursorOffset] = useState(props.value.length);
  const cursorOffsetRef = useRef(props.value.length);
  const pendingLocalValueRef = useRef<string | undefined>(undefined);
  const pasteTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressNextSubmitRef = useRef(false);
  // Ink's useInput rebinds when the handler identity changes, but Enter after
  // Ctrl+V can still observe a stale onSubmit/onClipboardImage closure from
  // the pre-attachment render. Always read the latest props through a ref.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    propsRef.current.onIsPastingChange?.(isPasting);
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
    propsRef.current.onPaste?.(text);
    if (pasteTimeoutRef.current) {
      clearTimeout(pasteTimeoutRef.current);
    }
    pasteTimeoutRef.current = setTimeout(() => {
      suppressNextSubmitRef.current = false;
      setIsPasting(false);
    }, PASTE_SETTLE_MS);
  };
  const resetLocalValueAfterSubmit = (): void => {
    pendingLocalValueRef.current = "";
    cursorOffsetRef.current = 0;
    setCursorOffset(0);
  };

  useInput((input, key) => {
    const latestProps = propsRef.current;
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
        capture: latestProps.captureClipboardImage ?? defaultCaptureClipboardImage,
        onClipboardImage: latestProps.onClipboardImage,
        onClipboardImageError: latestProps.onClipboardImageError,
      });
      if (outcome === "handled") {
        return;
      }
    }

    if (key.ctrl) {
      return;
    }

    // While Context Desk owns an empty composer, keep its navigation and
    // mutation keys out of the draft. Read-only panes still allow Space/P as
    // ordinary text because those actions are unavailable.
    if (
      latestProps.suppressInspectorKeys
      && (pendingLocalValueRef.current ?? latestProps.value ?? "").length === 0
    ) {
      const suppressMutationKeys =
        latestProps.suppressInspectorMutationKeys ?? latestProps.suppressInspectorKeys;
      if (key.return) {
        return;
      }
      if (suppressMutationKeys && (input === " " || input === "p")) {
        return;
      }
    }

    const currentValue = pendingLocalValueRef.current ?? latestProps.value;
    const currentCursorOffset = cursorOffsetRef.current;
    const carriageReturnIndex = input.indexOf("\r");
    const textBeforeReturn =
      carriageReturnIndex >= 0
        ? input.slice(0, carriageReturnIndex)
        : key.return
          ? input
          : undefined;
    if (!key.shift && textBeforeReturn !== undefined) {
      const submittedValue = textBeforeReturn.length > 0
        ? `${currentValue.slice(0, currentCursorOffset)}${sanitizeComposerInput(textBeforeReturn)}${currentValue.slice(currentCursorOffset)}`
        : currentValue;
      if (suppressNextSubmitRef.current || isPasting) {
        cursorOffsetRef.current = submittedValue.length;
        setCursorOffset(submittedValue.length);
        pendingLocalValueRef.current = submittedValue;
        if (submittedValue !== currentValue) {
          latestProps.onChange(submittedValue);
        }
        return;
      }
      resetLocalValueAfterSubmit();
      void Promise.resolve(latestProps.onSubmit(sanitizeComposerInput(submittedValue))).catch(() => undefined);
      return;
    }

    const result = applyComposerEdit({
      value: currentValue,
      cursorOffset: currentCursorOffset,
      input,
      key,
      allowLineBreaks: latestProps.mask === undefined,
    });

    cursorOffsetRef.current = result.nextCursorOffset;
    setCursorOffset(result.nextCursorOffset);

    if (result.submitted) {
      if (suppressNextSubmitRef.current || isPasting) {
        return;
      }
      resetLocalValueAfterSubmit();
      void Promise.resolve(latestProps.onSubmit(sanitizeComposerInput(result.nextValue))).catch(() => undefined);
      return;
    }

    if (result.nextValue !== currentValue) {
      if (shouldTreatComposerChangeAsPaste(currentValue, result.nextValue)) {
        armPasteWindow(result.nextValue);
      }
      pendingLocalValueRef.current = result.nextValue;
      latestProps.onChange(result.nextValue);
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
            props.textColor,
          )}
        </Box>
      ))}
    </Box>
  );
}
