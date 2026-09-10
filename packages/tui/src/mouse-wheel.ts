/**
 * SGR mouse tracking for transcript wheel scroll.
 *
 * Ink's Key has no wheel bit and the renderer keeps `mouseEvents: false`, so
 * the work shell enables X10+SGR itself and parses the CSI. Ink 6 tokenizes a
 * complete SGR sequence as one input event, then `useInput` strips the leading
 * ESC — handlers therefore see `[<64;x;yM`.
 */

const ESC = String.fromCharCode(27);

export const SGR_MOUSE_SEQUENCES = {
  enable: `${ESC}[?1006h${ESC}[?1000h`,
  disable: `${ESC}[?1000l${ESC}[?1006l`,
} as const;

const SGR_MOUSE_PATTERN = /^(?:\x1b)?\[<(\d+);(\d+);(\d+)([Mm])$/;

export type SgrMouseEvent = {
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly release: boolean;
};

export function parseSgrMouse(input: string): SgrMouseEvent | undefined {
  const match = SGR_MOUSE_PATTERN.exec(input);
  if (!match) {
    return undefined;
  }
  return {
    button: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    release: match[4] === "m",
  };
}

export function isSgrMouseInput(input: string): boolean {
  return parseSgrMouse(input) !== undefined;
}

/**
 * Button 64 = wheel up (older, same as PageUp / direction -1).
 * Button 65 = wheel down (newer, same as PageDown / direction +1).
 * Shift/alt/ctrl bits (2–4) are stripped so modified wheels still page.
 * Releases (`m`) are ignored so a press+release pair cannot double-page.
 */
export function resolveTranscriptWheelDirection(input: string): -1 | 1 | undefined {
  const event = parseSgrMouse(input);
  if (!event || event.release) {
    return undefined;
  }
  const wheel = event.button & ~0b11100;
  if (wheel === 64) {
    return -1;
  }
  if (wheel === 65) {
    return 1;
  }
  return undefined;
}

export function resolveTranscriptScrollDirection(input: {
  readonly ctrl?: boolean | undefined;
  readonly overlayOpen: boolean;
  readonly pageUp?: boolean | undefined;
  readonly pageDown?: boolean | undefined;
  readonly input?: string | undefined;
}): -1 | 1 | undefined {
  if (input.ctrl === true || input.overlayOpen) {
    return undefined;
  }
  if (input.pageUp) {
    return -1;
  }
  if (input.pageDown) {
    return 1;
  }
  return resolveTranscriptWheelDirection(input.input ?? "");
}

export function enableWorkShellMouseWheel(stdout: {
  readonly isTTY?: boolean | undefined;
  write(chunk: string): unknown;
}): () => void {
  if (!stdout.isTTY) {
    return () => {};
  }
  stdout.write(SGR_MOUSE_SEQUENCES.enable);
  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    stdout.write(SGR_MOUSE_SEQUENCES.disable);
  };
}
