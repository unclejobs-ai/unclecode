const STAGE_ORDER = ['explore', 'plan', 'work', 'critic', 'promote']
const TASK_STATUS_ORDER = ['running', 'active', 'blocked', 'ready', 'queued', 'pending']

function displayText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function nodeLabel(node) {
  return displayText(node?.title)
    ?? displayText(node?.summary)
    ?? displayText(node?.label)
    ?? displayText(node?.event)
    ?? displayText(node?.id)
}

function currentNode(nodes) {
  for (const status of TASK_STATUS_ORDER) {
    const match = nodes.find(node => node?.status === status)
    if (match) return match
  }
  return nodes.at(-1)
}

export function deriveWorkFocus(run) {
  const nodes = Array.isArray(run?.graph?.nodes) ? run.graph.nodes : []
  const node = currentNode(nodes)
  const stage = displayText(run?.quality?.stage) ?? 'unknown'
  const stageIndex = STAGE_ORDER.indexOf(stage)
  const remainingStages = stageIndex >= 0 ? STAGE_ORDER.slice(stageIndex + 1) : []
  const blockedNode = nodes.find(item => item?.status === 'blocked')
  const blockingFinding = ['block', 'refine', 'pivot'].includes(run?.quality?.gate)
    ? displayText(run?.quality?.findings?.[0])
    : undefined

  const decisionKind = run?.pendingDecision?.kind
  let blocker = decisionKind === 'security-approval'
    ? 'approval'
    : decisionKind === 'user-decision'
      ? 'user_decision'
      : displayText(run?.attentionReason)
    ?? displayText(blockedNode?.blocker)
    ?? displayText(blockedNode?.reason)
    ?? blockingFinding
  let blockerKind = decisionKind === 'security-approval'
    ? 'approval'
    : decisionKind === 'user-decision'
      ? 'decision'
      : blocker ? 'attention' : 'none'

  if (!blocker && run?.state === 'requires_action') {
    blocker = 'action_required'
    blockerKind = 'attention'
  } else if (!blocker && run?.state === 'pause_pending') {
    blocker = 'pause_pending'
    blockerKind = 'paused'
  } else if (!blocker && run?.state === 'paused') {
    blocker = 'paused'
    blockerKind = 'paused'
  } else if (!blocker && run?.state === 'failed') {
    blocker = 'failed'
    blockerKind = 'failed'
  }

  return {
    currentTask: nodeLabel(node) ?? displayText(run?.project) ?? '—',
    currentTaskStatus: displayText(node?.status) ?? displayText(run?.state) ?? 'unknown',
    stage,
    remainingStages,
    blocker,
    blockerKind,
  }
}
