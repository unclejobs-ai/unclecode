import type { RuntimeLedger } from "./runtime-ledger.js";

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

export type EventJournalStats = {
  readonly retainedEvents: number;
  readonly activeSubscriptions: number;
  readonly subscriberSessions: number;
  readonly replayWatermarks: number;
};

export interface EventJournal {
  publish(sessionId: string, event: string, data: unknown): JournalEvent;
  replay(sessionId: string, afterId?: number): JournalReplay;
  subscribeAfter(
    sessionId: string,
    afterId: number,
    listener: (event: JournalEvent) => void,
  ): { readonly replay: JournalReplay; readonly unsubscribe: () => void };
  readonly stats: EventJournalStats;
}

/**
 * A bounded, process-local replay buffer for live SSE delivery. It is not a
 * durable mutation receipt, admission record, or usage ledger.
 */
export class BoundedEventJournal {
  readonly #capacity: number;
  readonly #events: Array<JournalEvent | undefined>;
  readonly #eventsBySession = new Map<string, Map<number, JournalEvent>>();
  readonly #subscribers = new Map<string, Set<(event: JournalEvent) => void>>();
  readonly #replayWatermarks = new Map<string, number>();
  #activeSubscriptions = 0;
  #head = 0;
  #size = 0;
  #nextId = 1;

  constructor(options: { readonly capacity?: number } = {}) {
    this.#capacity = Math.max(1, Math.min(options.capacity ?? 1_024, 10_000));
    this.#events = new Array(this.#capacity);
  }

  publish(sessionId: string, event: string, data: unknown): JournalEvent {
    return this.publishRecorded(sessionId, this.#nextId++, event, data);
  }

  publishRecorded(sessionId: string, id: number, event: string, data: unknown): JournalEvent {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError("Journal event id must be a positive safe integer.");
    this.#nextId = Math.max(this.#nextId, id + 1);
    const item = Object.freeze({ id, sessionId, event, data, timestamp: Date.now() });
    if (this.#size === this.#capacity) {
      const evicted = this.#events[this.#head];
      if (!evicted) throw new Error("Event journal ring invariant violated.");
      const sessionEvents = this.#eventsBySession.get(evicted.sessionId);
      sessionEvents?.delete(evicted.id);
      if (sessionEvents?.size === 0) this.#eventsBySession.delete(evicted.sessionId);
      this.#replayWatermarks.delete(evicted.sessionId);
      this.#replayWatermarks.set(evicted.sessionId, evicted.id);
      while (this.#replayWatermarks.size > this.#capacity) {
        const oldestSessionId = this.#replayWatermarks.keys().next().value;
        if (oldestSessionId === undefined) break;
        this.#replayWatermarks.delete(oldestSessionId);
      }
      this.#events[this.#head] = item;
      this.#head = (this.#head + 1) % this.#capacity;
    } else {
      this.#events[(this.#head + this.#size) % this.#capacity] = item;
      this.#size += 1;
    }
    let sessionEvents = this.#eventsBySession.get(sessionId);
    if (!sessionEvents) {
      sessionEvents = new Map();
      this.#eventsBySession.set(sessionId, sessionEvents);
    }
    sessionEvents.set(id, item);
    for (const listener of this.#subscribers.get(sessionId) ?? []) listener(item);
    return item;
  }

  replay(sessionId: string, afterId = 0): JournalReplay {
    const oldest = this.#events[this.#head]?.id ?? this.#nextId;
    const newest = this.#size === 0
      ? 0
      : (this.#events[(this.#head + this.#size - 1) % this.#capacity]?.id ?? 0);
    const replayWatermark = this.#replayWatermarks.get(sessionId);
    const cursorExpired = afterId > newest
      || (afterId > 0 && replayWatermark !== undefined && afterId < replayWatermark)
      || (afterId > 0 && replayWatermark === undefined && afterId < oldest - 1);
    if (cursorExpired) {
      return { status: "expired", oldestAvailableId: oldest, newestId: newest, events: [] };
    }
    const events: JournalEvent[] = [];
    for (const [id, item] of this.#eventsBySession.get(sessionId) ?? []) {
      if (id > afterId) events.push(item);
    }
    return { status: "ok", events };
  }

  get stats(): EventJournalStats {
    return Object.freeze({
      retainedEvents: this.#size,
      activeSubscriptions: this.#activeSubscriptions,
      subscriberSessions: this.#subscribers.size,
      replayWatermarks: this.#replayWatermarks.size,
    });
  }

  subscribeAfter(sessionId: string, afterId: number, listener: (event: JournalEvent) => void): {
    readonly replay: JournalReplay;
    readonly unsubscribe: () => void;
  } {
    const unsubscribe = this.subscribe(sessionId, listener);
    const replay = this.replay(sessionId, afterId);
    if (replay.status === "ok") for (const event of replay.events) listener(event);
    return { replay, unsubscribe };
  }

  subscribe(sessionId: string, listener: (event: JournalEvent) => void): () => void {
    let set = this.#subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.#subscribers.set(sessionId, set);
    }
    if (!set.has(listener)) {
      set.add(listener);
      this.#activeSubscriptions += 1;
    }
    return () => {
      if (set?.delete(listener)) this.#activeSubscriptions -= 1;
      if (set?.size === 0) this.#subscribers.delete(sessionId);
    };
  }
}

/** Durable replay and sequencing backed by the owner ledger, with bounded live fan-out. */
export class LedgerBackedEventJournal implements EventJournal {
  readonly #ledger: RuntimeLedger;
  readonly #hot: BoundedEventJournal;

  constructor(input: { readonly ledger: RuntimeLedger; readonly hot?: BoundedEventJournal }) {
    this.#ledger = input.ledger;
    this.#hot = input.hot ?? new BoundedEventJournal();
  }

  publish(sessionId: string, event: string, data: unknown): JournalEvent {
    const persisted = this.#ledger.appendRuntimeEvent({ sessionId, type: event, payload: data });
    return this.#hot.publishRecorded(sessionId, persisted.seq, persisted.type, persisted.payload);
  }

  replay(sessionId: string, afterId = 0): JournalReplay {
    const replay = this.#ledger.replayRuntimeEvents(sessionId, afterId);
    if (replay.kind === "expired") {
      return {
        status: "expired",
        oldestAvailableId: replay.lowWatermark,
        newestId: replay.nextEventSeq - 1,
        events: [],
      };
    }
    return {
      status: "ok",
      events: replay.events.map(item => Object.freeze({
        id: item.seq,
        sessionId,
        event: item.type,
        data: item.payload,
        timestamp: 0,
      })),
    };
  }

  subscribeAfter(sessionId: string, afterId: number, listener: (event: JournalEvent) => void): {
    readonly replay: JournalReplay;
    readonly unsubscribe: () => void;
  } {
    const pending: JournalEvent[] = [];
    let replaying = true;
    const unsubscribe = this.#hot.subscribe(sessionId, (event) => {
      if (event.id <= afterId) return;
      if (replaying) pending.push(event);
      else listener(event);
    });
    const replay = this.replay(sessionId, afterId);
    let deliveredThrough = afterId;
    if (replay.status === "ok") {
      for (const event of replay.events) {
        listener(event);
        deliveredThrough = Math.max(deliveredThrough, event.id);
      }
    }
    replaying = false;
    for (const event of pending) {
      if (event.id <= deliveredThrough) continue;
      listener(event);
      deliveredThrough = event.id;
    }
    return { replay, unsubscribe };
  }

  get stats(): EventJournalStats {
    return this.#hot.stats;
  }
}
