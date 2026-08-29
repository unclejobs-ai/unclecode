import assert from "node:assert/strict";
import test from "node:test";

import { createInstrumentedLruCache } from "@unclecode/contracts";

test("instrumented LRU records hits, misses, and least-recently-used eviction", () => {
  const cache = createInstrumentedLruCache({
    name: "contract-test",
    maxEntries: 2,
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
    invalidations: 0,
    currentSize: 2,
    maxEntries: 2,
    retainedBytesEstimate: 12,
  });
});

test("instrumented LRU invalidates only the exact requested key", () => {
  const cache = createInstrumentedLruCache({
    name: "contract-test",
    maxEntries: 3,
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
  });

  cache.set("a", "alpha");
  cache.set("b", "beta");

  assert.equal(cache.snapshot().maxEntries, 1);
  assert.equal(cache.snapshot().currentSize, 1);
  assert.equal(cache.snapshot().evictions, 1);
});
