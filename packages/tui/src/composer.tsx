import { useEffect, useRef, useState } from "react";
import TextInput from "ink-text-input";

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

export function Composer(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void | Promise<void>;
  readonly onPaste?: ((text: string) => void) | undefined;
  readonly onIsPastingChange?: ((isPasting: boolean) => void) | undefined;
  readonly mask?: string | undefined;
}) {
  const [isPasting, setIsPasting] = useState(false);
  const pasteTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressNextSubmitRef = useRef(false);

  useEffect(() => {
    props.onIsPastingChange?.(isPasting);
  }, [isPasting, props.onIsPastingChange]);

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

  return (
    <TextInput
      value={props.value}
      {...(props.mask !== undefined ? { mask: props.mask } : {})}
      onChange={(rawNextValue) => {
        const nextValue = sanitizeComposerInput(rawNextValue);
        if (shouldTreatComposerChangeAsPaste(props.value, nextValue)) {
          armPasteWindow(nextValue);
        }
        props.onChange(nextValue);
      }}
      onSubmit={(rawNextValue) => {
        if (suppressNextSubmitRef.current || isPasting) {
          return;
        }
        void props.onSubmit(sanitizeComposerInput(rawNextValue));
      }}
    />
  );
}
