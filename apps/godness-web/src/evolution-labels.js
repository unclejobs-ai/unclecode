export function evolutionEvidenceLabel(proposal) {
  if (proposal?.stale === true || proposal?.state === 'stale') return 'stale'
  return proposal?.state === 'pr-ready' && proposal?.stale === false
    ? 'verified'
    : 'unproven'
}
