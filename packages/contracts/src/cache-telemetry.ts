export type CacheTelemetrySnapshot = {
  readonly name: string;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly invalidations: number;
  readonly currentSize: number;
  readonly maxEntries: number;
  /** Estimated serialized key and value bytes retained by live entries. */
  readonly retainedBytesEstimate: number;
};

export type CacheLookup<T> =
  | { readonly hit: true; readonly value: T }
  | { readonly hit: false };

export type InstrumentedLruCache<K, V> = {
  lookup(key: K): CacheLookup<V>;
  set(key: K, value: V): void;
  invalidate(key: K): boolean;
  invalidateAll(): number;
  entries(): IterableIterator<[K, V]>;
  snapshot(): CacheTelemetrySnapshot;
};

export function createInstrumentedLruCache<K, V>(options: {
  readonly name: string;
  readonly maxEntries: number;
  readonly estimateEntryBytes?: (key: K, value: V) => number;
}): InstrumentedLruCache<K, V> {
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(1, Math.floor(options.maxEntries))
    : 1;
  const entries = new Map<K, { readonly value: V; readonly retainedBytes: number }>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let invalidations = 0;
  let retainedBytesEstimate = 0;

  function estimateEntryBytes(key: K, value: V): number {
    const estimated = options.estimateEntryBytes
      ? options.estimateEntryBytes(key, value)
      : estimateSerializedBytes([key, value]);
    return Number.isFinite(estimated) ? Math.max(0, Math.floor(estimated)) : 0;
  }

  function deleteEntry(key: K): boolean {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    retainedBytesEstimate -= entry.retainedBytes;
    return true;
  }

  return {
    lookup(key) {
      const entry = entries.get(key);
      if (!entry) {
        misses += 1;
        return { hit: false };
      }
      hits += 1;
      entries.delete(key);
      entries.set(key, entry);
      return { hit: true, value: entry.value };
    },

    set(key, value) {
      deleteEntry(key);
      const retainedBytes = estimateEntryBytes(key, value);
      entries.set(key, { value, retainedBytes });
      retainedBytesEstimate += retainedBytes;

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        if (deleteEntry(oldest.value)) evictions += 1;
      }
    },

    invalidate(key) {
      const deleted = deleteEntry(key);
      if (deleted) invalidations += 1;
      return deleted;
    },

    invalidateAll() {
      let count = 0;
      for (const key of [...entries.keys()]) {
        if (deleteEntry(key)) count += 1;
      }
      invalidations += count;
      return count;
    },

    *entries() {
      for (const [key, entry] of entries) {
        yield [key, entry.value];
      }
    },

    snapshot() {
      return {
        name: options.name,
        hits,
        misses,
        evictions,
        invalidations,
        currentSize: entries.size,
        maxEntries,
        retainedBytesEstimate,
      };
    },
  };
}

function estimateSerializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return new TextEncoder().encode(serialized ?? String(value)).byteLength;
  } catch {
    return new TextEncoder().encode(String(value)).byteLength;
  }
}
