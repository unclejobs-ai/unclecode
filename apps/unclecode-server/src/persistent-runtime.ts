import { lstat, opendir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { BoundedEventJournal } from "./event-journal.js";
import { createRuntimeAdapter, type RuntimeAdapter, type RuntimeControlPort, type RuntimeControlRequest, type RuntimeControlResult } from "./runtime-adapter.js";
import type { RuntimeReadSource, RuntimeSessionSource } from "./control-room.js";
import type { RuntimeSessionMutationArbiter } from "./runtime-mutation-arbiter.js";

const MAX_CHECKPOINTS = 128;
const MAX_DIRECTORIES = 2_048;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;

export type AttachedRuntimeControl = {
  readonly revision: () => number;
  readonly mutationArbiter?: RuntimeSessionMutationArbiter | undefined;
  readonly snapshot?: (() => RuntimeSessionSource) | undefined;
  readonly onCommitted?: ((result: RuntimeControlResult) => void) | undefined;
  readonly control: (request: RuntimeControlRequest) => Promise<RuntimeControlResult>;
};

export class LiveRuntimeControlRegistry implements RuntimeControlPort {
  readonly #controls = new Map<string, AttachedRuntimeControl>();

  attach(sessionId: string, control: AttachedRuntimeControl): () => void {
    this.#controls.set(sessionId, control);
    return () => {
      if (this.#controls.get(sessionId) === control) this.#controls.delete(sessionId);
    };
  }

  revision(sessionId: string): number | undefined {
    return this.#controls.get(sessionId)?.revision();
  }

  snapshot(sessionId: string): RuntimeSessionSource | undefined {
    return this.#controls.get(sessionId)?.snapshot?.();
  }

  snapshots(): readonly RuntimeSessionSource[] {
    return [...this.#controls.values()].flatMap(control => {
      const snapshot = control.snapshot?.();
      return snapshot ? [snapshot] : [];
    });
  }

  async control(request: RuntimeControlRequest): Promise<RuntimeControlResult> {
    const attached = this.#controls.get(request.sessionId);
    if (!attached) return { ok: false, code: "not_attached", message: "Session is not attached to this runtime server." };
    const revision = attached.revision();
    if (!attached.mutationArbiter) {
      if (revision !== request.expectedRevision) {
        return { ok: false, code: "revision_conflict", message: "Session revision changed.", revision };
      }
      return attached.control(request);
    }
    const result = await attached.mutationArbiter.mutate<RuntimeControlResult, RuntimeControlResult>({
      idempotencyKey: request.idempotencyKey,
      fingerprint: JSON.stringify({ action: request.action, payload: request.payload, expectedRevision: request.expectedRevision }),
      expectedRevision: request.expectedRevision,
      ...(request.action === "cancel"
        ? { lane: "cancel" as const }
        : request.action === "follow-up"
          ? {}
          : { lane: "control" as const }),
      conflict: (current) => ({ ok: false, code: "revision_conflict", message: "Session revision changed.", revision: current }),
      invalidReuse: (current) => ({ ok: false, code: "invalid_action", message: "Idempotency-Key was reused for another runtime action.", revision: current }),
      execute: () => attached.control(request),
      didMutate: (response) => response.ok,
      complete: (response, current) => ({ ...response, revision: current }),
      fail: (error, current) => ({
        ok: false,
        code: "invalid_action",
        message: error instanceof Error ? error.message : String(error),
        revision: current,
      }),
    });
    attached.onCommitted?.(result);
    return result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateOf(value: unknown): RuntimeSessionSource["state"] {
  if (value === "running" || value === "pause_pending" || value === "paused" || value === "requires_action" || value === "completed" || value === "failed" || value === "cancelled") return value;
  return "idle";
}

function localeOf(checkpoint: Record<string, unknown>): "en" | "ko" {
  const metadata = isRecord(checkpoint.metadata) ? checkpoint.metadata : {};
  return checkpoint.uiLocale === "ko" || metadata.uiLocale === "ko" ? "ko" : "en";
}

async function checkpointPaths(rootDir: string): Promise<readonly string[]> {
  const pending = [rootDir];
  const found: string[] = [];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_DIRECTORIES && found.length < MAX_CHECKPOINTS) {
    const directory = pending.shift();
    if (!directory) break;
    visited += 1;
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".checkpoint.json")) found.push(path);
      if (found.length >= MAX_CHECKPOINTS) break;
    }
  }
  return found;
}

async function readCheckpoint(path: string, controls: LiveRuntimeControlRegistry): Promise<RuntimeSessionSource | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHECKPOINT_BYTES) return null;
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed) || typeof parsed.sessionId !== "string" || typeof parsed.projectPath !== "string") return null;
    const metadata = isRecord(parsed.metadata) ? parsed.metadata : undefined;
    const agentConsole = isRecord(parsed.agentConsole) ? parsed.agentConsole : undefined;
    const eventCount = typeof parsed.eventCount === "number" && Number.isSafeInteger(parsed.eventCount) ? parsed.eventCount : 0;
    const checkpointState = stateOf(parsed.state);
    const wasInFlight = checkpointState === "running"
      || checkpointState === "pause_pending"
      || checkpointState === "paused";
    const recoveredMetadata = wasInFlight
      ? { ...(metadata ?? {}), recoveryStatus: "non_resumable_owner_restart", checkpointState }
      : metadata;
    const persisted: RuntimeSessionSource = {
      sessionId: parsed.sessionId,
      projectPath: parsed.projectPath,
      locale: localeOf(parsed),
      state: wasInFlight ? "failed" : checkpointState,
      revision: controls.revision(parsed.sessionId) ?? eventCount,
      ...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
      ...(recoveredMetadata ? { metadata: recoveredMetadata } : {}),
      ...(agentConsole ? { agentConsole } : {}),
      context: {
        included: [],
        excluded: [],
        compacted: false,
        ...(typeof metadata?.lastSubmittedContextReceiptId === "string" ? { receiptId: metadata.lastSubmittedContextReceiptId } : {}),
      },
    };
    return controls.snapshot(parsed.sessionId) ?? persisted;
  } catch {
    return null;
  }
}

export async function readPersistentRuntime(rootDir: string, controls: LiveRuntimeControlRegistry): Promise<RuntimeReadSource> {
  const paths = await checkpointPaths(rootDir);
  const settled = await Promise.all(paths.map(path => readCheckpoint(path, controls)));
  const bySessionId = new Map(
    settled.filter((item): item is RuntimeSessionSource => item !== null)
      .map(item => [item.sessionId, item] as const),
  );
  for (const live of controls.snapshots()) bySessionId.set(live.sessionId, live);
  const sessions = [...bySessionId.values()]
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return {
    generatedAt: Date.now(),
    sessions,
    system: {
      providers: [],
      plugins: [],
      cleanup: [],
    },
  };
}

export function createPersistentRuntimeAdapter(input: {
  readonly rootDir: string;
  readonly controls?: LiveRuntimeControlRegistry;
  readonly journal?: BoundedEventJournal;
  readonly journalCapacity?: number;
}): {
  readonly adapter: RuntimeAdapter;
  readonly controls: LiveRuntimeControlRegistry;
  readonly journal: BoundedEventJournal;
} {
  const controls = input.controls ?? new LiveRuntimeControlRegistry();
  const journal = input.journal ?? new BoundedEventJournal(
    input.journalCapacity === undefined ? {} : { capacity: input.journalCapacity },
  );
  return {
    controls,
    journal,
    adapter: createRuntimeAdapter({
      read: () => readPersistentRuntime(input.rootDir, controls),
      controls,
    }),
  };
}
