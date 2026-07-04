const CLEAR_SCREEN_AND_SCROLLBACK = "\u001B[2J\u001B[3J\u001B[H";

export function shouldClearTerminalOnResize(
  previousColumns: number,
  nextColumns: number,
): boolean {
  return nextColumns < previousColumns;
}

export function clearTerminalScreen(stdout: NodeJS.WriteStream): void {
  if (!stdout.isTTY) {
    return;
  }
  stdout.write(CLEAR_SCREEN_AND_SCROLLBACK);
}

/**
 * Ink only erases the rows it drew in the previous frame. When the terminal
 * narrows, the emulator reflows those rows into more lines than Ink knows
 * about, so stale header/divider fragments survive in the screen and
 * scrollback (torn double-header residue). Clearing screen + scrollback
 * before Ink's own resize redraw removes the residue; Ink then repaints the
 * full frame because its narrowing path resets its last-output cache.
 *
 * Registered with prependListener so this runs before Ink's resize handler,
 * which is subscribed earlier (at render time).
 */
export function subscribeTerminalResizeClear(
  stdout: NodeJS.WriteStream,
  getColumns: () => number,
): () => void {
  let previousColumns = getColumns();
  const handleResize = () => {
    const nextColumns = getColumns();
    if (shouldClearTerminalOnResize(previousColumns, nextColumns)) {
      clearTerminalScreen(stdout);
    }
    previousColumns = nextColumns;
  };
  stdout.prependListener("resize", handleResize);
  return () => {
    stdout.off("resize", handleResize);
  };
}
