# F3 Agent Walkthrough

## Environment
- Workspace: temporary git repo initialized under `/tmp/unclecode-walkthrough-*`
- Auth path: `OPENAI_API_KEY=sk-demo-123`
- Session store: temporary `UNCLECODE_SESSION_STORE_ROOT`
- MCP config: user-level `memory` server + project-level `repo` server

## Executed user journey
1. `unclecode setup`
2. `unclecode auth status`
3. `unclecode doctor --verbose`
4. `unclecode mcp list`
5. `unclecode /doctor`
6. `unclecode research run summarize current workspace`
7. `unclecode research status`
8. `unclecode sessions`
9. `unclecode resume <research-session-id>`

## Outcome
All steps completed successfully without human intervention.

## Key outputs
### `unclecode setup`
- Reported auth as ready via `api-key-env`
- Reported runtime as `local available`
- Printed actionable next steps

### `unclecode auth status`
- Reported provider `openai`
- Reported source `api-key-env`
- Did not leak secrets

### `unclecode doctor --verbose`
- Reported `PASS` for mode/runtime/session store/MCP host
- Printed latency counters:
  - `configMs=2`
  - `authMs=0`
  - `runtimeMs=0`
  - `sessionStoreMs=2`
  - `mcpMs=2`
  - `totalMs=6`

### `unclecode mcp list`
- Listed merged user and project servers:
  - `memory | stdio | user | user config`
  - `repo | stdio | project | project config`

### `unclecode /doctor`
- Slash route correctly mapped to the doctor surface

### `unclecode research run summarize current workspace`
- Completed successfully
- Created a research session id
- Wrote `.unclecode/research-artifacts/research.md`

### `unclecode research status`
- Reported last run
- Reported final state `idle`

### `unclecode sessions` + `resume`
- Listed resumable research session metadata
- Resumed the created research session by id

## Verdict
APPROVE for the scripted product walkthrough covered in this pass.

## Notes
- This is a CLI-driven walkthrough, not a browser-captured OAuth walkthrough.
- Browser OAuth itself remains covered by integration tests and repeated flake checks rather than this walkthrough artifact.
