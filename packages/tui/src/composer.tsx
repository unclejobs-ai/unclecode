import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

const COMPOSER_PASTE_THRESHOLD = 48;
const PASTE_SETTLE_MS = 120;
const BRACKETED_PASTE_ARTIFACT_PATTERN = /(?:\u001b\[(?:200|201|990)~|\[(?:200|201|990)~)/g;

export function sanitizeComposerInput(value: string): string {
  return value.replace(BRACKETED_PASTE_ARTIFACT_PATTERN, "");
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
  const cursorOffset = Math.max(0, Math.min(input.cursorOffset, input.value.length));

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
      nextCursorOffset: Math.max(0, cursorOffset - 1),
      submitted: false,
    };
  }

  if (input.key.rightArrow) {
    return {
      nextValue: input.value,
      nextCursorOffset: Math.min(input.value.length, cursorOffset + 1),
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

    return {
      nextValue: `${input.value.slice(0, cursorOffset - 1)}${input.value.slice(cursorOffset)}`,
      nextCursorOffset: cursorOffset - 1,
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

function maskComposerValue(value: string, mask?: string): string {
  if (!mask) {
    return value;
  }

  return Array.from(value, (char) => (char === "\n" ? "\n" : mask)).join("");
}

function getCursorPosition(value: string, cursorOffset: number): {
  readonly lineIndex: number;
  readonly columnIndex: number;
} {
  const clampedOffset = Math.max(0, Math.min(cursorOffset, value.length));
  const beforeCursor = value.slice(0, clampedOffset);
  const lines = beforeCursor.split("\n");
  return {
    lineIndex: Math.max(0, lines.length - 1),
    columnIndex: lines.at(-1)?.length ?? 0,
  };
}

function renderComposerLine(line: string, cursorColumn: number | undefined): React.ReactNode {
  if (cursorColumn === undefined) {
    return <Text>{line.length > 0 ? line : " "}</Text>;
  }

  if (cursorColumn >= line.length) {
    return (
      <Text>
        {line}
        <Text inverse> </Text>
      </Text>
    );
  }

  return (
    <Text>
      {line.slice(0, cursorColumn)}
      <Text inverse>{line[cursorColumn]}</Text>
      {line.slice(cursorColumn + 1)}
    </Text>
  );
}

export function Composer(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void | Promise<void>;
  readonly onPaste?: ((text: string) => void) | undefined;
  readonly onIsPastingChange?: ((isPasting: boolean) => void) | undefined;
  readonly mask?: string | undefined;
}) {
  const [isPasting, setIsPasting] = useState(false);
  const [cursorOffset, setCursorOffset] = useState(props.value.length);
  const pasteTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressNextSubmitRef = useRef(false);

  useEffect(() => {
    props.onIsPastingChange?.(isPasting);
  }, [isPasting, props.onIsPastingChange]);

  useEffect(() => {
    setCursorOffset((current) => Math.min(current, props.value.length));
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

    const result = applyComposerEdit({
      value: props.value,
      cursorOffset,
      input,
      key,
      allowLineBreaks: props.mask === undefined,
    });

    setCursorOffset(result.nextCursorOffset);

    if (result.submitted) {
      if (suppressNextSubmitRef.current || isPasting) {
        return;
      }
      void props.onSubmit(sanitizeComposerInput(result.nextValue));
      return;
    }

    if (result.nextValue !== props.value) {
      if (shouldTreatComposerChangeAsPaste(props.value, result.nextValue)) {
        armPasteWindow(result.nextValue);
      }
      props.onChange(result.nextValue);
    }
  }, { isActive: true });

  const visibleValue = maskComposerValue(props.value, props.mask);
  const cursorPosition = getCursorPosition(visibleValue, cursorOffset);
  const lines = (visibleValue.length > 0 ? visibleValue : "").split("\n");

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Box key={`${index}-${line}`}>
          {renderComposerLine(
            line,
            index === cursorPosition.lineIndex ? cursorPosition.columnIndex : undefined,
          )}
        </Box>
      ))}
    </Box>
  );
}
