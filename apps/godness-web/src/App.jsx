import { useState, useSyncExternalStore } from 'react'
import './App.css'
import { evolutionEvidenceLabel } from './evolution-labels.js'
import { canApproveOnce, normalizePendingDecision } from './pending-decision.js'
import { deriveWorkFocus } from './work-focus.js'

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
    pause: 'Pause at safe boundary', resume: 'Resume work', cancel: 'Cancel', approve: 'Approve once',
    followUp: 'Queue a follow-up', followUpPlaceholder: 'Add a request after the current turn…', send: 'Queue',
    steer: 'Steer active agent', steerTarget: 'Agent', steerPlaceholder: 'Give the selected agent a focused correction…', deliver: 'Steer', noSteerTarget: 'No active agent can be steered.',
    currentTask: 'Current task', remainingStage: 'Remaining stage', blocker: 'Blocking reason', optionalDetail: 'Optional detail',
    noBlocker: 'No blocker', closeout: 'Current stage is the final stage', approvalBlocker: 'Waiting for one-shot security approval', userDecisionBlocker: 'Waiting for a product decision', actionRequiredBlocker: 'Operator action required; the server did not identify the decision kind', pausePendingBlocker: 'Pausing at the next safe boundary', pausedBlocker: 'Paused by the operator', failedBlocker: 'The run failed',
    securityApproval: 'Security approval', userDecision: 'User decision', recommended: 'Recommended', submitDecision: 'Submit decision', selectRequired: 'Answer every question to continue.',
    connectTitle: 'Connect to the runtime', connectHint: 'Enter the loopback server address and its local bearer token. Credentials stay in memory for this page.', serverUrl: 'Server URL', serverToken: 'Server token', connect: 'Connect', lock: 'Lock',
    pending: 'Pending', success: 'Applied', conflict: 'State changed; refresh and try again.', denied: 'Denied by policy.',
    loading: 'Loading runtime state', retry: 'Retry', noData: 'Nothing recorded for this view.',
    runtime: 'Runtime', quality: 'Quality', elapsed: 'Updated', state: 'State', attention: 'Needs attention',
    source: 'Source', hook: 'Hook', error: 'Error', cleanup: 'Cleanup', providerHealth: 'Provider health', pluginHealth: 'Plugin health',
    mergeGuard: 'Main merge and release require human approval.', external: 'External plugin', notReviewed: 'No independent reviewer evidence.',
    fullProjection: 'Full projection', humanGate: 'Human gate', heldOut: 'Held-out benchmark', manual: 'manual', stale: 'stale',
    isolation: 'Isolation', comparison: 'Comparison', candidateHash: 'Candidate hash', attestation: 'Attestation', approval: 'Approval',
    creator: 'Creator', refine: 'Refine', pivot: 'Pivot', worktree: 'worktree',
    statuses: { idle: 'idle', running: 'running', pause_pending: 'pause pending', paused: 'paused', requires_action: 'requires action', completed: 'completed', failed: 'failed', cancelled: 'cancelled', queued: 'queued', blocked: 'blocked', unknown: 'unknown' },
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
    pause: '안전 지점에서 일시정지', resume: '작업 재개', cancel: '취소', approve: '이번만 승인',
    followUp: '후속 요청 대기열', followUpPlaceholder: '현재 작업 이후에 실행할 요청…', send: '추가',
    steer: '활성 에이전트 조정', steerTarget: '에이전트', steerPlaceholder: '선택한 에이전트에 구체적인 수정 방향을 전달하세요…', deliver: '전달', noSteerTarget: '조정할 수 있는 활성 에이전트가 없습니다.',
    currentTask: '현재 작업', remainingStage: '남은 단계', blocker: '차단 이유', optionalDetail: '선택 상세',
    noBlocker: '차단 없음', closeout: '현재 단계가 마지막 단계입니다', approvalBlocker: '일회성 보안 승인을 기다리는 중', userDecisionBlocker: '사용자 제품 결정을 기다리는 중', actionRequiredBlocker: '운영자 작업이 필요하지만 서버가 결정 종류를 식별하지 않았습니다', pausePendingBlocker: '다음 안전 지점에서 일시정지 중', pausedBlocker: '운영자가 작업을 일시정지함', failedBlocker: '실행 실패',
    securityApproval: '보안 승인', userDecision: '사용자 결정', recommended: '권장', submitDecision: '결정 제출', selectRequired: '계속하려면 모든 질문에 답하세요.',
    connectTitle: '런타임 연결', connectHint: '루프백 서버 주소와 로컬 bearer 토큰을 입력하세요. 자격 증명은 이 페이지의 메모리에만 유지됩니다.', serverUrl: '서버 URL', serverToken: '서버 토큰', connect: '연결', lock: '잠금',
    pending: '처리 중', success: '적용됨', conflict: '상태가 변경되었습니다. 새로고침 후 다시 시도하세요.', denied: '정책에 의해 거부되었습니다.',
    loading: '런타임 상태를 불러오는 중', retry: '다시 시도', noData: '이 화면에 기록된 항목이 없습니다.',
    runtime: '런타임', quality: '품질', elapsed: '갱신', state: '상태', attention: '확인 필요',
    source: '출처', hook: '훅', error: '오류', cleanup: '정리', providerHealth: '공급자 상태', pluginHealth: '플러그인 상태',
    mergeGuard: '기본 브랜치 병합과 릴리스는 사람 승인이 필요합니다.', external: '외부 플러그인', notReviewed: '독립 검토자 증거가 없습니다.',
    fullProjection: '전체 투영', humanGate: '사람 승인', heldOut: '미공개 벤치마크', manual: '수동', stale: '만료됨',
    isolation: '격리', comparison: '비교', candidateHash: '후보 해시', attestation: '검증', approval: '승인',
    creator: '개선 후보', refine: '개선', pivot: '재계획', worktree: '격리 작업공간',
    statuses: { idle: '대기', running: '실행 중', pause_pending: '일시정지 대기', paused: '일시정지', requires_action: '응답 필요', completed: '완료', failed: '실패', cancelled: '취소됨', queued: '대기열', blocked: '차단됨', unknown: '알 수 없음' },
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

function AuthGate({ store, snapshot, copy }) {
  const [baseUrl, setBaseUrl] = useState(snapshot.serverUrl)
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submit = async event => {
    event.preventDefault()
    if (!token.trim() || submitting) return
    setSubmitting(true)
    const result = await store.authenticate({ baseUrl, token })
    if (result.status !== 'ready') setSubmitting(false)
  }

  return <main className="auth-shell">
    <form className="auth-gate" onSubmit={submit}>
      <span className="brand-mark" aria-label="UncleCode">UC</span>
      <span className="eyebrow">UncleCode / {copy.controlRoom}</span>
      <h1>{copy.connectTitle}</h1>
      <p>{copy.connectHint}</p>
      {snapshot.error && <p className="auth-gate__error" role="alert">{snapshot.error}</p>}
      <label htmlFor="server-url">{copy.serverUrl}</label>
      <input id="server-url" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} autoCapitalize="none" spellCheck="false" required />
      <label htmlFor="server-token">{copy.serverToken}</label>
      <input id="server-token" type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck="false" required />
      <button className="control--accent" disabled={submitting || !token.trim()}>{submitting ? copy.connecting : copy.connect}</button>
    </form>
  </main>
}

function ActionFeedback({ action, copy }) {
  if (!action) return null
  const label = action.status === 'pending' ? copy.pending : action.status === 'success' ? copy.success : action.status === 'conflict' ? copy.conflict : action.status === 'denied' ? copy.denied : action.message
  return <p className={`action-feedback action-feedback--${action.status}`} role="status">{label}</p>
}

function Metric({ label, value, mono = false }) {
  return <div className="metric"><span>{label}</span><strong className={mono ? 'mono' : ''}>{value}</strong></div>
}

function WorkFocus({ run, view, copy }) {
  const focus = deriveWorkFocus(run)
  const remaining = focus.remainingStages.length
    ? focus.remainingStages.map(stage => copy.stages[stage] ?? stage).join(' → ')
    : copy.closeout
  const blocker = focus.blocker === 'approval'
    ? copy.approvalBlocker
    : focus.blocker === 'user_decision'
      ? copy.userDecisionBlocker
      : focus.blocker === 'action_required'
        ? copy.actionRequiredBlocker
        : focus.blocker === 'pause_pending'
          ? copy.pausePendingBlocker
          : focus.blocker === 'paused'
            ? copy.pausedBlocker
            : focus.blocker === 'failed'
              ? copy.failedBlocker
              : focus.blocker ?? copy.noBlocker
  const detailIndex = VIEW_IDS.indexOf(view)

  return <section className="work-focus" aria-label={copy.currentTask}>
    <div className="work-focus__task"><span>{copy.currentTask}</span><strong>{focus.currentTask}</strong><Status value={focus.currentTaskStatus} copy={copy} /></div>
    <div><span>{copy.remainingStage}</span><strong>{remaining}</strong></div>
    <div className={`work-focus__blocker work-focus__blocker--${focus.blockerKind}`}><span>{copy.blocker}</span><strong>{blocker}</strong></div>
    <div><span>{copy.optionalDetail}</span><strong>{copy.nav[detailIndex < 0 ? 0 : detailIndex]}</strong></div>
  </section>
}

function DecisionQuestionList({ decision, copy }) {
  return <div className="decision-questions">{decision.questions.map(question => <section key={question.id}><strong>{question.question}</strong><ul>{question.options.map((option, index) => <li key={`${question.id}-${option.label}`}><span>{option.label}{question.recommended === index ? ` · ${copy.recommended}` : ''}</span>{option.description && <small>{option.description}</small>}</li>)}</ul></section>)}</div>
}

function UserDecisionForm({ decision, copy, pending, onDecision }) {
  const [selected, setSelected] = useState(() => new Map())
  const complete = decision.questions.every(question => {
    const values = selected.get(question.id) ?? []
    return values.length > 0 && (question.multi === true || values.length === 1)
  })
  const selectOption = (question, label) => {
    setSelected(current => {
      const next = new Map(current)
      if (question.multi !== true) {
        next.set(question.id, [label])
        return next
      }
      const values = current.get(question.id) ?? []
      next.set(question.id, values.includes(label)
        ? values.filter(value => value !== label)
        : [...values, label])
      return next
    })
  }
  const submit = event => {
    event.preventDefault()
    if (!complete || pending) return
    void onDecision({
      decisionId: decision.id,
      answers: decision.questions.map(question => ({
        id: question.id,
        selectedOptions: selected.get(question.id),
      })),
    })
  }

  return <form className="decision-form" onSubmit={submit}>
    {decision.questions.map(question => <fieldset key={question.id}>
      <legend>{question.question}</legend>
      <div className="decision-form__options">{question.options.map((option, index) => {
        const checked = (selected.get(question.id) ?? []).includes(option.label)
        return <label key={`${question.id}-${option.label}`}><input type={question.multi === true ? 'checkbox' : 'radio'} name={`decision-${decision.id}-${question.id}`} checked={checked} onChange={() => selectOption(question, option.label)} disabled={pending} /><span><strong>{option.label}{question.recommended === index ? ` · ${copy.recommended}` : ''}</strong>{option.description && <small>{option.description}</small>}</span></label>
      })}</div>
    </fieldset>)}
    <div className="decision-form__submit"><span>{complete ? '' : copy.selectRequired}</span><button className="control--accent" disabled={pending || !complete}>{copy.submitDecision}</button></div>
  </form>
}

function PendingDecision({ run, copy, pending, onApprove, onDecision }) {
  const decision = normalizePendingDecision(run.pendingDecision)
  if (!decision) return null
  const security = decision.kind === 'security-approval'
  const approvable = canApproveOnce(decision)
  const decisionFormKey = JSON.stringify([decision.id, decision.questions.map(question => [question.id, question.options.map(option => option.label)])])
  return <section className={`pending-decision pending-decision--${security ? 'security' : 'user'}`} aria-labelledby="pending-decision-title">
    <div className="pending-decision__header"><div><span className="eyebrow">{security ? copy.securityApproval : copy.userDecision}</span><h2 id="pending-decision-title">{decision.title ?? (security ? copy.securityApproval : copy.userDecision)}</h2></div>{security && approvable && <button className="control--accent" disabled={pending} onClick={() => void onApprove()}>{copy.approve}</button>}</div>
    {security
      ? <DecisionQuestionList decision={decision} copy={copy} />
      : <UserDecisionForm key={decisionFormKey} decision={decision} copy={copy} pending={pending} onDecision={onDecision} />}
  </section>
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

function SteerComposer({ run, copy, pending, onSteer }) {
  const targets = run.agents
    .map(agent => ({ ...agent, controlId: agent.id ?? agent.agentRunId }))
    .filter(agent => agent.controlId && !['completed', 'failed', 'cancelled', 'interrupted'].includes(agent.status))
  const [targetId, setTargetId] = useState('')
  const [message, setMessage] = useState('')
  const selectedTarget = targets.some(agent => agent.controlId === targetId) ? targetId : targets[0]?.controlId ?? ''
  const submit = event => {
    event.preventDefault()
    const nextMessage = message.trim()
    if (!selectedTarget || !nextMessage) return
    void onSteer({ agentRunId: selectedTarget, message: nextMessage }).then(result => {
      if (result.ok) setMessage('')
    })
  }

  return <form className="steer-composer" onSubmit={submit}>
    <div className="section-title"><div><span className="eyebrow">{copy.steer}</span><h2>{copy.steer}</h2></div><span className="mono subtle">{targets.length}</span></div>
    {targets.length ? <div className="steer-composer__fields">
      <label htmlFor="steer-target">{copy.steerTarget}</label>
      <select id="steer-target" value={selectedTarget} onChange={event => setTargetId(event.target.value)} disabled={pending}>{targets.map(agent => <option key={agent.controlId} value={agent.controlId}>{agent.displayName ?? agent.label ?? agent.controlId}</option>)}</select>
      <label htmlFor="steer-message" className="sr-only">{copy.steer}</label>
      <input id="steer-message" value={message} onChange={event => setMessage(event.target.value)} placeholder={copy.steerPlaceholder} disabled={pending} />
      <button className="control--accent" disabled={pending || !message.trim()}>{copy.deliver}</button>
    </div> : <p className="muted">{copy.noSteerTarget}</p>}
  </form>
}

function AgentsView({ run, copy, pending, onSteer }) {
  return <div className="view-stack"><SteerComposer run={run} copy={copy} pending={pending} onSteer={onSteer} /><AgentRows title={copy.agents} rows={run.agents} emptyLabel={copy.noData} copy={copy} /><AgentRows title={copy.jobs} rows={run.jobs} emptyLabel={copy.noData} copy={copy} /></div>
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
      const evidenceLabel = evolutionEvidenceLabel(proposal)
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

function MainView({ view, run, projection, copy, pending, onSteer }) {
  if (view === 'Quality') return <QualityView run={run} copy={copy} />
  if (view === 'Context') return <ContextView run={run} copy={copy} />
  if (view === 'Agents & Jobs') return <AgentsView run={run} copy={copy} pending={pending} onSteer={onSteer} />
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

  if (snapshot.status === 'auth_required') return <AuthGate store={store} snapshot={snapshot} copy={copy} />
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
      <div className="rail__footer"><div className={`connection connection--${snapshot.connection}`}><span />{snapshot.connection === 'live' ? copy.live : snapshot.connection === 'connecting' ? copy.connecting : copy.offline}</div><button className="lock-control" onClick={() => store.clearCredentials()}>{copy.lock}</button></div>
    </nav>
    <RunList runs={runs} selectedId={run.id} onSelect={id => { setSelectedId(id); store.selectSession?.(id) }} copy={copy} />
    <section className="workspace">
      <header className="workspace__header"><div><span className="eyebrow">{copy.runDetail} / <span className="mono">{run.id}</span></span><h1>{run.project}</h1><div className="run-meta"><Status value={run.state} copy={copy} /><span>{run.model}</span><span>{run.quality.profile}</span><span className={`gate gate--${run.quality.gate}`}>{copy.gates[run.quality.gate] ?? run.quality.gate}</span></div></div><div className="controls"><button disabled={pending || run.state !== 'running'} onClick={() => void doAction('pause')}>{copy.pause}</button><button disabled={pending || run.state !== 'paused'} onClick={() => void doAction('resume')}>{copy.resume}</button><button className="control--danger" disabled={pending || ['completed', 'failed', 'cancelled'].includes(run.state)} onClick={() => void doAction('cancel')}>{copy.cancel}</button></div></header>
      <ActionFeedback action={action} copy={copy} />
      {snapshot.error && <p className="inline-error" role="alert">{snapshot.error}</p>}
      <WorkFocus run={run} view={view} copy={copy} />
      <PendingDecision run={run} copy={copy} pending={pending} onApprove={() => doAction('approve', { decision: 'approve_once' })} onDecision={payload => doAction('decision', payload)} />
      <div className="workspace__body"><div className="workspace__main"><MainView view={view} run={run} projection={snapshot.data} copy={copy} pending={pending} onSteer={payload => doAction('steer', payload)} /></div><aside className="evidence-rail"><span className="eyebrow">{run.quality.recorded ? copy.qualityEngine : copy.noData}</span><div className="evidence-rail__gate"><strong>{copy.gates[run.quality.gate] ?? run.quality.gate}</strong><span>{run.quality.profile} · {copy.stages[run.quality.stage] ?? run.quality.stage}</span></div><Metric label="PDCA" value={copy.phases[run.quality.phase] ?? run.quality.phase} /><Metric label={copy.iteration} value={run.quality.iteration} mono /><Metric label={copy.independent} value={run.quality.independentVerification ? copy.verified : copy.unproven} /><div className="evidence-list"><span>{copy.evidence}</span>{run.artifacts.slice(0, 4).map(item => <code key={item.ref}>{item.hash ?? item.ref}</code>)}</div>{run.attentionReason && <p className="attention"><strong>{copy.attention}</strong>{run.attentionReason}</p>}</aside></div>
      <form className="follow-up" onSubmit={submitFollowUp}><label htmlFor="follow-up">{copy.followUp}</label><div><input id="follow-up" value={followUp} onChange={event => setFollowUp(event.target.value)} placeholder={copy.followUpPlaceholder} disabled={pending} /><button className="control--accent" disabled={pending || !followUp.trim()}>{copy.send}</button></div></form>
    </section>
  </main>
}
