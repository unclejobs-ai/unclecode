# Hermes Skill: team-coder

Targets a single-objective implementation lane via UncleCode's `team run`.
Hermes provides operator-level routing; UncleCode handles the in-process
loop, ACI tools, MMBridge gate, and SSOT chain.

## When to choose this skill

- One concrete defect or feature slice
- Acceptable to bound the run to coder budget (12 steps / $0.80)
- Operator wants a hash-chained audit trail and reproducible RUN_ID

## Operator prompt

```text
Use the team-coder skill against this repository.

Objective:
- {{plain-language description of the bug or feature slice}}

Execution rules:
- Single write-capable worker; reviewers stay read-only
- Defer security questions to mmbridge
- Read summary.md first, then mmbridge-gate.json
- If the gate fails, request a narrow corrective pass instead of broad rework

Run the payload:
node scripts/hermes-team-run.mjs run "$(cat references/hermes/examples/team-coder.json)"
```

## Output contract

After the run, expect under `.data/team-runs/<runId>/`:

- `manifest.json` — persona, objective, codeState, env, lanes
- `checkpoints.ndjson` — sha256-chained lifecycle log
- `workers/<workerId>/messages.ndjson` — append-only worker trace
- `reviews/mmbridge-gate.json` — gate verdict (pass | warn | fail)
- `summary.md` — operator-facing synthesis

Always read in the documented order: `summary.md` → `manifest.json` →
`reviews/mmbridge-gate.json` → `reviews/mmbridge-review.json` →
`workers/*/result.json` → raw stdout/stderr only when the structured files
do not answer the question.

## Hand-off

If the operator decides to apply the patch outside this run, include the
`runId` and the chain head in the commit / PR description so reviewers can
verify the citations.
