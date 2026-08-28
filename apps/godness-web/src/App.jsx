import { useState, useSyncExternalStore } from 'react'
import './App.css'

const COPY = {
  en: {
    nav: ['Runs', 'Quality', 'Context', 'Agents & Jobs', 'Artifacts', 'Evolve', 'System'],
    controlRoom: 'Control room', live: 'Live', connecting: 'Connecting', offline: 'Offline',
    noRuns: 'No recorded runs', noRunsHint: 'Start a turn in UncleCode. This view reads the same session and Quality Engine state as the TUI.',
    runDetail: 'Run detail', currentWork: 'Current work', qualityEngine: 'Quality Engine', evidence: 'Evidence',
    model: 'Model', profile: 'Profile', stage: 'Stage', gate: 'Gate', iteration: 'Iteration',
    independent: 'Independent review', verified: 'verified', unproven: 'unproven',
    timeline: 'Execution timeline', graph: 'Work graph', findings: 'Critic findings', history: 'Gate history',
    included: 'Included', excluded: 'Excluded', contextReceipt: 'Context receipt', compacted: 'Compacted',
    agents: 'Agents', jobs: 'Jobs', artifacts: 'Artifacts', proposals: 'Creator proposals', diagnostics: 'External diagnostics',
    pause: 'Interrupt & pause queue', resume: 'Resume queue', cancel: 'Cancel', approve: 'Approve once',
    followUp: 'Queue a follow-up', followUpPlaceholder: 'Add a request after the current turn…', send: 'Queue',
    pending: 'Pending', success: 'Applied', conflict: 'State changed; refresh and try again.', denied: 'Denied by policy.',
    loading: 'Loading runtime state', retry: 'Retry', noData: 'Nothing recorded for this view.',
    runtime: 'Runtime', quality: 'Quality', elapsed: 'Updated', state: 'State', attention: 'Needs attention',
    source: 'Source', hook: 'Hook', error: 'Error', cleanup: 'Cleanup', providerHealth: 'Provider health', pluginHealth: 'Plugin health',
    mergeGuard: 'Main merge and release require human approval.', external: 'External plugin', notReviewed: 'No independent reviewer evidence.',
    fullProjection: 'Full projection', humanGate: 'Human gate', heldOut: 'Held-out benchmark', manual: 'manual', stale: 'stale',
    isolation: 'Isolation', comparison: 'Comparison', candidateHash: 'Candidate hash', attestation: 'Attestation', approval: 'Approval',
    creator: 'Creator', refine: 'Refine', pivot: 'Pivot', worktree: 'worktree',
    statuses: { idle: 'idle', running: 'running', paused: 'interrupted / queue paused', requires_action: 'requires action', completed: 'completed', failed: 'failed', cancelled: 'cancelled', queued: 'queued', blocked: 'blocked', unknown: 'unknown' },
    gates: { proceed: 'proceed', refine: 'refine', pivot: 'pivot', block: 'block', unproven: 'unproven' },
    stages: { explore: 'explore', plan: 'plan', work: 'work', critic: 'critic', promote: 'promote' },
    phases: { plan: 'plan', do: 'do', check: 'check', act: 'act' },
    roles: { planner: 'planner', worker: 'worker', critic: 'critic', promoter: 'promoter' },
    proposalStates: { evaluating: 'evaluating', 'pr-ready': 'PR-ready' },
  },
  ko: {
    nav: ['실행', '품질', '컨텍스트', '에이전트와 작업', '산출물', '개선', '시스템'],
    controlRoom: '관제실', live: '연결됨', connecting: '연결 중', offline: '오프라인',
    noRuns: '기록된 실행이 없습니다', noRunsHint: 'UncleCode에서 작업을 시작하세요. TUI와 동일한 세션·Quality Engine 상태를 읽습니다.',
    runDetail: '실행 상세', currentWork: '현재 작업', qualityEngine: 'Quality Engine', evidence: '증거',
    model: '모델', profile: '프로필', stage: '단계', gate: '게이트', iteration: '반복',
    independent: '독립 검토', verified: '검증됨', unproven: '미입증',
    timeline: '실행 타임라인', graph: '작업 그래프', findings: '검토 지적', history: '게이트 이력',
    included: '포함', excluded: '제외', contextReceipt: '컨텍스트 영수증', compacted: '압축됨',
    agents: '에이전트', jobs: '작업', artifacts: '산출물', proposals: 'Creator 제안', diagnostics: '외부 진단',
    pause: '중단하고 대기열 정지', resume: '대기열 재개', cancel: '취소', approve: '이번만 승인',
    followUp: '후속 요청 대기열', followUpPlaceholder: '현재 작업 이후에 실행할 요청…', send: '추가',
    pending: '처리 중', success: '적용됨', conflict: '상태가 변경되었습니다. 새로고침 후 다시 시도하세요.', denied: '정책에 의해 거부되었습니다.',
    loading: '런타임 상태를 불러오는 중', retry: '다시 시도', noData: '이 화면에 기록된 항목이 없습니다.',
    runtime: '런타임', quality: '품질', elapsed: '갱신', state: '상태', attention: '확인 필요',
    source: '출처', hook: '훅', error: '오류', cleanup: '정리', providerHealth: '공급자 상태', pluginHealth: '플러그인 상태',
    mergeGuard: '기본 브랜치 병합과 릴리스는 사람 승인이 필요합니다.', external: '외부 플러그인', notReviewed: '독립 검토자 증거가 없습니다.',
    fullProjection: '전체 투영', humanGate: '사람 승인', heldOut: '미공개 벤치마크', manual: '수동', stale: '만료됨',
    isolation: '격리', comparison: '비교', candidateHash: '후보 해시', attestation: '검증', approval: '승인',
    creator: '개선 후보', refine: '개선', pivot: '재계획', worktree: '격리 작업공간',
    statuses: { idle: '대기', running: '실행 중', paused: '작업 중단 / 대기열 정지', requires_action: '응답 필요', completed: '완료', failed: '실패', cancelled: '취소됨', queued: '대기열', blocked: '차단됨', unknown: '알 수 없음' },
    gates: { proceed: '진행', refine: '개선', pivot: '재계획', block: '차단', unproven: '미입증' },
    stages: { explore: '탐색', plan: '계획', work: '구현', critic: '독립 검증', promote: '정리' },
    phases: { plan: '계획', do: '실행', check: '검증', act: '개선' },
    roles: { planner: '계획자', worker: '작업자', critic: '검토자', promoter: '정리 담당' },
    proposalStates: { evaluating: '평가 중', 'pr-ready': 'PR 준비됨' },
  },
}

const VIEW_IDS = ['Runs', 'Quality', 'Context', 'Agents & Jobs', 'Artifacts', 'Evolve', 'System']

function Status({ value, copy }) {
  return <span className={`status status--${String(value).replaceAll('_', '-')}`}><span className="status__dot" />{copy.statuses[value] ?? value}</span>
}

function Empty({ title, detail }) {
  return <div className="empty"><span className="empty__rule" /><h2>{title}</h2><p>{detail}</p></div>
}

function Skeleton({ copy }) {
  return <main className="shell shell--loading" aria-busy="true" aria-label={copy.loading}><div className="rail skeleton" /><div className="run-list skeleton" /><div className="workspace"><div className="skeleton skeleton--title" /><div className="skeleton skeleton--line" /><div className="skeleton skeleton--plane" /></div></main>
}

function ActionFeedback({ action, copy }) {
  if (!action) return null
  const label = action.status === 'pending' ? copy.pending : action.status === 'success' ? copy.success : action.status === 'conflict' ? copy.conflict : action.status === 'denied' ? copy.denied : action.message
  return <p className={`action-feedback action-feedback--${action.status}`} role="status">{label}</p>
}

function Metric({ label, value, mono = false }) {
  return <div className="metric"><span>{label}</span><strong className={mono ? 'mono' : ''}>{value}</strong></div>
}

function RunList({ runs, selectedId, onSelect, copy }) {
  return <aside className="run-list" aria-label={copy.nav[0]}>
    <header><span className="eyebrow">{copy.nav[0]}</span><strong className="mono">{runs.length}</strong></header>
    <div className="run-list__items">
      {runs.map(run => <button className={`run-row ${run.id === selectedId ? 'run-row--active' : ''}`} key={run.id} onClick={() => onSelect(run.id)}>
        <span className="run-row__top"><span className="run-row__project">{run.project}</span><Status value={run.state} copy={copy} /></span>
        <span className="run-row__id mono">{run.id}</span>
        <span className="run-row__quality"><span>{run.quality.profile}</span><span>{copy.stages[run.quality.stage] ?? run.quality.stage}</span><span className={`gate gate--${run.quality.gate}`}>{copy.gates[run.quality.gate] ?? run.quality.gate}</span></span>
      </button>)}
    </div>
  </aside>
}

function Timeline({ run, copy }) {
  const nodes = run.graph.nodes.length ? run.graph.nodes : run.quality.history
  return <section className="plane"><div className="section-title"><div><span className="eyebrow">{copy.currentWork}</span><h2>{run.graph.nodes.length ? copy.graph : copy.timeline}</h2></div><span className="mono subtle">{nodes.length}</span></div>
    {nodes.length === 0 ? <p className="muted">{copy.noData}</p> : <ol className="timeline">{nodes.map((node, index) => <li key={node.id ?? `${node.event}-${index}`}>
      <span className={`timeline__rail timeline__rail--${node.status ?? node.decision ?? 'completed'}`} />
      <div><span className="timeline__title">{node.title ?? node.event ?? (copy.stages[node.stage] ?? node.stage)}</span><span className="timeline__meta">{copy.roles[node.role] ?? node.role ?? (copy.stages[node.stage] ?? node.stage)} · {copy.statuses[node.status] ?? copy.gates[node.decision] ?? node.status ?? node.decision}</span></div>
      <span className="mono timeline__attempt">{node.attempt ? `#${node.attempt}` : ''}</span>
    </li>)}</ol>}
  </section>
}

function QualityView({ run, copy }) {
  const q = run.quality
  if (!q.recorded) return <Empty title={copy.noData} detail={copy.notReviewed} />
  return <div className="view-stack">
    <section className="quality-band"><div><span className="eyebrow">Quality Engine (SCC)</span><h2>{q.profile} / {copy.stages[q.stage] ?? q.stage}</h2><p>{q.independentVerification ? copy.verified : copy.notReviewed}</p></div><div className={`gate-display gate-display--${q.gate}`}><span>{copy.gate}</span><strong>{copy.gates[q.gate] ?? q.gate}</strong></div></section>
    <div className="metrics"><Metric label={copy.iteration} value={q.iteration} mono /><Metric label="PDCA" value={copy.phases[q.phase] ?? q.phase} /><Metric label={copy.refine} value={q.refineCount} mono /><Metric label={copy.pivot} value={q.pivotCount} mono /></div>
    <section className="plane"><div className="section-title"><h2>{copy.findings}</h2></div>{q.findings.length ? <ul className="finding-list">{q.findings.map((finding, i) => <li key={i}>{finding}</li>)}</ul> : <p className="muted">{copy.noData}</p>}</section>
    <section className="plane"><div className="section-title"><h2>{copy.history}</h2></div><div className="history-table">{q.history.map((entry, i) => <div key={i}><span>{copy.stages[entry.stage] ?? entry.stage}</span><strong>{copy.gates[entry.decision] ?? entry.decision}</strong><span className="mono">{entry.artifactHash ?? '—'}</span></div>)}</div></section>
  </div>
}

function SourceList({ title, items, emptyLabel }) {
  return <section className="source-column"><div className="section-title"><h2>{title}</h2><span className="mono subtle">{items.length}</span></div>{items.length ? <ul>{items.map(item => <li key={item.id}><div><strong>{item.label}</strong><span>{item.reason}</span></div><span className="mono">{item.tokenEstimate ?? '—'}</span></li>)}</ul> : <p className="muted">{emptyLabel}</p>}</section>
}

function ContextView({ run, copy }) {
  return <div className="context-grid"><SourceList title={copy.included} items={run.context.included} emptyLabel={copy.noData} /><SourceList title={copy.excluded} items={run.context.excluded} emptyLabel={copy.noData} /><section className="context-receipt"><span className="eyebrow">{copy.contextReceipt}</span><strong className="mono">{run.context.receiptId ?? '—'}</strong><p>{run.context.compacted ? copy.compacted : copy.fullProjection}</p></section></div>
}

function AgentRows({ title, rows, emptyLabel, copy }) {
  return <section className="plane"><div className="section-title"><h2>{title}</h2><span className="mono subtle">{rows.length}</span></div>{rows.length ? <div className="data-rows">{rows.map((row, i) => <div key={row.id ?? i}><strong>{row.displayName ?? row.label ?? row.id}</strong><Status value={row.status ?? 'unknown'} copy={copy} /><span>{row.currentActivity ?? row.type ?? '—'}</span><span className="mono">{row.model ?? row.agentRunId ?? '—'}</span></div>)}</div> : <p className="muted">{emptyLabel}</p>}</section>
}

function AgentsView({ run, copy }) {
  return <div className="view-stack"><AgentRows title={copy.agents} rows={run.agents} emptyLabel={copy.noData} copy={copy} /><AgentRows title={copy.jobs} rows={run.jobs} emptyLabel={copy.noData} copy={copy} /></div>
}

function ArtifactsView({ run, copy }) {
  return <section className="plane"><div className="section-title"><h2>{copy.artifacts}</h2><span className="mono subtle">{run.artifacts.length}</span></div>{run.artifacts.length ? <div className="artifact-list">{run.artifacts.map(item => <div key={item.ref}><span className="artifact-list__mark" /><div><strong className="mono">{item.ref}</strong><span>{item.verified ? copy.verified : item.stale ? copy.stale : copy.unproven}</span></div><span className="mono">{item.hash ?? '—'}</span></div>)}</div> : <p className="muted">{copy.noData}</p>}</section>
}

function EvolveView({ run, copy }) {
  return <div className="view-stack">
    <section className="quality-band"><div><span className="eyebrow">{copy.creator}</span><h2>{copy.proposals}</h2><p>{copy.mergeGuard}</p></div><span className="guard-label">{copy.humanGate}</span></section>
    {run.evolve.length ? run.evolve.map((proposal, i) => {
      const comparison = proposal.comparison
      const candidateHash = proposal.hashes?.candidateArtifact ?? proposal.hashes?.patch ?? proposal.hashes?.candidateCommit ?? '—'
      const attested = proposal.attestation?.branchExists === true && proposal.attestation?.worktreeExists === true
      const evidenceLabel = proposal.stale ? 'stale' : 'verified'
      return <section className="plane" key={proposal.id ?? i}>
        <div className="section-title"><div><span className="eyebrow">{proposal.candidateId ?? proposal.id}</span><h2>{copy.proposalStates[proposal.state] ?? proposal.state}{proposal.stale ? ` · ${copy.stale}` : ''}</h2></div><span className="guard-label">{proposal.humanApproval ?? copy.manual}</span></div>
        <div className="history-table">
          <div><span>{copy.isolation}</span><strong>{proposal.isolation === 'worktree' ? copy.worktree : proposal.isolation ?? '—'}</strong><span className="mono">{proposal.isolatedBranch ?? '—'}</span></div>
          <div><span>{copy.comparison}</span><strong>{proposal.heldOutBenchmark === true ? copy.heldOut : copy.unproven}</strong><span className="mono">{comparison ? `${comparison.baselineScore} → ${comparison.candidateScore} (Δ ${comparison.delta})` : '—'}</span></div>
          <div><span>{copy.candidateHash}</span><strong>{copy[evidenceLabel]}</strong><span className="mono">{candidateHash}</span></div>
          <div><span>{copy.attestation}</span><strong>{attested ? copy[evidenceLabel] : copy.unproven}</strong><span className="mono">{proposal.attestorId ?? '—'} · {proposal.attestation?.timestamp ?? '—'}</span></div>
          <div><span>{copy.approval}</span><strong>{proposal.humanApproval ?? '—'}</strong><span>{proposal.mergeRequiresHumanApproval === true ? copy.mergeGuard : copy.unproven}</span></div>
          <div><span>{copy.cleanup}</span><strong>{proposal.cleanup?.status ?? '—'}</strong><span className="mono">{proposal.cleanup?.resources?.length ?? 0}</span></div>
        </div>
      </section>
    }) : <Empty title={copy.noData} detail={copy.mergeGuard} />}
  </div>
}

function SystemView({ run, projection, copy }) {
  const diagnostics = run.system.diagnostics
  return <div className="view-stack"><div className="metrics"><Metric label={copy.providerHealth} value={projection.system?.providers?.length ?? 0} mono /><Metric label={copy.pluginHealth} value={projection.system?.plugins?.length ?? 0} mono /><Metric label={copy.cleanup} value={projection.system?.cleanup?.length ?? 0} mono /></div><section className="plane"><div className="section-title"><h2>{copy.diagnostics}</h2><span className="mono subtle">{diagnostics.length}</span></div>{diagnostics.length ? <div className="diagnostics">{diagnostics.map(item => <div key={item.dedupeKey}><span className="external-label">{copy.external}</span><div><strong>{item.pluginId}</strong><span>{copy.source} · {item.source} / {item.trust}</span><span>{copy.hook} · {item.hook}</span><span className="diagnostic-error">{copy.error} · {item.error}</span></div><span className="mono">{item.dedupeKey}</span></div>)}</div> : <p className="muted">{copy.noData}</p>}</section></div>
}

function MainView({ view, run, projection, copy }) {
  if (view === 'Quality') return <QualityView run={run} copy={copy} />
  if (view === 'Context') return <ContextView run={run} copy={copy} />
  if (view === 'Agents & Jobs') return <AgentsView run={run} copy={copy} />
  if (view === 'Artifacts') return <ArtifactsView run={run} copy={copy} />
  if (view === 'Evolve') return <EvolveView run={run} copy={copy} />
  if (view === 'System') return <SystemView run={run} projection={projection} copy={copy} />
  return <Timeline run={run} copy={copy} />
}

export default function App({ store }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [view, setView] = useState('Runs')
  const [selectedId, setSelectedId] = useState(null)
  const [followUp, setFollowUp] = useState('')
  const runs = snapshot.data?.runs ?? []
  const run = runs.find(item => item.id === selectedId) ?? runs[0]
  const browserLocale = globalThis.navigator?.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en'
  const locale = run?.locale === 'ko' ? 'ko' : run?.locale === 'en' ? 'en' : browserLocale
  const copy = COPY[locale]

  if (snapshot.status === 'idle' || snapshot.status === 'loading') return <Skeleton copy={copy} />
  if (snapshot.status === 'error' && !snapshot.data) return <div className="fatal"><span className="brand-mark">UC</span><h1>{copy.controlRoom}</h1><p>{snapshot.error}</p><button onClick={() => store.refresh()}>{copy.retry}</button></div>
  if (!run) return <div className="empty-shell"><header><span className="brand-mark">UC</span><span>UncleCode / {copy.controlRoom}</span></header><Empty title={copy.noRuns} detail={copy.noRunsHint} /></div>

  const action = snapshot.actions[run.id]
  const pending = action?.status === 'pending'
  const doAction = (name, payload) => store.action(run.id, name, run.revision, payload)
  const submitFollowUp = event => {
    event.preventDefault()
    const message = followUp.trim()
    if (!message) return
    void doAction('follow-up', { message }).then(result => { if (result.ok) setFollowUp('') })
  }

  return <main className="shell">
    <nav className="rail" aria-label={copy.controlRoom}>
      <div className="brand-mark" aria-label="UncleCode">UC</div>
      <div className="rail__nav">{VIEW_IDS.map((id, index) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)} title={copy.nav[index]}><span>{String(index + 1).padStart(2, '0')}</span><strong>{copy.nav[index]}</strong></button>)}</div>
      <div className={`connection connection--${snapshot.connection}`}><span />{snapshot.connection === 'live' ? copy.live : snapshot.connection === 'connecting' ? copy.connecting : copy.offline}</div>
    </nav>
    <RunList runs={runs} selectedId={run.id} onSelect={id => { setSelectedId(id); store.selectSession?.(id) }} copy={copy} />
    <section className="workspace">
      <header className="workspace__header"><div><span className="eyebrow">{copy.runDetail} / <span className="mono">{run.id}</span></span><h1>{run.project}</h1><div className="run-meta"><Status value={run.state} copy={copy} /><span>{run.model}</span><span>{run.quality.profile}</span><span className={`gate gate--${run.quality.gate}`}>{copy.gates[run.quality.gate] ?? run.quality.gate}</span></div></div><div className="controls"><button disabled={pending || run.state !== 'running'} onClick={() => void doAction('pause')}>{copy.pause}</button><button disabled={pending || run.state !== 'paused'} onClick={() => void doAction('resume')}>{copy.resume}</button>{run.state === 'requires_action' && <button className="control--accent" disabled={pending} onClick={() => void doAction('approve', { decision: 'approve_once' })}>{copy.approve}</button>}<button className="control--danger" disabled={pending || ['completed', 'failed', 'cancelled'].includes(run.state)} onClick={() => void doAction('cancel')}>{copy.cancel}</button></div></header>
      <ActionFeedback action={action} copy={copy} />
      {snapshot.error && <p className="inline-error" role="alert">{snapshot.error}</p>}
      <div className="workspace__body"><div className="workspace__main"><MainView view={view} run={run} projection={snapshot.data} copy={copy} /></div><aside className="evidence-rail"><span className="eyebrow">{run.quality.recorded ? copy.qualityEngine : copy.noData}</span><div className="evidence-rail__gate"><strong>{copy.gates[run.quality.gate] ?? run.quality.gate}</strong><span>{run.quality.profile} · {copy.stages[run.quality.stage] ?? run.quality.stage}</span></div><Metric label="PDCA" value={copy.phases[run.quality.phase] ?? run.quality.phase} /><Metric label={copy.iteration} value={run.quality.iteration} mono /><Metric label={copy.independent} value={run.quality.independentVerification ? copy.verified : copy.unproven} /><div className="evidence-list"><span>{copy.evidence}</span>{run.artifacts.slice(0, 4).map(item => <code key={item.ref}>{item.hash ?? item.ref}</code>)}</div>{run.attentionReason && <p className="attention"><strong>{copy.attention}</strong>{run.attentionReason}</p>}</aside></div>
      <form className="follow-up" onSubmit={submitFollowUp}><label htmlFor="follow-up">{copy.followUp}</label><div><input id="follow-up" value={followUp} onChange={event => setFollowUp(event.target.value)} placeholder={copy.followUpPlaceholder} disabled={pending} /><button className="control--accent" disabled={pending || !followUp.trim()}>{copy.send}</button></div></form>
    </section>
  </main>
}
