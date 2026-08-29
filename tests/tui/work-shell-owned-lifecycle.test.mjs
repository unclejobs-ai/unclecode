import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render } from "ink";
import React from "react";

import {
  getSessionCenterEscapeHint,
  useWorkShellEngineState,
} from "../../packages/tui/src/index.tsx";

function LifecycleHarness({ engine, ownership }) {
  useWorkShellEngineState(engine, { ownership });
  return null;
}

function createEngine() {
  let disposeCount = 0;
  return {
    engine: {
      getState: () => ({ ready: true }),
      subscribe: () => () => {},
      initialize: async () => {},
      dispose: () => { disposeCount += 1; },
    },
    getDisposeCount: () => disposeCount,
  };
}

function renderHarness(element) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  const stdout = new PassThrough();
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.isTTY = true;
  stdout.resume();
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  stderr.columns = 80;
  stderr.rows = 24;
  stderr.isTTY = true;
  return render(element, { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
}

test("pane detach unsubscribes without disposing a shared remote engine", async () => {
  const shared = createEngine();
  const instance = renderHarness(React.createElement(LifecycleHarness, {
    engine: shared.engine,
    ownership: "shared",
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  instance.unmount();
  instance.cleanup();
  assert.equal(shared.getDisposeCount(), 0);
});

test("pane unmount still disposes an engine it owns", async () => {
  const owned = createEngine();
  const instance = renderHarness(React.createElement(LifecycleHarness, {
    engine: owned.engine,
    ownership: "owned",
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  instance.unmount();
  instance.cleanup();
  assert.equal(owned.getDisposeCount(), 1);
});

test("embedded Work navigation never advertises Ctrl+O as a session or context menu", () => {
  const hint = getSessionCenterEscapeHint({
    view: "work",
    detailOpen: false,
    hasSelectedApproval: false,
    hasEmbeddedWorkPane: true,
  });
  assert.equal(hint, "? sessions");
});
