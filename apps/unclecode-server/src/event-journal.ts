export type JournalEvent = {
  readonly id: number;
  readonly sessionId: string;
  readonly event: string;
  readonly data: unknown;
  readonly timestamp: number;
};

export type JournalReplay =
  | { readonly status: "ok"; readonly events: readonly JournalEvent[] }
  | { readonly status: "expired"; readonly oldestAvailableId: number; readonly newestId: number; readonly events: readonly [] };

/**
 * A bounded, process-local replay buffer for live SSE delivery. It is not a
 * durable mutation receipt, admission record, or usage ledger.
 */
export class BoundedEventJournal {
  readonly #capacity: number;
  readonly #events: JournalEvent[] = [];
  readonly #subscribers = new Map<string, Set<(event: JournalEvent) => void>>();
  readonly #replayWatermarks = new Map<string, number>();
  #nextId = 1;

  constructor(options: { readonly capacity?: number } = {}) {
    this.#capacity = Math.max(1, Math.min(options.capacity ?? 1_024, 10_000));
  }

  publish(sessionId: string, event: string, data: unknown): JournalEvent {
    const item = Object.freeze({ id: this.#nextId++, sessionId, event, data, timestamp: Date.now() });
    this.#events.push(item);
    if (this.#events.length > this.#capacity) {
      for (const evicted of this.#events.splice(0, this.#events.length - this.#capacity)) {
        this.#replayWatermarks.delete(evicted.sessionId);
        this.#replayWatermarks.set(evicted.sessionId, evicted.id);
      }
      while (this.#replayWatermarks.size > this.#capacity) {
        const oldestSessionId = this.#replayWatermarks.keys().next().value;
        if (oldestSessionId === undefined) break;
        this.#replayWatermarks.delete(oldestSessionId);
      }
    }
    for (const listener of this.#subscribers.get(sessionId) ?? []) listener(item);
    return item;
  }

  replay(sessionId: string, afterId = 0): JournalReplay {
    const oldest = this.#events[0]?.id ?? this.#nextId;
    const newest = this.#events.at(-1)?.id ?? 0;
    const replayWatermark = this.#replayWatermarks.get(sessionId);
    const cursorExpired = afterId > newest
      || (afterId > 0 && replayWatermark !== undefined && afterId < replayWatermark)
      || (afterId > 0 && replayWatermark === undefined && afterId < oldest - 1);
    if (cursorExpired) {
      return { status: "expired", oldestAvailableId: oldest, newestId: newest, events: [] };
    }
    return { status: "ok", events: this.#events.filter(item => item.sessionId === sessionId && item.id > afterId) };
  }

  get stats(): {
    readonly retainedEvents: number;
    readonly activeSubscriptions: number;
    readonly subscriberSessions: number;
    readonly replayWatermarks: number;
  } {
    let activeSubscriptions = 0;
    for (const subscribers of this.#subscribers.values()) activeSubscriptions += subscribers.size;
    return Object.freeze({
      retainedEvents: this.#events.length,
      activeSubscriptions,
      subscriberSessions: this.#subscribers.size,
      replayWatermarks: this.#replayWatermarks.size,
    });
  }

  subscribeAfter(sessionId: string, afterId: number, listener: (event: JournalEvent) => void): {
    readonly replay: JournalReplay;
    readonly unsubscribe: () => void;
  } {
    let set = this.#subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.#subscribers.set(sessionId, set);
    }
    set.add(listener);
    const replay = this.replay(sessionId, afterId);
    if (replay.status === "ok") for (const event of replay.events) listener(event);
    return {
      replay,
      unsubscribe: () => {
        set?.delete(listener);
        if (set?.size === 0) this.#subscribers.delete(sessionId);
      },
    };
  }
}
