# Hermes Skill: team-builder

Bounded feature slice end-to-end with mandatory MMBridge gate. Larger budget
than team-coder (24 steps / $2.00) and explicitly multi-file.

## When to choose this skill

- A scoped feature slice with clear acceptance tests
- Two or more files in scope, but inside one logical change
- Operator wants the run to fail-loud on regression rather than improvise

## Operator prompt

```text
Use the team-builder skill against this repository.

Objective:
- {{feature slice and acceptance criteria}}

Execution rules:
- One write-capable worker
- Preserve existing behavior outside the requested scope
- Run targeted tests after each meaningful change
- Read summary.md before inspecting raw role artifacts
- If review and gate disagree but neither indicates a blocker, request a narrow follow-up

Run the payload:
node scripts/hermes-team-run.mjs run "$(cat references/hermes/examples/team-builder.json)"
```

## Output contract

Same as team-coder, plus:

- `reviews/mmbridge-review.json` — qualitative reviewer notes
- The `summary.md` should call out user-visible notes for release notes
- If the gate is `warn`, the summary must explain whether the warning is
  local enough to ship without a corrective pass

## Hand-off

A team-builder run that finishes `accepted` is acceptable to merge as a
single PR; a `gated` or `corrective` run requires a follow-up before merge.
