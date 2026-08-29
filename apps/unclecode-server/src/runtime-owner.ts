import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { watchSessionPersistenceNotices } from "@unclecode/session-store";

import { BoundedEventJournal } from "./event-journal.js";
import { makeControlRoomHandlers, startServer, ensureServerToken } from "./index.js";
import { createPersistentRuntimeAdapter, LiveRuntimeControlRegistry } from "./persistent-runtime.js";
import { LiveRuntimeEngineRegistry, type RuntimeSessionFactory } from "./runtime-engine-rpc.js";
import { RuntimeSessionMutationArbiter } from "./runtime-mutation-arbiter.js";
import { attachWorkShellRuntime, type WorkShellControlEngine } from "./work-shell-control.js";
import {
  RUNTIME_OWNER_PROTOCOL,
  currentBootIdentity,
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
}): Promise<{
  readonly lease: RuntimeOwnerLease;
  readonly controls: LiveRuntimeControlRegistry;
  readonly journal: BoundedEventJournal;
  readonly engines: LiveRuntimeEngineRegistry;
  readonly stop: () => Promise<void>;
}> {
  const ownerId = input.ownerId ?? randomUUID();
  const bootId = input.bootId ?? currentBootIdentity();
  const token = ensureServerToken(input.tokenPath);
  const journal = input.journal ?? new BoundedEventJournal();
  const { adapter, controls } = createPersistentRuntimeAdapter({
    rootDir: input.rootDir,
    ...(input.controls ? { controls: input.controls } : {}),
    journal,
  });
  const engines = input.engines ?? new LiveRuntimeEngineRegistry({
    ...(input.createSession ? {
      createSession: async (request) => {
        const created = await input.createSession!(request);
        const revisionClock = { value: 0 };
        const mutationArbiter = new RuntimeSessionMutationArbiter(revisionClock);
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
  const controlHandlers = makeControlRoomHandlers({ adapter, journal });
  const notices = await watchSessionPersistenceNotices({
    rootDir: input.rootDir,
    onNotice(notice) {
      journal.publish(notice.sessionId, "run.updated", { kind: "checkpoint", revision: notice.revision });
    },
  });
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
    notices.stop();
    throw error;
  }
  const lease: RuntimeOwnerLease = {
    version: 1,
    protocol: RUNTIME_OWNER_PROTOCOL,
    ownerId,
    pid: process.pid,
    bootId,
    endpoint: server.url,
    tokenPath: input.tokenPath,
    startedAt: Date.now(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
  };
  await publishRuntimeOwnerLease(input.leasePath, lease);
  return {
    lease,
    controls,
    journal,
    engines,
    async stop() {
      await server.stop();
      notices.stop();
      await engines.disposeAll();
      const current = await readRuntimeOwnerLease(input.leasePath);
      if (current?.ownerId === ownerId) await unlink(input.leasePath).catch(() => undefined);
    },
  };
}
