import test from "node:test";
import assert from "node:assert/strict";

import { formatAttachmentTraceLine } from "@unclecode/orchestrator";

/**
 * Q6 — attachment lifecycle trace events. The renderer is intentionally
 * scoped to clipboard source for v1; future producers (drag-drop, file
 * picker) will add their own source values without changing this shape.
 */

test("attached event renders source, mime, and size", () => {
  const line = formatAttachmentTraceLine({
    type: "attachment.attached",
    source: "clipboard",
    mimeType: "image/png",
    byteEstimate: 4096,
  });
  assert.match(line, /attached/);
  assert.match(line, /clipboard/);
  assert.match(line, /image\/png/);
  assert.match(line, /4kB/);
});

test("dropped event includes the rejection reason", () => {
  const line = formatAttachmentTraceLine({
    type: "attachment.dropped",
    source: "clipboard",
    reason: "cap-exceeded",
    byteEstimate: 6 * 1024 * 1024,
  });
  assert.match(line, /dropped/);
  assert.match(line, /cap-exceeded/);
  assert.match(line, /6144kB/);
});

test("renderer omits absent fields cleanly without throwing", () => {
  const line = formatAttachmentTraceLine({
    type: "attachment.dropped",
    source: "clipboard",
  });
  assert.match(line, /dropped/);
  assert.match(line, /clipboard/);
  // No size note, no mime, no reason — degraded but legible.
  assert.doesNotMatch(line, /undefined/);
  assert.doesNotMatch(line, /NaN/);
});
