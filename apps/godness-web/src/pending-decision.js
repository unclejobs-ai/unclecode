const DECISION_KINDS = new Set(['security-approval', 'user-decision'])

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizePendingDecision(value) {
  if (!value || typeof value !== 'object' || !DECISION_KINDS.has(value.kind) || !nonEmpty(value.id) || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 8) return null
  const questionIds = new Set()
  const questions = value.questions.map(question => {
    const id = nonEmpty(question?.id)
    if (!question || typeof question !== 'object' || !id || questionIds.has(id) || !nonEmpty(question.question) || !Array.isArray(question.options) || !question.options.length || question.options.length > 16) return null
    questionIds.add(id)
    const labels = new Set()
    const options = question.options.map(option => {
      if (!option || typeof option !== 'object' || !nonEmpty(option.label)) return null
      const label = nonEmpty(option.label)
      if (labels.has(label)) return null
      labels.add(label)
      return { label, description: nonEmpty(option.description) }
    }).filter(Boolean)
    if (options.length !== question.options.length) return null
    const recommended = Number.isSafeInteger(question.recommended) && question.recommended >= 0 && question.recommended < options.length
      ? question.recommended
      : undefined
    if (question.recommended !== undefined && recommended === undefined) return null
    return {
      id,
      question: nonEmpty(question.question),
      options,
      multi: question.multi === true,
      recommended,
    }
  }).filter(Boolean)
  if (questions.length !== value.questions.length) return null
  return { kind: value.kind, id: nonEmpty(value.id), title: nonEmpty(value.title), questions }
}

export function canApproveOnce(decision) {
  return decision?.kind === 'security-approval'
    && decision.questions.length === 1
    && decision.questions[0].options.some(option => option.label === 'Approve')
}

export function approvalPayloadFor(decision) {
  return canApproveOnce(decision)
    ? { decision: 'approve_once', decisionId: decision.id }
    : null
}
