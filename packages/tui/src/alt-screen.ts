/**
 * Alternate screen buffer.
 *
 * Every terminal-native coding agent — Claude Code, Codex, Grok Build, Droid,
 * OpenCode, Kaku — switches the terminal to its alternate buffer on launch, so
 * the app owns the whole viewport and the shell scrollback comes back
 * untouched on exit. UncleCode drew inline instead: the frame appeared *below*
 * the shell prompt, `unclecode` stayed visible above it, and the last frame
 * was left behind in scrollback afterwards. That is why it never felt like it
 * took over the terminal.
 *
 * The escapes are built from a char code rather than written literally so the
 * source stays free of raw control characters.
 */

const ESC = String.fromCharCode(27);

/** Switch to the alternate buffer and park the cursor at the top-left. */
const ENTER_ALTERNATE_SCREEN = `${ESC}[?1049h${ESC}[H`;
/** Return to the primary buffer, restoring the shell's scrollback. */
const LEAVE_ALTERNATE_SCREEN = `${ESC}[?1049l`;
/** Hide/show the hardware cursor; Ink draws its own. */
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ENABLE_MOUSE_TRACKING = `${ESC}[?1000h${ESC}[?1006h`;
const DISABLE_MOUSE_TRACKING = `${ESC}[?1006l${ESC}[?1000l`;

export type AltScreenSession = {
  /** Idempotent — safe to call from both the exit path and a signal handler. */
  readonly restore: () => void;
  readonly active: boolean;
};

const INACTIVE: AltScreenSession = { restore: () => {}, active: false };

/** Enable SGR mouse reporting while the work pane owns transcript scrolling. */
export function enterMouseTracking(stdout: NodeJS.WriteStream = process.stdout): AltScreenSession {
  if (!stdout.isTTY || process.env.UNCLECODE_DISABLE_ALT_SCREEN === "1") return INACTIVE;
  let restored = false;
  stdout.write(ENABLE_MOUSE_TRACKING);
  return {
    active: true,
    restore: () => {
      if (restored) return;
      restored = true;
      stdout.write(DISABLE_MOUSE_TRACKING);
    },
  };
}

/**
 * Enter the alternate screen, returning a restore handle.
 *
 * Restoration is wired to process exit and to the fatal signals as well as the
 * returned handle: a crash that skipped the handle would otherwise strand the
 * user's terminal on an empty alternate buffer with no cursor.
 */
export function enterAlternateScreen(stdout: NodeJS.WriteStream = process.stdout): AltScreenSession {
  if (!stdout.isTTY || process.env.UNCLECODE_DISABLE_ALT_SCREEN === "1") {
    return INACTIVE;
  }

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    process.off("exit", onExit);
    for (const signal of FATAL_SIGNALS) process.off(signal, onSignal);
    stdout.write(`${DISABLE_MOUSE_TRACKING}${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`);
  };

  const onExit = (): void => { restore(); };
  const onSignal = (signal: NodeJS.Signals): void => {
    restore();
    // Re-raise with the default disposition so the exit status reports the
    // signal rather than a plain 0.
    process.off(signal, onSignal);
    process.kill(process.pid, signal);
  };

  stdout.write(`${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}`);
  process.once("exit", onExit);
  for (const signal of FATAL_SIGNALS) process.once(signal, onSignal);

  return { restore, active: true };
}

const FATAL_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** @internal test seam. */
export const ALT_SCREEN_SEQUENCES = {
  enter: ENTER_ALTERNATE_SCREEN,
  leave: LEAVE_ALTERNATE_SCREEN,
  hideCursor: HIDE_CURSOR,
  showCursor: SHOW_CURSOR,
  enableMouseTracking: ENABLE_MOUSE_TRACKING,
  disableMouseTracking: DISABLE_MOUSE_TRACKING,
} as const;
