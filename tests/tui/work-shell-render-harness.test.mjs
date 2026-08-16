import assert from "node:assert/strict";
import test from "node:test";

import { waitForSettledFrame } from "./work-shell-render-harness.mjs";

test("waitForSettledFrame waits for output newer than an action baseline", async () => {
  let output = "already rendered";
  const baseline = output;
  const update = setTimeout(() => {
    output = "updated frame";
  }, 60);

  try {
    const settled = await waitForSettledFrame(
      () => output,
      { baseline, timeoutMs: 500, quietMs: 20, pollMs: 5 },
    );
    assert.equal(settled, "updated frame");
  } finally {
    clearTimeout(update);
  }
});
