import { redactRuntimeDiagnostic } from "./runtime-error-redaction.js";

const MAX_SYSTEM_TEXT = 160;

export const SYSTEM_OBSERVABILITY_BOUNDS = Object.freeze({
  activeResourceTypes: 32,
  engineSessions: 256,
  providers: 32,
  mcpServers: 64,
  pluginHosts: 64,
  pluginsPerHost: 64,
  cleanup: 128,
  caches: 32,
  cacheSources: 32,
});

export type RuntimeEvidenceAuthentication = "authenticated" | "missing" | "unverified";
export type RuntimeLiveProbeStatus = "passed" | "failed" | "not-run";
export type RuntimeEvidenceSourceStatus = "available" | "unavailable";

export type RuntimeProviderEvidence = {
  readonly provider: string;
  readonly model: string;
  readonly configured: boolean;
  readonly authentication: RuntimeEvidenceAuthentication;
  readonly liveProbe: RuntimeLiveProbeStatus;
  readonly observedAt: number;
};

export type RuntimeMcpServerEvidence = {
  readonly name: string;
  readonly transport: "stdio" | "http" | "sse" | "sse-ide" | "ws" | "sdk" | "claudeai-proxy";
  readonly configured: boolean;
  readonly authentication: RuntimeEvidenceAuthentication;
  readonly liveProbe: RuntimeLiveProbeStatus;
  readonly observedAt: number;
};

export type RuntimePluginRegistrationEvidence = {
  readonly name: string;
  readonly source: "memory" | "workspace" | "cached" | "builtin";
  readonly trustLane: "host-provided" | "workspace-trusted" | "cached-external" | "builtin-trusted";
  readonly hookCount: number;
};

export type RuntimePluginLifecycleEvidence = {
  readonly status: "active" | "disposing" | "disposed";
  readonly registrationCount: number;
  readonly pendingCleanupCount: number;
  readonly registrations: readonly RuntimePluginRegistrationEvidence[];
  readonly truncated: boolean;
};

export type RuntimePluginHostEvidence = RuntimePluginLifecycleEvidence & {
  readonly sessionId: string;
};

export type RuntimeSessionObservabilitySource = {
  readonly provider?: RuntimeProviderEvidence | undefined;
  readonly mcpServers?: readonly RuntimeMcpServerEvidence[] | undefined;
  readonly mcpConfigurationStatus?: RuntimeEvidenceSourceStatus | undefined;
  readonly plugins?: RuntimePluginLifecycleEvidence | undefined;
};

export type RuntimeCleanupEvidence = {
  readonly kind: "runtime-session" | "plugin-host" | "mcp-profile";
  readonly identity: string;
  readonly status: "pending" | "completed" | "failed";
  readonly recordedAt: number;
};

export type RuntimeCacheTelemetrySnapshot = {
  readonly name: string;
  readonly hits: number;
  readonly misses: number;
  readonly hitRate?: number;
  readonly evictions: number;
  readonly byteEvictions: number;
  readonly invalidations: number;
  readonly currentSize: number;
  readonly maxEntries: number;
  readonly maxRetainedBytes: number;
  readonly retainedBytesEstimate: number;
};

export type RuntimeCacheTelemetrySourceEvidence = {
  readonly name: string;
  readonly status: RuntimeEvidenceSourceStatus;
  readonly failureCount: number;
};

export type RuntimeCacheTelemetryReport = {
  readonly caches: readonly RuntimeCacheTelemetrySnapshot[];
  readonly sources: readonly RuntimeCacheTelemetrySourceEvidence[];
  readonly sourceFailures?: number | undefined;
  readonly projectionFailures?: number | undefined;
  readonly truncated?: boolean | undefined;
};

export type RuntimeCacheTelemetryReadResult =
  | RuntimeCacheTelemetryReport
  | readonly RuntimeCacheTelemetrySnapshot[];

export type RuntimeSystemObservabilitySource = {
  readonly evidenceSources?: {
    readonly owner: RuntimeEvidenceSourceStatus;
    readonly cacheTelemetry: RuntimeEvidenceSourceStatus;
  } | undefined;
  readonly memory?: {
    readonly rssBytes: number;
    readonly heapTotalBytes: number;
    readonly heapUsedBytes: number;
    readonly externalBytes: number;
    readonly arrayBuffersBytes: number;
  } | undefined;
  readonly resources?: {
    readonly activeCount: number;
    readonly byType: readonly { readonly type: string; readonly count: number }[];
    readonly userCpuMicros: number;
    readonly systemCpuMicros: number;
    readonly maxRssKilobytes: number;
  } | undefined;
  readonly journal?: {
    readonly retainedEvents: number;
    readonly activeSubscriptions: number;
    readonly subscriberSessions: number;
    readonly replayWatermarks: number;
  } | undefined;
  readonly engines?: {
    readonly attachedSessions: number;
    readonly activeMutationsObserved: number;
    readonly pendingCreations: number;
    readonly pendingTeardowns: number;
    readonly clientLeaseProtectedSessionsObserved: number;
    readonly teardownFailuresRetained: number;
    readonly observedSessions: number;
    readonly scanTruncated: boolean;
    readonly cleanupEntriesDropped: number;
    readonly unlistedPendingTeardowns: number;
    readonly observabilityCallbackFailures: number;
    readonly mcpConfigurationUnavailableObserved: number;
  } | undefined;
  readonly providers?: readonly RuntimeProviderEvidence[] | undefined;
  readonly mcpServers?: readonly RuntimeMcpServerEvidence[] | undefined;
  readonly pluginHosts?: readonly RuntimePluginHostEvidence[] | undefined;
  readonly cleanup?: readonly RuntimeCleanupEvidence[] | undefined;
  readonly caches?: readonly RuntimeCacheTelemetrySnapshot[] | undefined;
  readonly cacheTelemetry?: Omit<RuntimeCacheTelemetryReport, "caches"> | undefined;
};

export type ControlRoomSystemProjection = Required<RuntimeSystemObservabilitySource>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max = MAX_SYSTEM_TEXT): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return redactRuntimeDiagnostic(text, max);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function timestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function authentication(value: unknown): RuntimeEvidenceAuthentication {
  return value === "authenticated" || value === "missing" ? value : "unverified";
}

function liveProbe(value: unknown): RuntimeLiveProbeStatus {
  return value === "passed" || value === "failed" ? value : "not-run";
}

function projectProvider(value: unknown): RuntimeProviderEvidence | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
  return {
    provider: boundedText(value.provider),
    model: boundedText(value.model),
    configured: value.configured === true,
    authentication: authentication(value.authentication),
    liveProbe: liveProbe(value.liveProbe),
    observedAt: timestamp(value.observedAt),
  };
}

function projectMcpServer(value: unknown): RuntimeMcpServerEvidence | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const transport = value.transport;
  if (transport !== "stdio" && transport !== "http" && transport !== "sse" && transport !== "sse-ide"
    && transport !== "ws" && transport !== "sdk" && transport !== "claudeai-proxy") return undefined;
  return {
    name: boundedText(value.name),
    transport,
    configured: value.configured === true,
    authentication: authentication(value.authentication),
    liveProbe: liveProbe(value.liveProbe),
    observedAt: timestamp(value.observedAt),
  };
}

function projectPluginRegistration(value: unknown): RuntimePluginRegistrationEvidence | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const source = value.source;
  const trustLane = value.trustLane;
  if (source !== "memory" && source !== "workspace" && source !== "cached" && source !== "builtin") return undefined;
  if (trustLane !== "host-provided" && trustLane !== "workspace-trusted"
    && trustLane !== "cached-external" && trustLane !== "builtin-trusted") return undefined;
  return {
    name: boundedText(value.name),
    source,
    trustLane,
    hookCount: count(value.hookCount),
  };
}

function projectPluginHost(value: unknown): RuntimePluginHostEvidence | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string") return undefined;
  const status = value.status === "disposing" || value.status === "disposed" ? value.status : "active";
  const registrations = Array.isArray(value.registrations)
    ? value.registrations.slice(0, SYSTEM_OBSERVABILITY_BOUNDS.pluginsPerHost)
        .map(projectPluginRegistration)
        .filter((item): item is RuntimePluginRegistrationEvidence => item !== undefined)
    : [];
  return {
    sessionId: boundedText(value.sessionId),
    status,
    registrationCount: count(value.registrationCount),
    pendingCleanupCount: count(value.pendingCleanupCount),
    registrations,
    truncated: value.truncated === true || count(value.registrationCount) > registrations.length,
  };
}

function projectCleanup(value: unknown): RuntimeCleanupEvidence | undefined {
  if (!isRecord(value) || typeof value.identity !== "string") return undefined;
  const kind = value.kind;
  const status = value.status;
  if (kind !== "runtime-session" && kind !== "plugin-host" && kind !== "mcp-profile") return undefined;
  if (status !== "pending" && status !== "completed" && status !== "failed") return undefined;
  return { kind, identity: boundedText(value.identity), status, recordedAt: timestamp(value.recordedAt) };
}

function telemetryCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function projectCaches(value: unknown): {
  readonly values: readonly RuntimeCacheTelemetrySnapshot[];
  readonly failures: number;
  readonly truncated: boolean;
} {
  if (!Array.isArray(value)) {
    return { values: [], failures: value === undefined ? 0 : 1, truncated: false };
  }
  let failures = 0;
  const values = value.slice(0, SYSTEM_OBSERVABILITY_BOUNDS.caches).flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || candidate.name.length === 0) {
      failures += 1;
      return [];
    }
    const hits = telemetryCount(candidate.hits);
    const misses = telemetryCount(candidate.misses);
    const evictions = telemetryCount(candidate.evictions);
    const byteEvictions = telemetryCount(candidate.byteEvictions);
    const invalidations = telemetryCount(candidate.invalidations);
    const currentSize = telemetryCount(candidate.currentSize);
    const maxEntries = telemetryCount(candidate.maxEntries);
    const maxRetainedBytes = telemetryCount(candidate.maxRetainedBytes);
    const retainedBytesEstimate = telemetryCount(candidate.retainedBytesEstimate);
    if (hits === undefined || misses === undefined || evictions === undefined
      || byteEvictions === undefined || invalidations === undefined || currentSize === undefined
      || maxEntries === undefined || maxRetainedBytes === undefined || retainedBytesEstimate === undefined) {
      failures += 1;
      return [];
    }
    const lookups = hits + misses;
    return [{
      name: boundedText(candidate.name, 120),
      hits,
      misses,
      hitRate: lookups > 0 ? hits / lookups : 0,
      evictions,
      byteEvictions,
      invalidations,
      currentSize,
      maxEntries,
      maxRetainedBytes,
      retainedBytesEstimate,
    }];
  });
  return {
    values,
    failures,
    truncated: value.length > SYSTEM_OBSERVABILITY_BOUNDS.caches,
  };
}

function projectCacheSources(value: unknown): {
  readonly values: readonly RuntimeCacheTelemetrySourceEvidence[];
  readonly failures: number;
  readonly truncated: boolean;
} {
  if (!Array.isArray(value)) {
    return { values: [], failures: value === undefined ? 0 : 1, truncated: false };
  }
  let failures = 0;
  const values = value.slice(0, SYSTEM_OBSERVABILITY_BOUNDS.cacheSources).flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || candidate.name.length === 0
      || (candidate.status !== "available" && candidate.status !== "unavailable")) {
      failures += 1;
      return [];
    }
    const failureCount = telemetryCount(candidate.failureCount);
    if (failureCount === undefined) {
      failures += 1;
      return [];
    }
    const projected: RuntimeCacheTelemetrySourceEvidence = {
      name: boundedText(candidate.name, 120),
      status: candidate.status === "available" ? "available" : "unavailable",
      failureCount,
    };
    return [projected];
  });
  return {
    values,
    failures,
    truncated: value.length > SYSTEM_OBSERVABILITY_BOUNDS.cacheSources,
  };
}

export function projectSystemObservability(source: RuntimeSystemObservabilitySource | undefined): ControlRoomSystemProjection {
  const memory: Readonly<Record<string, unknown>> = isRecord(source?.memory) ? source.memory : {};
  const resources: Readonly<Record<string, unknown>> = isRecord(source?.resources) ? source.resources : {};
  const journal: Readonly<Record<string, unknown>> = isRecord(source?.journal) ? source.journal : {};
  const engines: Readonly<Record<string, unknown>> = isRecord(source?.engines) ? source.engines : {};
  const rawCacheTelemetry: Readonly<Record<string, unknown>> = isRecord(source?.cacheTelemetry)
    ? source.cacheTelemetry
    : {};
  const projectedCaches = projectCaches(source?.caches);
  const projectedCacheSources = projectCacheSources(rawCacheTelemetry.sources);
  const inheritedProjectionFailures = count(rawCacheTelemetry.projectionFailures);
  const hasAggregateSourceFailures = rawCacheTelemetry.sourceFailures !== undefined;
  const aggregateSourceFailures = hasAggregateSourceFailures
    ? telemetryCount(rawCacheTelemetry.sourceFailures)
    : undefined;
  const projectionFailures = inheritedProjectionFailures
    + projectedCaches.failures
    + projectedCacheSources.failures
    + (hasAggregateSourceFailures && aggregateSourceFailures === undefined ? 1 : 0);
  const projectedSourceFailures = projectedCacheSources.values.reduce(
    (total, cacheSource) => total + cacheSource.failureCount,
    0,
  );
  const sourceFailures = aggregateSourceFailures === undefined
    ? projectedSourceFailures
    : Math.max(aggregateSourceFailures, projectedSourceFailures);
  const hasExplicitCacheSources = Array.isArray(rawCacheTelemetry.sources);
  const cacheSourcesHealthy = !hasExplicitCacheSources || (
    projectedCacheSources.values.length > 0
    && projectedCacheSources.values.every(item => item.status === "available" && item.failureCount === 0)
  );
  const resourceTypes = Array.isArray(resources.byType)
    ? resources.byType.slice(0, SYSTEM_OBSERVABILITY_BOUNDS.activeResourceTypes).flatMap((candidate: unknown) =>
        isRecord(candidate) && typeof candidate.type === "string"
          ? [{ type: boundedText(candidate.type, 120), count: count(candidate.count) }]
          : [])
    : [];
  return {
    evidenceSources: {
      owner: source?.evidenceSources?.owner === "available" ? "available" : "unavailable",
      cacheTelemetry: source?.evidenceSources?.cacheTelemetry === "available"
        && cacheSourcesHealthy
        && sourceFailures === 0
        && projectionFailures === 0
        && rawCacheTelemetry.truncated !== true
        && !projectedCaches.truncated
        && !projectedCacheSources.truncated
        ? "available"
        : "unavailable",
    },
    memory: {
      rssBytes: count(memory.rssBytes),
      heapTotalBytes: count(memory.heapTotalBytes),
      heapUsedBytes: count(memory.heapUsedBytes),
      externalBytes: count(memory.externalBytes),
      arrayBuffersBytes: count(memory.arrayBuffersBytes),
    },
    resources: {
      activeCount: count(resources.activeCount),
      byType: resourceTypes,
      userCpuMicros: count(resources.userCpuMicros),
      systemCpuMicros: count(resources.systemCpuMicros),
      maxRssKilobytes: count(resources.maxRssKilobytes),
    },
    journal: {
      retainedEvents: count(journal.retainedEvents),
      activeSubscriptions: count(journal.activeSubscriptions),
      subscriberSessions: count(journal.subscriberSessions),
      replayWatermarks: count(journal.replayWatermarks),
    },
    engines: {
      attachedSessions: count(engines.attachedSessions),
      activeMutationsObserved: count(engines.activeMutationsObserved),
      pendingCreations: count(engines.pendingCreations),
      pendingTeardowns: count(engines.pendingTeardowns),
      clientLeaseProtectedSessionsObserved: count(engines.clientLeaseProtectedSessionsObserved),
      teardownFailuresRetained: count(engines.teardownFailuresRetained),
      observedSessions: count(engines.observedSessions),
      scanTruncated: engines.scanTruncated === true,
      cleanupEntriesDropped: count(engines.cleanupEntriesDropped),
      unlistedPendingTeardowns: count(engines.unlistedPendingTeardowns),
      observabilityCallbackFailures: count(engines.observabilityCallbackFailures),
      mcpConfigurationUnavailableObserved: count(engines.mcpConfigurationUnavailableObserved),
    },
    providers: (source?.providers ?? []).slice(0, SYSTEM_OBSERVABILITY_BOUNDS.providers)
      .map(projectProvider).filter((item): item is RuntimeProviderEvidence => item !== undefined),
    mcpServers: (source?.mcpServers ?? []).slice(0, SYSTEM_OBSERVABILITY_BOUNDS.mcpServers)
      .map(projectMcpServer).filter((item): item is RuntimeMcpServerEvidence => item !== undefined),
    pluginHosts: (source?.pluginHosts ?? []).slice(0, SYSTEM_OBSERVABILITY_BOUNDS.pluginHosts)
      .map(projectPluginHost).filter((item): item is RuntimePluginHostEvidence => item !== undefined),
    cleanup: (source?.cleanup ?? []).slice(-SYSTEM_OBSERVABILITY_BOUNDS.cleanup)
      .map(projectCleanup).filter((item): item is RuntimeCleanupEvidence => item !== undefined),
    caches: projectedCaches.values,
    cacheTelemetry: {
      sources: projectedCacheSources.values,
      sourceFailures,
      projectionFailures,
      truncated: rawCacheTelemetry.truncated === true
        || projectedCaches.truncated
        || projectedCacheSources.truncated,
    },
  };
}

export function readRuntimeProcessObservability(): Pick<RuntimeSystemObservabilitySource, "memory" | "resources"> {
  const memory = process.memoryUsage();
  const usage = process.resourceUsage();
  const activeResources = typeof process.getActiveResourcesInfo === "function"
    ? process.getActiveResourcesInfo()
    : [];
  const resourceCounts = new Map<string, number>();
  for (const resource of activeResources) resourceCounts.set(resource, (resourceCounts.get(resource) ?? 0) + 1);
  return {
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
    resources: {
      activeCount: activeResources.length,
      byType: [...resourceCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, SYSTEM_OBSERVABILITY_BOUNDS.activeResourceTypes)
        .map(([type, resourceCount]) => ({ type, count: resourceCount })),
      userCpuMicros: usage.userCPUTime,
      systemCpuMicros: usage.systemCPUTime,
      maxRssKilobytes: usage.maxRSS,
    },
  };
}
