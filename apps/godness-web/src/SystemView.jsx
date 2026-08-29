import React from 'react'
import { deriveSystemHealth, formatBytes, normalizeSystemProjection } from './system-view.js'

function Metric({ label, value }) {
  return <div className="metric"><span>{label}</span><strong className="mono">{value}</strong></div>
}

function EvidenceStatus({ value, copy }) {
  return <span className={`system-status system-status--${value}`}>{copy.systemStatuses[value] ?? value}</span>
}

function EvidenceRows({ title, rows, copy }) {
  return <section className="plane system-section">
    <div className="section-title"><h2>{title}</h2><span className="mono subtle">{rows.length}</span></div>
    {rows.length ? <div className="system-evidence">{rows.map((item, index) => <div key={`${item.name}-${index}`}>
      <div><strong>{item.name}</strong><span className="mono">{item.detail || '—'}</span></div>
      <EvidenceStatus value={item.configured ? 'configured' : 'notConfigured'} copy={copy} />
      <EvidenceStatus value={item.authentication} copy={copy} />
      <EvidenceStatus value={item.liveProbe} copy={copy} />
    </div>)}</div> : <p className="muted">{copy.configuredEmpty}</p>}
  </section>
}

export function SystemView({ projection, run, copy }) {
  const system = normalizeSystemProjection(projection?.system)
  const health = deriveSystemHealth(system)
  const diagnostics = run?.system?.diagnostics ?? []
  const registrations = system.pluginHosts.reduce((total, host) => total + host.registrationCount, 0)

  return <div className="view-stack system-view">
    <section className={`system-summary system-summary--${health.overall}`}>
      <div><span className="eyebrow">{copy.systemOwner}</span><h2>{copy.systemStatuses[health.overall]}</h2><p>{health.reasons.length ? health.reasons.map(reason => copy.systemReasons[reason]).join(' · ') : copy.systemNominal}</p></div>
      <div className="system-summary__sources"><span>{copy.ownerEvidence}<EvidenceStatus value={health.owner} copy={copy} /></span><span>{copy.cacheEvidence}<EvidenceStatus value={system.evidenceSources.cacheTelemetry} copy={copy} /></span></div>
    </section>

    <div className="metrics system-metrics"><Metric label={copy.providerHealth} value={system.providers.length} /><Metric label={copy.mcpHealth} value={system.mcpServers.length} /><Metric label={copy.pluginHosts} value={system.pluginHosts.length} /><Metric label={copy.pluginRegistrations} value={registrations} /></div>
    <div className="system-columns"><EvidenceRows title={copy.providers} rows={system.providers} copy={copy} /><EvidenceRows title={copy.mcpServers} rows={system.mcpServers} copy={copy} /></div>

    <section className="plane system-section">
      <div className="section-title"><h2>{copy.pluginLifecycle}</h2><span className="mono subtle">{system.pluginHosts.length}</span></div>
      {system.pluginHosts.length ? <div className="plugin-hosts">{system.pluginHosts.map(host => <div key={host.id}>
        <div className="plugin-hosts__owner"><strong>{copy.pluginHost} {host.id.split('-')[1]}</strong><EvidenceStatus value={host.status} copy={copy} /></div>
        <span>{copy.pluginRegistrations} · <b className="mono">{host.registrationCount}</b></span>
        <span>{copy.pendingCleanup} · <b className="mono">{host.pendingCleanupCount}</b></span>
        <span>{host.registrations.map(item => `${item.name} · ${item.source}/${item.trustLane} · ${item.hookCount}`).join(', ') || copy.configuredEmpty}{host.truncated ? ` · ${copy.truncated}` : ''}</span>
      </div>)}</div> : <p className="muted">{copy.configuredEmpty}</p>}
    </section>

    <section className="plane system-section">
      <div className="section-title"><h2>{copy.memoryResources}</h2></div>
      <div className="metrics system-metrics"><Metric label="RSS" value={formatBytes(system.memory.rssBytes)} /><Metric label={copy.heapUsed} value={formatBytes(system.memory.heapUsedBytes)} /><Metric label={copy.heapTotal} value={formatBytes(system.memory.heapTotalBytes)} /><Metric label={copy.externalMemory} value={formatBytes(system.memory.externalBytes)} /><Metric label={copy.activeResources} value={system.resources.activeCount} /><Metric label={copy.cpuTime} value={`${Math.round((system.resources.userCpuMicros + system.resources.systemCpuMicros) / 1000)} ms`} /><Metric label={copy.maxRss} value={formatBytes(system.resources.maxRssKilobytes * 1024)} /></div>
      {system.resources.byType.length > 0 && <div className="resource-types">{system.resources.byType.map(item => <span key={item.type}>{item.type}<strong className="mono">{item.count}</strong></span>)}</div>}
    </section>

    <section className="plane system-section">
      <div className="section-title"><h2>{copy.caches}</h2><span className="mono subtle">{system.caches.length}</span></div>
      {system.caches.length ? <div className="cache-rows">{system.caches.map((cache, index) => <div key={`${cache.name}-${index}`}><strong>{cache.name}</strong><span>{copy.hits} <b>{cache.hits}</b> / {copy.misses} <b>{cache.misses}</b></span><span>{copy.hitRate} <b>{Math.round(cache.hitRate * 100)}%</b></span><span>{copy.entries} <b>{cache.currentSize}/{cache.maxEntries || '—'}</b></span><span>{copy.bytes} <b>{formatBytes(cache.retainedBytesEstimate)} / {formatBytes(cache.maxRetainedBytes)}</b></span></div>)}</div> : <p className="muted">{system.evidenceSources.cacheTelemetry === 'available' ? copy.configuredEmpty : copy.sourceUnavailable}</p>}
    </section>

    <div className="system-columns">
      <section className="plane system-section"><div className="section-title"><h2>{copy.engineCounters}</h2></div><div className="counter-list"><Metric label={copy.attachedSessions} value={system.engines.attachedSessions} /><Metric label={copy.observedSessions} value={`${system.engines.observedSessions}${system.engines.scanTruncated ? '+' : ''}`} /><Metric label={copy.activeMutations} value={system.engines.activeMutationsObserved} /><Metric label={copy.clientLeases} value={system.engines.clientLeaseProtectedSessionsObserved} /><Metric label={copy.pendingCreations} value={system.engines.pendingCreations} /><Metric label={copy.pendingTeardowns} value={system.engines.pendingTeardowns} /><Metric label={copy.teardownFailures} value={system.engines.teardownFailuresRetained} /><Metric label={copy.cleanupDropped} value={system.engines.cleanupEntriesDropped} /><Metric label={copy.unlistedTeardowns} value={system.engines.unlistedPendingTeardowns} /><Metric label={copy.callbackFailures} value={system.engines.observabilityCallbackFailures} /><Metric label={copy.mcpUnavailable} value={system.engines.mcpConfigurationUnavailableObserved} /></div></section>
      <section className="plane system-section"><div className="section-title"><h2>{copy.journalCounters}</h2></div><div className="counter-list"><Metric label={copy.retainedEvents} value={system.journal.retainedEvents} /><Metric label={copy.activeSubscriptions} value={system.journal.activeSubscriptions} /><Metric label={copy.subscriberSessions} value={system.journal.subscriberSessions} /><Metric label={copy.replayWatermarks} value={system.journal.replayWatermarks} /></div></section>
    </div>

    <section className="plane system-section">
      <div className="section-title"><h2>{copy.cleanup}</h2><span className="mono subtle">{system.cleanup.length}</span></div>
      {system.cleanup.length ? <div className="cleanup-rows">{system.cleanup.map((item, index) => <div key={`${item.kind}-${item.identity}-${index}`}><strong>{item.kind}</strong><span className="mono">{item.identity}</span><EvidenceStatus value={item.status} copy={copy} /><time className="mono">{item.recordedAt || '—'}</time></div>)}</div> : <p className="muted">{copy.configuredEmpty}</p>}
    </section>

    {diagnostics.length > 0 && <section className="plane system-section"><div className="section-title"><h2>{copy.diagnostics}</h2><span className="mono subtle">{diagnostics.length}</span></div><div className="diagnostics">{diagnostics.map((item, index) => <div key={item.dedupeKey ?? index}><span className="external-label">{copy.external}</span><div><strong>{copy.diagnosticRecorded}</strong><span>{copy.source} · {item.source} / {item.trust}</span></div><span className="mono">#{index + 1}</span></div>)}</div></section>}
  </div>
}
