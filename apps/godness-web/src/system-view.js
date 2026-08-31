const BOUNDS = Object.freeze({
  providers: 32,
  mcpServers: 64,
  pluginHosts: 64,
  pluginsPerHost: 64,
  resourceTypes: 32,
  cleanup: 128,
  caches: 32,
})

const SAFE_IDENTITY = /^[A-Za-z0-9._:-]{1,160}$/
const AUTHENTICATION = new Set(['authenticated', 'missing', 'unverified'])
const LIVE_PROBES = new Set(['passed', 'failed', 'not-run'])

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function boundedText(value, max = 160) {
  if (typeof value !== 'string') return ''
  const redacted = value
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, match => `${match.split(/[=:]/, 1)[0]}=[REDACTED]`)
    .replace(/\b(?:sk|ghp|xoxb)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/(?:^|\s)(?:\.{0,2}\/|[A-Za-z]:\\)[^\s,;]+/g, ' [PATH]')
    .trim()
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted
}

function sourceStatus(value) {
  return value === 'available' ? 'available' : 'unavailable'
}

function authentication(value) {
  return AUTHENTICATION.has(value) ? value : 'unverified'
}

function liveProbe(value) {
  return LIVE_PROBES.has(value) ? value : 'not-run'
}

function evidenceRow(value, kind) {
  const item = record(value)
  const name = boundedText(kind === 'provider' ? item.provider : item.name)
  if (!name) return null
  return {
    name,
    detail: boundedText(kind === 'provider' ? item.model : item.transport),
    configured: item.configured === true,
    authentication: authentication(item.authentication),
    liveProbe: liveProbe(item.liveProbe),
    observedAt: count(item.observedAt),
  }
}

function pluginHost(value, index) {
  const host = record(value)
  const status = host.status === 'disposing' || host.status === 'disposed' ? host.status : 'active'
  const registrations = Array.isArray(host.registrations)
    ? host.registrations.slice(0, BOUNDS.pluginsPerHost).flatMap(candidate => {
        const registration = record(candidate)
        const name = boundedText(registration.name)
        if (!name) return []
        return [{
          name,
          source: boundedText(registration.source, 32),
          trustLane: boundedText(registration.trustLane, 40),
          hookCount: count(registration.hookCount),
        }]
      })
    : []
  return {
    id: `host-${index + 1}`,
    status,
    registrationCount: count(host.registrationCount),
    pendingCleanupCount: count(host.pendingCleanupCount),
    registrations,
    truncated: host.truncated === true || count(host.registrationCount) > registrations.length,
  }
}

export function normalizeSystemProjection(value) {
  const system = record(value)
  const evidenceSources = record(system.evidenceSources)
  const memory = record(system.memory)
  const resources = record(system.resources)
  const journal = record(system.journal)
  const engines = record(system.engines)

  return {
    evidenceSources: {
      owner: sourceStatus(evidenceSources.owner),
      cacheTelemetry: sourceStatus(evidenceSources.cacheTelemetry),
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
      byType: (Array.isArray(resources.byType) ? resources.byType : [])
        .slice(0, BOUNDS.resourceTypes)
        .flatMap(candidate => {
          const item = record(candidate)
          const type = boundedText(item.type, 120)
          return type ? [{ type, count: count(item.count) }] : []
        }),
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
    providers: (Array.isArray(system.providers) ? system.providers : [])
      .slice(0, BOUNDS.providers)
      .flatMap(candidate => evidenceRow(candidate, 'provider') ?? []),
    mcpServers: (Array.isArray(system.mcpServers) ? system.mcpServers : [])
      .slice(0, BOUNDS.mcpServers)
      .flatMap(candidate => evidenceRow(candidate, 'mcp') ?? []),
    pluginHosts: (Array.isArray(system.pluginHosts) ? system.pluginHosts : [])
      .slice(0, BOUNDS.pluginHosts)
      .map(pluginHost),
    cleanup: (Array.isArray(system.cleanup) ? system.cleanup : [])
      .slice(-BOUNDS.cleanup)
      .flatMap(candidate => {
        const item = record(candidate)
        if (!['runtime-session', 'plugin-host', 'mcp-profile'].includes(item.kind)) return []
        if (!['pending', 'completed', 'failed'].includes(item.status)) return []
        return [{
          kind: item.kind,
          identity: typeof item.identity === 'string' && SAFE_IDENTITY.test(item.identity) ? item.identity : '[REDACTED]',
          status: item.status,
          recordedAt: count(item.recordedAt),
        }]
      }),
    caches: (Array.isArray(system.caches) ? system.caches : [])
      .slice(0, BOUNDS.caches)
      .map(candidate => {
        const item = record(candidate)
        const hits = count(item.hits)
        const misses = count(item.misses)
        return {
          name: boundedText(item.name, 120) || 'cache',
          hits,
          misses,
          hitRate: hits + misses > 0 ? hits / (hits + misses) : 0,
          currentSize: count(item.currentSize),
          maxEntries: count(item.maxEntries),
          retainedBytesEstimate: count(item.retainedBytesEstimate),
          maxRetainedBytes: count(item.maxRetainedBytes),
        }
      }),
  }
}

export function deriveSystemHealth(system) {
  if (system.evidenceSources.owner !== 'available') {
    return { overall: 'unavailable', owner: 'unavailable', reasons: ['owner'] }
  }
  const reasons = []
  if (system.evidenceSources.cacheTelemetry !== 'available') reasons.push('cacheTelemetry')
  if (system.engines.observabilityCallbackFailures > 0) reasons.push('callbacks')
  if (system.engines.mcpConfigurationUnavailableObserved > 0) reasons.push('mcpConfiguration')
  if (system.providers.some(item => !item.configured || item.authentication === 'missing' || item.liveProbe === 'failed')) reasons.push('providers')
  if (system.mcpServers.some(item => !item.configured || item.authentication === 'missing' || item.liveProbe === 'failed')) reasons.push('mcpServers')
  if (system.pluginHosts.some(item => item.status !== 'active' || item.pendingCleanupCount > 0)) reasons.push('pluginHosts')
  if (system.cleanup.some(item => item.status === 'failed')) reasons.push('cleanup')
  return { overall: reasons.length ? 'degraded' : 'available', owner: 'available', reasons }
}

export function formatBytes(value) {
  const bytes = count(value)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

export function resolveControlRoomView(view, hasRun) {
  return hasRun ? view : 'System'
}
