import assert from "node:assert/strict";
import test from "node:test";

import { createInstrumentedLruCache } from "@unclecode/contracts";

test("instrumented LRU records hits, misses, and least-recently-used eviction", () => {
  const cache = createInstrumentedLruCache({
    name: "contract-test",
    maxEntries: 2,
    maxRetainedBytes: 100,
    estimateEntryBytes: (key, value) => key.length + value.length,
  });

  cache.set("a", "alpha");
  cache.set("b", "beta");
  assert.deepEqual(cache.lookup("a"), { hit: true, value: "alpha" });
  assert.deepEqual(cache.lookup("missing"), { hit: false });
  cache.set("c", "gamma");

  assert.deepEqual(cache.lookup("b"), { hit: false });
  assert.deepEqual(cache.lookup("a"), { hit: true, value: "alpha" });
  assert.deepEqual(cache.snapshot(), {
    name: "contract-test",
    hits: 2,
    misses: 2,
    evictions: 1,
    byteEvictions: 0,
    invalidations: 0,
    currentSize: 2,
    maxEntries: 2,
    maxRetainedBytes: 100,
    retainedBytesEstimate: 12,
  });
});

test("instrumented LRU invalidates only the exact requested key", () => {
  const cache = createInstrumentedLruCache({
    name: "contract-test",
    maxEntries: 3,
    maxRetainedBytes: 3,
    estimateEntryBytes: () => 1,
  });
  cache.set("root-a::head-1", "a");
  cache.set("root-a::head-2", "b");
  cache.set("root-b::head-1", "c");

  assert.equal(cache.invalidate("root-a::head-1"), true);
  assert.equal(cache.invalidate("root-a::head-1"), false);
  assert.deepEqual(
    [...cache.entries()],
    [
      ["root-a::head-2", "b"],
      ["root-b::head-1", "c"],
    ],
  );
  assert.equal(cache.snapshot().invalidations, 1);
});

test("instrumented LRU retains only bounded estimated bytes during repeated churn", () => {
  const cache = createInstrumentedLruCache({
    name: "churn-test",
    maxEntries: 4,
    maxRetainedBytes: 72,
    estimateEntryBytes: (key, value) => key.length + value.length,
  });

  for (let index = 0; index < 10_000; index += 1) {
    cache.set(`key-${index}`, `value-${index}`);
  }

  const snapshot = cache.snapshot();
  assert.equal(snapshot.currentSize, 4);
  assert.equal(snapshot.evictions, 9_996);
  assert.equal(snapshot.retainedBytesEstimate, 72);
  assert.ok(JSON.stringify(snapshot).includes('"retainedBytesEstimate":72'));
});

test("instrumented LRU cannot become unbounded from a non-finite entry cap", () => {
  const cache = createInstrumentedLruCache({
    name: "invalid-cap",
    maxEntries: Number.NaN,
    maxRetainedBytes: Number.NaN,
  });

  cache.set("a", "alpha");
  cache.set("b", "beta");

  assert.equal(cache.snapshot().maxEntries, 1);
  assert.equal(cache.snapshot().maxRetainedBytes, 1);
  assert.equal(cache.snapshot().currentSize, 0);
  assert.equal(cache.snapshot().evictions, 2);
  assert.equal(cache.snapshot().byteEvictions, 2);
});

test("instrumented LRU evicts least-recently-used entries to enforce the retained-byte cap", () => {
  const cache = createInstrumentedLruCache({
    name: "byte-cap",
    maxEntries: 10,
    maxRetainedBytes: 12,
    estimateEntryBytes: () => 6,
  });

  cache.set("a", "alpha");
  cache.set("b", "beta");
  assert.equal(cache.lookup("a").hit, true);
  cache.set("c", "gamma");

  assert.equal(cache.lookup("b").hit, false);
  assert.deepEqual(
    [...cache.entries()].map(([key]) => key),
    ["a", "c"],
  );
  const snapshot = cache.snapshot();
  assert.equal(snapshot.currentSize, 2);
  assert.equal(snapshot.retainedBytesEstimate, 12);
  assert.equal(snapshot.maxRetainedBytes, 12);
  assert.equal(snapshot.evictions, 1);
  assert.equal(snapshot.byteEvictions, 1);
});

test("instrumented LRU rejects an oversized single entry without evicting unrelated entries", () => {
  const cache = createInstrumentedLruCache({
    name: "oversized-entry",
    maxEntries: 10,
    maxRetainedBytes: 10,
    estimateEntryBytes: (_key, value) => value.length,
  });

  cache.set("small", "12345");
  cache.set("huge", "x".repeat(100_000));

  assert.equal(cache.lookup("small").hit, true);
  assert.equal(cache.lookup("huge").hit, false);
  const snapshot = cache.snapshot();
  assert.equal(snapshot.currentSize, 1);
  assert.equal(snapshot.retainedBytesEstimate, 5);
  assert.equal(snapshot.evictions, 1);
  assert.equal(snapshot.byteEvictions, 1);
});

test("instrumented LRU keeps retained bytes bounded during byte-driven churn", () => {
  const cache = createInstrumentedLruCache({
    name: "byte-churn",
    maxEntries: 100,
    maxRetainedBytes: 30,
    estimateEntryBytes: () => 10,
  });

  for (let index = 0; index < 10_000; index += 1) {
    cache.set(`key-${index}`, `value-${index}`);
  }

  const snapshot = cache.snapshot();
  assert.equal(snapshot.currentSize, 3);
  assert.equal(snapshot.retainedBytesEstimate, 30);
  assert.equal(snapshot.evictions, 9_997);
  assert.equal(snapshot.byteEvictions, 9_997);
});

test("instrumented LRU rejects values whose retained size cannot be serialized safely", () => {
  const cache = createInstrumentedLruCache({
    name: "cyclic-entry",
    maxEntries: 4,
    maxRetainedBytes: 64,
  });
  const cyclic = { payload: "x".repeat(5 * 1024 * 1024) };
  cyclic.self = cyclic;

  cache.set("cyclic", cyclic);

  assert.equal(cache.lookup("cyclic").hit, false);
  assert.equal(cache.snapshot().currentSize, 0);
  assert.equal(cache.snapshot().retainedBytesEstimate, 0);
  assert.equal(cache.snapshot().byteEvictions, 1);
});
