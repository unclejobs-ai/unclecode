import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { Text } from "ink";
import { useWorkShellDashboardHomeSync } from "@unclecode/tui";

import { renderDebugFrame } from "./work-shell-render-harness.mjs";

// The dashboard re-renders the work pane on every `home.updated`, and the pane
// hands the hook freshly allocated line arrays with unchanged contents. Keying
// the sync effects on array identity turned that into a self-sustaining render
// loop (~10 renders/s at idle, three synchronous Rust spawns each).
test("dashboard home sync settles when line arrays are re-allocated with the same contents", async () => {
  let syncCalls = 0;

  function Pane({ bridgeLines, memoryLines, onSyncHomeState }) {
    useWorkShellDashboardHomeSync({
      isBusy: false,
      authLabel: "api-key-env",
      bridgeLines,
      memoryLines,
      onSyncHomeState,
    });
    return React.createElement(Text, null, "pane");
  }

  function Dashboard() {
    const [home, dispatch] = React.useReducer(
      (state, patch) => ({ ...state, ...patch }),
      { bridgeLines: ["Bridge ready"], memoryLines: ["Memory ready"] },
    );
    const onSyncHomeState = React.useCallback((patch) => {
      syncCalls += 1;
      dispatch(patch);
    }, []);
    return React.createElement(Pane, {
      bridgeLines: [...home.bridgeLines],
      memoryLines: [...home.memoryLines],
      onSyncHomeState,
    });
  }

  const handle = renderDebugFrame(React.createElement(Dashboard));
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    handle.instance.unmount();
  }

  assert.ok(syncCalls <= 1, `expected the home sync to settle, saw ${syncCalls} sync calls in 500ms`);
});
