/**
 * Terminal background detection, shared by the work shell and the dashboard.
 *
 * Both surfaces paint with ANSI colour names so they inherit the user's
 * terminal theme, but the primary text tier still has to know which end of the
 * ramp is readable: `whiteBright` on a dark ground, `black` on a light one.
 * This is the only thing the palettes branch on.
 *
 * Resolution order — override, probe, COLORFGBG, dark:
 *
 * COLORFGBG alone is not enough. Ghostty, iTerm2, Alacritty and WezTerm do not
 * set it, so it is absent on most modern setups and every one of them fell
 * through to the dark default — right by luck on a dark theme, wrong on a light
 * one. `probeTerminalBackground` asks the terminal directly via OSC 11, the
 * same query Textual and Lip Gloss use, and its answer is preferred when the
 * terminal replies.
 */

type Background = "light" | "dark";

let probedBackground: Background | undefined;

export function detectTerminalBackground(): Background {
  const override = process.env.UNCLECODE_TERMINAL_BACKGROUND;
  if (override === "dark" || override === "light") return override;
  if (probedBackground) return probedBackground;
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bg = parts.length >= 2 ? Number.parseInt(parts[1] ?? "", 10) : Number.NaN;
    if (!Number.isNaN(bg)) return bg >= 7 ? "light" : "dark";
  }
  return "dark";
}

/** @internal test seam — clears the cached probe result. */
export function resetProbedTerminalBackground(): void {
  probedBackground = undefined;
}

/**
 * Classify an OSC 11 reply body. Terminals answer with 16-bit-per-channel
 * values (`rgb:1a1a/1b1b/2626`) but some report 8- or 12-bit, so each channel
 * is normalised by its own digit count rather than assumed to be four.
 */
export function parseOsc11Background(reply: string): Background | undefined {
  const match = /rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(reply);
  if (!match) return undefined;
  const channels = [match[1], match[2], match[3]].map((raw) => {
    const digits = raw ?? "";
    const max = 16 ** digits.length - 1;
    return max > 0 ? Number.parseInt(digits, 16) / max : 0;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  // WCAG relative luminance; above the midpoint the ground is light.
  const linear = [red, green, blue].map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const luminance =
    0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
  return luminance > 0.25 ? "light" : "dark";
}

const OSC11_QUERY = "\u001B]11;?\u0007";

/**
 * Ask the terminal for its background colour and cache the answer.
 *
 * Must run before Ink mounts: it puts stdin in raw mode and consumes the
 * reply, and Ink owns stdin once it starts. Terminals that ignore OSC 11 simply
 * never reply, so the probe resolves on a short timeout and the caller falls
 * back to COLORFGBG.
 */
export async function probeTerminalBackground(input?: {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly timeoutMs?: number;
}): Promise<Background | undefined> {
  const stdin = input?.stdin ?? process.stdin;
  const stdout = input?.stdout ?? process.stdout;
  const timeoutMs = input?.timeoutMs ?? 120;

  // Opt-in. The probe has to own stdin — raw mode plus a data listener — for
  // the moment before Ink mounts and claims it itself, and that handover
  // races: launched repeatedly against the real binary, the shell came up
  // blank perhaps one run in two. Guessing the background wrong costs
  // contrast; losing the render costs the app. Until the handover is
  // deterministic this stays behind a flag, and resolution falls back to
  // COLORFGBG then dark.
  if (process.env.UNCLECODE_PROBE_TERMINAL_BACKGROUND !== "1") return undefined;
  if (process.env.UNCLECODE_TERMINAL_BACKGROUND || process.env.NO_COLOR) return undefined;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") return undefined;

  const wasRaw = stdin.isRaw === true;
  let reply = "";

  return await new Promise<Background | undefined>((resolve) => {
    let settled = false;
    const finish = (value: Background | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Remove only what this probe added. Pausing stdin here left it paused
      // for the Ink app that mounts next, which rendered nothing at all —
      // caught only by running the real binary, never by the tests, because
      // they feed a fake stdin that no renderer consumes afterwards.
      stdin.off("data", onData);
      if (!wasRaw) stdin.setRawMode(false);
      if (value) probedBackground = value;
      resolve(value);
    };

    const onData = (chunk: Buffer | string): void => {
      reply += chunk.toString("utf8");
      // The reply ends at BEL or ST; wait for one before parsing.
      if (!/\u0007|\u001B\\/.test(reply)) return;
      finish(parseOsc11Background(reply));
    };

    const timer = setTimeout(() => { finish(parseOsc11Background(reply)); }, timeoutMs);

    try {
      stdin.setRawMode(true);
      // Attaching a "data" listener puts the stream in flowing mode on its
      // own; an explicit resume() would have to be undone, and undoing it is
      // what broke the app.
      stdin.on("data", onData);
      stdout.write(OSC11_QUERY);
    } catch {
      finish(undefined);
    }
  });
}
