import { constants, chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

const RUNTIME_LEDGER_APPLICATION_ID = 0x55434c47;
const RUNTIME_LEDGER_SCHEMA_VERSION = 3;
const DEFAULT_FINGERPRINT_MAX_BYTES = 4 * 1024;
const DEFAULT_RESULT_MAX_BYTES = 64 * 1024;
const DEFAULT_EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_EVENTS_PER_SESSION = 1_000;

export type MutationReceiptStatus = "admitted" | "completed" | "failed" | "in_doubt";

export type RuntimeSessionState = {
  readonly sessionId: string;
  readonly revision: number;
  readonly nextEventSeq: number;
  readonly eventLowWatermark: number;
};

export type AdmitMutationInput = {
  readonly sessionId: string;
  readonly domain: string;
  readonly idempotencyKey: string;
  readonly fingerprint: unknown;
};

export type AdmitMutationResult =
  | { readonly kind: "admitted"; readonly acceptedRevision: number }
  | {
      readonly kind: "replay";
      readonly status: MutationReceiptStatus;
      readonly acceptedRevision: number;
      readonly result?: unknown;
    }
  | {
      readonly kind: "mismatch";
      readonly status: MutationReceiptStatus;
      readonly acceptedRevision: number;
    };

export type CompleteMutationInput = {
  readonly sessionId: string;
  readonly domain: string;
  readonly idempotencyKey: string;
  readonly status: "completed" | "failed";
  readonly result?: unknown;
};

export type MutationReceiptRef = {
  readonly sessionId: string;
  readonly domain: string;
  readonly idempotencyKey: string;
};

export type ReopenMutationResult =
  | { readonly kind: "reopened"; readonly acceptedRevision: number }
  | {
      readonly kind: "replay";
      readonly status: MutationReceiptStatus;
      readonly acceptedRevision: number;
      readonly result?: unknown;
    };

export type OpenRuntimeLedgerOptions = {
  readonly dbPath: string;
  readonly receiptFingerprintMaxBytes?: number;
  readonly receiptResultMaxBytes?: number;
  readonly eventPayloadMaxBytes?: number;
  readonly maxEventsPerSession?: number;
};

export type RuntimeEvent = {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
};

export type AppendRuntimeEventInput = {
  readonly sessionId: string;
  readonly type: string;
  readonly payload: unknown;
};

export type ReplayRuntimeEventsResult = {
  readonly kind: "events" | "expired";
  readonly lowWatermark: number;
  readonly nextEventSeq: number;
  readonly events: readonly RuntimeEvent[];
};

export type UsageCounterVector = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheSavingsUsd: number;
  readonly costUsd: number;
};

export type RecordUsageInput = {
  readonly sessionId: string;
  readonly eventId: string;
  readonly mainId?: string;
  readonly agentId?: string;
  readonly route: {
    readonly provider: string;
    readonly model: string;
  };
  readonly counters: UsageCounterVector;
};

export type RecordUsageResult =
  | { readonly kind: "recorded" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "scope_mismatch" };

export type UsageTotalsSnapshot = {
  readonly session: UsageCounterVector;
  readonly byMain: readonly { readonly mainId: string; readonly totals: UsageCounterVector }[];
  readonly byAgent: readonly { readonly agentId: string; readonly totals: UsageCounterVector }[];
  readonly byRoute: readonly {
    readonly provider: string;
    readonly model: string;
    readonly totals: UsageCounterVector;
  }[];
};

type SqlRow = Record<string, SQLOutputValue>;

export interface RuntimeLedger {
  admitMutation(input: AdmitMutationInput): AdmitMutationResult;
  completeMutation(input: CompleteMutationInput): void;
  recoverInDoubt(): number;
  reopenMutation(input: MutationReceiptRef): ReopenMutationResult;
  recordUsage(input: RecordUsageInput): RecordUsageResult;
  snapshotUsageTotals(sessionId: string): UsageTotalsSnapshot;
  appendRuntimeEvent(input: AppendRuntimeEventInput): RuntimeEvent;
  replayRuntimeEvents(sessionId: string, afterSeq: number): ReplayRuntimeEventsResult;
  getSessionState(sessionId: string): RuntimeSessionState | undefined;
  close(): void;
}

export function openRuntimeLedger(options: OpenRuntimeLedgerOptions): RuntimeLedger {
  const dbPath = options.dbPath;
  if (typeof dbPath !== "string" || dbPath.length === 0) throw new TypeError("Runtime ledger dbPath is required.");
  const fingerprintMaxBytes = positiveSafeInteger(
    options.receiptFingerprintMaxBytes ?? DEFAULT_FINGERPRINT_MAX_BYTES,
    "receiptFingerprintMaxBytes",
  );
  const resultMaxBytes = positiveSafeInteger(
    options.receiptResultMaxBytes ?? DEFAULT_RESULT_MAX_BYTES,
    "receiptResultMaxBytes",
  );
  const eventPayloadMaxBytes = positiveSafeInteger(
    options.eventPayloadMaxBytes ?? DEFAULT_EVENT_PAYLOAD_MAX_BYTES,
    "eventPayloadMaxBytes",
  );
  const maxEventsPerSession = positiveSafeInteger(
    options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION,
    "maxEventsPerSession",
  );
  const created = prepareDatabasePath(dbPath);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    if (created) {
      configureDatabase(db);
      initializeSchema(db);
    } else {
      verifyExistingDatabase(db);
      configureDatabase(db);
    }
    chmodSync(dbPath, 0o600);
    return new SqliteRuntimeLedger(db, fingerprintMaxBytes, resultMaxBytes, eventPayloadMaxBytes, maxEventsPerSession);
  } catch (error) {
    db?.close();
    throw new Error(`Unable to open runtime ledger at ${dbPath}: ${errorMessage(error)}`, { cause: error });
  }
}

class SqliteRuntimeLedger implements RuntimeLedger {
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly fingerprintMaxBytes: number,
    private readonly resultMaxBytes: number,
    private readonly eventPayloadMaxBytes: number,
    private readonly maxEventsPerSession: number,
  ) {}

  admitMutation(input: AdmitMutationInput): AdmitMutationResult {
    this.assertOpen();
    const sessionId = boundedIdentifier(input.sessionId, "sessionId", 512);
    const domain = boundedIdentifier(input.domain, "domain", 128);
    const idempotencyKey = boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512);
    const fingerprint = canonicalJson(input.fingerprint, this.fingerprintMaxBytes, "mutation fingerprint");

    return inImmediateTransaction(this.db, () => {
      ensureSession(this.db, sessionId);
      const existing = row(
        this.db
          .prepare(
            `SELECT fingerprint_json, status, accepted_revision, result_json
             FROM mutation_receipts
             WHERE session_id = ? AND domain = ? AND idempotency_key = ?`,
          )
          .get(sessionId, domain, idempotencyKey),
      );
      if (existing !== undefined) {
        const status = receiptStatus(existing.status);
        const acceptedRevision = safeIntegerColumn(existing.accepted_revision, "accepted_revision");
        if (existing.fingerprint_json !== fingerprint) {
          return { kind: "mismatch", status, acceptedRevision };
        }
        const resultJson = nullableStringColumn(existing.result_json, "result_json");
        return {
          kind: "replay",
          status,
          acceptedRevision,
          ...(resultJson === null ? {} : { result: JSON.parse(resultJson) as unknown }),
        };
      }

      this.db.prepare("UPDATE runtime_sessions SET revision = revision + 1 WHERE session_id = ?").run(sessionId);
      const session = requiredRow(
        this.db.prepare("SELECT revision FROM runtime_sessions WHERE session_id = ?").get(sessionId),
        `session ${sessionId}`,
      );
      const acceptedRevision = safeIntegerColumn(session.revision, "revision");
      this.db
        .prepare(
          `INSERT INTO mutation_receipts (
             session_id, domain, idempotency_key, fingerprint_json, status, accepted_revision, result_json
           ) VALUES (?, ?, ?, ?, 'admitted', ?, NULL)`,
        )
        .run(sessionId, domain, idempotencyKey, fingerprint, acceptedRevision);
      return { kind: "admitted", acceptedRevision };
    });
  }

  completeMutation(input: CompleteMutationInput): void {
    this.assertOpen();
    const sessionId = boundedIdentifier(input.sessionId, "sessionId", 512);
    const domain = boundedIdentifier(input.domain, "domain", 128);
    const idempotencyKey = boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512);
    if (input.status !== "completed" && input.status !== "failed") {
      throw new TypeError("Mutation completion status must be completed or failed.");
    }
    const resultJson = input.result === undefined
      ? null
      : canonicalJson(input.result, this.resultMaxBytes, "mutation result");

    inImmediateTransaction(this.db, () => {
      const existing = requiredRow(
        this.db
          .prepare(
            `SELECT status, result_json FROM mutation_receipts
             WHERE session_id = ? AND domain = ? AND idempotency_key = ?`,
          )
          .get(sessionId, domain, idempotencyKey),
        `mutation receipt ${sessionId}/${domain}/${idempotencyKey}`,
      );
      const currentStatus = receiptStatus(existing.status);
      const currentResult = nullableStringColumn(existing.result_json, "result_json");
      if (currentStatus === "completed" || currentStatus === "failed") {
        if (currentStatus === input.status && currentResult === resultJson) return;
        throw new Error("Mutation receipt is already terminal with a different outcome.");
      }
      this.db
        .prepare(
          `UPDATE mutation_receipts SET status = ?, result_json = ?
           WHERE session_id = ? AND domain = ? AND idempotency_key = ?`,
        )
        .run(input.status, resultJson, sessionId, domain, idempotencyKey);
    });
  }

  recoverInDoubt(): number {
    this.assertOpen();
    return inImmediateTransaction(this.db, () => {
      const changed = this.db
        .prepare("UPDATE mutation_receipts SET status = 'in_doubt' WHERE status = 'admitted'")
        .run().changes;
      return Number(changed);
    });
  }

  reopenMutation(input: MutationReceiptRef): ReopenMutationResult {
    this.assertOpen();
    const sessionId = boundedIdentifier(input.sessionId, "sessionId", 512);
    const domain = boundedIdentifier(input.domain, "domain", 128);
    const idempotencyKey = boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512);
    return inImmediateTransaction(this.db, () => {
      const existing = requiredRow(
        this.db
          .prepare(
            `SELECT status, accepted_revision, result_json FROM mutation_receipts
             WHERE session_id = ? AND domain = ? AND idempotency_key = ?`,
          )
          .get(sessionId, domain, idempotencyKey),
        `mutation receipt ${sessionId}/${domain}/${idempotencyKey}`,
      );
      const status = receiptStatus(existing.status);
      const acceptedRevision = safeIntegerColumn(existing.accepted_revision, "accepted_revision");
      if (status === "in_doubt") {
        this.db
          .prepare(
            `UPDATE mutation_receipts SET status = 'admitted'
             WHERE session_id = ? AND domain = ? AND idempotency_key = ? AND status = 'in_doubt'`,
          )
          .run(sessionId, domain, idempotencyKey);
        return { kind: "reopened", acceptedRevision };
      }
      const resultJson = nullableStringColumn(existing.result_json, "result_json");
      return {
        kind: "replay",
        status,
        acceptedRevision,
        ...(resultJson === null ? {} : { result: JSON.parse(resultJson) as unknown }),
      };
    });
  }

  recordUsage(input: RecordUsageInput): RecordUsageResult {
    this.assertOpen();
    const sessionId = boundedIdentifier(input.sessionId, "sessionId", 512);
    const eventId = boundedIdentifier(input.eventId, "eventId", 512);
    const mainId = boundedOptionalIdentifier(input.mainId, "mainId", 512);
    const agentId = boundedOptionalIdentifier(input.agentId, "agentId", 512);
    const provider = boundedIdentifier(input.route?.provider, "route.provider", 256);
    const model = boundedIdentifier(input.route?.model, "route.model", 256);
    const counters = validateUsageCounters(input.counters);

    return inImmediateTransaction(this.db, () => {
      ensureSession(this.db, sessionId);
      const existing = row(
        this.db
          .prepare(
            `SELECT main_id, agent_id, provider, model,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    cache_savings_usd, cost_usd
             FROM usage_events WHERE session_id = ? AND event_id = ?`,
          )
          .get(sessionId, eventId),
      );
      if (existing !== undefined) {
        return usageEventMatches(existing, mainId, agentId, provider, model, counters)
          ? { kind: "duplicate" }
          : { kind: "scope_mismatch" };
      }

      this.db
        .prepare(
          `INSERT INTO usage_events (
             session_id, event_id, main_id, agent_id, provider, model,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             cache_savings_usd, cost_usd
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, eventId, mainId, agentId, provider, model, ...usageCounterParameters(counters));
      upsertUsageTotal(this.db, "usage_session_totals", [sessionId], counters);
      if (mainId !== null) upsertUsageTotal(this.db, "usage_main_totals", [sessionId, mainId], counters);
      if (agentId !== null) upsertUsageTotal(this.db, "usage_agent_totals", [sessionId, agentId], counters);
      upsertUsageTotal(this.db, "usage_route_totals", [sessionId, provider, model], counters);
      return { kind: "recorded" };
    });
  }

  snapshotUsageTotals(sessionId: string): UsageTotalsSnapshot {
    this.assertOpen();
    const normalized = boundedIdentifier(sessionId, "sessionId", 512);
    const sessionRow = row(this.db.prepare("SELECT * FROM usage_session_totals WHERE session_id = ?").get(normalized));
    const mainRows = this.db
      .prepare("SELECT * FROM usage_main_totals WHERE session_id = ? ORDER BY main_id")
      .all(normalized) as SqlRow[];
    const agentRows = this.db
      .prepare("SELECT * FROM usage_agent_totals WHERE session_id = ? ORDER BY agent_id")
      .all(normalized) as SqlRow[];
    const routeRows = this.db
      .prepare("SELECT * FROM usage_route_totals WHERE session_id = ? ORDER BY provider, model")
      .all(normalized) as SqlRow[];
    return {
      session: sessionRow === undefined ? zeroUsageCounters() : usageCountersFromRow(sessionRow),
      byMain: mainRows.map((value) => ({
        mainId: stringColumn(value.main_id, "main_id"),
        totals: usageCountersFromRow(value),
      })),
      byAgent: agentRows.map((value) => ({
        agentId: stringColumn(value.agent_id, "agent_id"),
        totals: usageCountersFromRow(value),
      })),
      byRoute: routeRows.map((value) => ({
        provider: stringColumn(value.provider, "provider"),
        model: stringColumn(value.model, "model"),
        totals: usageCountersFromRow(value),
      })),
    };
  }

  appendRuntimeEvent(input: AppendRuntimeEventInput): RuntimeEvent {
    this.assertOpen();
    const sessionId = boundedIdentifier(input.sessionId, "sessionId", 512);
    const type = boundedIdentifier(input.type, "event type", 256);
    const payloadJson = canonicalJson(input.payload, this.eventPayloadMaxBytes, "runtime event payload");
    return inImmediateTransaction(this.db, () => {
      ensureSession(this.db, sessionId);
      const session = requiredRow(
        this.db
          .prepare("SELECT next_event_seq, event_low_watermark FROM runtime_sessions WHERE session_id = ?")
          .get(sessionId),
        `session ${sessionId}`,
      );
      const seq = safeIntegerColumn(session.next_event_seq, "next_event_seq");
      const previousLowWatermark = safeIntegerColumn(session.event_low_watermark, "event_low_watermark");
      this.db
        .prepare("INSERT INTO runtime_events (session_id, seq, type, payload_json) VALUES (?, ?, ?, ?)")
        .run(sessionId, seq, type, payloadJson);
      const nextEventSeq = seq + 1;
      if (!Number.isSafeInteger(nextEventSeq)) throw new RangeError("Runtime event sequence is exhausted.");
      const lowWatermark = Math.max(previousLowWatermark, nextEventSeq - this.maxEventsPerSession);
      this.db
        .prepare(
          `UPDATE runtime_sessions SET next_event_seq = ?, event_low_watermark = ?
           WHERE session_id = ?`,
        )
        .run(nextEventSeq, lowWatermark, sessionId);
      this.db.prepare("DELETE FROM runtime_events WHERE session_id = ? AND seq < ?").run(sessionId, lowWatermark);
      return { seq, type, payload: JSON.parse(payloadJson) as unknown };
    });
  }

  replayRuntimeEvents(sessionId: string, afterSeq: number): ReplayRuntimeEventsResult {
    this.assertOpen();
    const normalized = boundedIdentifier(sessionId, "sessionId", 512);
    const normalizedAfterSeq = nonNegativeSafeInteger(afterSeq, "afterSeq");
    const session = row(
      this.db
        .prepare("SELECT next_event_seq, event_low_watermark FROM runtime_sessions WHERE session_id = ?")
        .get(normalized),
    );
    if (session === undefined) {
      return { kind: "events", lowWatermark: 1, nextEventSeq: 1, events: [] };
    }
    const lowWatermark = safeIntegerColumn(session.event_low_watermark, "event_low_watermark");
    const nextEventSeq = safeIntegerColumn(session.next_event_seq, "next_event_seq");
    if (normalizedAfterSeq < lowWatermark - 1) {
      return { kind: "expired", lowWatermark, nextEventSeq, events: [] };
    }
    const values = this.db
      .prepare(
        `SELECT seq, type, payload_json FROM runtime_events
         WHERE session_id = ? AND seq > ? ORDER BY seq`,
      )
      .all(normalized, normalizedAfterSeq) as SqlRow[];
    return {
      kind: "events",
      lowWatermark,
      nextEventSeq,
      events: values.map((value) => ({
        seq: safeIntegerColumn(value.seq, "seq"),
        type: stringColumn(value.type, "type"),
        payload: JSON.parse(stringColumn(value.payload_json, "payload_json")) as unknown,
      })),
    };
  }

  getSessionState(sessionId: string): RuntimeSessionState | undefined {
    this.assertOpen();
    const normalized = boundedIdentifier(sessionId, "sessionId", 512);
    const value = row(
      this.db
        .prepare(
          `SELECT session_id, revision, next_event_seq, event_low_watermark
           FROM runtime_sessions WHERE session_id = ?`,
        )
        .get(normalized),
    );
    if (value === undefined) return undefined;
    return {
      sessionId: stringColumn(value.session_id, "session_id"),
      revision: safeIntegerColumn(value.revision, "revision"),
      nextEventSeq: safeIntegerColumn(value.next_event_seq, "next_event_seq"),
      eventLowWatermark: safeIntegerColumn(value.event_low_watermark, "event_low_watermark"),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Runtime ledger is closed.");
  }
}

function initializeSchema(db: DatabaseSync): void {
  inImmediateTransaction(db, () => {
    db.exec(`
      CREATE TABLE runtime_sessions (
        session_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        next_event_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_event_seq >= 1),
        event_low_watermark INTEGER NOT NULL DEFAULT 1 CHECK (event_low_watermark >= 1),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;

      CREATE TABLE mutation_receipts (
        session_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('admitted', 'completed', 'failed', 'in_doubt')),
        accepted_revision INTEGER NOT NULL CHECK (accepted_revision >= 1),
        result_json TEXT,
        PRIMARY KEY (session_id, domain, idempotency_key),
        FOREIGN KEY (session_id) REFERENCES runtime_sessions(session_id) ON DELETE CASCADE
      ) STRICT;
    `);
    createUsageSchema(db);
    createRuntimeEventsSchema(db);
    db.exec(`PRAGMA application_id = ${String(RUNTIME_LEDGER_APPLICATION_ID)}`);
    db.exec(`PRAGMA user_version = ${String(RUNTIME_LEDGER_SCHEMA_VERSION)}`);
  });
}

function configureDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
}

function verifyExistingDatabase(db: DatabaseSync): void {
  const integrity = requiredRow(db.prepare("PRAGMA quick_check").get(), "quick_check");
  if (integrity.quick_check !== "ok") throw new Error("Runtime ledger integrity check failed.");
  const applicationId = pragmaNumber(db, "application_id");
  const schemaVersion = pragmaNumber(db, "user_version");
  if (applicationId !== RUNTIME_LEDGER_APPLICATION_ID) throw new Error("File is not an UncleCode runtime ledger.");
  if (schemaVersion === 1 || schemaVersion === 2) {
    inImmediateTransaction(db, () => {
      if (schemaVersion === 1) createUsageSchema(db);
      createRuntimeEventsSchema(db);
      db.exec(`PRAGMA user_version = ${String(RUNTIME_LEDGER_SCHEMA_VERSION)}`);
    });
    return;
  }
  if (schemaVersion !== RUNTIME_LEDGER_SCHEMA_VERSION) {
    throw new Error(`Unsupported runtime ledger schema version: ${String(schemaVersion)}.`);
  }
}

function createRuntimeEventsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE runtime_events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, seq),
      FOREIGN KEY (session_id) REFERENCES runtime_sessions(session_id) ON DELETE CASCADE
    ) STRICT;
  `);
}

function createUsageSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE usage_events (
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      main_id TEXT,
      agent_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
      cache_savings_usd REAL NOT NULL CHECK (cache_savings_usd >= 0),
      cost_usd REAL NOT NULL CHECK (cost_usd >= 0),
      PRIMARY KEY (session_id, event_id),
      FOREIGN KEY (session_id) REFERENCES runtime_sessions(session_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE usage_session_totals (
      session_id TEXT PRIMARY KEY,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cache_savings_usd REAL NOT NULL,
      cost_usd REAL NOT NULL,
      FOREIGN KEY (session_id) REFERENCES runtime_sessions(session_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE usage_main_totals (
      session_id TEXT NOT NULL,
      main_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cache_savings_usd REAL NOT NULL,
      cost_usd REAL NOT NULL,
      PRIMARY KEY (session_id, main_id),
      FOREIGN KEY (session_id) REFERENCES runtime_sessions(session_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE usage_agent_totals (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cache_savings_usd REAL NOT NULL,
      cost_usd REAL NOT NULL,
      PRIMARY KEY (session_id, agent_id),
      FOREIGN KEY (session_id) REFERENCES runtime_sessions(session_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE usage_route_totals (
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cache_savings_usd REAL NOT NULL,
      cost_usd REAL NOT NULL,
      PRIMARY KEY (session_id, provider, model),
      FOREIGN KEY (session_id) REFERENCES runtime_sessions(session_id) ON DELETE CASCADE
    ) STRICT;
  `);
}

function prepareDatabasePath(dbPath: string): boolean {
  const parent = dirname(dbPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("Runtime ledger parent must be a real directory, not a symlink.");
  }
  chmodSync(parent, 0o700);
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Runtime ledger path is not a regular file: ${candidate}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    const descriptor = openSync(
      dbPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(descriptor);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    chmodSync(dbPath, 0o600);
    return false;
  }
}

function ensureSession(db: DatabaseSync, sessionId: string): void {
  db.prepare("INSERT OR IGNORE INTO runtime_sessions (session_id) VALUES (?)").run(sessionId);
}

function inImmediateTransaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validateUsageCounters(value: unknown): UsageCounterVector {
  if (typeof value !== "object" || value === null) throw new TypeError("Usage counters are required.");
  const counters = value as Record<string, unknown>;
  return {
    inputTokens: nonNegativeSafeInteger(counters.inputTokens, "inputTokens"),
    outputTokens: nonNegativeSafeInteger(counters.outputTokens, "outputTokens"),
    cacheReadTokens: nonNegativeSafeInteger(counters.cacheReadTokens, "cacheReadTokens"),
    cacheWriteTokens: nonNegativeSafeInteger(counters.cacheWriteTokens, "cacheWriteTokens"),
    cacheSavingsUsd: nonNegativeFiniteNumber(counters.cacheSavingsUsd, "cacheSavingsUsd"),
    costUsd: nonNegativeFiniteNumber(counters.costUsd, "costUsd"),
  };
}

function usageCounterParameters(counters: UsageCounterVector): [number, number, number, number, number, number] {
  return [
    counters.inputTokens,
    counters.outputTokens,
    counters.cacheReadTokens,
    counters.cacheWriteTokens,
    counters.cacheSavingsUsd,
    counters.costUsd,
  ];
}

function usageEventMatches(
  value: SqlRow,
  mainId: string | null,
  agentId: string | null,
  provider: string,
  model: string,
  counters: UsageCounterVector,
): boolean {
  return value.main_id === mainId
    && value.agent_id === agentId
    && value.provider === provider
    && value.model === model
    && value.input_tokens === counters.inputTokens
    && value.output_tokens === counters.outputTokens
    && value.cache_read_tokens === counters.cacheReadTokens
    && value.cache_write_tokens === counters.cacheWriteTokens
    && value.cache_savings_usd === counters.cacheSavingsUsd
    && value.cost_usd === counters.costUsd;
}

function upsertUsageTotal(
  db: DatabaseSync,
  table: "usage_session_totals" | "usage_main_totals" | "usage_agent_totals" | "usage_route_totals",
  keys: readonly string[],
  counters: UsageCounterVector,
): void {
  const keyColumns = table === "usage_session_totals"
    ? ["session_id"]
    : table === "usage_main_totals"
      ? ["session_id", "main_id"]
      : table === "usage_agent_totals"
        ? ["session_id", "agent_id"]
        : ["session_id", "provider", "model"];
  const placeholders = [...keyColumns, "input", "output", "read", "write", "savings", "cost"]
    .map(() => "?")
    .join(", ");
  db.prepare(
    `INSERT INTO ${table} (
       ${keyColumns.join(", ")}, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cache_savings_usd, cost_usd
     ) VALUES (${placeholders})
     ON CONFLICT (${keyColumns.join(", ")}) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
       cache_savings_usd = cache_savings_usd + excluded.cache_savings_usd,
       cost_usd = cost_usd + excluded.cost_usd`,
  ).run(...keys, ...usageCounterParameters(counters));
}

function usageCountersFromRow(value: SqlRow): UsageCounterVector {
  return {
    inputTokens: safeIntegerColumn(value.input_tokens, "input_tokens"),
    outputTokens: safeIntegerColumn(value.output_tokens, "output_tokens"),
    cacheReadTokens: safeIntegerColumn(value.cache_read_tokens, "cache_read_tokens"),
    cacheWriteTokens: safeIntegerColumn(value.cache_write_tokens, "cache_write_tokens"),
    cacheSavingsUsd: finiteNumberColumn(value.cache_savings_usd, "cache_savings_usd"),
    costUsd: finiteNumberColumn(value.cost_usd, "cost_usd"),
  };
}

function zeroUsageCounters(): UsageCounterVector {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheSavingsUsd: 0,
    costUsd: 0,
  };
}

function canonicalJson(value: unknown, maxBytes: number, label: string): string {
  const seen = new Set<object>();
  const visit = (current: unknown): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError(`${label} must contain only finite numbers.`);
      return Object.is(current, -0) ? 0 : current;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) throw new TypeError(`${label} must not be cyclic.`);
      seen.add(current);
      const result = current.map(visit);
      seen.delete(current);
      return result;
    }
    if (typeof current === "object") {
      if (seen.has(current)) throw new TypeError(`${label} must not be cyclic.`);
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${label} must contain only JSON objects and arrays.`);
      }
      seen.add(current);
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(current as Record<string, unknown>).sort()) {
        const child = (current as Record<string, unknown>)[key];
        if (child === undefined || typeof child === "bigint" || typeof child === "function" || typeof child === "symbol") {
          throw new TypeError(`${label} must contain only JSON values.`);
        }
        result[key] = visit(child);
      }
      seen.delete(current);
      return result;
    }
    throw new TypeError(`${label} must contain only JSON values.`);
  };
  const serialized = JSON.stringify(visit(value));
  if (serialized === undefined) throw new TypeError(`${label} must be a JSON value.`);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new RangeError(`${label} exceeds the ${String(maxBytes)} byte limit.`);
  }
  return serialized;
}

function boundedIdentifier(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new RangeError(`${label} exceeds the byte limit.`);
  return value;
}

function boundedOptionalIdentifier(value: unknown, label: string, maxBytes: number): string | null {
  return value === undefined ? null : boundedIdentifier(value, label, maxBytes);
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function nonNegativeFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function pragmaNumber(db: DatabaseSync, name: "application_id" | "user_version"): number {
  const value = requiredRow(db.prepare(`PRAGMA ${name}`).get(), name)[name];
  return safeIntegerColumn(value, name);
}

function receiptStatus(value: SQLOutputValue | undefined): MutationReceiptStatus {
  if (value === "admitted" || value === "completed" || value === "failed" || value === "in_doubt") return value;
  throw new Error("Runtime ledger contains an invalid receipt status.");
}

function row(value: unknown): SqlRow | undefined {
  return value === undefined ? undefined : (value as SqlRow);
}

function requiredRow(value: unknown, label: string): SqlRow {
  const result = row(value);
  if (result === undefined) throw new Error(`Runtime ledger row not found: ${label}.`);
  return result;
}

function safeIntegerColumn(value: SQLOutputValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid integer column: ${label}.`);
  return value;
}

function stringColumn(value: SQLOutputValue | undefined, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid string column: ${label}.`);
  return value;
}

function nullableStringColumn(value: SQLOutputValue | undefined, label: string): string | null {
  if (value === null || typeof value === "string") return value;
  throw new Error(`Invalid nullable string column: ${label}.`);
}

function finiteNumberColumn(value: SQLOutputValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid number column: ${label}.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
