import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { watchSessionPersistenceNotices } from "@unclecode/session-store";
import { bindRuntimeUsageRecorder } from "@unclecode/orchestrator";

import { BoundedEventJournal, LedgerBackedEventJournal } from "./event-journal.js";
import { makeControlRoomHandlers, startServer, ensureServerToken } from "./index.js";
import { createPersistentRuntimeAdapter, LiveRuntimeControlRegistry } from "./persistent-runtime.js";
import { LiveRuntimeEngineRegistry, type RuntimeSessionFactory } from "./runtime-engine-rpc.js";
import { readRuntimeAdmissionRevision } from "./runtime-admission-ledger.js";
import { RuntimeSessionMutationArbiter } from "./runtime-mutation-arbiter.js";
import { openRuntimeLedger } from "./runtime-ledger.js";
import { attachWorkShellRuntime, type WorkShellControlEngine } from "./work-shell-control.js";
import type { RuntimeCacheTelemetrySnapshot } from "./control-room.js";
import { readRuntimeProcessObservability } from "./system-observability.js";
import {
  RUNTIME_OWNER_PROTOCOL,
  currentBootIdentity,
  processStartIdentity,
  publishRuntimeOwnerLease,
  readRuntimeOwnerLease,
  type RuntimeOwnerLease,
} from "./runtime-owner-discovery.js";

export function defaultRuntimeOwnerPaths(userHome = homedir()): {
  readonly leasePath: string;
  readonly lockPath: string;
  readonly tokenPath: string;
} {
  const root = join(userHome, ".unclecode");
  return {
    leasePath: join(root, "runtime-owner-v1.json"),
    lockPath: join(root, "runtime-owner-v1.lock"),
    tokenPath: join(root, "server.token"),
  };
}

export async function startPersistentRuntimeOwner(input: {
  readonly rootDir: string;
  readonly leasePath: string;
  readonly tokenPath: string;
  readonly controls?: LiveRuntimeControlRegistry | undefined;
  readonly journal?: BoundedEventJournal | undefined;
  readonly engines?: LiveRuntimeEngineRegistry | undefined;
  readonly createSession?: RuntimeSessionFactory | undefined;
  readonly ownerId?: string | undefined;
  readonly bootId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly projectPath?: string | undefined;
  readonly resolveProcessStartIdentity?: ((pid: number) => Promise<string | null>) | undefined;
  readonly readCacheTelemetry?: (() => readonly RuntimeCacheTelemetrySnapshot[]) | undefined;
}): Promise<{
  readonly lease: RuntimeOwnerLease;
  readonly controls: LiveRuntimeControlRegistry;
  readonly journal: LedgerBackedEventJournal;
  readonly engines: LiveRuntimeEngineRegistry;
  readonly stop: () => Promise<void>;
}> {
  const ownerId = input.ownerId ?? randomUUID();
  const bootId = input.bootId ?? currentBootIdentity();
  const processStartId = await (input.resolveProcessStartIdentity ?? processStartIdentity)(process.pid);
  if (!processStartId) throw new Error("Cannot establish the runtime owner process-start identity.");
  const hotJournal = input.journal ?? new BoundedEventJournal();
  const ledger = openRuntimeLedger({
    dbPath: join(input.rootDir, "runtime-owner-v1", "owner.db"),
  });
  try {
    ledger.recoverInDoubt();
  } catch (error) {
    ledger.close();
    throw error;
  }
  let token: string;
  try {
    token = ensureServerToken(input.tokenPath);
  } catch (error) {
    ledger.close();
    throw error;
  }
  const journal = new LedgerBackedEventJournal({ ledger, hot: hotJournal });
  let engines: LiveRuntimeEngineRegistry;
  const { adapter, controls } = createPersistentRuntimeAdapter({
    rootDir: input.rootDir,
    ...(input.controls ? { controls: input.controls } : {}),
    journal,
    ...(input.readCacheTelemetry ? { readCacheTelemetry: input.readCacheTelemetry } : {}),
    readSystemObservability: () => ({
      ...readRuntimeProcessObservability(),
      journal: journal.stats,
      ...engines.systemSnapshot(),
    }),
  });
  engines = input.engines ?? new LiveRuntimeEngineRegistry({
    ...(input.createSession ? {
      createSession: async (request) => {
        const created = await input.createSession!(request);
        const revisionClock = created.revisionClock ?? { value: 0 };
        const legacyRevision = await readRuntimeAdmissionRevision({
          rootDir: input.rootDir,
          projectPath: created.projectPath,
          sessionId: request.sessionId,
        });
        revisionClock.value = ledger.seedSessionRevision(
          request.sessionId,
          Math.max(revisionClock.value, legacyRevision),
        );
        const revisionEngine = created.engine as typeof created.engine & {
          bindRuntimeRevisionClock?: ((clock: { readonly value: number }) => void) | undefined;
          bindRuntimeUsageRecorder?: ((recorder: ReturnType<typeof bindRuntimeUsageRecorder>) => void) | undefined;
        };
        revisionEngine.bindRuntimeRevisionClock?.(revisionClock);
        revisionEngine.bindRuntimeUsageRecorder?.(bindRuntimeUsageRecorder({
          sessionId: request.sessionId,
          ledger,
        }));
        const mutationArbiter = new RuntimeSessionMutationArbiter(revisionClock, {
          ledger,
          sessionId: request.sessionId,
          domain: "runtime-session",
        });
        const detachControl = attachWorkShellRuntime(controls, {
          sessionId: request.sessionId,
          projectPath: created.projectPath,
          engine: created.engine as WorkShellControlEngine,
          ...(created.provider ? { provider: created.provider } : {}),
          revisionClock,
          mutationArbiter,
          onChanged(event) { journal.publish(event.sessionId, "run.updated", event); },
        });
        return {
          ...created,
          revisionClock,
          mutationArbiter,
          async dispose() {
            detachControl();
            await created.dispose?.();
          },
        };
      },
    } : {}),
  });
  const controlHandlers = makeControlRoomHandlers({ adapter, journal, publishControlResults: false });
  let notices;
  try {
    notices = await watchSessionPersistenceNotices({
      rootDir: input.rootDir,
      onNotice(notice) {
        const live = engines.read(notice.sessionId);
        const revision = live.ok ? live.revision : notice.revision;
        journal.publish(notice.sessionId, "run.updated", { kind: "checkpoint", revision });
      },
    });
  } catch (error) {
    ledger.close();
    throw error;
  }
  let server;
  try {
    server = await startServer({
    port: 0,
    host: "127.0.0.1",
    handlers: {
      ...controlHandlers,
      readEngineState: (sessionId) => engines.read(sessionId),
      invokeEngineMethod: (request) => engines.invoke(request),
      listRuntimeSessions: () => engines.list(),
      createRuntimeSession: (request) => engines.create(request),
      attachRuntimeSession: (sessionId) => engines.attachSession(sessionId),
    },
    authToken: token,
    runtimeOwner: { protocol: RUNTIME_OWNER_PROTOCOL, ownerId, bootId },
    });
  } catch (error) {
    try {
      notices.stop();
    } finally {
      ledger.close();
    }
    throw error;
  }
  const lease: RuntimeOwnerLease = {
    version: 1,
    protocol: RUNTIME_OWNER_PROTOCOL,
    ownerId,
    pid: process.pid,
    processStartId,
    bootId,
    endpoint: server.url,
    tokenPath: input.tokenPath,
    startedAt: Date.now(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
  };
  try {
    await publishRuntimeOwnerLease(input.leasePath, lease);
  } catch (error) {
    try {
      try {
        notices.stop();
      } finally {
        await server.stop();
      }
    } finally {
      try {
        await engines.disposeAll();
      } finally {
        ledger.close();
      }
    }
    throw error;
  }
  return {
    lease,
    controls,
    journal,
    engines,
    async stop() {
      try {
        await server.stop();
      } finally {
        try {
          notices.stop();
        } finally {
          try {
            await engines.disposeAll();
          } finally {
            ledger.close();
          }
        }
      }
      const current = await readRuntimeOwnerLease(input.leasePath);
      if (current?.ownerId === ownerId) await unlink(input.leasePath).catch(() => undefined);
    },
  };
}
