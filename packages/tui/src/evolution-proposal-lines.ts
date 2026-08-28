import type { EvolutionProposalProjection } from "@unclecode/contracts";

import { boundRow } from "./work-shell-agent-console-format.js";

function hasRetainedResource(
  proposal: EvolutionProposalProjection,
  kind: "branch" | "worktree",
): boolean {
  return proposal.cleanup.resources.some(
    (resource) => resource.kind === kind && resource.status === "retained",
  );
}

/**
 * A candidate is current only while the host still attests both isolation
 * resources and the cleanup journal says they are retained. Recorded hashes
 * for every other terminal state are historical evidence, not live files.
 */
function isFreshRetainedCandidate(
  proposal: EvolutionProposalProjection,
): boolean {
  return (
    proposal.state === "pr-ready" &&
    !proposal.stale &&
    proposal.cleanup.status === "retained" &&
    proposal.attestation?.branchExists === true &&
    proposal.attestation.worktreeExists === true &&
    hasRetainedResource(proposal, "branch") &&
    hasRetainedResource(proposal, "worktree")
  );
}

export function selectRecordedEvolutionProposalLines(
  proposal: EvolutionProposalProjection | undefined,
  width: number,
): readonly string[] {
  if (!proposal) return [];
  const fresh = isFreshRetainedCandidate(proposal);
  const comparison = proposal.comparison;
  const candidateHash =
    proposal.hashes.candidateArtifact ??
    proposal.hashes.patch ??
    proposal.hashes.candidateCommit;
  const retained = proposal.cleanup.resources.filter(
    (resource) => resource.status === "retained",
  ).length;
  const removed = proposal.cleanup.resources.filter(
    (resource) => resource.status === "removed",
  ).length;
  const delta = comparison
    ? `${comparison.delta >= 0 ? "+" : ""}${comparison.delta}`
    : undefined;
  const resourceHistory =
    proposal.cleanup.status === "completed"
      ? "resources removed"
      : `resources ${proposal.cleanup.status}`;

  return [
    boundRow(`Evolution · ${proposal.state} · recorded`, width),
    boundRow(
      `Isolation · ${proposal.isolation}` +
        `${proposal.isolatedBranch ? ` · ${proposal.isolatedBranch}` : ""}` +
        ` · ${fresh ? "attested current" : "historical record"}`,
      width,
    ),
    ...(comparison
      ? [
          boundRow(
            `Held-out · ${proposal.heldOutBenchmarkId}` +
              ` · baseline ${comparison.baselineScore} → candidate ${comparison.candidateScore}` +
              ` · delta ${delta} · ${comparison.passed ? "passed" : "rejected"}`,
            width,
          ),
        ]
      : [
          boundRow(
            `Held-out · ${proposal.heldOutBenchmarkId} · comparison unavailable`,
            width,
          ),
        ]),
    ...(candidateHash
      ? [
          boundRow(
            `Candidate hash · ${candidateHash} · ${fresh ? "current" : "recorded/historical"}`,
            width,
          ),
        ]
      : []),
    ...(proposal.attestation
      ? [
          boundRow(
            `Attestor · ${proposal.attestorId} · ${proposal.attestation.timestamp}` +
              ` · ${fresh ? "current branch+worktree present" : `historical attestation · ${resourceHistory}`}`,
            width,
          ),
        ]
      : [boundRow(`Attestor · ${proposal.attestorId} · not recorded`, width)]),
    boundRow("Approval · pending · merge requires human approval", width),
    boundRow(
      `Cleanup · ${proposal.cleanup.status} · ${retained} retained · ${removed} removed`,
      width,
    ),
  ];
}
