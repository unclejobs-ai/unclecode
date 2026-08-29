import {
  captureClipboardImage as defaultCaptureClipboardImage,
  type ClipboardImageAttachment,
  type ClipboardImageResult,
} from "@unclecode/orchestrator";
import { Box, Text, useCursor, useInput, type DOMElement } from "ink";
import React, { useEffect, useRef, useState } from "react";

import { getDisplayWidth, segmentDisplayGraphemes, truncateForDisplayWidth } from "./text-width.js";
import type { AgentConsoleKeyState } from "./work-shell-agent-console-input.js";

// `ClipboardImageResult` is re-exported only because it is part of
// `handleComposerClipboardPaste`'s public signature (an internal test seam).
// Composer itself never receives a result type from props anymore.
export type { ClipboardImageResult };

const COMPOSER_PASTE_THRESHOLD = 48;
const PASTE_SETTLE_MS = 120;
const BRACKETED_PASTE_ARTIFACT_PATTERN = /(?:\u001b\[(?:200|201|990)~|\[(?:200|201|990)~)/g;
const NON_TEXT_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const COMPOSER_DEFAULT_VISIBLE_WIDTH = 72;
const COMPOSER_MAX_VISIBLE_ROWS = 4;

export function isRawComposerEmpty(value: string, pendingValue?: string): boolean {
  return (pendingValue ?? value).length === 0;
}

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

  if (input.key.backspace) {
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

  if (input.key.delete) {
    if (cursorOffset === input.value.length) {
      return {
        nextValue: input.value,
        nextCursorOffset: cursorOffset,
        submitted: false,
      };
    }

    const nextOffset = nextComposerCursorOffset(input.value, cursorOffset);
    return {
      nextValue: `${input.value.slice(0, cursorOffset)}${input.value.slice(nextOffset)}`,
      nextCursorOffset: cursorOffset,
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
  if (input.pendingLocalValue !== undefined) {
    // A controlled parent can acknowledge an earlier edit after a newer local
    // edit is already pending. Preserve both the newer draft and its cursor;
    // explicit owner resets use resetEpoch instead of masquerading as an ack.
    return normalizeComposerCursorOffset(input.pendingLocalValue, input.currentCursorOffset);
  }

  return input.nextValue.length;
}

function maskComposerValue(value: string, mask?: string): string {
  if (!mask) {
    return value;
  }

  return segmentDisplayGraphemes(value).map((grapheme) => (grapheme === "\n" ? "\n" : mask)).join("");
}

export type ComposerViewportLayout = {
  readonly lines: readonly string[];
  readonly cursor: {
    readonly row: number;
    readonly column: number;
  };
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
};

export function layoutComposerViewport(input: {
  readonly value: string;
  readonly cursorOffset: number;
  readonly width: number;
  readonly maxRows: number;
}): ComposerViewportLayout {
  const width = Math.max(1, Math.trunc(input.width));
  const maxRows = Math.max(1, Math.trunc(input.maxRows));
  const cursorOffset = normalizeComposerCursorOffset(input.value, input.cursorOffset);
  const rows: string[][] = [[]];
  let row = 0;
  let column = 0;
  let offset = 0;
  let cursor = { row: 0, column: 0 };
  let cursorResolved = false;

  for (const grapheme of segmentDisplayGraphemes(input.value)) {
    if (grapheme !== "\n") {
      const graphemeWidth = Math.max(1, getDisplayWidth(grapheme));
      if (column === width || column + graphemeWidth > width) {
        rows.push([]);
        row += 1;
        column = 0;
      }
    }

    if (offset === cursorOffset) {
      cursor = { row, column };
      cursorResolved = true;
    }

    if (grapheme === "\n") {
      rows.push([]);
      row += 1;
      column = 0;
    } else {
      rows[row]?.push(grapheme);
      column += Math.max(1, getDisplayWidth(grapheme));
    }
    offset += grapheme.length;
  }

  if (!cursorResolved) {
    if (column === width) {
      rows.push([]);
      row += 1;
      column = 0;
    }
    cursor = { row, column };
  }

  const firstVisibleRow = Math.min(
    Math.max(0, rows.length - maxRows),
    Math.max(0, cursor.row - Math.floor(maxRows / 2)),
  );
  const lines = rows.slice(firstVisibleRow, firstVisibleRow + maxRows).map((parts) => parts.join(""));
  return {
    lines,
    cursor: {
      row: cursor.row - firstVisibleRow,
      column: cursor.column,
    },
    hiddenAbove: firstVisibleRow,
    hiddenBelow: Math.max(0, rows.length - firstVisibleRow - lines.length),
  };
}

export function resolveComposerTerminalCursor(input: {
  readonly origin: { readonly x: number; readonly y: number } | undefined;
  readonly viewport: ComposerViewportLayout | null;
  readonly visible: boolean;
}): { readonly x: number; readonly y: number } | undefined {
  if (!input.visible || !input.origin || !input.viewport) {
    return undefined;
  }
  return {
    x: input.origin.x + input.viewport.cursor.column,
    y: input.origin.y + input.viewport.cursor.row + (input.viewport.hiddenAbove > 0 ? 1 : 0),
  };
}

function padComposerLine(value: string, width: number): string {
  const padding = Math.max(0, width - getDisplayWidth(value));
  return `${value}${" ".repeat(padding)}`;
}

export function formatComposerOverflowLine(
  direction: "above" | "below",
  count: number,
  width: number,
): string {
  const arrow = direction === "above" ? "↑" : "↓";
  return padComposerLine(
    truncateForDisplayWidth(`${arrow} ${count} more`, width),
    width,
  );
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

function getComposerAbsolutePosition(
  node: DOMElement | null,
): { readonly x: number; readonly y: number } | undefined {
  let current: DOMElement | undefined = node ?? undefined;
  let x = 0;
  let y = 0;
  while (current?.parentNode) {
    if (!current.yogaNode) {
      return undefined;
    }
    x += current.yogaNode.getComputedLeft();
    y += current.yogaNode.getComputedTop();
    current = current.parentNode;
  }
  return current ? { x, y } : undefined;
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
  readonly suppressInspectorPinKey?: boolean | undefined;
  readonly suppressInspectorDeliveryKey?: boolean | undefined;
  readonly suppressInspectorUndoKey?: boolean | undefined;
  readonly suppressInspectorAdviceKeys?: boolean | undefined;
  /**
   * Context Desk Enter: the desk resolves Enter to its expansion action, so it
   * only earns the key on a host that actually wired an expansion handler.
   * Defaults to `suppressInspectorKeys` so a caller that still passes only the
   * blanket inspector flag keeps the previous blanket-Enter behaviour.
   */
  readonly suppressInspectorExpandKey?: boolean | undefined;
  /**
   * Context Desk (Pure Yazi): `h`/`j`/`k`/`l` walk panes and rows, so while the
   * open desk owns an empty composer they must not also land in the draft.
   * Arrow and Page keys never insert text, so only the letters need this.
   *
   * This is the both-axes default for a host that wires the desk as one unit.
   * The runtime wires the two movements independently, so a host that only has
   * one of them must split them with the two props below — otherwise the axis
   * it never wired reaches neither the desk nor the draft and the letter just
   * disappears.
   */
  readonly suppressInspectorNavigationKeys?: boolean | undefined;
  /** `h`/`l` pane walk. Defaults to `suppressInspectorNavigationKeys`. */
  readonly suppressInspectorPaneNavigationKeys?: boolean | undefined;
  /** `j`/`k` row walk. Defaults to `suppressInspectorNavigationKeys`. */
  readonly suppressInspectorCursorNavigationKeys?: boolean | undefined;
  /**
   * Cache Telemetry and Agent History own A/C while their overlay is open.
   * Suppress those action keys before the local draft ref can retain them
   * during the asynchronous panel switch.
   */
  readonly suppressTelemetryHotkeys?: boolean | undefined;
  /**
   * Agent Console (Sprint 3): the console's key ownership is state-dependent
   * (toggle chord, browse keys, cancel confirmation, steer mode), so the
   * Composer asks the console's own resolver instead of carrying a second
   * copy of the key map. Returning true keeps the keystroke out of the draft;
   * `compose` reserves the keystroke for this composer ahead of stale panel
   * suppression flags without swallowing the text.
   */
  readonly suppressAgentConsoleKey?:
    | ((
      input: string,
      key: AgentConsoleKeyState,
      composerEmpty: boolean,
    ) => boolean | "compose")
    | undefined;
  /**
   * Work shell action keys (empty-screen starter prompts, decision replies,
   * the `?` keymap): when the shell's shared ownership predicate claims the
   * single character, it must act elsewhere — never as draft text. Returning
   * true keeps the keystroke out of the draft at the same evaluation point
   * as `suppressAgentConsoleKey`.
   */
  readonly suppressShellActionKeys?:
    | ((input: string, composerEmpty: boolean) => boolean)
    | undefined;
  /**
   * Ghost hint painted onto the empty input row. Shown only while the draft is
   * empty, unmasked, and not settling a paste, so the first keystroke replaces
   * it with real text. Rendered dim over the same padded row (and the same
   * terminal-cursor math) the blank draft used, so layout is unchanged.
   */
  readonly placeholder?: string | undefined;
  readonly cursorVisible?: boolean | undefined;
  /** Explicit owner reset; unlike controlled value acknowledgements, this discards pending local input. */
  readonly resetEpoch?: number | undefined;
}) {
  const { setCursorPosition } = useCursor();
  const composerRef = useRef<DOMElement>(null);
  const [terminalOrigin, setTerminalOrigin] = useState<{ readonly x: number; readonly y: number }>();
  const [isPasting, setIsPasting] = useState(false);
  const [cursorOffset, setCursorOffset] = useState(props.value.length);
  const cursorOffsetRef = useRef(props.value.length);
  const pendingLocalValueRef = useRef<string | undefined>(undefined);
  const resetEpochRef = useRef(props.resetEpoch);
  const pasteTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressNextSubmitRef = useRef(false);
  // Ink's useInput rebinds when the handler identity changes, but Enter after
  // Ctrl+V can still observe a stale onSubmit/onClipboardImage closure from
  // the pre-attachment render. Always read the latest props through a ref.
  const propsRef = useRef(props);
  propsRef.current = props;
  // An explicit owner reset is stronger than a delayed controlled-value ack.
  // Clear the pending draft during render so the very next input handler
  // cannot submit an Esc-cancelled IME/steer draft before effects run.
  const resetEpochChanged = resetEpochRef.current !== props.resetEpoch;
  if (resetEpochChanged) {
    resetEpochRef.current = props.resetEpoch;
    pendingLocalValueRef.current = undefined;
    cursorOffsetRef.current = props.value.length;
  }

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

  useEffect(() => {
    if (resetEpochChanged) setCursorOffset(props.value.length);
  }, [resetEpochChanged, props.value]);

  useEffect(
    () => () => {
      if (pasteTimeoutRef.current) {
        clearTimeout(pasteTimeoutRef.current);
      }
    },
    [],
  );
  useEffect(() => {
    const nextOrigin = getComposerAbsolutePosition(composerRef.current);
    setTerminalOrigin((current) => (
      current?.x === nextOrigin?.x && current?.y === nextOrigin?.y ? current : nextOrigin
    ));
  });

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
    // The Agent Console takes the frame ahead of every panel overlay, so its
    // ownership question is asked first.
    const agentConsoleKeyOwnership = latestProps.suppressAgentConsoleKey?.(
      input,
      key,
      isRawComposerEmpty(latestProps.value ?? "", pendingLocalValueRef.current),
    );
    if (agentConsoleKeyOwnership === true) {
      // Esc and Alt+A can tear down an agent-steer composer before React has
      // painted the parent's cleared value. Discard the child-owned draft in
      // the same terminal input event so a following Enter can never submit
      // the abandoned agent message as an ordinary provider prompt.
      if (key.escape || (key.meta && input.toLowerCase() === "a")) {
        resetLocalValueAfterSubmit();
      }
      return;
    }
    const agentConsoleOwnsComposer = agentConsoleKeyOwnership === "compose";
    // Shell action keys (starter prefill, decision one-key replies, `?`
    // keymap) resolve through the same shared predicate the input controller
    // dispatches on, so an owned character is never also draft text.
    if (
      !agentConsoleOwnsComposer
      && latestProps.suppressShellActionKeys?.(
        input,
        isRawComposerEmpty(latestProps.value ?? "", pendingLocalValueRef.current),
      )
    ) {
      return;
    }
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

    if ((key.ctrl && input === "v") || input === "\u0016") {
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


    if (
      !agentConsoleOwnsComposer
      && latestProps.suppressTelemetryHotkeys
      && isRawComposerEmpty(latestProps.value ?? "", pendingLocalValueRef.current)
      && (input.toLowerCase() === "a" || input.toLowerCase() === "c")
    ) {
      return;
    }

    // While Context Desk owns an empty composer, keep its navigation and
    // enabled action keys out of the draft. Read-only panes leave unavailable
    // action letters available as ordinary text.
    if (
      !agentConsoleOwnsComposer
      && latestProps.suppressInspectorKeys
      && isRawComposerEmpty(latestProps.value ?? "", pendingLocalValueRef.current)
    ) {
      const suppressMutationKeys =
        latestProps.suppressInspectorMutationKeys ?? latestProps.suppressInspectorKeys;
      // Enter belongs to the desk only where an expansion handler exists.
      // Swallowing it on a host that cannot expand would drop the keystroke
      // between the desk and the composer's own submit.
      const suppressExpandKey =
        latestProps.suppressInspectorExpandKey ?? latestProps.suppressInspectorKeys;
      if (key.return && suppressExpandKey) {
        return;
      }
      // Each axis answers for its own handler: a desk that walks rows but not
      // panes must hand `h`/`l` back as ordinary text.
      const suppressPaneNavigationKeys =
        latestProps.suppressInspectorPaneNavigationKeys
        ?? latestProps.suppressInspectorNavigationKeys;
      const suppressCursorNavigationKeys =
        latestProps.suppressInspectorCursorNavigationKeys
        ?? latestProps.suppressInspectorNavigationKeys;
      if (suppressPaneNavigationKeys && (input === "h" || input === "l")) {
        return;
      }
      if (suppressCursorNavigationKeys && (input === "j" || input === "k")) {
        return;
      }
      const suppressPinKey =
        latestProps.suppressInspectorPinKey ?? suppressMutationKeys;
      const suppressDeliveryKey =
        latestProps.suppressInspectorDeliveryKey ?? suppressMutationKeys;
      if (
        (suppressPinKey && input === "p")
        || (suppressDeliveryKey && input === " ")
      ) {
        return;
      }
      if (latestProps.suppressInspectorUndoKey && input === "u") {
        return;
      }
      if (
        latestProps.suppressInspectorAdviceKeys
        && (input === "a" || input === "r")
      ) {
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

  // Local input owns the prompt until the controlled parent acknowledges the
  // exact value. Rendering `props.value` during that window makes IME preedit
  // text blink out whenever an unrelated async engine update rerenders the
  // pane. The pending value is already the edit/submit authority above; use
  // that same owner for paint and cursor math.
  const renderValue = pendingLocalValueRef.current ?? props.value;
  const visibleValue = maskComposerValue(renderValue, props.mask);
  const normalizedCursorOffset = normalizeComposerCursorOffset(renderValue, cursorOffset);
  const visibleCursorOffset = props.mask
    ? maskComposerValue(renderValue.slice(0, normalizedCursorOffset), props.mask).length
    : normalizedCursorOffset;
  const visibleWidth = resolveComposerVisibleWidth(props.terminalColumns);
  const viewport = layoutComposerViewport({
    value: visibleValue,
    cursorOffset: visibleCursorOffset,
    width: visibleWidth,
    maxRows: COMPOSER_MAX_VISIBLE_ROWS,
  });
  const terminalCursor = resolveComposerTerminalCursor({
    origin: terminalOrigin,
    viewport,
    visible: props.cursorVisible ?? true,
  });
  setCursorPosition(terminalCursor);
  const colorProps = props.textColor ? { color: props.textColor } : {};
  // The placeholder replaces the padded blank row of an empty draft (mask and
  // paste windows keep their own presentation), never the typed text.
  const placeholderLine = props.placeholder !== undefined
    && renderValue.length === 0
    && props.mask === undefined
    && !isPasting
    ? props.placeholder
    : undefined;

  return (
    <Box ref={composerRef} flexDirection="column">
      {viewport.hiddenAbove > 0 ? (
        <Text {...colorProps} dimColor>{formatComposerOverflowLine("above", viewport.hiddenAbove, visibleWidth)}</Text>
      ) : null}
      {viewport.lines.map((line, index) => (
        placeholderLine !== undefined && line.length === 0 ? (
          <Text
            key={index}
            {...colorProps}
            dimColor
          >{padComposerLine(truncateForDisplayWidth(placeholderLine, visibleWidth), visibleWidth)}</Text>
        ) : (
          <Text key={index} {...colorProps}>{padComposerLine(line.length > 0 ? line : " ", visibleWidth)}</Text>
        )
      ))}
      {viewport.hiddenBelow > 0 ? (
        <Text {...colorProps} dimColor>{formatComposerOverflowLine("below", viewport.hiddenBelow, visibleWidth)}</Text>
      ) : null}
    </Box>
  );
}
