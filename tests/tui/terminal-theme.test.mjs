import assert from "node:assert/strict";
import test from "node:test";

import {
  detectTerminalBackground,
  parseOsc11Background,
  probeTerminalBackground,
  resetProbedTerminalBackground,
} from "../../packages/tui/src/terminal-theme.ts";

// Restores env and the probe cache after `run` finishes. A plain try/finally
// would restore as soon as an async `run` returned its promise — wiping the
// probe cache before the assertions that depend on it had run.
function withEnv(overrides, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetProbedTerminalBackground();
  };

  let result;
  try {
    result = run();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === "function") {
    return result.finally(restore);
  }
  restore();
  return result;
}

test("parseOsc11Background classifies 16-bit replies from real terminals", () => {
  // Tokyo Night ground, as Ghostty reports it.
  assert.equal(parseOsc11Background("\u001B]11;rgb:1a1a/1b1b/2626\u0007"), "dark");
  // Solarized Light.
  assert.equal(parseOsc11Background("\u001B]11;rgb:fdfd/f6f6/e3e3\u0007"), "light");
  // ST-terminated reply.
  assert.equal(parseOsc11Background("\u001B]11;rgb:0000/0000/0000\u001B\\"), "dark");
});

test("parseOsc11Background normalises per channel digit count", () => {
  // 8-bit-per-channel white must read as light, not as a near-zero fraction.
  assert.equal(parseOsc11Background("\u001B]11;rgb:ff/ff/ff\u0007"), "light");
  assert.equal(parseOsc11Background("\u001B]11;rgb:fff/fff/fff\u0007"), "light");
  assert.equal(parseOsc11Background("\u001B]11;rgb:00/00/00\u0007"), "dark");
});

test("parseOsc11Background returns undefined when the terminal says nothing useful", () => {
  assert.equal(parseOsc11Background(""), undefined);
  assert.equal(parseOsc11Background("garbage"), undefined);
});

test("detectTerminalBackground prefers the explicit override", () => {
  withEnv({ UNCLECODE_TERMINAL_BACKGROUND: "light", COLORFGBG: "15;0" }, () => {
    assert.equal(detectTerminalBackground(), "light");
  });
});

test("detectTerminalBackground falls back to COLORFGBG, then dark", () => {
  withEnv({ UNCLECODE_TERMINAL_BACKGROUND: undefined, COLORFGBG: "0;15" }, () => {
    assert.equal(detectTerminalBackground(), "light");
  });
  withEnv({ UNCLECODE_TERMINAL_BACKGROUND: undefined, COLORFGBG: "15;0" }, () => {
    assert.equal(detectTerminalBackground(), "dark");
  });
  // Ghostty, iTerm2, Alacritty and WezTerm leave COLORFGBG unset.
  withEnv({ UNCLECODE_TERMINAL_BACKGROUND: undefined, COLORFGBG: undefined }, () => {
    assert.equal(detectTerminalBackground(), "dark");
  });
});

test("probeTerminalBackground is a no-op off a TTY", async () => {
  const result = await withEnv(
    { UNCLECODE_TERMINAL_BACKGROUND: undefined, NO_COLOR: undefined, UNCLECODE_PROBE_TERMINAL_BACKGROUND: "1" },
    () =>
      probeTerminalBackground({
        stdin: { isTTY: false },
        stdout: { isTTY: false },
        timeoutMs: 5,
      }),
  );
  assert.equal(result, undefined);
});

test("probeTerminalBackground reads the reply and overrides COLORFGBG", async () => {
  const listeners = new Set();
  let written = "";
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode() {},
    resume() {},
    pause() {},
    on(event, listener) { if (event === "data") listeners.add(listener); },
    off(event, listener) { if (event === "data") listeners.delete(listener); },
  };
  const stdout = {
    isTTY: true,
    write(chunk) {
      written += chunk;
      // Reply the way a light terminal would.
      for (const listener of listeners) {
        listener(Buffer.from("\u001B]11;rgb:fdfd/f6f6/e3e3\u0007"));
      }
    },
  };

  try {
    const result = await withEnv(
      // COLORFGBG claims dark; the terminal's own answer must win.
      { UNCLECODE_TERMINAL_BACKGROUND: undefined, NO_COLOR: undefined, COLORFGBG: "15;0", UNCLECODE_PROBE_TERMINAL_BACKGROUND: "1" },
      async () => {
        const probed = await probeTerminalBackground({ stdin, stdout, timeoutMs: 50 });
        assert.equal(probed, "light");
        assert.equal(detectTerminalBackground(), "light");
        return probed;
      },
    );
    assert.equal(result, "light");
    assert.match(written, /\u001B\]11;\?/);
  } finally {
    resetProbedTerminalBackground();
  }
});

test("probeTerminalBackground resolves on timeout when the terminal ignores OSC 11", async () => {
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode() {},
    resume() {},
    pause() {},
    on() {},
    off() {},
  };
  const stdout = { isTTY: true, write() {} };

  const result = await withEnv(
    { UNCLECODE_TERMINAL_BACKGROUND: undefined, NO_COLOR: undefined, UNCLECODE_PROBE_TERMINAL_BACKGROUND: "1" },
    () => probeTerminalBackground({ stdin, stdout, timeoutMs: 20 }),
  );
  assert.equal(result, undefined);
});


test("probing leaves stdin usable for the renderer that mounts next", async () => {
  // The probe runs before Ink mounts and must hand stdin back untouched. An
  // earlier version called stdin.pause() on the way out, which left the stream
  // paused for Ink: the app started, rendered nothing, and exited. Only the
  // real binary showed it, so this asserts the handover directly.
  const calls = [];
  const listeners = new Set();
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode(value) { calls.push(`setRawMode:${value}`); this.isRaw = value; },
    resume() { calls.push("resume"); },
    pause() { calls.push("pause"); },
    on(event, listener) { if (event === "data") listeners.add(listener); },
    off(event, listener) { if (event === "data") listeners.delete(listener); },
  };
  const stdout = {
    isTTY: true,
    write() {
      for (const listener of listeners) {
        listener(Buffer.from("\u001B]11;rgb:1a1a/1b1b/2626\u0007"));
      }
    },
  };

  await withEnv(
    { UNCLECODE_TERMINAL_BACKGROUND: undefined, NO_COLOR: undefined, UNCLECODE_PROBE_TERMINAL_BACKGROUND: "1" },
    () => probeTerminalBackground({ stdin, stdout, timeoutMs: 50 }),
  );

  assert.ok(!calls.includes("pause"), `probe must not pause stdin, saw: ${calls.join(", ")}`);
  assert.equal(listeners.size, 0, "probe must remove its own data listener");
  assert.equal(stdin.isRaw, false, "probe must restore the prior raw mode");
});

test("probing is opt-in so a stdin handover race cannot cost the render", async () => {
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode() { throw new Error("probe must not touch stdin when the flag is off"); },
    on() { throw new Error("probe must not listen when the flag is off"); },
    off() {},
    resume() {},
    pause() {},
  };
  const stdout = {
    isTTY: true,
    write() { throw new Error("probe must not write when the flag is off"); },
  };

  const result = await withEnv(
    {
      UNCLECODE_TERMINAL_BACKGROUND: undefined,
      NO_COLOR: undefined,
      UNCLECODE_PROBE_TERMINAL_BACKGROUND: undefined,
    },
    () => probeTerminalBackground({ stdin, stdout, timeoutMs: 20 }),
  );

  assert.equal(result, undefined);
});
