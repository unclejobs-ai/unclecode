import assert from "node:assert/strict";
import test from "node:test";

import { formatWorkShellQueueIndicator } from "../../packages/tui/src/work-shell-view.tsx";

test("formatWorkShellQueueIndicator returns null when count is 0", () => {
  assert.equal(formatWorkShellQueueIndicator(0), null);
});

test("formatWorkShellQueueIndicator returns null for negative counts", () => {
  assert.equal(formatWorkShellQueueIndicator(-1), null);
});

test("formatWorkShellQueueIndicator renders count and /queue hint for 1 queued item", () => {
  const result = formatWorkShellQueueIndicator(1);
  assert.ok(result !== null);
  assert.match(result, /1/);
  assert.match(result, /queued/);
  assert.match(result, /\/queue/);
});

test("formatWorkShellQueueIndicator renders the correct count for multiple items", () => {
  const result = formatWorkShellQueueIndicator(3);
  assert.ok(result !== null);
  assert.match(result, /3/);
  assert.match(result, /queued/);
  assert.match(result, /\/queue/);
});

test("formatWorkShellQueueIndicator indicator string matches expected format", () => {
  assert.equal(formatWorkShellQueueIndicator(2), "⋯ 2 queued · /queue");
});

test("formatWorkShellQueueIndicator marks interrupted queues as paused", () => {
  assert.equal(formatWorkShellQueueIndicator(2, true), "⋯ 2 queued · paused · /queue clear");
});
