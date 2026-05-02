import test from "node:test";
import assert from "node:assert/strict";

import { applyProviderAttachmentCaps } from "@unclecode/providers";

const A = (dataUrl) => ({
  type: "image",
  mimeType: "image/png",
  dataUrl,
  path: "(clipboard)",
  displayName: "a.png",
});

function sizedDataUrl(byteSize) {
  const raw = Buffer.alloc(byteSize, 0);
  const b64 = raw.toString("base64");
  return `data:image/png;base64,${b64}`;
}

test("returns identity when list is under both caps", () => {
  const attachments = [A("data:image/png;base64,aGVsbG8=")]; // ~5 bytes
  const result = applyProviderAttachmentCaps(attachments);
  assert.strictEqual(result, attachments, "must short-circuit with same reference");
});

test("returns empty array when given empty array", () => {
  const result = applyProviderAttachmentCaps([]);
  assert.deepEqual(result, []);
});

test("truncates when count exceeds 5", () => {
  const attachments = Array.from({ length: 7 }, (_, i) =>
    A(`data:image/png;base64,${btoa(String(i))}`),
  );
  const result = applyProviderAttachmentCaps(attachments);
  assert.equal(result.length, 5);
});

test("preserves first 5 when count exceeds 5", () => {
  const attachments = Array.from({ length: 6 }, (_, i) =>
    A(`data:image/png;base64,${btoa(String(i + 1))}`),
  );
  const result = applyProviderAttachmentCaps(attachments);
  assert.equal(result.length, 5);
  assert.deepEqual(
    result.map((a) => a.dataUrl),
    attachments.slice(0, 5).map((a) => a.dataUrl),
  );
});

test("drops oversized attachments (>5 MiB)", () => {
  const big = sizedDataUrl(6 * 1024 * 1024); // 6 MiB
  const small = sizedDataUrl(1024); // 1 KiB
  const attachments = [A(small), A(big), A(small)];
  const result = applyProviderAttachmentCaps(attachments);
  assert.equal(result.length, 2);
});

test("drops oversized attachments even when count is under cap", () => {
  const big = sizedDataUrl(6 * 1024 * 1024);
  const result = applyProviderAttachmentCaps([A(big)]);
  assert.deepEqual(result, []);
});

test("returns identity when all under caps and count exactly 5", () => {
  const attachments = Array.from({ length: 5 }, (_, i) =>
    A(`data:image/png;base64,${btoa(String(i))}`),
  );
  const result = applyProviderAttachmentCaps(attachments);
  assert.strictEqual(result, attachments);
});

test("applies both count and size caps together", () => {
  const small = sizedDataUrl(1024);
  const big = sizedDataUrl(6 * 1024 * 1024);
  const attachments = [
    A(small), A(big), A(small), A(small), A(big),
    A(small), A(small),
  ];
  const result = applyProviderAttachmentCaps(attachments);
  assert.equal(result.length, 5);
});

test("accepts exactly 5 MiB attachments (boundary)", () => {
  const exact = sizedDataUrl(5 * 1024 * 1024);
  const result = applyProviderAttachmentCaps([A(exact)]);
  assert.equal(result.length, 1);
});

test("drops attachment 1 byte over 5 MiB", () => {
  const over = sizedDataUrl(5 * 1024 * 1024 + 1);
  const result = applyProviderAttachmentCaps([A(over)]);
  assert.equal(result.length, 0);
});
