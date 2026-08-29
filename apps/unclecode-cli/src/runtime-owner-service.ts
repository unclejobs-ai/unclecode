import {
  createWorkShellPaneRuntime,
  getAppReasoningConfigCacheTelemetrySnapshot,
  getExtensionRegistryCacheTelemetrySnapshot,
  runWorkShellInlineCommand,
} from "@unclecode/orchestrator";
import type { CacheTelemetrySnapshot } from "@unclecode/contracts";
import { getContextBrokerCacheTelemetrySnapshot } from "@unclecode/context-broker";
import { getProviderCacheTelemetrySnapshot } from "@unclecode/providers";
import {
  defaultRuntimeOwnerPaths,
  startPersistentRuntimeOwner,
  type RuntimeSessionFactory,
} from "@unclecode/server";
import { getSessionStoreRoot } from "@unclecode/session-store";
import { formatWorkShellError } from "@unclecode/tui";
import { pathToFileURL } from "node:url";

import { loadWorkCliBootstrap } from "./work-runtime-bootstrap.js";
import { createManagedDashboardInput, type ManagedDashboardSession } from "./work-runtime-dashboard.js";
import { initializeRestoredRuntimeEngine, readRestoredSessionRevision } from "./runtime-session-revision.js";

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const resolveInline = (
  args: readonly string[],
  runInlineCommand: (args: readonly string[], onProgress?: ((line: string) => void) | undefined) => Promise<readonly string[]>,
  onProgress?: ((line: string) => void) | undefined,
) => runWorkShellInlineCommand(args, runInlineCommand, formatWorkShellError, onProgress);

const MAX_RUNTIME_OWNER_CACHE_SNAPSHOTS = 32;
const MAX_RUNTIME_OWNER_CACHE_SOURCES = 32;

type RuntimeOwnerCacheTelemetryReport = {
  readonly caches: readonly CacheTelemetrySnapshot[];
  readonly sources: readonly {
    readonly name: string;
    readonly status: "available" | "unavailable";
    readonly failureCount: number;
  }[];
};

function readCacheSource(
  name: string,
  reader: (() => readonly CacheTelemetrySnapshot[]) | undefined,
): RuntimeOwnerCacheTelemetryReport {
  if (!reader) {
    return {
      caches: [],
      sources: [{ name, status: "unavailable", failureCount: 0 }],
    };
  }
  try {
    return {
      caches: reader(),
      sources: [{ name, status: "available", failureCount: 0 }],
    };
  } catch {
    return {
      caches: [],
      sources: [{ name, status: "unavailable", failureCount: 1 }],
    };
  }
}

export function readRuntimeOwnerCacheTelemetry() {
  const reports = [
    readCacheSource("provider", getProviderCacheTelemetrySnapshot),
    readCacheSource("context-broker", getContextBrokerCacheTelemetrySnapshot),
    readCacheSource("extension-manifest", () => [getExtensionRegistryCacheTelemetrySnapshot()]),
    readCacheSource("app-reasoning-config", () => [getAppReasoningConfigCacheTelemetrySnapshot()]),
    // LSP diagnostic caches live inside session-scoped clients today and have
    // no side-effect-free owner snapshot. Keep the missing source explicit
    // until sessions expose that evidence; an empty healthy row would lie.
    readCacheSource("per-session-lsp", undefined),
  ];
  const caches = reports.flatMap(report => report.caches);
  const sources = reports.flatMap(report => report.sources);
  return {
    caches: caches.slice(0, MAX_RUNTIME_OWNER_CACHE_SNAPSHOTS),
    sources: sources.slice(0, MAX_RUNTIME_OWNER_CACHE_SOURCES),
    sourceFailures: sources.reduce((total, source) => total + source.failureCount, 0),
    projectionFailures: 0,
    truncated: caches.length > MAX_RUNTIME_OWNER_CACHE_SNAPSHOTS
      || sources.length > MAX_RUNTIME_OWNER_CACHE_SOURCES,
  };
}

export function createRuntimeOwnerSessionDisposer(
  engine: { readonly dispose: () => void | Promise<void> },
  disposePlugins?: (() => void | Promise<void>) | undefined,
): () => Promise<void> {
  let disposal: Promise<void> | undefined;
  return () => {
    disposal ??= (async () => {
      try {
        await engine.dispose();
      } finally {
        await disposePlugins?.();
      }
    })();
    return disposal;
  };
}

const createSession: RuntimeSessionFactory = async (request) => {
  const rootDir = getSessionStoreRoot(process.env);
  const restoredRevision = await readRestoredSessionRevision({
    rootDir,
    projectPath: request.projectPath,
    sessionId: request.sessionId,
    resume: request.resume,
  });
  const loaded = await loadWorkCliBootstrap({
    argv: [
      "--cwd", request.projectPath,
      ...(request.provider ? ["--provider", request.provider] : []),
      ...(request.model ? ["--model", request.model] : []),
      ...(request.reasoning ? ["--reasoning", request.reasoning] : []),
      ...(request.resume ? ["--session-id", request.sessionId] : []),
    ],
  });
  if (loaded.prompt) {
    await loaded.dispose?.();
    throw new Error("Runtime owner session factory received prompt mode.");
  }
  const session: ManagedDashboardSession = {
    ...loaded,
    options: { ...loaded.options, cwd: request.projectPath, sessionId: request.sessionId },
  };
  let disposeSession: (() => Promise<void>) | undefined;
  try {
    const dashboardInput = createManagedDashboardInput(session, {
      resolveWorkShellInlineCommand: resolveInline,
      ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
    });
    const runtime = createWorkShellPaneRuntime({ ...dashboardInput.paneRuntime, onExit() {} });
    disposeSession = createRuntimeOwnerSessionDisposer(runtime.engine, loaded.dispose);
    const revisionClock = await initializeRestoredRuntimeEngine(runtime.engine, restoredRevision);
    return {
      engine: runtime.engine,
      projectPath: request.projectPath,
      provider: session.options.provider,
      revisionClock,
      dispose: disposeSession,
      ...(loaded.readObservability ? { readObservability: loaded.readObservability } : {}),
    };
  } catch (error) {
    if (disposeSession) await disposeSession();
    else await loaded.dispose?.();
    throw error;
  }
};

async function main(): Promise<void> {
  const defaults = defaultRuntimeOwnerPaths(process.env.HOME);
  const leasePath = readFlag("--lease-path") ?? defaults.leasePath;
  const tokenPath = readFlag("--token-path") ?? defaults.tokenPath;
  const ownerId = readFlag("--owner-id");
  const bootId = readFlag("--boot-id");
  const owner = await startPersistentRuntimeOwner({
    rootDir: getSessionStoreRoot(process.env),
    leasePath,
    tokenPath,
    createSession,
    readCacheTelemetry: readRuntimeOwnerCacheTelemetry,
    ...(ownerId ? { ownerId } : {}),
    ...(bootId ? { bootId } : {}),
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await owner.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    // stderr is intentionally attached to /dev/null by the launcher: discovery
    // reports only a bounded status and never echoes provider configuration.
    process.stderr.write(`${error instanceof Error ? error.message : "Runtime owner failed."}\n`);
    process.exitCode = 1;
  });
}
