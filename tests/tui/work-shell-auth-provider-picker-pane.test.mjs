import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render } from "ink";
import React from "react";

import { WorkShellPane } from "../../packages/tui/src/index.tsx";
import {
  getWorkShellSlashSuggestions,
  shouldBlockSlashSubmit,
} from "../../packages/orchestrator/src/index.ts";
import { waitForSettledFrame } from "./work-shell-render-harness.mjs";

process.env.UNCLECODE_TERMINAL_BACKGROUND = "dark";

// biome-ignore lint/suspicious/noControlCharactersInRegex: frames carry SGR sequences.
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;
const KEY_DOWN = "\u001B[B";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\u001B";

const CATALOG_ROWS = [
  { id: "kimi-code", name: "Kimi Code", available: true, credentialKey: "kimi-code", signedIn: true, originKind: "oauth" },
  { id: "openrouter", name: "OpenRouter", available: true, credentialKey: "openrouter", signedIn: false },
];

function createInkInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  input.resume = () => input;
  input.pause = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

function createWritableError() {
  const error = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  error.columns = 120;
  error.rows = 40;
  error.isTTY = true;
  return error;
}

function renderPane(element) {
  const stdin = createInkInput();
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.isTTY = true;
  let output = "";
  // Ink's debug renderer writes one whole frame per render, so the last chunk
  // is the screen as it stands now — the accumulator cannot tell a stale
  // receipt that scrolled into history apart from one still on screen.
  let frame = "";
  stdout.on("data", (chunk) => {
    frame = chunk.toString();
    output += chunk.toString();
  });
  const instance = render(element, {
    stdin,
    stdout,
    stderr: createWritableError(),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    stdin,
    instance,
    getOutput: () => output.replace(ANSI_PATTERN, ""),
    getFrame: () => frame.replace(ANSI_PATTERN, ""),
  };
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createEngine() {
  const submitted = [];
  const state = {
    entries: [],
    model: "gpt-5.4",
    mode: "yolo",
    reasoning: "medium",
    authLabel: "oauth-file",
    isBusy: false,
    bridgeLines: [],
    memoryLines: [],
    panel: { title: "Session status", lines: ["Work context ready."] },
  };
  const listeners = new Set();
  return {
    submitted,
    engine: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      initialize: async () => {},
      dispose: () => {},
      handleSubmit: async (line) => {
        submitted.push(line);
      },
      setMode: async () => {},
      openSessionsPanel: async () => {},
    },
  };
}

function paneProps(engine, extras) {
  return {
    provider: "OpenAI",
    model: "gpt-5.4",
    mode: "yolo",
    engine,
    cwd: "/Users/parkeungje/project/unclecode",
    resolveComposerInput: async (value) => ({ prompt: value, attachments: [], transcriptText: value }),
    getSuggestions: (value) =>
      getWorkShellSlashSuggestions(value, { provider: "openai", currentModel: "gpt-5.4" }),
    onExit: () => {},
    shouldBlockSlashSubmit: (line) =>
      shouldBlockSlashSubmit(line, { provider: "openai", currentModel: "gpt-5.4" }),
    getReasoningLabel: () => "default medium",
    isReasoningSupported: () => true,
    ...extras,
  };
}

test("typing /auth reads the injected OMP catalog and makes it the first surface", async () => {
  const { engine } = createEngine();
  let listCalls = 0;
  const { stdin, instance, getOutput } = renderPane(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        ompAuthCatalog: {
          list: async () => {
            listCalls += 1;
            return { ok: true, dbPath: "/tmp/agent.db", providers: CATALOG_ROWS };
          },
          signIn: async () => ({ ok: false, error: { code: "OMP_UNAVAILABLE", message: "unused" } }),
        },
      }),
    ),
  );

  try {
    stdin.write("/auth");
    await waitFor(() => /OMP providers/.test(getOutput()), "the OMP provider catalog");
    const output = getOutput();
    assert.match(output, /Kimi Code/);
    assert.match(output, /OpenRouter/);
    assert.match(output, /not signed in/);
    assert.equal(listCalls, 1, "the catalog must be read once, not per keystroke");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("leaving while the catalog loads retries cleanly on the next /auth open", async () => {
  const { engine } = createEngine();
  const pendingCatalogs = [];
  let listCalls = 0;
  const { stdin, instance, getOutput } = renderPane(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        ompAuthCatalog: {
          list: () => {
            listCalls += 1;
            return new Promise((resolve) => {
              pendingCatalogs.push(resolve);
            });
          },
          signIn: async () => ({ ok: false, error: { code: "OMP_UNAVAILABLE", message: "unused" } }),
        },
      }),
    ),
  );

  try {
    stdin.write("/auth");
    await waitFor(() => /Reading OMP credential catalog/.test(getOutput()), "the first catalog read");
    assert.equal(listCalls, 1);

    const closeBaseline = getOutput();
    stdin.write(KEY_ESCAPE);
    await waitForSettledFrame(getOutput, { baseline: closeBaseline, timeoutMs: 5_000 });
    stdin.write("/auth");
    await waitFor(() => listCalls === 2, "the retried catalog read");

    pendingCatalogs[1]({ ok: true, dbPath: "/tmp/agent.db", providers: CATALOG_ROWS });
    await waitFor(() => /Kimi Code/.test(getOutput()), "the reopened provider catalog");
    pendingCatalogs[0]({ ok: true, dbPath: "/tmp/stale.db", providers: [] });
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Down then Enter hands the highlighted provider to the OMP-owned sign-in", async () => {
  const { engine, submitted } = createEngine();
  const signInCalls = [];
  const { stdin, instance, getOutput } = renderPane(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        ompAuthCatalog: {
          list: async () => ({ ok: true, dbPath: "/tmp/agent.db", providers: CATALOG_ROWS }),
          signIn: async (providerId) => {
            signInCalls.push(providerId);
            return {
              ok: true,
              binPath: "/x/omp",
              argv: ["auth-broker", "login", providerId],
              command: `omp auth-broker login ${providerId}`,
            };
          },
        },
      }),
    ),
  );

  try {
    const catalogBaseline = getOutput();
    stdin.write("/auth");
    // Wait for the resolved frame to settle so Ink has committed the matching
    // useInput subscription before the synthetic Down key arrives.
    await waitForSettledFrame(getOutput, { baseline: catalogBaseline, timeoutMs: 5_000 });
    assert.match(getOutput(), /› ● Kimi Code/);
    const cursorBaseline = getOutput();
    stdin.write(KEY_DOWN);
    await waitForSettledFrame(getOutput, { baseline: cursorBaseline, timeoutMs: 5_000 });
    assert.match(getOutput(), /› ○ OpenRouter/);
    stdin.write(KEY_ENTER);
    await waitFor(() => signInCalls.length > 0, "the sign-in handoff");

    assert.deepEqual(signInCalls, ["openrouter"]);
    await waitFor(
      () => /Sign-in handoff · run: omp auth-broker login openrouter/.test(getOutput()),
      "the sign-in receipt",
    );
    assert.deepEqual(submitted, [], "the picker must not also send /auth to the engine");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("a failed catalog read shows the failure and never routes /auth to a fake provider", async () => {
  const { engine } = createEngine();
  const { stdin, instance, getOutput } = renderPane(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        ompAuthCatalog: {
          list: async () => ({
            ok: false,
            error: { code: "OMP_UNAVAILABLE", message: "omp executable not found on PATH" },
          }),
          signIn: async () => {
            throw new Error("signIn must not be reachable without a catalog");
          },
        },
      }),
    ),
  );

  try {
    stdin.write("/auth");
    await waitFor(() => /OMP unavailable/.test(getOutput()), "the OMP unavailable state");
    assert.match(getOutput(), /omp executable not found on PATH/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("/auth status stays on the existing auth surface without opening the OMP picker", async () => {
  const { engine, submitted } = createEngine();
  let listCalls = 0;
  const { stdin, instance, getOutput, getFrame } = renderPane(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        ompAuthCatalog: {
          list: async () => {
            listCalls += 1;
            return { ok: true, dbPath: "/tmp/agent.db", providers: CATALOG_ROWS };
          },
          signIn: async () => {
            throw new Error("a reserved /auth subcommand must not trigger sign-in");
          },
        },
      }),
    ),
  );

  try {
    stdin.write("/auth status");
    await waitFor(() => /\/auth status/.test(getFrame()), "the reserved auth command");
    assert.equal(listCalls, 0, "reserved auth commands must not load the OMP catalog");
    assert.doesNotMatch(getFrame(), /OMP providers|no provider matches/);

    stdin.write(KEY_ENTER);
    await waitFor(() => submitted.length > 0, "the engine submit");
    assert.deepEqual(submitted, ["/auth status"]);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Enter on an unavailable provider states why instead of calling OMP sign-in", async () => {
  const { engine, submitted } = createEngine();
  const signInCalls = [];
  const { stdin, instance, getOutput, getFrame } = renderPane(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        ompAuthCatalog: {
          list: async () => ({
            ok: true,
            dbPath: "/tmp/agent.db",
            providers: [
              CATALOG_ROWS[0],
              { id: "devin", name: "Devin", available: false, credentialKey: "devin", signedIn: false },
            ],
          }),
          signIn: async (providerId) => {
            signInCalls.push(providerId);
            return { ok: false, error: { code: "OMP_SIGN_IN_UNAVAILABLE", message: "unreachable" } };
          },
        },
      }),
    ),
  );

  try {
    const catalogBaseline = getOutput();
    stdin.write("/auth");
    await waitForSettledFrame(getOutput, { baseline: catalogBaseline, timeoutMs: 5_000 });
    const cursorBaseline = getOutput();
    stdin.write(KEY_DOWN);
    await waitForSettledFrame(getOutput, { baseline: cursorBaseline, timeoutMs: 5_000 });
    assert.match(getFrame(), /› × Devin/);

    stdin.write(KEY_ENTER);
    await waitFor(
      () => /Sign-in unavailable · Devin is marked unavailable by OMP/.test(getFrame()),
      "the unavailable receipt",
    );

    assert.deepEqual(signInCalls, [], "an unavailable row must never reach OMP sign-in");
    assert.deepEqual(submitted, [], "Enter is consumed by the picker, not forwarded to the engine");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("closing /auth retires the sign-in receipt so reopening cannot replay it", async () => {
  const { engine } = createEngine();
  const { stdin, instance, getOutput, getFrame } = renderPane(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        ompAuthCatalog: {
          list: async () => ({ ok: true, dbPath: "/tmp/agent.db", providers: CATALOG_ROWS }),
          signIn: async (providerId) => ({
            ok: true,
            binPath: "/x/omp",
            argv: ["auth-broker", "login", providerId],
            command: `omp auth-broker login ${providerId}`,
          }),
        },
      }),
    ),
  );

  try {
    const catalogBaseline = getOutput();
    stdin.write("/auth");
    await waitForSettledFrame(getOutput, { baseline: catalogBaseline, timeoutMs: 5_000 });
    stdin.write(KEY_ENTER);
    await waitFor(
      () => /Sign-in handoff · run: omp auth-broker login kimi-code/.test(getFrame()),
      "the sign-in receipt",
    );

    const closeBaseline = getOutput();
    stdin.write(KEY_ESCAPE);
    await waitForSettledFrame(getOutput, { baseline: closeBaseline, timeoutMs: 5_000 });
    const reopenBaseline = getOutput();
    stdin.write("/auth");
    await waitFor(() => /OMP providers/.test(getFrame()), "the reopened provider catalog");
    await waitForSettledFrame(getOutput, { baseline: reopenBaseline, timeoutMs: 5_000 });

    assert.match(getFrame(), /Kimi Code/);
    assert.doesNotMatch(
      getFrame(),
      /Sign-in handoff/,
      "a reopened picker must not paint the previous session's handoff",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("a new sign-in drops the previous receipt before its own handoff lands", async () => {
  const { engine } = createEngine();
  const signInCalls = [];
  const pendingSignIns = [];
  const { stdin, instance, getOutput, getFrame } = renderPane(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        ompAuthCatalog: {
          list: async () => ({ ok: true, dbPath: "/tmp/agent.db", providers: CATALOG_ROWS }),
          signIn: (providerId) => {
            signInCalls.push(providerId);
            const handoff = {
              ok: true,
              binPath: "/x/omp",
              argv: ["auth-broker", "login", providerId],
              command: `omp auth-broker login ${providerId}`,
            };
            if (signInCalls.length === 1) {
              return Promise.resolve(handoff);
            }
            return new Promise((resolve) => {
              pendingSignIns.push(() => resolve(handoff));
            });
          },
        },
      }),
    ),
  );

  try {
    const catalogBaseline = getOutput();
    stdin.write("/auth");
    await waitForSettledFrame(getOutput, { baseline: catalogBaseline, timeoutMs: 5_000 });
    stdin.write(KEY_ENTER);
    await waitFor(
      () => /Sign-in handoff · run: omp auth-broker login kimi-code/.test(getFrame()),
      "the first receipt",
    );

    // Submitting clears the composer, so the second sign-in starts the way a
    // user would start it: type `/auth` again while the picker is still open.
    const refilterBaseline = getOutput();
    stdin.write("/auth");
    await waitForSettledFrame(getOutput, { baseline: refilterBaseline, timeoutMs: 5_000 });
    const cursorBaseline = getOutput();
    stdin.write(KEY_DOWN);
    await waitForSettledFrame(getOutput, { baseline: cursorBaseline, timeoutMs: 5_000 });
    assert.match(getFrame(), /› ○ OpenRouter/);

    stdin.write(KEY_ENTER);
    await waitFor(() => signInCalls.length === 2, "the second sign-in");
    await waitFor(
      () => /OMP providers/.test(getFrame()) && !/Sign-in handoff/.test(getFrame()),
      "the retired first receipt",
    );

    pendingSignIns[0]();
    await waitFor(
      () => /Sign-in handoff · run: omp auth-broker login openrouter/.test(getFrame()),
      "the second receipt",
    );

    assert.deepEqual(signInCalls, ["kimi-code", "openrouter"]);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("a sign-in that resolves after close and reopen cannot paint a stale receipt", async () => {
  const { engine } = createEngine();
  let resolveSignIn;
  const { stdin, instance, getOutput, getFrame } = renderPane(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        ompAuthCatalog: {
          list: async () => ({ ok: true, dbPath: "/tmp/agent.db", providers: CATALOG_ROWS }),
          signIn: () => new Promise((resolve) => {
            resolveSignIn = resolve;
          }),
        },
      }),
    ),
  );

  try {
    const catalogBaseline = getOutput();
    stdin.write("/auth");
    await waitForSettledFrame(getOutput, { baseline: catalogBaseline, timeoutMs: 5_000 });
    stdin.write(KEY_ENTER);
    await waitFor(() => typeof resolveSignIn === "function", "the pending sign-in");

    const closeBaseline = getOutput();
    stdin.write(KEY_ESCAPE);
    await waitForSettledFrame(getOutput, { baseline: closeBaseline, timeoutMs: 5_000 });
    stdin.write("/auth");
    await waitFor(() => /OMP providers/.test(getFrame()), "the reopened picker");

    resolveSignIn({
      ok: true,
      binPath: "/x/omp",
      argv: ["auth-broker", "login", "kimi-code"],
      command: "omp auth-broker login kimi-code",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.doesNotMatch(
      getFrame(),
      /Sign-in handoff/,
      "the prior open's completion must not overwrite the reopened picker",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("only the latest overlapping sign-in may publish a receipt", async () => {
  const { engine } = createEngine();
  const pendingSignIns = [];
  const { stdin, instance, getOutput, getFrame } = renderPane(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        ompAuthCatalog: {
          list: async () => ({ ok: true, dbPath: "/tmp/agent.db", providers: CATALOG_ROWS }),
          signIn: (providerId) => new Promise((resolve) => {
            pendingSignIns.push({ providerId, resolve });
          }),
        },
      }),
    ),
  );

  try {
    const catalogBaseline = getOutput();
    stdin.write("/auth");
    await waitForSettledFrame(getOutput, { baseline: catalogBaseline, timeoutMs: 5_000 });
    stdin.write(KEY_ENTER);
    await waitFor(() => pendingSignIns.length === 1, "the first pending sign-in");

    stdin.write("/auth");
    await waitFor(() => /OMP providers/.test(getFrame()), "the refiltered picker");
    const cursorBaseline = getOutput();
    stdin.write(KEY_DOWN);
    await waitForSettledFrame(getOutput, { baseline: cursorBaseline, timeoutMs: 5_000 });
    stdin.write(KEY_ENTER);
    await waitFor(() => pendingSignIns.length === 2, "the second pending sign-in");

    pendingSignIns[1].resolve({
      ok: true,
      binPath: "/x/omp",
      argv: ["auth-broker", "login", "openrouter"],
      command: "omp auth-broker login openrouter",
    });
    await waitFor(
      () => /Sign-in handoff · run: omp auth-broker login openrouter/.test(getFrame()),
      "the latest sign-in receipt",
    );

    pendingSignIns[0].resolve({
      ok: true,
      binPath: "/x/omp",
      argv: ["auth-broker", "login", "kimi-code"],
      command: "omp auth-broker login kimi-code",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.match(getFrame(), /Sign-in handoff · run: omp auth-broker login openrouter/);
    assert.doesNotMatch(getFrame(), /Sign-in handoff · run: omp auth-broker login kimi-code/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});
