import assert from "node:assert/strict";
import test from "node:test";

import { formatWorkShellLiveActivityLine } from "../../packages/tui/src/work-shell-view.tsx";

test("formatWorkShellLiveActivityLine shows nothing while idle", () => {
  assert.equal(formatWorkShellLiveActivityLine({ isBusy: false }), null);
  assert.equal(
    formatWorkShellLiveActivityLine({ isBusy: false, busyStatus: "Reading files" }),
    null,
  );
});

test("formatWorkShellLiveActivityLine surfaces a live progress line while busy", () => {
  const fallback = formatWorkShellLiveActivityLine({ isBusy: true, spinnerFrame: 0 });
  assert.ok(typeof fallback === "string" && fallback.length > 0);
  assert.match(fallback, /Working/);

  const withStatus = formatWorkShellLiveActivityLine({
    isBusy: true,
    busyStatus: "Reading project files",
    spinnerFrame: 0,
  });
  assert.ok(typeof withStatus === "string" && withStatus.length > 0);
  // a concrete status replaces the generic fallback
  assert.doesNotMatch(withStatus, /^.\s+Working…$/);
});
