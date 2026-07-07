# UncleCode Rust Porting Plan

Status: active migration.

The target state is a Rust-native UncleCode CLI/runtime. The TypeScript
workspace remains as a compatibility bridge only while features are moved.

## Direction

1. Rust owns the executable entrypoint.
2. Rust moves one runtime boundary at a time from TypeScript.
3. TypeScript provider/OAuth/TUI code can remain temporarily behind the bridge.
4. A feature is considered ported only when Rust owns implementation and tests.
5. Provider capability parity is part of the port, including GPT-5.5 defaults,
   reasoning support, pricing metadata, auth flows, and request/stream handling.
6. Harness engineering is part of the port: config inspection, approval policy,
   model selection, team/runtime presets, and startup latency must be verified on
   the Rust path before the TypeScript bridge is removed.

## First Cut

The new `rust/unclecode` binary is now the Rust entrypoint. It currently:

- locates the UncleCode workspace root
- handles `--version`, `--help`, and `--rust-version` natively before the
  TypeScript bridge is considered
- handles top-level `auth status`, `auth logout`, and slash-form `/auth status`
  natively before the TypeScript bridge is considered
- handles top-level `auth login` saved-auth detection, API-key stdin login,
  browser OAuth URL/callback login, standard device OAuth, and Codex-derived
  device OAuth fallback natively before the TypeScript bridge is considered
- handles top-level `harness status`, `harness explain`, `harness apply`, and
  slash-form `/harness status` natively before the TypeScript bridge is
  considered
- handles top-level `mode status`, `mode set`, slash-form `/mode status`, and
  split slash `unclecode /mode status` natively before the TypeScript bridge is
  considered
- handles top-level `sessions`, `sessions fork`, `sessions share`, and
  slash-form `/sessions` natively before the TypeScript bridge is considered
- handles top-level `resume <session-id>` and `resume <session-id> --json`
  natively before the TypeScript bridge is considered
- handles top-level `research status`, `research status --json`, `research run`,
  `research run --json`, and slash-form `/research status` natively before the
  TypeScript bridge is considered
- handles top-level `team run --dispatch` natively for coordinator execution,
  worker process spawning, timeout/kill handling, output capture, stale-lock
  sweep, and final run checkpointing; live `openai`, `anthropic`, `gemini`,
  `cursor`, `codex`, `opencode`, `hermes`, and `glm` worker adapters are also
  Rust-native. SDK lanes use a Rust mini-loop with provider query, Rust ACI
  tool dispatch, and chained `team_step` checkpoints.
- handles non-interactive top-level `work <prompt...>` natively through the
  Rust provider/tool mini-loop. Prompt mode uses Rust model defaults, OpenAI
  saved-auth/API-key resolution, workspace guidance injection, provider
  base-url/env lookup, and the same explicit `UNCLECODE_ALLOW_RUN_SHELL=1`
  shell-tool opt-in as the previous work runtime.
- handles empty top-level `work` natively as a Rust line terminal session.
  The line runtime provides `/help`, `/status`, `/model`, `/provider`,
  `/tools`, `/queue`, `/drain`, offline help/status without provider
  credentials, and queued follow-up draining. It reuses the same Rust
  provider/tool mini-loop for submitted prompts.
- routes root-bin top-level `tui` to the same Rust-native work line runtime,
  retiring the root CLI's temporary TypeScript/Ink `tui` entrypoint.
- routes no-argument root-bin `unclecode` startup to the Rust-native work line
  runtime instead of the temporary TypeScript default work session.
- routes root-bin top-level `center` to a Rust-native session center that lists
  recent sessions, resume commands, queue follow-up entrypoints, and an
  empty-state path to `unclecode work`, retiring the root CLI's temporary
  TypeScript/Ink session-center entrypoint.
- fails closed for unsupported top-level commands instead of launching the
  TypeScript bridge, so `target/*/unclecode` remains Rust-native even on error
  paths

The root `bin/unclecode.cjs` wrapper now runs an available Rust binary before
checking any temporary TypeScript build artifact. This means native Rust
surfaces run from the package bin without a Node fallback to
`apps/unclecode-cli/dist/index.js`.
When both debug and release Rust binaries exist, the wrapper picks the newest
binary so a stale release build does not shadow a newly built debug CLI during
local development.
If no Rust binary exists, the wrapper gives a single recovery path:
`cargo build -p unclecode`.

This keeps the CLI usable while making Rust the new executable surface.
The package CLI now also routes normal built `unclecode work`, `unclecode tui`,
`unclecode center`, no-argument TTY startup, and `unclecode resume` invocations
through Rust-native command surfaces instead of opening the temporary
TypeScript work/center entrypoints.

## Rust-Owned Surfaces

These surfaces are no longer just planned; they have Rust implementation and
Rust tests:

- `unclecode-core::queue::WorkQueue`
- `unclecode-core::queue::PersistentWorkQueue`
- `unclecode-core::session::SessionLog`
- `unclecode-core::session::WorkShellSessionStore`
- `unclecode-core::session::session_paths`
- `unclecode-core::auth::resolve_openai_auth_status`
- `unclecode-core::auth::resolve_openai_auth`
- `unclecode-core::auth::{read_openai_credentials_file, write_openai_raw_credentials}`
- `unclecode-core::model_registry::{openai_model_registry, openai_reasoning_support}`
- `unclecode-core::model_registry::{detect_provider_for_model, provider_model_catalog, provider_label}`
- `unclecode-core::model_registry::resolve_provider_route`
- `unclecode-core::model_registry::provider_capability_json`
- `unclecode-core::model_pricing::{model_price, estimate_cost_usd}`
- `unclecode-core::provider_prompt::{DEFAULT_PROVIDER_SYSTEM_PROMPT, build_provider_system_prompt}`
- `unclecode-core::harness::{inspect_harness_status, apply_harness_preset}`
- `unclecode-core::redaction::redact_secrets`
- `unclecode-core::sha256::sha256_hex`
- `unclecode-core::runtime::{run_command, run_shell_command}`
- `unclecode-core::path_guard::assert_within_workspace`
- `unclecode-core::aci::{list_files, read_text_file, view_text_file, glob_files, write_text_file, search_text}`
- `unclecode-core::http_transport::{post_json_with_headers, post_json_with_headers_retry, http_transport_response_json}`
- `unclecode-core::http_transport::{resolve_proxy_policy, proxy_policy_json}`
- `unclecode-core::command_router::{route_cli_slash_command_json, cli_slash_help_text}`
- `unclecode-core::composer_input::resolve_composer_input_json`
- `unclecode-core::steer::resolve_busy_submit_json`
- `unclecode-core::research_run::research_run_report`
- `unclecode-core::team_mini_loop::run_team_mini_loop`
- `unclecode-core::team_mini_loop::run_provider_mini_loop`

The CLI exposes native smoke commands that do not call the TypeScript bridge:

```sh
target/debug/unclecode rust queue-smoke
target/debug/unclecode rust queue push-json smoke-session "queued follow-up"
target/debug/unclecode rust queue len-json smoke-session
target/debug/unclecode rust queue pop-json smoke-session
target/debug/unclecode rust queue clear smoke-session
target/debug/unclecode rust session-smoke
printf 'Chat: inspect repo' | target/debug/unclecode rust session persist smoke-session gpt-5.5 analyze idle verbose
target/debug/unclecode rust session list
target/debug/unclecode rust session resume smoke-session
target/debug/unclecode rust session paths ~/.unclecode/state "$PWD" smoke-session
printf '{"cwd":"'"$PWD"'","argv":["--cwd","..","--provider","openai","--model","gpt-5.5","--reasoning","high","--session-id","work-123","--tools","fix","auth"]}' | target/debug/unclecode rust work-runtime parse-args
printf '{"promptParts":["review","auth.ts"],"options":{"tools":true,"cwd":"/tmp/project-a","provider":"openai","model":"gpt-5.5","reasoning":"high","sessionId":"work-123"}}' | target/debug/unclecode rust work-runtime build-command-args
printf '{"forwardedArgs":["--tools"],"callerCwd":"/tmp/project-a"}' | target/debug/unclecode rust work-runtime with-cwd
printf '{"cliSourceDir":"'"$PWD"'/apps/unclecode-cli/src"}' | target/debug/unclecode rust work-runtime entrypoint-paths
OPENAI_API_KEY=sk-test target/debug/unclecode work --provider openai "summarize current workspace"
OPENAI_API_KEY=sk-test target/debug/unclecode work
target/debug/unclecode tui --help
target/debug/unclecode
target/debug/unclecode center
target/debug/unclecode center --help
printf '{"cwd":"'"$PWD"'","argv1":"unclecode","env":{"USER":"park"},"options":{"persona":"hardener","gate":"warn","runtime":"local","workerTimeout":"42"}}' | target/debug/unclecode rust team run-config
printf '{"options":{"persona":"coder","workerId":"w1","task":"fix auth","runtime":"codex","extras":"{\"agent\":\"codex\"}"}}' | target/debug/unclecode rust team worker-options
printf '{"lanes":"cursor,codex,opencode:hf/llama:3.1:instruct:agent=codex"}' | target/debug/unclecode rust team lanes
printf '{"baseArgs":["worker.mjs"],"spec":{"workerId":"w1","persona":"coder","task":"fix auth","runtime":"hermes","extras":{"agent":"codex"}}}' | target/debug/unclecode rust team worker-spawn-args
printf '{"outcomes":[{"status":"completed"},{"status":"failed"}]}' | target/debug/unclecode rust team dispatch-status
printf '{"baseEnv":{"PATH":"/bin","DROP":null},"bindingEnv":{"UNCLECODE_TEAM_RUN_ID":"tr_1"},"extraEnv":{"UNCLECODE_TEAM_WORKER_LIVE":"0"}}' | target/debug/unclecode rust team child-env
printf '{"killedByTimeout":false,"code":0,"signal":null}' | target/debug/unclecode rust team worker-close-outcome
printf '{"dataRoot":".data"}' | target/debug/unclecode rust team list-runs
target/debug/unclecode team --help
target/debug/unclecode team run --record tr_1 --lanes codex,opencode "record native run"
UNCLECODE_TEAM_WORKER_LIVE=0 target/debug/unclecode team run --dispatch --record tr_dispatch_1 --lanes codex,opencode "dispatch native dry run"
target/debug/unclecode team run --dispatch --record tr_codex_live --lanes codex:gpt-5.5 "dispatch native codex worker"
OPENAI_API_KEY=sk-test target/debug/unclecode team run --dispatch --record tr_openai_live --lanes openai:gpt-5.5 "dispatch native openai mini-loop worker"
ANTHROPIC_API_KEY=sk-ant target/debug/unclecode team run --dispatch --record tr_anthropic_live --lanes anthropic:claude-sonnet-4-6 "dispatch native anthropic mini-loop worker"
GEMINI_API_KEY=gemini-key target/debug/unclecode team run --dispatch --record tr_gemini_live --lanes gemini:gemini-2.5-pro "dispatch native gemini mini-loop worker"
CURSOR_API_KEY=cursor-key target/debug/unclecode team run --dispatch --record tr_cursor_live --lanes cursor:composer-2.5 "dispatch native cursor worker"
GLM_API_KEY=glm-key GLM_BASE_URL=http://localhost:8787/v4 target/debug/unclecode team run --dispatch --record tr_glm_live --lanes glm:glm-5.1 "dispatch native glm worker"
target/debug/unclecode team ls
target/debug/unclecode team status
target/debug/unclecode team inspect --verify tr_1
target/debug/unclecode team abort tr_1
target/debug/unclecode team doctor
target/debug/unclecode queue push session-1 "follow up"
target/debug/unclecode queue list session-1
target/debug/unclecode queue pop session-1
OPENAI_API_KEY=sk-test target/debug/unclecode rust auth status
OPENAI_API_KEY=sk-test target/debug/unclecode auth status
OPENAI_API_KEY=sk-test target/debug/unclecode "/auth status"
OPENAI_OAUTH_CLIENT_ID=client_123 target/debug/unclecode auth login --print
OPENAI_OAUTH_CLIENT_ID=client_123 target/debug/unclecode auth login --browser
OPENAI_OAUTH_CLIENT_ID=client_123 target/debug/unclecode auth login --device
target/debug/unclecode auth login
target/debug/unclecode auth login --device
target/debug/unclecode auth --help
target/debug/unclecode auth login --help
printf 'sk-test' | UNCLECODE_OPENAI_CREDENTIALS_PATH=target/openai-cli-smoke.json target/debug/unclecode auth login --api-key-stdin --org org_test --project proj_test
OPENAI_API_KEY=sk-test target/debug/unclecode rust auth resolve
target/debug/unclecode harness status
target/debug/unclecode "/harness status"
target/debug/unclecode harness explain
target/debug/unclecode mode status
target/debug/unclecode mode set yolo
target/debug/unclecode "/mode status"
target/debug/unclecode research status
target/debug/unclecode research status --json
target/debug/unclecode research --help
target/debug/unclecode research run --help
target/debug/unclecode research run "summarize current workspace"
target/debug/unclecode "/research status"
target/debug/unclecode sessions
target/debug/unclecode "/sessions"
target/debug/unclecode rust command route '/sessions'
target/debug/unclecode rust command help
printf '/review auth flow' | target/debug/unclecode rust command submit-route false default true
printf '/queue' | target/debug/unclecode rust command builtin-command
printf '{"kind":"review","focus":"auth flow"}' | target/debug/unclecode rust command prompt-command
printf '{"slashCommand":["prompt","review","auth","flow"]}' | target/debug/unclecode rust command prompt-slash-command
printf '/remember session keep this' | target/debug/unclecode rust command local-command
printf '{"currentContextSummaryLines":["Auth issue: stale oauth","Loaded guidance: AGENTS.md"],"authIssueLines":["Auth issue: saved OAuth needs refresh."]}' | target/debug/unclecode rust context auth-issues
printf 'inspect this' | target/debug/unclecode rust composer resolve "$PWD"
printf 'follow up' | target/debug/unclecode rust steer busy-submit 0
target/debug/unclecode rust steer drain-start false false 1
printf '{"id":1,"line":"follow up"}' | target/debug/unclecode rust steer drain-step 1
target/debug/unclecode resume smoke-session
target/debug/unclecode resume smoke-session --json
target/debug/unclecode rust auth authorization-url client_123 http://localhost:7777/callback state_123 challenge_123 - openid profile model.request
printf 'http://localhost:7777/callback?code=code_123&state=state_123' | target/debug/unclecode rust auth parse-callback state_123
target/debug/unclecode rust auth request-spec authorization-code https://auth.openai.com
target/debug/unclecode rust auth request-body device-code client_123 openid profile model.request
printf '{"authType":"api-key","apiKey":"sk-test"}' | UNCLECODE_OPENAI_CREDENTIALS_PATH=target/openai-raw-smoke.json target/debug/unclecode rust auth write-raw
UNCLECODE_OPENAI_CREDENTIALS_PATH=target/openai-raw-smoke.json target/debug/unclecode rust auth read-credentials
printf 'sk-test' | UNCLECODE_OPENAI_CREDENTIALS_PATH=target/openai-smoke.json target/debug/unclecode rust auth save-api-key - -
printf 'at-test\nrt-test\n' | UNCLECODE_OPENAI_CREDENTIALS_PATH=target/openai-oauth-smoke.json target/debug/unclecode rust auth save-oauth codex - test-project test-account
UNCLECODE_OPENAI_CREDENTIALS_PATH=target/openai-smoke.json target/debug/unclecode rust auth logout
OPENAI_MODEL=gpt-5.5 target/debug/unclecode rust model openai-registry
target/debug/unclecode model list openai
target/debug/unclecode model route auto gpt-5.5
target/debug/unclecode "/model reasoning gpt-5.5"
target/debug/unclecode rust model openai-reasoning gpt-5.5
target/debug/unclecode rust model price gpt-4.1-mini
target/debug/unclecode rust model estimate-cost gpt-4.1-mini 1000000 1000000
target/debug/unclecode rust model detect-provider claude-sonnet-4-6
	GEMINI_MODEL=gemini-2.5-pro GEMINI_MODELS=gemini-2.5-pro-exp target/debug/unclecode rust model catalog gemini
	printf 'sk-test' | target/debug/unclecode rust provider openai-request-spec-json api
	printf 'oauth-token' | target/debug/unclecode rust provider openai-request-spec-json codex acct_123
	printf '[{"role":"user","content":"hi"}]\0[]' | target/debug/unclecode rust provider openai-chat-body gpt-5.5 - yes
	printf '[{"name":"search","description":"Search","input_schema":{"type":"object","properties":{"q":{"type":"string"}}}}]' | target/debug/unclecode rust provider openai-chat-tools
	printf 'system prompt\0[{"role":"user","content":"hi"}]' | target/debug/unclecode rust provider openai-query-messages
	printf '{"choices":[{"message":{"content":"hi","tool_calls":[{"id":"call_1","function":{"name":"search","arguments":"{\"q\":\"x\"}"}}]}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}' | target/debug/unclecode rust provider openai-chat-response
	printf '{"choices":[{"message":{"content":"hi","tool_calls":[{"id":"call_1","function":{"name":"search","arguments":"{\"q\":\"x\"}"}}]}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}' | target/debug/unclecode rust provider openai-chat-response-json gpt-5.5
	printf 'boom' | target/debug/unclecode rust provider request-error openai 500 3
	printf '[{"id":"call_1","function":{"name":"search","arguments":"{\"q\":\"x\"}"}}]' | target/debug/unclecode rust provider openai-tool-actions
	printf 'thinking' | target/debug/unclecode rust provider loop-decision 7 1 8
	printf 'thinking' | target/debug/unclecode rust provider iteration-action-plan 0 1 8
	printf 'previous\0thinking\0[{"role":"system","content":"s"}]\0[{"role":"assistant","content":"thinking"}]' | target/debug/unclecode rust provider turn-step openai 0 1 8
	printf 'previous\0thinking\0[{"role":"system","content":"s"}]\0[{"role":"assistant","content":"thinking","tool_calls":[{"id":"call_1","function":{"name":"read_file","arguments":"{}"}}]}]\0[{"toolName":"read_file","toolCallId":"call_1","kind":"success","isError":false,"content":"ok"}]' | target/debug/unclecode rust provider complete-turn-step openai 0 1 8
	printf '[{"callId":"call_1","tool":"read_file","input":{"path":"README.md"}},{"callId":"call_2","tool":"missing","input":{}}]\0["read_file"]' | target/debug/unclecode rust provider tool-dispatch-plan openai
	printf '[{"role":"system","content":"s"}]\0[{"role":"user","content":"hi"}]' | target/debug/unclecode rust provider append-state openai
	printf '[{"role":"system","content":"s"}]\0[]' | target/debug/unclecode rust provider start-turn openai inspect
	printf '[{"type":"image","mimeType":"image/png","dataUrl":"data:image/png;base64,AAAA"}]' | target/debug/unclecode rust provider attachment-caps
	printf '{"path":"README.md"}' | target/debug/unclecode rust provider tool-trace-started openai read_file call_1 10
	printf '{"path":"README.md"}' | target/debug/unclecode rust provider tool-execution-start openai read_file call_1
	printf 'thinking' | target/debug/unclecode rust provider reasoning-delta openai gpt-5.5 text
	printf 'stream thinking' | target/debug/unclecode rust provider reasoning-delta-record openai gpt-5.5 text rs_1
	printf 'ok' | target/debug/unclecode rust provider tool-trace-completed openai read_file call_1 10 15 no
	printf 'ok' | target/debug/unclecode rust provider tool-execution-result openai read_file call_1 10 15 no
	printf 'ok' | target/debug/unclecode rust provider tool-execution-finish openai read_file call_1 10 no
	printf '{"content":"ok"}' | target/debug/unclecode rust provider tool-execution-finish-result openai read_file call_1 10
	printf 'ok' | target/debug/unclecode rust provider tool-result openai read_file call_1 success no
	printf '[{"type":"tool_result","tool_use_id":"tu_1","content":"ok","is_error":false}]' | target/debug/unclecode rust provider tool-result-container anthropic
	printf '[{"toolName":"read_file","toolCallId":"call_1","kind":"success","isError":false,"content":"ok"}]' | target/debug/unclecode rust provider tool-result-turn-entries openai
	printf '[{"role":"user","content":"hi"}]\0[{"toolName":"read_file","toolCallId":"call_1","kind":"success","isError":false,"content":"ok"}]' | target/debug/unclecode rust provider tool-result-turn-step openai
	printf '[{"dataUrl":"data:image/png;base64,AAAA"}]' | target/debug/unclecode rust provider openai-user-message inspect
	printf 'working\0[{"id":"call_1","function":{"name":"search","arguments":"{}"}}]' | target/debug/unclecode rust provider openai-assistant-message
	printf 'ok' | target/debug/unclecode rust provider openai-tool-message call_1
	printf '[{"role":"user","content":"hi"}]' | target/debug/unclecode rust provider openai-responses-input
	printf '[{"name":"search","description":"Search","input_schema":{"type":"object","properties":{"q":{"type":"string"}}}}]' | target/debug/unclecode rust provider openai-responses-tools
	printf 'system prompt\0[{"role":"user","content":"hi"}]' | target/debug/unclecode rust provider gemini-query-messages
	printf '[{"name":"search","description":"Search","input_schema":{"type":"object","properties":{"q":{"type":"string"}}}}]' | target/debug/unclecode rust provider gemini-tools
	printf '[{"mimeType":"image/png","dataUrl":"data:image/png;base64,AAAA"}]' | target/debug/unclecode rust provider gemini-user-content inspect
	printf 'ok' | target/debug/unclecode rust provider gemini-function-response run_shell fc_1 success no
	printf 'boom' | target/debug/unclecode rust provider gemini-function-response run_shell fc_1 error yes
	printf '{"candidates":[{"content":{"parts":[{"text":"ok"},{"functionCall":{"id":"fc_1","name":"run_shell","args":{"command":"echo ok"}}}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2}}' | target/debug/unclecode rust provider gemini-response gemini-2.5-pro
	printf 'system\0[{"role":"user","parts":[{"text":"hi"}]}]\0[{"name":"run_shell"}]' | target/debug/unclecode rust provider gemini-generate-request gemini-3.1-flash yes
	printf 'system prompt\0[{"role":"user","content":"hi"}]' | target/debug/unclecode rust provider anthropic-query-messages
	printf 'sk-ant-test' | target/debug/unclecode rust provider anthropic-request-spec
	printf '[{"mimeType":"image/png","dataUrl":"data:image/png;base64,AAAA"}]' | target/debug/unclecode rust provider anthropic-user-message inspect
	printf 'ok' | target/debug/unclecode rust provider anthropic-tool-result tu_1 no
	printf 'boom' | target/debug/unclecode rust provider anthropic-tool-result tu_1 yes
	printf '{"content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"tu_1","name":"run_shell","input":{"command":"echo ok"}}],"usage":{"input_tokens":1,"output_tokens":2}}' | target/debug/unclecode rust provider anthropic-response claude-sonnet-4-6
	printf 'system\0[{"role":"user","content":"hi"}]\0[{"name":"run_shell"}]' | target/debug/unclecode rust provider anthropic-messages-request claude-sonnet-4-6
	printf 'system\0[{"type":"message","role":"user","content":[]}]\0[]' | target/debug/unclecode rust provider openai-codex-body gpt-5.5 medium none
	printf 'data: {"type":"response.completed"}\n\n' | target/debug/unclecode rust sse data-blocks
	printf 'data: {"type":"response.completed","response":{"id":"resp-smoke"}}\n\n' | target/debug/unclecode rust sse responses-records
	printf 'data: {"type":"response.completed","response":{"id":"resp-smoke"}}\n\n' | target/debug/unclecode rust sse responses-result
	printf 'data: {"type":"response.completed","response":{"id":"resp-smoke"}}\n\n' | target/debug/unclecode rust sse responses-message
	printf 'data: {"type":"response.completed","response":{"id":"resp-smoke"}}\n\n' | target/debug/unclecode rust provider openai-responses-message gpt-5.5
	target/debug/unclecode rust harness inspect "$PWD"
	target/debug/unclecode rust harness preset team-auditor
	target/debug/unclecode rust perf startup
	rm -rf target/harness-smoke && mkdir -p target/harness-smoke/.codex && printf 'model_reasoning_effort = "high"\napprovals_reviewer = "user"\n' > target/harness-smoke/.codex/config.toml
	target/debug/unclecode rust harness apply yolo target/harness-smoke
		printf 'ghp_%036d' 0 | target/debug/unclecode rust redact
printf 'abc' | target/debug/unclecode rust sha256
printf 'abc' | target/debug/unclecode rust sha256-base64url
target/debug/unclecode rust run -- node -e "process.stdout.write('native-runtime-ok')"
target/debug/unclecode rust shell -- pwd
printf 'Cargo.toml' | target/debug/unclecode rust path assert existing
printf 'target/path-smoke.txt' | target/debug/unclecode rust path assert allow-missing
target/debug/unclecode rust aci list rust
target/debug/unclecode rust aci read Cargo.toml
target/debug/unclecode rust aci view Cargo.toml 5
target/debug/unclecode rust aci view-json Cargo.toml 5 2
printf 'rust-write-ok' | target/debug/unclecode rust aci write target/rust-write-smoke.txt
printf 'alpha\nbeta\ngamma\n' | target/debug/unclecode rust aci write target/rust-edit-smoke.txt
printf 'BETA' | target/debug/unclecode rust aci edit-json target/rust-edit-smoke.txt 2 2
target/debug/unclecode rust aci search unclecode-core rust
target/debug/unclecode rust aci search-json unclecode-core rust 3 1
target/debug/unclecode rust aci find-json Cargo 5
target/debug/unclecode rust aci glob '**/*.rs'
printf '%s\n' '--- a/x.txt' '+++ b/x.txt' '@@ -1 +1 @@' '-old' '+new' | target/debug/unclecode rust aci parse-patch
printf '%s\n' '--- a/target/rust-write-smoke.txt' '+++ b/target/rust-write-smoke.txt' '@@ -1 +1 @@' '-rust-write-ok' '+rust-patch-ok' | target/debug/unclecode rust aci apply-patch
```

The live TypeScript tool surface now prefers this Rust ACI path for:

- `toolHandlers.list_files`
- `toolHandlers.read_file`
- `toolHandlers.write_file`
- `toolHandlers.search_text`
- `toolHandlers.run_shell`

The team mini-loop executor now also routes `read_file`, `write_file`,
`search_text`, `list_files`, and `apply_patch` through Rust ACI (`view`,
`write`, `search`, `glob`, and `apply-patch`) instead of the TypeScript
file-viewer/write/search/glob/apply-patch helpers. TypeScript still owns
mini-loop observation shaping.

The public TypeScript ACI compatibility export for unified diff parsing and
patch application is now also Rust-backed: `parseUnifiedDiff` calls
`unclecode rust aci parse-patch`, and `applyPatch` calls
`unclecode rust aci apply-patch`. TypeScript keeps only the compatibility
types and JSON shape validation.

The public TypeScript ACI file viewer compatibility export is Rust-backed as
well. `openFile`, `gotoLine`, and `scroll` call
`unclecode rust aci view-json`, so line counting, window clamping, path
containment, and rendered numbered content are owned by Rust. TypeScript keeps
only the legacy function names and state-shape validation.

The public TypeScript ACI search compatibility export is Rust-backed as well.
`findFile` calls `unclecode rust aci find-json`, and `searchDir` calls
`unclecode rust aci search-json`; Rust owns ripgrep argv construction, literal
query protection, caps, glob filters, result shaping, and workspace containment.
TypeScript keeps only compatibility types, JSON validation, and remaps Rust path
guard failures into the legacy `PathContainmentError` class.

The public TypeScript path containment compatibility export is Rust-backed as
well. `assertWithinWorkspace` calls `unclecode rust path assert` over stdin, so
canonicalization, symlink escape rejection, traversal rejection, missing-leaf
resolution, and workspace prefix checks are owned by Rust. TypeScript keeps the
legacy `PathContainmentError` class and NFC input normalization for API
compatibility with existing callers.

The public TypeScript ACI file editor compatibility export is Rust-backed for
file mutation. `editFile` calls `unclecode rust aci edit-json` for line-range
validation, content replacement, preview generation, and write; lint-failure
rollback calls `unclecode rust aci restore`, and the existing 3-part lint error
message is rendered by `unclecode rust aci lint-failure-message`. TypeScript
keeps the injected linter runner contract because tests and callers can still
provide custom lint behavior.

The live work-shell queue also uses the Rust persistent queue for queued
follow-up text:

- busy-turn follow-ups call `unclecode rust queue push`
- queue drain calls `unclecode rust queue pop`
- `/queue` count is backed by `unclecode rust queue len`
- `/queue` backlog previews are backed by `unclecode rust queue list`
- `/queue clear` is resolved by the Rust command router and clears the Rust
  persistent queue without interrupting the active turn

Attachment payloads remain process-local while the text backlog is Rust-owned.

The work-turn orchestrator now delegates intent classification, fallback
complex-task generation, worker-budget policy, planner response parsing,
changed-file extraction, planner/guardian/synthesis prompt construction, and core orchestrator
trace-event payload construction to `unclecode rust orchestrator`. This removes
another TypeScript regex/string-template decision point from the planner/executor
boundary: TypeScript still owns async execution and trace timing, but the
prompt-to-simple/complex/research decision, static executor task shape,
mode-to-worker-count policy,
LLM-planner JSON extraction, agent-facing review/synthesis wording, and UI trace
payload wording are native. WorkAgent planner-running and final synthesis
reviewer traces use the same Rust trace-event contract, so the two orchestration
layers no longer diverge in their trace payload copy.

The OpenAI provider path now builds request specs, request bodies, messages,
response parsing, default HTTP POST transport, the stateless one-shot `query()`
path, and the live Chat Completions model-call path through Rust. Tests can
still inject `fetchImpl` for deterministic provider unit coverage, but the
non-injected production query path calls `unclecode rust provider
openai-chat-query`, which internally owns message/tool wire conversion, body
construction, HTTP POST, response parsing, action normalization, and `costUsd`
estimation. The non-injected live `runTurn()` path calls `unclecode rust
provider openai-chat-complete` for each OpenAI API model request, so Rust owns
the chat-completion HTTP exchange, response parser, and normalized action
projection while TypeScript still keeps the temporary tool loop and handler
dispatch.

The Rust HTTP surface also exposes proxy policy inspection through
`unclecode rust http proxy-policy <url>`, including `HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` decisions. This makes provider
transport routing debuggable before the TypeScript bridge is removed.
Rendered proxy policy JSON now redacts credentials from proxy URLs, so terminal
diagnostics can explain which proxy is active without leaking `user:password`
material from the shell environment.

The same Rust HTTP path now owns transient retry behavior for default OpenAI
transport calls. `unclecode rust http post` retries temporary transport
failures and 429/5xx responses before returning the final response envelope,
including the attempt count.
Provider-specific POST commands now exist for the final bridge removal path:
`unclecode rust provider openai-post`, `gemini-post`, and `anthropic-post`
combine request-spec resolution with Rust HTTP execution. The reusable owner is
`unclecode-core::provider_transport`, so this is no longer just CLI command
glue. TypeScript keeps injected test-client paths, but non-injected
Anthropic/Gemini and OpenAI Codex transport no longer need to stitch request
specs into generic HTTP calls.
OpenAI one-shot `query` and live chat-completion paths now reuse the same
`provider_transport::post_openai_chat_response` function, so OpenAI REST
transport construction has one Rust core owner across CLI commands and
provider runtime helpers.
The provider tool-loop iteration limit is now exposed by Rust through
`unclecode rust provider loop-limit`; TypeScript caches that contract instead
of carrying its own hard-coded loop maximum.

Gemini stateless `query` and live `runTurn` calls now also use Rust-owned REST
request specs and the Rust HTTP transport when tests do not inject a SDK
client. The request target is `GEMINI_API_BASE_URL` when set, otherwise the
official Gemini `generativelanguage.googleapis.com/v1beta` endpoint. The
non-injected path now forwards raw Rust HTTP response text directly into
`unclecode rust provider gemini-response`, so TypeScript no longer parses the
live Gemini JSON response before provider normalization or `costUsd` projection.
The live Gemini non-SDK path now posts through `unclecode rust provider
gemini-post`, which owns request-spec resolution plus HTTP execution in one
Rust command instead of stitching `gemini-request-spec-json` and `http post`
together in TypeScript.

Provider routing now has a Rust-owned JSON metadata surface through
`unclecode rust model provider-route-json`. TypeScript still instantiates the
runtime client classes, but runtime provider validation and route metadata now
come from Rust so proxy/fallback policy can move behind the same command.
OpenAI now reports `transport=native` for the Rust `/v1/responses` route instead
of the older compat label, so GPT-5.5/GPT-5.4 route status no longer presents a
native runtime as a compatibility proxy.
That route metadata includes the provider endpoint URL plus Rust-resolved proxy
policy fields: selected proxy URL, source env var, bypass state, target host,
and `NO_PROXY` entries. Provider package callers consume this single Rust
router envelope instead of recomputing or key/value parsing endpoint/proxy
facts in TypeScript.
The selected proxy URL is display-safe in both key/value and JSON route
commands: Rust preserves host/port/source while replacing proxy credentials
with `redacted` before terminal output reaches TUI status, trace lines, or CLI
diagnostics.

Top-level CLI slash routing now has a Rust-owned builtin route surface through
`unclecode rust command route`. Builtin aliases, prefix matching,
plain-input detection, and dynamic `/mode set <mode>` routing now come from the
Rust command router.
Work-shell slash routing also uses `unclecode rust command work-shell-route` for
builtin operational commands and dynamic prompt/research/auth/mode command
routing. TypeScript still owns suggestion metadata, but no longer owns the
work-shell builtin submit router.
Work-shell submit routing now trusts `unclecode rust command submit-route` for
builtin, prompt, local memory, secure-entry, busy-ignore, and chat decisions.
TypeScript only performs the extension slash fallback that depends on the
reload-sensitive manifest cache.
Standalone work-shell builtin command resolution now comes from `unclecode rust
command builtin-command`; TypeScript validates the returned JSON shape but no
longer re-implements exact builtin, trace-mode, model, reasoning, or skill
command matching.
Prompt command bodies for `/review` and `/commit` now come from `unclecode rust
command prompt-command`, so the text that becomes the agent's actual work
instruction is no longer a TypeScript-owned contract.
Prompt slash-command classification now comes from `unclecode rust command
prompt-slash-command`, so `/review`/`/commit` focus extraction from routed
slash arrays stays native even when submit fallback code handles dynamic routes.
Work-shell inline action classification now comes from `unclecode rust command
inline-action`, so `/doctor`, `/auth`, `/research`, `/mode`, `/mcp`, and
`/mmbridge` slash routes map to dashboard action IDs through the native command
router. Rust also extracts `/research run ...` prompts, and the remaining Node
CLI compatibility seam now delegates research execution to the Rust run report.
Local memory command parsing for `/memories` and `/remember` now comes from
`unclecode rust command local-command`; TypeScript validates the returned JSON
shape but no longer re-implements scope/default/usage parsing.
Extension manifest loading now uses `unclecode rust command
extension-slash-commands` for plugin command fallback and `unclecode rust command
extension-manifests` for config overlays and status summaries. TypeScript keeps
only the reload-sensitive manifest cache.

The live work-shell session snapshot path uses the Rust session store for:

- recent session list backing data
- work-shell checkpoint/event-log writes
- work-shell resume trace-mode reads
- session metadata including model, summary, state, mode, and trace mode

The JSON shape remains compatible with the existing TypeScript session-store
fixtures while write/list/resume ownership moves to Rust.

The session-store and provider packages now use the Rust redaction engine for:

- session event/checkpoint JSON string redaction
- project-memory record redaction
- provider streamed reasoning/tool trace delta redaction

The session-store package now uses Rust session path derivation for:

- project opaque bucket IDs
- session event-log/checkpoint paths
- project-memory DB paths
- research artifact directories

The CLI fast sessions path also uses the same Rust session path derivation, so
`unclecode sessions` no longer carries a separate TypeScript opaque-id/hash
implementation.
The root CLI `sessions fork` and `sessions share` paths are Rust-native. The
Rust locator reads checkpoint contents to resolve opaque session filenames, so
fork/share works with the real hashed session-store layout instead of assuming
filenames contain the raw session id.

The team worker and mini-loop step tracing now use Rust SHA-256 for task,
action-argument, and observation hashes instead of Node `crypto`.
The disk-backed team file ownership registry also uses Rust SHA-256 for lock
file names.
The session-store team-run checkpoint chain also uses Rust SHA-256 for run IDs
and append-only line hashes.
TeamBinding code citations now use Rust SHA-256 for file content hashes, so
team SSOT citation generation and verification no longer use Node `crypto`.
OpenAI browser OAuth PKCE S256 code challenges now use Rust SHA-256 base64url
encoding instead of Node `crypto`.
CLI session share slugs now use Rust SHA-256 for their deterministic
fingerprint segment.
Context broker guidance dedupe and worktree freshness fingerprints now use
Rust SHA-256, including byte-preserving stdin hashing for file contents.
Workspace guidance loading now has a Rust-owned context surface through
`unclecode rust context guidance <cwd> <home-dir|->`. Rust discovers AGENTS,
CLAUDE, GEMINI, UNCLECODE, local overrides, and `.sisyphus/rules/*.md`, then
returns the system prompt appendix, loaded-source summary, duplicate guidance
notes, and basic conflict explanations. TypeScript only supplies already-loaded
project skills while `/context` and `/reload` consume the Rust-built payload.
Repo-map generation, repo-map cache tokens, worktree fingerprints, and context
packet freshness checks now run through `unclecode rust context
repo-map|repo-map-token|worktree-fingerprint|freshness`. Rust owns git status,
tracked file scanning, binary filtering, line counting, hotspot scoring inputs,
dirty-worktree hashing, and stale/unknown freshness decisions; TypeScript now
validates the returned payload shape and keeps packet assembly glue.
Context packet selection now runs through `unclecode rust context selection`,
with Rust owning token budgets, token estimation, hotspot slicing, changed-file
diffs, candidate path selection, policy-signal derivation, readable content
inclusion, and token-limit enforcement. TypeScript now restores the included
content entries into a `Map` and attaches provenance/id metadata.
Workspace skill discovery and named skill loading now run through
`unclecode rust context skills metadata|list` and `unclecode rust context
skill-load`. Rust owns SKILL.md breadth-first discovery, frontmatter parsing,
summary generation, project/user scope tagging, duplicate suppression, legacy
superpowers filtering, and load-attempt reporting; TypeScript keeps only the
metadata cache and payload validation.
Work-shell Queue, inline command, Status, Harness, Skills, loaded-skill, Memories, and
Auth entry/progress panels now
run through `unclecode rust ux panel
<queue|context|inline-command|status|harness|skills|skill|memories|auth-secure-entry|auth-progress>`.
Rust owns the queue / steer copy, backlog state lines, context source/health
summaries, inline command titles/empty-output copy, harness command affordances,
skill list presentation, memory empty-state copy, secure key-entry copy, and
OAuth progress ordering for these terminal surfaces while TypeScript validates the panel
payload and wires it into the existing shell engine. Status now also surfaces
The live `/harness` builtin result now runs through `unclecode rust ux
harness-command`. Rust owns the transcript copy, worker budget display,
auto-continue display, and returned Harness panel payload; TypeScript only
validates the payload and applies it to the shell state until the full loop
moves.
Rust router/proxy metadata so `/status` shows the runtime provider, endpoint,
and proxy/bypass decision instead of hiding transport state.
The live `/skills` builtin result now runs through `unclecode rust ux
skills-command`. Rust owns the loaded/empty transcript copy and returned Skills
panel payload; TypeScript keeps only payload validation and shell state wiring.
The live `/help` builtin result now runs through `unclecode rust ux
help-command`. Rust owns the help transcript copy and returned help panel
payload; TypeScript keeps only payload validation and shell state wiring.
The live `/context` builtin result now runs through `unclecode rust ux
context-command`. Rust owns the transcript copy and expanded context panel
payload for source/health/guidance/bridge/memory/live-trace inspection;
TypeScript keeps only payload validation and shell state wiring.
The live `/queue` and `/queue clear` builtin results now run through
`unclecode rust ux queue-command`. Rust owns the transcript copy and returned
Queue panel payload, including busy-state messaging, clear-result copy, backlog
counts, worker budget, queued item previews, and steer guidance. TypeScript
keeps only payload validation and shell state wiring.
The live `/auth key` secure-entry builtin result now runs through `unclecode
rust ux auth-key-command`. Rust owns the composer-mode transition payload, user
transcript entry, and secure API key entry panel payload; TypeScript keeps only
payload validation and shell state wiring.
Secure API key entry submit results now run through `unclecode rust ux
auth-key-submit-result`. Rust owns unavailable/error/success transcript copy,
secure-entry retry panels, status fallback panels, auth state patches, inline
result panels, and trace-line handoff; TypeScript only performs credential
write and auth refresh side effects until the full shell loop moves.
OAuth progress updates now run through `unclecode rust ux auth-progress-result`.
Rust owns the live Auth panel patch and progress-line ordering while TypeScript
only streams progress events from the running auth command.
Secure input cancellation now runs through `unclecode rust ux
sensitive-input-cancel-result`. Rust owns the cancel transcript entry,
composer reset value, and status panel rebuild with route/proxy/context lines,
so Esc from secret entry returns to a readable native Session status surface.
Prompt-turn failures now run through `unclecode rust ux prompt-failure-result`.
Rust owns the visible failure transcript entry, auth-label patch, turn-duration
patch, and auth-failure Session status panel with route/proxy/context issue
lines; TypeScript keeps only provider execution, auth refresh, and payload
application until the full prompt loop moves.
Prompt-turn success results now run through `unclecode rust ux
prompt-success-result`. Rust owns the assistant transcript entry and
bridge/memory/duration patch shape while TypeScript keeps provider execution
and bridge/memory side-effect calls until those services move.
Prompt-turn lifecycle busy patches now run through `unclecode rust ux
prompt-start-result` and `prompt-finalize-result`. Rust owns the thinking
status, turn-start timestamp patch, and idle cleanup flags for the shell loop.
Post-turn bridge/memory effects now run through `unclecode rust ux
post-turn-success-result`. Rust owns bridge-line merging, memory-line echo,
and the bridge/memory synthetic trace event payloads while TypeScript keeps
the storage side-effect calls until the bridge and memory services move.
The live `/skill <name>` builtin result now runs through `unclecode rust ux
skill-command`. Rust owns missing-name usage copy, load-error copy, read-attempt
transcript entries, loaded-skill transcript copy, and the returned Skill panel
payload; TypeScript keeps only skill file loading plus payload validation and
shell state wiring.
The live `/tools` builtin result now runs through `unclecode rust ux
tools-command`. Rust owns the user/system transcript copy for available tool
lines; TypeScript keeps only the current tool-list source and payload
validation.
The live `/status` builtin result now runs through `unclecode rust ux
status-command`. Rust owns the transcript copy, provider route/proxy resolution,
context source/health inspection, and returned Session status panel payload;
TypeScript keeps only current shell state collection and payload validation.
`/status` also carries current context summary, bridge, memory, and live trace
lines into the Rust panel, so the same surface shows what context the agent is
working from instead of forcing users to infer hidden state.
Terminal text cleanup now also has `unclecode rust ux text
<normalize-markdown|busy-status|trace-line|attachment-preview|inline-command-summary|inline-image-support|inline-image-sequence|work-shell-transition|wrap-display|panel-line-class|panel-layout|entry-presentation|attachment-layout|viewport-layout|error-message|provider-title|runtime-label|empty-conversation-hint|composer-hint|thinking-line|status-line|usage-line|footer-line>`,
so markdown stripping, busy status label normalization, agent/tool trace line
formatting, provider route/proxy trace lines, inline command transcript
summaries, provider/auth error guidance, image attachment preview/support copy,
work-shell header/status copy, composer hints, composer/attachment layout,
viewport width layout, body text wrapping, panel-line classification, panel
layout/anchor/min-height decisions, entry presentation/layout, and footer
truncation are Rust-owned while the current Ink renderer caches results to avoid
per-frame process work.
Workspace reload and sensitive-input cancel transcript entries are also
Rust-owned through the same UX text contract, leaving TypeScript to validate and
append native chat-entry payloads.
The `/model` slash picker suggestions now run through `unclecode rust ux
model-suggestions <provider> <current-model> <input>`. Rust owns current-model
ordering, provider catalog slicing, reasoning support labels, unsupported-model
warnings, `/model list` inclusion, and prefix filtering; TypeScript keeps only
slash registry routing and payload validation.
The `/model` slash picker panel now runs through `unclecode rust ux panel
model-picker`, so the live picker rows, selected marker, current-model summary,
reasoning/support wording, and controls copy share the native UX contract.
The live work-shell `/model` command panel now runs through `unclecode rust ux
model-panel`. Rust owns the terminal-facing current-model summary, reasoning
label, choice rows, active marker, and control copy. TypeScript still applies
the selected model/reasoning state transition until the full work-shell runtime
moves to Rust.
The live `/model` builtin execution now runs through `unclecode rust ux
model-builtin-command`. Rust owns command normalization, provider catalog
expansion, next-model selection, reasoning fallback/unsupported decisions,
transcript copy, and the returned Model picker panel payload; TypeScript keeps
only payload validation and runtime setting application until the full shell
loop moves.
The live `/reasoning` command transition now runs through `unclecode rust ux
reasoning-builtin-command`. Rust owns command normalization, unsupported-model
guardrails, supported-effort validation, default reset behavior, user-facing
result copy, provider route/proxy resolution, and the returned Session status
panel payload; TypeScript keeps only payload validation and runtime setting
application until the full shell loop moves.
The live trace-mode transition now runs through `unclecode rust ux
trace-mode-command`. Rust owns `/verbose`/`/minimal` transcript copy, trace-mode
patch payloads, trace-line clearing for minimal mode, and the rebuilt context
panel payload; TypeScript keeps only payload validation, state patch application,
and persistence until the full shell loop moves.
Live trace-event application now runs through `unclecode rust ux trace-event`.
Rust owns busy-status set/clear decisions, turn-start timestamp extraction,
minimal/verbose transcript visibility, and trace-entry role selection. TypeScript
keeps only applying the returned patch and preserving JavaScript `undefined`
semantics for field clears until the whole work-shell state reducer moves.
Work-shell trace-line state patching now runs through `unclecode rust ux
trace-line-patch`. Rust owns trace-line prepending, the 8-line cap, and pinned
panel preservation decisions; TypeScript keeps only rebuilding the existing
context panel when the Rust decision says it is allowed.
Work-shell trace-mode state patching now runs through `unclecode rust ux
trace-mode-patch`. Rust owns verbose/minimal patch shape, minimal trace clearing,
and whether the context panel should be rebuilt; TypeScript keeps only invoking
the existing context panel renderer when requested.
Work-shell busy state patching now runs through `unclecode rust ux
busy-state-patch`. Rust owns `isBusy`, busy-status set/clear, and
current-turn-start timestamp set/clear decisions; TypeScript keeps only mapping
Rust's explicit clear actions back to JavaScript `undefined` fields.
Work-shell auth state patching now runs through `unclecode rust ux
auth-state-patch`. Rust owns auth-label updates and whether launcher guidance
lines should be set or preserved; TypeScript keeps only applying the returned
partial state patch.
Work-shell dashboard home sync now runs through `unclecode rust ux
dashboard-home-patch|dashboard-home-sync-state|dashboard-home-refresh`. Rust
owns the home-state patch shape and the refresh decision for busy completion,
auth-label changes, and first bridge/memory line changes; React keeps only the
effect wiring and async refresh call.
Work-shell initial state now runs through `unclecode rust ux initial-state`.
Rust owns boot-time empty collections, default composer/busy flags, and
mode-sensitive trace-mode defaults (`ultrawork` starts verbose, other modes
start minimal unless explicitly restored); TypeScript keeps only attaching the
existing rendered context panel.
Work-shell transcript append patches now run through `unclecode rust ux
append-entries-patch`. Rust owns ordered entry concatenation for conversation
state updates; TypeScript keeps only applying the returned entries array.
Work-shell mode-default reasoning normalization now runs through `unclecode rust
ux mode-default-reasoning`. Rust owns preserving unsupported reasoning and
tagging supported reasoning as `mode-default` for shell command payloads.
General slash picker suggestions now run through `unclecode rust ux
slash-suggestions <input>` with registry entries streamed on stdin. Rust owns
`/auth` preferred ordering, `/mode set` profile expansion, prefix/include/token
scoring, and duplicate suppression; TypeScript keeps command registry assembly,
`/model` provider context, and payload validation.
Slash submit blocking now runs through `unclecode rust ux slash-submit-block`.
Rust owns `/model` picker blocking, exact model-pick passthrough, and unresolved
slash-with-suggestions blocking; TypeScript keeps only resolving available
routes and suggestion rows before asking Rust for the final decision.
Work-shell prompt-turn helpers now run through `unclecode rust ux prompt-turn`.
Rust owns chat/prompt-command turn summary construction, read-only mode edit
guarding, permission-seeking stall detection, stall outro stripping, and the
auto-continue follow-up prompt. TypeScript keeps only the async provider call
needed to continue a stalled answer.
Work-shell keyboard and submit decisions now run through `unclecode rust ux
input-action|submit-action`. Rust owns Ctrl+C exit, Shift+Tab mode cycling,
Tab slash completion, arrow navigation, Esc priority between sensitive input,
overlay, and sessions, busy submit queuing, partial slash blocking, and
selected slash submit decisions. TypeScript keeps only a no-op fast path for
ordinary text keystrokes so typing does not spawn a Rust process per character.
General slash command panels now run through `unclecode rust ux panel
commands`, so non-auth/non-model picker rows, selection markers, match heading,
and command controls copy are Rust-owned.
Auth slash panels now run through `unclecode rust ux panel auth-picker`, so the
current auth summary, OAuth/API-key route copy, remembered auth guidance,
route rows, and auth tips are native UX surfaces.
Work-shell help and status panels now run through `unclecode rust ux panel
help|status`, so default shell guidance, provider/model/reasoning state,
auth display, and workspace status are Rust-owned terminal surfaces.
Recent sessions panels now run through `unclecode rust ux panel sessions`, so
loading and loaded session overlays use the same native panel contract.
The live `/sessions` builtin result now runs through `unclecode rust ux
sessions-command`. Rust owns the overlay-opening transcript entry while the
existing Rust panel contract still owns loading and loaded session overlays;
TypeScript only performs the session-list side effect until the full shell loop
moves.
The live `/reload` builtin result now runs through `unclecode rust ux
reload-command`. Rust owns the start and completion transcript entries for
workspace context refresh; TypeScript only performs the reload side effect and
validates the returned chat-entry payload until the full shell loop moves.
The local `/memories` and `/remember` command results now run through
`unclecode rust ux memories-command|remember-command`. Rust owns the memory
listing transcript, Memories panel patch, remember usage feedback, remembered
tool transcript, and trace-line handoff shape; TypeScript only performs the
memory read/write side effects and validates the returned payload until the
full shell loop moves.
Inline operational command completion now runs through `unclecode rust ux
inline-command-result`. Rust owns API-key argument redaction, success/failure
completion copy, result transcript entries, inline result panel patch,
auth-launcher state patch, and trace-line handoff; TypeScript only performs the
command side effect and auth refresh until the full shell loop moves.
Inline operational command visibility now runs through `unclecode rust ux
inline-command-visibility`. Rust owns pre-execution redaction, visible argument
projection, and auth/auth-login classification before TypeScript appends any
user-visible command transcript entry.
The live `/clear` builtin result now runs through `unclecode rust ux
clear-command`. Rust owns the terminal-facing cleared transcript entry and
state patch payload; TypeScript only triggers the agent clear side-effect and
validates the returned patch until the full shell loop moves.
Memory-bus citations and retrieval hashes now use Rust SHA-256 for episodic,
semantic, procedural, and external-doc memory surfaces.
Snapshot-store blob filenames and manifest content hashes now use Rust
SHA-256 over raw file bytes.
OpenAI OAuth JWT inspection for client-id reuse, expiry checks, and
`model.request` scope gating now runs through `unclecode rust auth
inspect-oauth-token`.
OpenAI browser OAuth authorization URL construction and callback code/state
validation now run through `unclecode rust auth authorization-url` and
`unclecode rust auth parse-callback`.
OpenAI OAuth and Codex device request bodies now run through `unclecode rust auth
request-body`, covering x-www-form-urlencoded API device/token/exchange bodies
and JSON Codex device bodies.
OpenAI OAuth and Codex token/device request endpoint specs now run through
`unclecode rust auth request-spec`; non-injected login/exchange paths post
through `unclecode rust http post`, while injected `fetch` remains a test seam.
OpenAI OAuth token endpoint response parsing for access/refresh token and
error fields now runs through `unclecode rust auth parse-token-response`.
OpenAI OAuth API and Codex device authorization response parsing now runs
through Rust auth parsers for device/usercode and Codex code-verifier fields.
Provider tool-call argument object normalization now runs through `unclecode
rust json normalize-object-arg`.
OpenAI Responses SSE `data:` block framing now runs through `unclecode rust sse
data-blocks`; the TypeScript provider bridge only parses the resulting JSON
event payloads while the stream framing rule lives in Rust.
OpenAI Responses SSE semantic records now run through `unclecode rust sse
responses-records`, including response IDs, text blocks, reasoning deltas and
blocks, and function-call tool-use blocks. The TypeScript provider bridge now
maps Rust records back into its temporary compatibility objects instead of
owning the Responses stream event switch.
OpenAI Responses SSE result projection now also runs through `unclecode rust sse
responses-result`, so Codex live `runTurn` receives Rust-built response ID,
reasoning delta, text, reasoning, and tool-use JSON instead of rebuilding those
blocks from tabbed records in TypeScript.
Codex live `runTurn` now uses `unclecode rust sse responses-message`, so the
assistant text and OpenAI-compatible `tool_calls` projection are Rust-owned
instead of being rebuilt from generic content blocks in TypeScript.
The OpenAI provider live Codex path now uses `unclecode rust provider
openai-responses-message`, which combines the Rust-built assistant message with
Rust-built reasoning trace events and normalized provider actions in one command
result. The Codex path no longer needs to feed Rust-projected `tool_calls` back
through `openai-tool-actions` before dispatch planning.
Harness status inspection and preset mutation for `.codex/config.toml` now run
through `unclecode rust harness inspect` and `unclecode rust harness apply`,
including model, reasoning effort, approval policy, multi-agent flag,
status-line entries, MCP server names, and named team presets.
Harness preset patch lookup now reads from Rust via `unclecode rust harness
preset`, leaving TypeScript as a command/parser bridge instead of the preset
source of truth.
OpenAI model registry and compatibility catalogs are Rust-owned and keep GPT-5.5
as the default frontier model, with GPT-5.4 and GPT-5.4-mini still present for
explicit operator selection.
The OpenAI compat catalog mirrors the Rust registry's frontier-first order:
`gpt-5.5`, `gpt-5.5`, `gpt-5.4-mini`, then `o4-mini` before older 4.1/4o
fallbacks, so the model picker does not bury the newer reasoning-capable option
behind stale fallback models.
Provider capability decisions now run through `unclecode rust model capability`,
so prompt-caching, tool-call, and session-memory support checks share the same
Rust model registry as provider routing and catalogs. TypeScript keeps only the
legacy `ProviderCapabilityMismatchError` throw shape.
Top-level `unclecode model ...` and slash-form `unclecode "/model ..."` now
resolve through the Rust CLI before the TypeScript bridge is considered.
Rust owns provider catalogs, route/key-value output, route JSON output,
reasoning support, pricing, cost estimates, provider detection, capability
checks, and bare model summaries on this native surface.
OpenAI API and Codex provider request endpoint/header specs now run through
`unclecode rust provider openai-request-spec-json`, including Codex account
header, event-stream accept header, originator, user-agent, and native Rust
request id. TypeScript now consumes the Rust-owned JSON request spec envelope
instead of parsing tabbed stdout records.
OpenAI API and Codex provider request body envelopes now run through `unclecode
rust provider openai-chat-body` and `unclecode rust provider openai-codex-body`.
Rust owns the provider-level wire envelope: model, tool choice, reasoning,
store/stream/include, parallel tool-call flag, and text verbosity contract.
Runtime reasoning effort enablement now runs through `unclecode rust provider
reasoning-effort`, so OpenAI API, OpenAI query, and Codex paths share one
Rust-owned rule for when to include a concrete effort versus disabling
reasoning. TypeScript caches the normalized Rust decision only to avoid repeated
bridge calls.
Provider tool include and tool-choice policy now runs through `unclecode rust
provider tool-policy`, covering OpenAI live chat, OpenAI query, Codex live, and
Gemini live/query request surfaces. TypeScript still builds provider-specific
wire payloads, but no longer owns the surface-specific include-tools or
Codex `auto`/`none` decision.
The provider default system prompt and caller-provided prompt appendix merge now
run through `unclecode rust provider system-prompt`, so OpenAI, Anthropic, and
Gemini share one Rust-owned behavioral prompt contract. TypeScript caches the
string result and still carries provider-specific state arrays until those loops
move fully.
OpenAI API chat tool conversion and query-message conversion now run through
`unclecode rust provider openai-chat-tools` and `unclecode rust provider
openai-query-messages`, including default-system insertion and assistant
tool-call wire mapping.
OpenAI API chat response parsing now runs through `unclecode rust provider
openai-chat-response-json`, so content extraction, reasoning-content extraction,
tool-call extraction, token-usage extraction, response-cost projection, and the
normalized response envelope are Rust-owned. TypeScript still performs the transport `fetch` for
injected-test paths and dispatches tool handlers, but no longer owns the OpenAI
Chat Completions response record/envelope parser.
OpenAI stateless `query()` without an injected `fetchImpl` now runs through
`unclecode rust provider openai-chat-query`. Rust owns the whole one-shot request:
default-system insertion, tool conversion, body construction, proxy-aware HTTP
transport, response parsing, tool-action normalization, malformed argument
guarding, and cost estimation. TypeScript keeps only the injected-fetch test seam
and the higher-level provider interface.
OpenAI live `runTurn` message construction now runs through `unclecode rust
provider openai-user-message`, `openai-assistant-message`, and
`openai-tool-message`, so multimodal user content, assistant tool-call state,
and tool result message wire shapes are Rust-owned while TypeScript still keeps
the temporary in-memory vector and dispatches handlers.
OpenAI live `runTurn()` model calls without an injected `fetchImpl` now run
through `unclecode rust provider openai-chat-complete`. Rust owns the
proxy-aware Chat Completions HTTP POST, content/reasoning/tool-call parsing, and
malformed tool-argument guarding for the live OpenAI API path. That Rust
envelope now includes provider actions directly, avoiding the previous
toolCalls-to-OpenAI-wire-to-actions round trip in the non-injected path.
TypeScript still owns the outer loop that appends assistant/tool messages and
dispatches local tool handlers until the provider runtime client moves fully
into Rust.
OpenAI live/query tool-call action projection now comes directly from
`openai-chat-response-json`, `openai-chat-query`, `openai-chat-complete`, and
`openai-responses-message`, so call IDs, tool names, malformed argument
fallbacks, and handler input objects are Rust-owned without a TypeScript
tool-call re-normalization pass. `openai-tool-actions` remains available as a
compatibility smoke surface.
Provider live-loop policy now runs through `unclecode rust provider
loop-decision`, so OpenAI, Gemini, and Anthropic share a Rust-owned decision for
continue/final/iteration-limit outcomes and the limit fallback text. TypeScript
still invokes local tool handlers and appends provider-specific tool result
messages.
Live-loop tool dispatch gating now runs through `unclecode rust provider
iteration-action-plan`, so TypeScript no longer owns the local
`actions.length > 0 && i + 1 < maxIterations` policy. Rust decides whether a
model turn should dispatch local tools before the live loop calls handlers.
Provider model-response turn planning now runs through `unclecode rust provider
turn-step`, combining response entry append, assistant text update, and
continue/final/limit decision into one Rust-owned step for OpenAI, Anthropic,
and Gemini live loops.
Live provider iteration completion now runs through `unclecode rust provider
complete-turn-step`, which appends the model response entry, applies the
continue/final/limit decision, and appends provider-specific tool-result entries
when the loop continues. TypeScript still executes local handlers, but no longer
performs a separate post-handler state append in live `runTurn`.
Provider local-tool dispatch planning now runs through `unclecode rust provider
tool-dispatch-plan`, so handler-name matching and unknown-tool error outcomes
are Rust-owned. TypeScript still executes the selected local handlers.
Provider live-loop state append now runs through `unclecode rust provider
append-state`, so OpenAI `messages`, Anthropic `messages`, and Gemini `contents`
use one Rust-owned array extension surface. TypeScript still stores the mutable
in-memory vector until the entire provider loop is moved into Rust.
Provider turn start now runs through `unclecode rust provider start-turn`, so
provider-specific user entry construction plus state append are one Rust-owned
step for OpenAI, Anthropic, and Gemini live turns. TypeScript no longer
constructs live user-entry arrays before the loop.
Provider state reset now runs through `unclecode rust provider reset-state`, so
OpenAI re-seeds its system message while Anthropic/Gemini clear to empty state
through one Rust-owned lifecycle rule.
Provider runtime settings updates now run through `unclecode rust provider
runtime-settings`, so model trimming and OpenAI-only reasoning updates share one
Rust-owned provider lifecycle rule.
Provider attachment count/size caps now run through `unclecode rust provider
attachment-caps`, and OpenAI/Anthropic/Gemini user-message builders apply the
same Rust-owned cap internally before projecting image blocks.
Provider local-tool execution start now runs through `unclecode rust provider
tool-execution-start`, so started timestamp generation and the started trace
envelope are Rust-owned before TypeScript invokes the local handler.
Provider tool trace event envelopes now run through `unclecode rust provider
tool-trace-started` and `tool-trace-completed`, so started/completed event shape,
provider/tool/call IDs, error flag, output field, and duration calculation are
Rust-owned while TypeScript only executes the local handler and forwards the
resulting event to the trace listener.
Provider local-tool execution completion now runs through `unclecode rust
provider tool-execution-result`, so the completed trace envelope and normalized
tool result outcome are created together by Rust after TypeScript returns a
handler result or exception.
The live `runTurn` path uses `unclecode rust provider tool-execution-finish`,
so Rust also owns the completion timestamp for local tool execution and
preserves the original start timestamp across handler exceptions.
Successful local tool handler result normalization now runs through
`unclecode rust provider tool-execution-finish-result`, so TypeScript no longer
interprets handler `isError` defaults or `content` before building the completed
trace and normalized outcome.
OpenAI, Anthropic, and Gemini now share one thin TypeScript local-handler
execution helper around these Rust contracts instead of carrying three copied
dispatch/trace/outcome loops. TypeScript still calls the local handler, but the
remaining JS surface is a single choke point for the eventual Rust runtime
replacement.
OpenAI chat-completion reasoning deltas now run through `unclecode rust provider
reasoning-delta`, so redaction, trace shape, and temporary chat item IDs are
Rust-owned for that path. Codex Responses stream deltas now run through
`unclecode rust provider reasoning-delta-record`, so Rust preserves the stream
item ID while owning redaction and trace shape before TypeScript forwards the
event. The live Codex path consumes those stream traces through the higher-level
`openai-responses-message` command.
Provider tool result payloads now run through `unclecode rust provider
tool-result`, so OpenAI tool messages, Anthropic `tool_result` blocks, and Gemini
`functionResponse` parts use one Rust-owned outcome surface. TypeScript still
chooses the local handler, but no longer owns the provider-specific success,
error, or unknown-tool result envelope.
Anthropic and Gemini live-loop tool-result turn containers now run through
`unclecode rust provider tool-result-container`, so the provider-specific
`role: "user"` wrapper for Anthropic `content` and Gemini `parts` is also
Rust-owned.
Live-loop local tool outcomes still have standalone compatibility commands:
`tool-result-turn-entries` builds provider-specific entries and
`tool-result-turn-step` appends them to state. The live `runTurn` path now uses
the broader `complete-turn-step` contract instead, so a continued model
iteration appends both assistant response and tool-result turn inside one Rust
state transition.
Codex Responses input conversion now also runs through Rust via `unclecode rust
provider openai-responses-input`, including OpenAI-compatible message conversion,
image URL preservation, latest tool-turn slicing, and dangling/orphaned tool item
cleanup.
Codex Responses tool conversion now runs through `unclecode rust provider
openai-responses-tools`, so tool definition mapping, strict flag defaults, and
parameter schema pass-through are Rust-owned for the Codex backend.
Gemini query message conversion and function declaration conversion now run
through `unclecode rust provider gemini-query-messages` and `unclecode rust
provider gemini-tools`; TypeScript no longer owns the stateless query
contents/tool declaration mapper, and the default non-injected provider no
longer instantiates the Gemini SDK client.
Gemini live `runTurn` user content and tool-result functionResponse parts now
also run through `unclecode rust provider gemini-user-content` and `unclecode
rust provider gemini-function-response`, so prompt/image inline data conversion
and tool-response wire shape are Rust-owned while TypeScript still dispatches
tool handlers. The default non-injected path posts each live Gemini turn through
`unclecode rust http post`; injected clients remain only as a deterministic test
surface using a small structural client interface, so the provider package no
longer depends on `@google/genai`.
Gemini response parsing now runs through `unclecode rust provider
gemini-response`, including text aggregation, functionCall action extraction,
usage metadata extraction, `costUsd` projection, and model content preservation
for live `runTurn` state. Default Rust HTTP paths pass the raw response text directly into that
parser; only injected test clients still enter through a structural object.
Gemini SDK generateContent request envelope construction now runs through
`unclecode rust provider gemini-generate-request`, so TypeScript no longer owns
the model/contents/config/tools request shape before transport.
Anthropic query message conversion now runs through `unclecode rust provider
anthropic-query-messages`; the default non-injected `query` path posts through
Rust HTTP, so TypeScript no longer owns either the stateless query
system/message mapper or the provider transport.
Anthropic live `runTurn` user message and tool_result block construction now
runs through `unclecode rust provider anthropic-user-message` and `unclecode
rust provider anthropic-tool-result`, including supported image MIME filtering,
base64 payload extraction, and optional `is_error` field handling. TypeScript
still dispatches handlers, while the default non-injected live `runTurn` path
posts each Anthropic turn through `unclecode rust provider anthropic-post`,
which owns request-spec resolution plus HTTP execution in one Rust command.
Anthropic response parsing now runs through `unclecode rust provider
anthropic-response`, including text aggregation, tool_use action extraction,
usage token extraction, `costUsd` projection, and assistant message preservation
for live `runTurn` state. Default Rust HTTP paths pass the raw response text directly into that
parser; only injected test clients still enter through a structural object.
Anthropic SDK messages.create request envelope construction now runs through
`unclecode rust provider anthropic-messages-request`, including model,
max_tokens, system, messages, and tools fields. TypeScript keeps only the
temporary injected-client test path, and the default non-injected provider no
longer instantiates the Anthropic SDK client. The provider package no longer
depends on `@anthropic-ai/sdk`; injected tests use a structural
`messages.create` client.
Native startup timing now has a Rust smoke surface through `unclecode rust perf
startup`; this is the first perf probe for replacing Node bootstrap timing with
Rust-owned launch evidence.

The work-shell bootstrap/config path now uses the Rust OpenAI auth resolver for:

- auth label source used by the shell
- refresh-required / insufficient-scope issue lines
- env API key, env OAuth token, UncleCode credential file, and Codex auth file detection
- bearer-token extraction used by `loadConfig`
- runtime auth refresh after inline `/auth` commands
- Codex-vs-API runtime selection for scoped OAuth tokens
- provider-level `resolveOpenAIAuthStatus` and `unclecode auth status` rendering data
- root CLI `unclecode auth`, `unclecode auth --help`, `unclecode auth status`,
  `unclecode auth logout`, `unclecode auth login --api-key-stdin`, and
  slash-form `/auth status` dispatch before the TypeScript bridge is considered
- root CLI browser/device OAuth login is Rust-owned for the standard
  `OPENAI_OAUTH_CLIENT_ID` path, including PKCE URL generation, local callback
  waiting, authorization-code exchange, device-code polling, and credential
  file writes before the TypeScript bridge is considered
- root CLI `unclecode harness status`, `unclecode harness explain`,
  `unclecode harness apply`, and slash-form `/harness status` dispatch before
  the TypeScript bridge is considered
- root CLI `unclecode mode status`, `unclecode mode set`, slash-form
  `/mode status`, and split slash `/mode status` dispatch before the TypeScript
  bridge is considered
- root CLI `unclecode sessions`, `unclecode sessions fork`,
  `unclecode sessions share`, and slash-form `/sessions` dispatch before the
  TypeScript bridge is considered
- root CLI `unclecode resume <session-id>` and
  `unclecode resume <session-id> --json` dispatch before the TypeScript bridge
  is considered
- root CLI `unclecode research status`, `unclecode research status --json`,
  `unclecode research run <prompt...>`, `unclecode research run --json
  <prompt...>`, and slash-form `/research status` dispatch before the
  TypeScript bridge is considered
- root CLI `unclecode research` and `unclecode research --help` dispatch before
  the TypeScript bridge is considered
- TypeScript compatibility `research status`, `/research status`, and
  `research run` paths now delegate their report text/JSON to Rust instead of
  recomputing MCP profile, context packet summaries, artifacts, and session
  state in Node
- work runtime provider selection rejects unsupported providers through the
  Rust runtime decision contract instead of reinterpreting route metadata in
  TypeScript
- work-shell follow-up queue push, pop, count, list, and `/queue` backlog
  previews
- provider-level default `resolveOpenAIAuth` resolution for non-injected callers
- provider-level OpenAI model registry and reasoning-support lookups used by `/model`
- provider-level router endpoint/proxy metadata used by `resolveProviderRoute`
- provider-level runtime factory decision via `model provider-runtime-json`, so
  `createRuntimeProvider` no longer owns route support branching in TypeScript
- provider-level request-error diagnostics include provider, endpoint,
  proxy source/bypass, auth signal, retry state, attempt count, and compact
  response body from Rust
- provider-level capability checks used by `assertProviderCapability`
- provider-level runtime reasoning-effort enablement used by OpenAI API/query/Codex request bodies
- app-level reasoning config selection via `provider app-reasoning`, including
  non-OpenAI disablement, OpenAI model capability checks, mode defaults, and
  explicit override precedence
- live `/reasoning` command execution via `ux reasoning-builtin-command`,
  including unsupported-model guardrails, supported-effort validation, default
  reset behavior, user-facing result copy, provider route/proxy resolution, and
  returned Session status panel payload
- live trace-mode transitions via `ux trace-mode-command`, including
  `/verbose`/`/minimal` result copy, trace-line clearing, and the context panel
  payload rebuilt after returning to minimal mode
- live trace-event application via `ux trace-event`, including busy-status
  set/clear decisions, turn-start timestamp extraction, trace transcript role,
  and minimal/verbose visibility
- live `/context` builtin execution via `ux context-command`, including
  transcript copy and expanded context panel payload
- live `/queue` and `/queue clear` builtin execution via `ux queue-command`,
  including transcript copy and Queue panel payload
- live `/auth key` secure-entry execution via `ux auth-key-command`, including
  composer-mode transition and secure entry panel payload
- live `/skill <name>` execution via `ux skill-command`, including usage/error
  copy, read-attempt transcript entries, and loaded skill panel payload
- live `/tools` builtin execution via `ux tools-command`, including tool-list
  transcript copy
- live `/status` builtin execution via `ux status-command`, including provider
  route/proxy resolution, context source/health lines, and Session status panel
  payload
- provider-level tool include/tool-choice policy used by OpenAI API/query/Codex and Gemini
- provider-level default system prompt and caller appendix merge used by OpenAI/Anthropic/Gemini
- provider-level OpenAI stateless `query()` default path via `openai-chat-query`
- provider-level OpenAI live `runTurn()` default model-call path via
  `openai-chat-complete`
- provider-level OpenAI live model-call action projection in
  `openai-chat-complete`
- provider-level provider HTTP failure message formatting via `request-error`
- provider-level OpenAI response action projection via `openai-chat-response-json`,
  `openai-chat-query`, `openai-chat-complete`, and `openai-responses-message`
- provider-level live tool-loop continue/final/limit policy via
  `loop-decision`
- provider-level live local-tool dispatch gating via `iteration-action-plan`
- provider-level model-response turn planning via `turn-step`
- provider-level full live iteration completion via `complete-turn-step`
- provider-level local tool dispatch planning via `tool-dispatch-plan`
- provider-level live turn-state array append via `append-state`
- provider-level live turn start and user-entry append via `start-turn`
- provider-level live turn-state reset via `reset-state`
- provider-level runtime settings updates via `runtime-settings`
- provider-level multimodal attachment caps via `attachment-caps`
- provider-level live tool-result turn compatibility append via
  `tool-result-turn-step`
- provider-level local tool start timestamp + trace projection via
  `tool-execution-start`
- provider-level tool trace envelope and duration policy via
  `tool-trace-started` / `tool-trace-completed`
- provider-level local tool completion trace + outcome projection via
  `tool-execution-result`
- provider-level live local tool completion timestamping via
  `tool-execution-finish`
- provider-level successful local tool result object normalization via
  `tool-execution-finish-result`
- provider-level chat reasoning delta trace projection via `reasoning-delta`
- provider-level stream reasoning delta trace projection via
  `reasoning-delta-record`
- Codex Responses SSE live assistant message projection via
  `responses-message`
- OpenAI provider Codex live message + trace projection via
  `openai-responses-message`
- OpenAI provider Codex live action projection via `openai-responses-message`
- provider-level local tool result payloads via `tool-result`
- provider-level Anthropic/Gemini tool result turn containers via
  `tool-result-container`
- provider-level batched tool result turn entries via `tool-result-turn-entries`
- shared provider labels/catalogs and team-worker model-family provider detection
- provider-level advisory model pricing and `costUsd` estimates
- provider runtime redaction for streamed reasoning/tool trace deltas
- CLI harness status inspection, preset mutation, and `.codex/config.toml` field extraction
- API-key credential save and local credential logout for CLI/work-shell auth actions
- OAuth credential persistence after Codex/API device and browser login flows
- OAuth token client-id/scope/expiry inspection for injected and default provider paths
- OAuth token endpoint access/refresh/error response parsing
- OAuth API/Codex device authorization response parsing
- provider tool-call argument object/defaulting normalization
- OpenAI credential-store file fallback writes, reads, permissions, and clears
- provider credential-store default runtime no longer dynamically imports
  Node `keytar`; default write/read/clear paths go through Rust credential
  file commands, with keytar retained only as an explicitly injected test seam

The TypeScript auth bridge remains as a compatibility seam for tests that
inject `readOpenAiAuthFile` directly, callers that pass custom fallback auth
paths, explicitly injected keytar test doubles, TUI progress hooks, and Codex
reusable-client device fallback. OAuth JWT parsing, credential file IO, root
browser callback login, root device polling, and default runtime credential
storage are Rust-owned. Refresh orchestration and custom injected test seams
remain in the TypeScript provider bridge until the provider client moves fully.

## Migration Order

1. Process/runtime runner
2. Queue and backlog state
3. Session log and NDJSON stores
4. File ownership locks
5. Path containment
6. ACI tools: read, search, edit, shell
7. Mini-loop agent
8. Provider clients and remaining OAuth refresh orchestration
9. Runtime startup performance checks
10. TUI
11. Remove the TypeScript bridge

## Next Removal Targets

The next migration step should wire the remaining Rust-owned session/runtime
pieces into the live work shell path, replacing these TypeScript owners:

- TypeScript project-memory session-store code that still reads or mutates the same store
- TypeScript OAuth refresh orchestration and OpenAI request client glue
- Full-screen work-shell `runTurn()` outer tool loop and provider runtime client
  state for package/built-CLI TUI compatibility surfaces. Root-bin
  non-interactive `work <prompt...>`, empty line-mode `work`, and root-bin
  `tui`/`center`/no-argument startup are already Rust-native.
- remaining TypeScript turn-orchestrator async execution, ownership waits, and
  trace dispatch around Rust-owned intent/task/prompt/trace payload decisions
- Remaining TypeScript `program.ts` command plumbing for direct
  `apps/unclecode-cli/dist/index.js` compatibility execution; the Rust binary
  no longer falls back to it for unknown commands
- Remaining TypeScript `program.ts` auth login compatibility plumbing for the
  direct package/built-CLI path. Root-bin auth status/logout/API-key stdin,
  saved-auth reporting, browser OAuth, standard device OAuth, and Codex-derived
  device OAuth are already Rust-native.
- Rust-native startup/performance benchmark replacing Node bootstrap timings
- non-OpenAI provider runtime clients
- Rust-native provider runtime clients; `/status` and active-turn trace already
  expose the Rust router/proxy decision
- remaining TypeScript CLI/provider/TUI bridge glue around the Rust tool calls
- terminal response UX polish: streaming status, command/result boundaries,
  streaming/error copy, command/result boundaries, and no ambiguous prompt
  interpretation
- full-screen TUI font/readability pass for CJK/Hangul width, contrast,
  density, input focus, and a consistently refined visual language, or a clear
  retirement path if line-mode becomes the default terminal UX
- context strategy: finish Rust-owned context explanation layer so context
  loading explains source choice, stale context, and missing context

## Verification

Use these gates while the bridge exists:

```sh
cargo test --workspace
cargo build --workspace
npm run build
node bin/unclecode.cjs --version
node bin/unclecode.cjs --help
OPENAI_API_KEY=sk-test node bin/unclecode.cjs auth status
OPENAI_API_KEY=sk-test node bin/unclecode.cjs "/auth status"
node bin/unclecode.cjs harness status
node bin/unclecode.cjs "/harness status"
node bin/unclecode.cjs mode status
node bin/unclecode.cjs mode set yolo
node bin/unclecode.cjs "/mode status"
node bin/unclecode.cjs sessions
node bin/unclecode.cjs "/sessions"
node bin/unclecode.cjs sessions fork smoke-session
node bin/unclecode.cjs sessions share smoke-session
node bin/unclecode.cjs resume smoke-session
node bin/unclecode.cjs resume smoke-session --json
target/debug/unclecode --version
target/debug/unclecode --rust-version
target/debug/unclecode rust perf startup
target/debug/unclecode config --help
target/debug/unclecode mcp --help
target/debug/unclecode mode --help
target/debug/unclecode harness --help
target/debug/unclecode sessions --help
target/debug/unclecode setup --help
target/debug/unclecode doctor --help
target/debug/unclecode work --help
target/debug/unclecode rust queue-smoke
target/debug/unclecode rust queue push smoke-session "queued follow-up"
target/debug/unclecode rust queue len smoke-session
target/debug/unclecode rust queue pop smoke-session
target/debug/unclecode rust queue clear smoke-session
target/debug/unclecode rust session-smoke
printf 'Chat: inspect repo' | target/debug/unclecode rust session persist smoke-session gpt-5.5 analyze idle verbose
target/debug/unclecode rust session list
target/debug/unclecode rust session resume smoke-session
target/debug/unclecode rust session paths ~/.unclecode/state "$PWD" smoke-session
OPENAI_API_KEY=sk-test target/debug/unclecode rust auth status
OPENAI_API_KEY=sk-test target/debug/unclecode auth status
OPENAI_API_KEY=sk-test target/debug/unclecode "/auth status"
OPENAI_API_KEY=sk-test target/debug/unclecode rust auth resolve
target/debug/unclecode harness status
target/debug/unclecode "/harness status"
target/debug/unclecode harness explain
target/debug/unclecode mode status
target/debug/unclecode mode set yolo
target/debug/unclecode "/mode status"
target/debug/unclecode sessions
target/debug/unclecode "/sessions"
target/debug/unclecode sessions fork smoke-session
target/debug/unclecode sessions share smoke-session
target/debug/unclecode resume smoke-session
target/debug/unclecode resume smoke-session --json
printf 'x.eyJzY3AiOlsibW9kZWwucmVxdWVzdCJdLCJjbGllbnRfaWQiOiJhcHBfMTIzIn0.y' | target/debug/unclecode rust auth inspect-oauth-token
target/debug/unclecode rust auth authorization-url client_123 http://localhost:7777/callback state_123 challenge_123 - openid profile model.request
printf 'http://localhost:7777/callback?code=code_123&state=state_123' | target/debug/unclecode rust auth parse-callback state_123
target/debug/unclecode rust auth request-spec authorization-code https://auth.openai.com
target/debug/unclecode rust auth request-body device-code client_123 openid profile model.request
target/debug/unclecode rust auth request-body device-token client_123 device-test
target/debug/unclecode rust auth request-body authorization-code client_123 code-test verifier-test http://localhost:7777/callback
target/debug/unclecode rust auth request-body codex-device-code client_123
target/debug/unclecode rust auth request-body codex-device-token device-auth-test user-test
printf '{"access_token":"at-test","refresh_token":"rt-test"}' | target/debug/unclecode rust auth parse-token-response
printf '{"device_code":"device-test","user_code":"user-test","verification_uri":"https://auth.openai.com/activate","expires_in":900,"interval":5}' | target/debug/unclecode rust auth parse-device-response
printf '{"device_auth_id":"device-auth-test","user_code":"user-test","interval":5}' | target/debug/unclecode rust auth parse-codex-device-response
printf '{"authorization_code":"code-test","code_verifier":"verifier-test"}' | target/debug/unclecode rust auth parse-codex-token-response
printf '[]' | target/debug/unclecode rust context guidance "$PWD" -
printf '{"path":"README.md"}' | target/debug/unclecode rust json normalize-object-arg
printf 'data: {"type":"response.completed"}\n\n' | target/debug/unclecode rust sse data-blocks
printf 'data: {"type":"response.completed","response":{"id":"resp-smoke"}}\n\n' | target/debug/unclecode rust sse responses-records
printf 'data: {"type":"response.completed","response":{"id":"resp-smoke"}}\n\n' | target/debug/unclecode rust sse responses-result
printf 'data: {"type":"response.completed","response":{"id":"resp-smoke"}}\n\n' | target/debug/unclecode rust sse responses-message
printf 'data: {"type":"response.completed","response":{"id":"resp-smoke"}}\n\n' | target/debug/unclecode rust provider openai-responses-message gpt-5.5
target/debug/unclecode rust harness inspect "$PWD"
target/debug/unclecode rust harness preset team-auditor
rm -rf target/harness-smoke && mkdir -p target/harness-smoke/.codex && printf 'model_reasoning_effort = "high"\napprovals_reviewer = "user"\n' > target/harness-smoke/.codex/config.toml
target/debug/unclecode rust harness apply yolo target/harness-smoke
printf '{"authType":"api-key","apiKey":"sk-test"}' | UNCLECODE_OPENAI_CREDENTIALS_PATH=target/openai-raw-smoke.json target/debug/unclecode rust auth write-raw
UNCLECODE_OPENAI_CREDENTIALS_PATH=target/openai-raw-smoke.json target/debug/unclecode rust auth read-credentials
printf 'sk-test' | UNCLECODE_OPENAI_CREDENTIALS_PATH=target/openai-smoke.json target/debug/unclecode rust auth save-api-key - -
printf 'at-test\nrt-test\n' | UNCLECODE_OPENAI_CREDENTIALS_PATH=target/openai-oauth-smoke.json target/debug/unclecode rust auth save-oauth codex - test-project test-account
UNCLECODE_OPENAI_CREDENTIALS_PATH=target/openai-smoke.json target/debug/unclecode rust auth logout
OPENAI_MODEL=gpt-5.5 target/debug/unclecode rust model openai-registry
target/debug/unclecode rust model openai-reasoning gpt-5.5
target/debug/unclecode rust model price gpt-4.1-mini
target/debug/unclecode rust model estimate-cost gpt-4.1-mini 1000000 1000000
target/debug/unclecode rust model detect-provider claude-sonnet-4-6
target/debug/unclecode rust model provider-route auto gemini-2.5-flash
target/debug/unclecode rust model provider-route-json auto gemini-2.5-flash
HTTPS_PROXY=http://user:secret@proxy.local:8080 NO_PROXY= target/debug/unclecode rust model provider-route openai gpt-5.5
HTTPS_PROXY=http://user:secret@proxy.local:8080 NO_PROXY= target/debug/unclecode rust model provider-route-json openai gpt-5.5
target/debug/unclecode rust command route '/mode set analyze'
target/debug/unclecode rust command work-shell-route '/review auth flow'
target/debug/unclecode rust command extension-slash-commands "$PWD" -
target/debug/unclecode rust command extension-manifests "$PWD" -
printf '/queue' | target/debug/unclecode rust command builtin-command
printf '{"kind":"review","focus":"auth flow"}' | target/debug/unclecode rust command prompt-command
printf '{"slashCommand":["prompt","review","auth","flow"]}' | target/debug/unclecode rust command prompt-slash-command
printf '{"args":["research","run","summarize","current","workspace"]}' | target/debug/unclecode rust command inline-action
printf '/remember session keep this' | target/debug/unclecode rust command local-command
target/debug/unclecode rust command help
GEMINI_MODEL=gemini-2.5-pro GEMINI_MODELS=gemini-2.5-pro-exp target/debug/unclecode rust model catalog gemini
printf 'sk-test' | target/debug/unclecode rust provider openai-request-spec-json api
printf 'oauth-token' | target/debug/unclecode rust provider openai-request-spec-json codex acct_123
printf '[{"role":"user","content":"hi"}]\0[]' | target/debug/unclecode rust provider openai-chat-body gpt-5.5 - yes
printf '[{"name":"search","description":"Search","input_schema":{"type":"object","properties":{"q":{"type":"string"}}}}]' | target/debug/unclecode rust provider openai-chat-tools
printf 'system prompt\0[{"role":"user","content":"hi"}]' | target/debug/unclecode rust provider openai-query-messages
printf '{"choices":[{"message":{"content":"hi","tool_calls":[{"id":"call_1","function":{"name":"search","arguments":"{\"q\":\"x\"}"}}]}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}' | target/debug/unclecode rust provider openai-chat-response
printf '{"choices":[{"message":{"content":"hi","tool_calls":[{"id":"call_1","function":{"name":"search","arguments":"{\"q\":\"x\"}"}}]}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}' | target/debug/unclecode rust provider openai-chat-response-json gpt-5.5
printf 'boom' | target/debug/unclecode rust provider request-error openai 500 3
printf '[{"id":"call_1","function":{"name":"search","arguments":"{\"q\":\"x\"}"}}]' | target/debug/unclecode rust provider openai-tool-actions
printf 'thinking' | target/debug/unclecode rust provider loop-decision 7 1 8
printf 'thinking' | target/debug/unclecode rust provider iteration-action-plan 0 1 8
printf 'previous\0thinking\0[{"role":"system","content":"s"}]\0[{"role":"assistant","content":"thinking"}]' | target/debug/unclecode rust provider turn-step openai 0 1 8
printf 'previous\0thinking\0[{"role":"system","content":"s"}]\0[{"role":"assistant","content":"thinking","tool_calls":[{"id":"call_1","function":{"name":"read_file","arguments":"{}"}}]}]\0[{"toolName":"read_file","toolCallId":"call_1","kind":"success","isError":false,"content":"ok"}]' | target/debug/unclecode rust provider complete-turn-step openai 0 1 8
printf '[{"callId":"call_1","tool":"read_file","input":{"path":"README.md"}},{"callId":"call_2","tool":"missing","input":{}}]\0["read_file"]' | target/debug/unclecode rust provider tool-dispatch-plan openai
printf '[{"type":"image","mimeType":"image/png","dataUrl":"data:image/png;base64,AAAA"}]' | target/debug/unclecode rust provider attachment-caps
printf '[{"role":"system","content":"s"}]\0[{"role":"user","content":"hi"}]' | target/debug/unclecode rust provider append-state openai
printf '[{"role":"system","content":"s"}]\0[]' | target/debug/unclecode rust provider start-turn openai inspect
printf '{"path":"README.md"}' | target/debug/unclecode rust provider tool-trace-started openai read_file call_1 10
printf '{"path":"README.md"}' | target/debug/unclecode rust provider tool-execution-start openai read_file call_1
printf 'thinking' | target/debug/unclecode rust provider reasoning-delta openai gpt-5.5 text
printf 'stream thinking' | target/debug/unclecode rust provider reasoning-delta-record openai gpt-5.5 text rs_1
printf 'inspect repo' | target/debug/unclecode rust provider turn-started-trace openai gpt-5.5 42
target/debug/unclecode rust provider route-trace openai gpt-5.5 42
target/debug/unclecode rust provider calling-trace openai gpt-5.5 42
printf 'done' | target/debug/unclecode rust provider turn-completed-trace openai gpt-5.5 42 48
printf 'ok' | target/debug/unclecode rust provider tool-trace-completed openai read_file call_1 10 15 no
printf 'ok' | target/debug/unclecode rust provider tool-execution-result openai read_file call_1 10 15 no
printf 'ok' | target/debug/unclecode rust provider tool-execution-finish openai read_file call_1 10 no
printf '{"content":"ok"}' | target/debug/unclecode rust provider tool-execution-finish-result openai read_file call_1 10
printf 'ok' | target/debug/unclecode rust provider tool-result openai read_file call_1 success no
printf '[{"type":"tool_result","tool_use_id":"tu_1","content":"ok","is_error":false}]' | target/debug/unclecode rust provider tool-result-container anthropic
printf '[{"toolName":"read_file","toolCallId":"call_1","kind":"success","isError":false,"content":"ok"}]' | target/debug/unclecode rust provider tool-result-turn-entries openai
printf '[{"role":"user","content":"hi"}]\0[{"toolName":"read_file","toolCallId":"call_1","kind":"success","isError":false,"content":"ok"}]' | target/debug/unclecode rust provider tool-result-turn-step openai
printf '[{"dataUrl":"data:image/png;base64,AAAA"}]' | target/debug/unclecode rust provider openai-user-message inspect
printf 'working\0[{"id":"call_1","function":{"name":"search","arguments":"{}"}}]' | target/debug/unclecode rust provider openai-assistant-message
printf 'ok' | target/debug/unclecode rust provider openai-tool-message call_1
printf '[{"role":"user","content":"hi"}]' | target/debug/unclecode rust provider openai-responses-input
printf '[{"name":"search","description":"Search","input_schema":{"type":"object","properties":{"q":{"type":"string"}}}}]' | target/debug/unclecode rust provider openai-responses-tools
printf 'system prompt\0[{"role":"user","content":"hi"}]' | target/debug/unclecode rust provider gemini-query-messages
printf 'g-test' | target/debug/unclecode rust provider gemini-request-spec-json gemini-2.5-flash
printf '[{"name":"search","description":"Search","input_schema":{"type":"object","properties":{"q":{"type":"string"}}}}]' | target/debug/unclecode rust provider gemini-tools
printf '[{"mimeType":"image/png","dataUrl":"data:image/png;base64,AAAA"}]' | target/debug/unclecode rust provider gemini-user-content inspect
printf 'ok' | target/debug/unclecode rust provider gemini-function-response run_shell fc_1 success no
printf 'boom' | target/debug/unclecode rust provider gemini-function-response run_shell fc_1 error yes
printf '{"candidates":[{"content":{"parts":[{"text":"ok"},{"functionCall":{"id":"fc_1","name":"run_shell","args":{"command":"echo ok"}}}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2}}' | target/debug/unclecode rust provider gemini-response gemini-2.5-pro
printf 'system\0[{"role":"user","parts":[{"text":"hi"}]}]\0[{"name":"run_shell"}]' | target/debug/unclecode rust provider gemini-generate-request gemini-3.1-flash yes
printf 'system prompt\0[{"role":"user","content":"hi"}]' | target/debug/unclecode rust provider anthropic-query-messages
printf 'sk-ant-test' | target/debug/unclecode rust provider anthropic-request-spec-json
printf '[{"mimeType":"image/png","dataUrl":"data:image/png;base64,AAAA"}]' | target/debug/unclecode rust provider anthropic-user-message inspect
printf 'ok' | target/debug/unclecode rust provider anthropic-tool-result tu_1 no
printf 'boom' | target/debug/unclecode rust provider anthropic-tool-result tu_1 yes
printf '{"content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"tu_1","name":"run_shell","input":{"command":"echo ok"}}],"usage":{"input_tokens":1,"output_tokens":2}}' | target/debug/unclecode rust provider anthropic-response claude-sonnet-4-6
printf 'system\0[{"role":"user","content":"hi"}]\0[{"name":"run_shell"}]' | target/debug/unclecode rust provider anthropic-messages-request claude-sonnet-4-6
printf 'system\0[{"type":"message","role":"user","content":[]}]\0[]' | target/debug/unclecode rust provider openai-codex-body gpt-5.5 medium none
printf 'ghp_%036d' 0 | target/debug/unclecode rust redact
printf 'abc' | target/debug/unclecode rust sha256
printf 'abc' | target/debug/unclecode rust sha256-base64url
target/debug/unclecode rust run -- node -e "process.stdout.write('native-runtime-ok')"
target/debug/unclecode rust shell -- pwd
printf 'Cargo.toml' | target/debug/unclecode rust path assert existing
printf 'target/path-smoke.txt' | target/debug/unclecode rust path assert allow-missing
target/debug/unclecode rust aci list rust
target/debug/unclecode rust aci read Cargo.toml
target/debug/unclecode rust aci view Cargo.toml 5
target/debug/unclecode rust aci view-json Cargo.toml 5 2
printf 'rust-write-ok' | target/debug/unclecode rust aci write target/rust-write-smoke.txt
target/debug/unclecode rust aci read target/rust-write-smoke.txt
printf 'alpha\nbeta\ngamma\n' | target/debug/unclecode rust aci write target/rust-edit-smoke.txt
printf 'BETA' | target/debug/unclecode rust aci edit-json target/rust-edit-smoke.txt 2 2
target/debug/unclecode rust aci search unclecode-core rust
target/debug/unclecode rust aci search-json unclecode-core rust 3 1
target/debug/unclecode rust aci find-json Cargo 5
target/debug/unclecode rust aci glob '**/*.rs'
printf '%s\n' '--- a/x.txt' '+++ b/x.txt' '@@ -1 +1 @@' '-old' '+new' | target/debug/unclecode rust aci parse-patch
printf '[{"command":"/auth status","description":"Show auth source."},{"command":"/auth login","description":"Sign in."},{"command":"/auth key","description":"Open secure API key entry."},{"command":"/queue","description":"Queue."}]' | target/debug/unclecode rust ux slash-suggestions /auth
printf '{"value":"","key":{"tab":true,"shift":true},"input":"plain text","slashSuggestionCount":0,"isBusy":false,"hasRequestSessionsView":false,"currentMode":"default"}' | target/debug/unclecode rust ux input-action
printf '{"value":"/auth","isBusy":false,"shouldBlockSlashSubmit":true,"selectedSlashCommand":"/auth status"}' | target/debug/unclecode rust ux submit-action
printf '{"input":"/model","routeResolved":false,"suggestions":[{"command":"/model gpt-5.5","description":"Current"}]}' | target/debug/unclecode rust ux slash-submit-block
printf '{"value":"gkdl","isBusy":false,"shouldBlockSlashSubmit":false,"activePanelTitle":"Model picker"}' | target/debug/unclecode rust ux submit-action
printf '{"selectedIndex":0,"suggestionCount":3,"direction":"previous"}' | target/debug/unclecode rust ux slash-selection
printf '{"currentCount":0,"dataUrl":"data:image/png;base64,aGVsbG8="}' | target/debug/unclecode rust ux clipboard-cap
printf '[{"dataUrl":"data:image/png;base64,AAAA","displayName":"a.png"},{"dataUrl":"data:image/png;base64,AAAA","displayName":"dup.png"}]' | target/debug/unclecode rust ux attachment-dedup
printf 'oauth-file' | target/debug/unclecode rust ux auth-label
printf '["Provider: openai","Source: oauth-file"]' | target/debug/unclecode rust ux auth-extract-label
printf '{"mode":"default","authLabel":"api-key-env","browserOAuthAvailable":true}' | target/debug/unclecode rust ux auth-launcher-lines
printf '{"lines":["source: oauth-file","auth: oauth","expiresAt: refresh-required","expired: no"],"browserOAuthAvailable":true}' | target/debug/unclecode rust ux auth-status-panel-lines
printf '{"args":["auth","login","--browser"],"lines":["Browser OAuth unavailable. Set OPENAI_OAUTH_CLIENT_ID."],"failed":true,"authLabel":"api-key-env"}' | target/debug/unclecode rust ux auth-browser-failure-lines
printf '{"value":"@README.md 요약"}' | target/debug/unclecode rust ux composer-preview-mode
printf '{"text":"Done.\n\nIf you want, I can continue."}' | target/debug/unclecode rust ux prompt-turn permission-stall
printf '{"contextSummaryLines":["Loaded guidance: AGENTS.md","AGENTS.md: Follow repo rules."],"bridgeLines":["project-context bridge ready"],"memoryLines":[],"traceLines":[],"expanded":true}' | target/debug/unclecode rust ux panel context
printf '{"args":["doctor"],"lines":["Doctor summary","config PASS"]}' | target/debug/unclecode rust ux panel inline-command
printf '{"suggestions":[{"command":"/model","description":"Show models."},{"command":"/model list","description":"List models."},{"command":"/model gpt-5.5","description":"Current · reasoning default medium · supports low, medium, high"},{"command":"/model gpt-5.4-mini","description":"Available · reasoning default medium · supports low, medium, high"}],"selectedIndex":2}' | target/debug/unclecode rust ux panel model-picker
printf '{"input":"/model gkdl","suggestions":[],"selectedIndex":0}' | target/debug/unclecode rust ux panel model-picker
printf '{"line":"/model gpt-4.1-mini","provider":"openai","currentModel":"gpt-5.5","currentReasoning":{"effort":"high","source":"override","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},"modeDefaultReasoning":{"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}}' | target/debug/unclecode rust ux model-builtin-command
printf '{"input":"/zz","suggestions":[],"selectedIndex":0}' | target/debug/unclecode rust ux panel commands
printf '{"input":"/re","suggestions":[{"command":"/reload","description":"Reload workspace guidance, skills, and extension context."}],"selectedIndex":0}' | target/debug/unclecode rust ux panel commands
printf '{"suggestions":[{"command":"/auth status","description":"Show auth source."},{"command":"/auth login","description":"Sign in with browser OAuth."}],"selectedIndex":1,"authLabel":"oauth-file","browserOAuthAvailable":true}' | target/debug/unclecode rust ux panel auth-picker
printf '{"input":"/reasoning low","currentReasoning":{"effort":"high","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},"modeDefaultReasoning":{"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}}' | target/debug/unclecode rust ux reasoning-command
printf '{"line":"/reasoning low","provider":"openai","model":"gpt-5.5","mode":"default","cwd":"/repo","authLabel":"api-key-env","currentReasoning":{"effort":"high","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},"modeDefaultReasoning":{"effort":"medium","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},"contextSummaryLines":["Loaded guidance: AGENTS.md"],"bridgeLines":["bridge ready"],"memoryLines":[],"traceLines":[]}' | target/debug/unclecode rust ux reasoning-builtin-command
printf '{"line":"/minimal","traceMode":"minimal","contextSummaryLines":["Loaded guidance: AGENTS.md"],"bridgeLines":["bridge ready"],"memoryLines":["memory ready"],"traceLines":["old trace"]}' | target/debug/unclecode rust ux trace-mode-command
printf '{"event":{"type":"provider.route"},"line":"route openai direct","traceMode":"minimal"}' | target/debug/unclecode rust ux trace-event
printf '{"line":"new trace","traceLines":["old trace"],"panelTitle":"Status","preservePanel":false}' | target/debug/unclecode rust ux trace-line-patch
printf '{"traceMode":"minimal"}' | target/debug/unclecode rust ux trace-mode-patch
printf '{"isBusy":true,"busyStatus":"thinking","currentTurnStartedAt":123}' | target/debug/unclecode rust ux busy-state-patch
printf '{"authLabel":"oauth-file","authLauncherLines":["Saved auth found."]}' | target/debug/unclecode rust ux auth-state-patch
printf '{"authLabel":"oauth-file","bridgeLines":["bridge"],"memoryLines":["memory"]}' | target/debug/unclecode rust ux dashboard-home-patch
printf '{"isBusy":true,"authLabel":"oauth-file","bridgeLines":["bridge"],"memoryLines":["memory"]}' | target/debug/unclecode rust ux dashboard-home-sync-state
printf '{"previous":{"isBusy":true,"authLabel":"oauth-file","bridgeLines":[],"memoryLines":[]},"next":{"isBusy":false,"authLabel":"oauth-file","bridgeLines":["bridge"],"memoryLines":[]}}' | target/debug/unclecode rust ux dashboard-home-refresh
printf '{"model":"gpt-5.5","mode":"ultrawork","reasoning":{"effort":"high","source":"mode-default","support":{"status":"supported","supportedEfforts":["low","medium","high"]}},"authLabel":"oauth-file"}' | target/debug/unclecode rust ux initial-state
printf '{"entries":[{"role":"system","text":"hello"}],"nextEntries":[{"role":"assistant","text":"world"}]}' | target/debug/unclecode rust ux append-entries-patch
printf '{"effort":"high","source":"override","support":{"status":"supported","supportedEfforts":["low","medium","high"]}}' | target/debug/unclecode rust ux mode-default-reasoning
printf '{"line":"/skills","skills":[{"name":"autopilot","scope":"project","summary":"Keep moving."}]}' | target/debug/unclecode rust ux skills-command
printf '{"line":"/help"}' | target/debug/unclecode rust ux help-command
printf '{"line":"/context","contextSummaryLines":["Loaded guidance: AGENTS.md"],"bridgeLines":["bridge ready"],"memoryLines":[],"traceLines":[]}' | target/debug/unclecode rust ux context-command
printf '{"line":"/queue","isBusy":true,"busyStatus":"thinking","mode":"yolo","workerBudget":4,"queuedCount":1,"queuedItems":[{"id":1,"line":"follow up"}]}' | target/debug/unclecode rust ux queue-command
printf '{"line":"/auth key"}' | target/debug/unclecode rust ux auth-key-command
printf '{"kind":"success","resultLines":["API key login saved.","Auth: api-key-file"],"nextAuthLabel":"api-key-file"}' | target/debug/unclecode rust ux auth-key-submit-result
printf '{"progressLines":["Opening browser…","Enter code: ABCD-1234","Waiting for device approval…"]}' | target/debug/unclecode rust ux auth-progress-result
printf '{"provider":"openai","model":"gpt-5.5","mode":"default","cwd":"/repo","reasoningLabel":"medium (mode-default)","authLabel":"api-key-file","contextSummaryLines":["Loaded guidance: AGENTS.md"],"bridgeLines":[],"memoryLines":[],"traceLines":[]}' | target/debug/unclecode rust ux sensitive-input-cancel-result
printf '{"formattedMessage":"Auth failed. Run /auth login.","nextAuthLabel":"api-key-file","lastTurnDurationMs":42,"isAuthFailure":true,"provider":"openai","model":"gpt-5.5","mode":"default","cwd":"/repo","reasoningLabel":"medium (mode-default)","contextSummaryLines":["Auth issue: saved OAuth needs refresh."],"bridgeLines":[],"memoryLines":[],"traceLines":[]}' | target/debug/unclecode rust ux prompt-failure-result
printf '{"assistantText":"Done.","bridgeLines":["bridge-1"],"memoryLines":["memory-1"],"lastTurnDurationMs":23}' | target/debug/unclecode rust ux prompt-success-result
printf '{"turnStartedAt":42}' | target/debug/unclecode rust ux prompt-start-result
printf '{}' | target/debug/unclecode rust ux prompt-finalize-result
printf '{"summary":"User: hello\nAssistant: world","bridgeId":"bridge-1","bridgeLine":"bridge-1 line","currentBridgeLines":["bridge-0"],"memoryId":"memory-1","memoryLines":["memory-1 line"]}' | target/debug/unclecode rust ux post-turn-success-result
printf '{"text":"하이abc","width":5}' | target/debug/unclecode rust ux text wrap-display
printf '  /model gpt-4.1-mini  Warning · reasoning unsupported' | target/debug/unclecode rust ux text panel-line-class
printf '{"panelTitle":"Models","inputValue":"/model"}' | target/debug/unclecode rust ux text panel-layout
printf 'assistant' | target/debug/unclecode rust ux text entry-presentation
printf '{"lineIndex":2}' | target/debug/unclecode rust ux text attachment-layout
printf '{"panelPlacement":"side","terminalColumns":180}' | target/debug/unclecode rust ux text viewport-layout
printf '{"inputValue":"/model","dockWidth":20,"attachmentCount":5,"footerLine":"~/repo · gpt-5.5"}' | target/debug/unclecode rust ux text composer-dock-layout
printf 'OpenAI request failed with status 401' | target/debug/unclecode rust ux text error-message
printf '{"node":"v22.22.0","platform":"darwin","arch":"arm64"}' | target/debug/unclecode rust ux text runtime-label
printf '{"inputValue":"/model g","slashSuggestionCount":2}' | target/debug/unclecode rust ux text composer-hint
printf '{"model":"gpt-5.5","mode":"default","authLabel":"Browser OAuth · file"}' | target/debug/unclecode rust ux text status-line
printf '{"cwd":"/Users/me/project/엉클코드","home":"/Users/me","model":"gpt-5.5","mode":"default","authLabel":"Browser OAuth · file","composerHint":"하이","width":20}' | target/debug/unclecode rust ux text footer-line
printf '{"prompt":"fix login.ts oauth.ts","mode":"yolo"}' | target/debug/unclecode rust orchestrator classify-intent
printf 'refactor login.ts oauth.ts session.ts' | target/debug/unclecode rust orchestrator complex-tasks
printf 'Here are tasks:\n[{"id":"task-1","summary":"Read files","prompt":"Read src/index.ts"}]' | target/debug/unclecode rust orchestrator parse-plan-response
target/debug/unclecode rust orchestrator worker-budget yolo
printf '[{"summary":"Inspect login.ts","prompt":"Edit src/login.ts"}]' | target/debug/unclecode rust orchestrator changed-files
printf '{"prompt":"refactor login","results":[{"summary":"result one"}],"executableChecks":"lint PASS"}' | target/debug/unclecode rust orchestrator guardian-review-prompt
printf '{"prompt":"refactor login","model":"gpt-5.5","reasoning":"high","results":[{"summary":"result one"}],"guardianSummary":"ok"}' | target/debug/unclecode rust orchestrator synthesis-prompt
printf '{"kind":"executor-running","workerId":"executor-1","taskId":"task-1","summary":"Inspect login.ts","startedAt":10}' | target/debug/unclecode rust orchestrator trace-event
printf '{"line":"/skill analyze","skill":{"name":"analyze","content":"# Analyze\nLook deeper.","attempts":[{"path":"/skills/analyze","ok":true}]}}' | target/debug/unclecode rust ux skill-command
printf '{"line":"/tools","toolLines":["read_file","write_file"]}' | target/debug/unclecode rust ux tools-command
printf '{"line":"/status","provider":"openai","model":"gpt-5.5","mode":"default","cwd":"/repo","reasoningLabel":"medium (mode-default)","authLabel":"api-key-env","contextSummaryLines":["Loaded guidance: AGENTS.md"],"bridgeLines":["bridge ready"],"memoryLines":[],"traceLines":[]}' | target/debug/unclecode rust ux status-command
printf '{}' | target/debug/unclecode rust ux panel help
printf '{"provider":"openai","model":"gpt-5.5","mode":"default","cwd":"/repo","reasoningLabel":"medium (mode-default)","authLabel":"api-key-env","route":{"providerId":"openai","label":"OpenAI","transport":"native","runtimeSupported":true,"endpointUrl":"https://api.openai.com/v1/responses","proxyPolicy":{"targetHost":"api.openai.com","proxyUrl":null,"source":"none","bypassed":false,"noProxy":[]}}}' | target/debug/unclecode rust ux panel status
printf '{"lines":["session-1","session-2"]}' | target/debug/unclecode rust ux panel sessions
printf '{"sessionMemory":["session-1"],"projectMemory":["project-1"]}' | target/debug/unclecode rust ux panel memories
printf '{"message":"Paste key."}' | target/debug/unclecode rust ux panel auth-secure-entry
printf '{"progressLines":["Opening browser…","Enter code: ABCD-1234","Waiting for device approval…"]}' | target/debug/unclecode rust ux panel auth-progress
printf '## Heading\n- `npm run check`\n- **Done**' | target/debug/unclecode rust ux text normalize-markdown
printf '· thinking inspect repo' | target/debug/unclecode rust ux text busy-status
printf '{"type":"orchestrator.step","role":"executor","status":"running","summary":"Calling openai gpt-5.5"}' | target/debug/unclecode rust ux text trace-line
printf '{"type":"provider.route","provider":"openai","label":"OpenAI","transport":"native","endpointUrl":"https://api.openai.com/v1/responses","proxyPolicy":{"targetHost":"api.openai.com","proxyUrl":null,"source":"none","bypassed":false,"noProxy":[]}}' | target/debug/unclecode rust ux text trace-line
printf '{"type":"attachment.attached","source":"clipboard","mimeType":"image/png","byteEstimate":4096}' | target/debug/unclecode rust ux text trace-line
printf '[{"displayName":"shot.png","mimeType":"image/png"}]' | target/debug/unclecode rust ux text attachment-preview
printf '{"args":["doctor"],"lines":["Doctor summary","config PASS","auth PASS"]}' | target/debug/unclecode rust ux text inline-command-summary
TERM_PROGRAM=iTerm.app target/debug/unclecode rust ux text inline-image-support
printf '{"displayName":"shot.png","dataUrl":"data:image/png;base64,AAAA"}' | TERM=xterm-kitty target/debug/unclecode rust ux text inline-image-sequence
printf '{"kind":"workspace-reload-start","line":"/reload"}' | target/debug/unclecode rust ux text work-shell-transition
printf '{"kind":"workspace-reload-complete"}' | target/debug/unclecode rust ux text work-shell-transition
printf '{"kind":"sensitive-input-cancel"}' | target/debug/unclecode rust ux text work-shell-transition
printf '{"line":"/clear"}' | target/debug/unclecode rust ux clear-command
printf '{"line":"/harness","mode":"yolo","workerBudget":4,"autoContinue":true}' | target/debug/unclecode rust ux harness-command
printf '{"line":"/sessions"}' | target/debug/unclecode rust ux sessions-command
printf '{"line":"/reload"}' | target/debug/unclecode rust ux reload-command
printf '{"line":"/memories","sessionMemory":["session-1"],"projectMemory":["project-1"]}' | target/debug/unclecode rust ux memories-command
printf '{"line":"/remember session keep this","scope":"session","memoryTrace":"memory keep this","nextMemoryLines":["keep this"]}' | target/debug/unclecode rust ux remember-command
printf '{"line":"/auth login --api-key sk-secret","slashCommand":["auth","login","--api-key","sk-secret"],"resultLines":["OAuth login complete.","Auth: oauth-file"],"failed":false,"nextAuthLabel":"oauth-file"}' | target/debug/unclecode rust ux inline-command-result
printf '{"line":"/auth login --api-key sk-secret","slashCommand":["auth","login","--api-key","sk-secret"]}' | target/debug/unclecode rust ux inline-command-visibility
HTTPS_PROXY=http://proxy.local:8080 NO_PROXY=.openai.com target/debug/unclecode rust http proxy-policy https://api.openai.com/v1/chat
HTTPS_PROXY=http://user:secret@proxy.local:8080 NO_PROXY= target/debug/unclecode rust http proxy-policy https://api.openai.com/v1/chat
target/debug/unclecode --help
```

The Rust binary completion gate is that `target/*/unclecode` must not call Node
or `apps/unclecode-cli/dist/index.js` for normal or unsupported top-level
commands.

## Final Product Differentiation Todo

Before calling the Rust port complete, write the bottom-line product argument:
why UncleCode is better than OpenCode, Pi, Hermes Agent, Claude Code, Command
Code, Kimi CLI, Qwen CLI, Gemini CLI, and similar tools. The implemented
argument is:

UncleCode is not just another single-provider coding chat shell. Its strongest
position is a Rust-native control plane for serious terminal agent work:
provider routing, proxy policy, auth state, model capability, queue/steer
state, sessions, team dispatch, research runs, harness presets, and CJK-safe
terminal rendering are inspectable and regression-tested in the same native
core. Compared with single-agent CLIs, UncleCode's advantage is operational
control: users can see why a model/provider/router was chosen, queue follow-up
intent without corrupting the active turn, keep session/context state visible,
dispatch multiple runtimes, and run through proxy/auth/harness constraints
without secret leaks or synthetic trace claims. Compared with broad ecosystem
tools, UncleCode's advantage is that these controls are built into the terminal
UX rather than bolted on as external scripts.

This must include the user-facing quality bar, not just internals:

- model picker UX must be fast, readable, keyboard-obvious, and not feel like a
  raw debug list
- model picker panels now expose provider, current model, current thinking
  mode, available model count, per-model reasoning availability, and explicit
  keyboard controls from the Rust UX layer
- steer and queue flows must make busy/queued/draining states obvious without
  trapping typed input or losing intent
- queue/steer copy now states that plain follow-ups run automatically after the
  active turn, shows queued entries as `Queued #n`, and explains that slash
  commands are not queued while busy
- `/queue` now highlights the next queued follow-up and advertises
  `/queue clear`; busy-time `/queue clear` is allowed by the Rust steer
  decision while other slash commands remain rejected
- queue panels no longer duplicate the next item as both `Next` and
  `Queued #1`, and queued drain copy now names the queued id plus a compact
  prompt preview
- `/queue` and `/queue clear` execution now use the Rust queue-command
  contract for transcript copy and Queue panel payload, keeping busy/idle/clear
  messaging and backlog presentation in the native core
- work-shell submit routing trusts the Rust command router for prompt/local
  memory/builtin decisions; TypeScript keeps only extension slash fallback
- standalone work-shell builtin command resolution now uses the Rust
  builtin-command contract, keeping slash command intent in the native core
- work-shell inline action ID and `/research run ...` prompt classification now
  use the Rust command router before TypeScript runs async side effects
- `/model` command execution now uses the Rust model-builtin-command contract
  for transcript copy, next-model, reasoning support, fallback effort/source,
  result copy, and panel rendering
- `/clear` execution now uses the Rust clear-command contract for the cleared
  transcript entry and state patch payload, keeping even destructive-looking
  shell state feedback in the native core
- `/harness` execution now uses the Rust harness-command contract for
  transcript copy, worker budget display, auto-continue display, and the
  returned Harness panel payload
- `/sessions` execution now uses the Rust sessions-command contract for the
  overlay-opening transcript entry, with loading and loaded session panels
  already rendered by the Rust UX panel contract
- `/reload` execution now uses the Rust reload-command contract for start and
  completion feedback, keeping context refresh status copy native and
  consistent with the rest of the terminal UX
- `/memories` and `/remember` execution now use Rust command contracts for
  listing feedback, panel patches, usage errors, remembered trace handoff, and
  session-memory state updates, so the persistent context surface feels native
  instead of bolted onto the TypeScript shell
- inline operational command completion now uses the Rust inline-command-result
  contract for redaction, completion copy, transcript entries, panel/auth
  patches, and trace lines, keeping sensitive auth flows consistent across CLI
  and work-shell surfaces
- inline operational command visibility now uses the Rust
  inline-command-visibility contract for pre-execution redaction and auth
  command classification before any visible transcript entry is appended
- `/reasoning` command execution now uses the Rust reasoning-builtin-command
  contract for unsupported-model guidance, supported-effort validation, default
  reset, override source tagging, result copy, provider route/proxy details, and
  the returned Session status panel payload
- `/skills` execution now uses the Rust skills-command contract for loaded or
  empty result copy and the returned Skills panel payload
- `/skill <name>` execution now uses the Rust skill-command contract for
  missing-name usage, load-error copy, read-attempt transcript entries,
  loaded-skill result copy, and the returned Skill panel payload
- `/tools` execution now uses the Rust tools-command contract for tool-list
  transcript copy, keeping command result wording in the native core
- `/status` execution now uses the Rust status-command contract for transcript
  copy, provider route/proxy resolution, context source/health inspection, and
  the returned Session status panel payload
- `/help` execution now uses the Rust help-command contract for help result
  copy and the returned work-shell help panel payload
- `/verbose` and `/minimal` execution now uses the Rust trace-mode-command
  contract for transcript copy, trace-mode patching, minimal-mode trace clear,
  and rebuilt context panel payload
- `/context` execution now uses the Rust context-command contract for result
  copy and expanded context panel payload, so "what the agent knows now" is a
  native inspectable surface rather than hidden TypeScript state
- `/review` and `/commit` prompt bodies now use the Rust prompt-command
  contract, keeping actual agent work instructions in the native core
- `/review` and `/commit` prompt slash classification now uses the Rust
  prompt-slash-command contract, keeping focus extraction from routed slash
  arrays in the native core
- `/memories` and `/remember` local command parsing now uses the Rust
  local-command contract, keeping memory command intent in the native core
- `/memories` panel rendering now uses the Rust UX panel contract, keeping
  memory empty-state and section copy in the native core
- secure API key entry and OAuth progress panels now use the Rust UX panel
  contract, keeping auth terminal copy and progress ordering in the native core
- top-level `unclecode auth`, `auth --help`, `auth status`, `auth logout`, and
  `auth login --api-key-stdin [--org <id>] [--project <id>]` now use Rust for
  help, status, logout, secure stdin key capture, credential-file writes, and
  non-leaking success copy
- top-level `unclecode auth login --browser` and `auth login --device` now use
  Rust for callback waiting, token exchange/polling, model.request scope checks,
  and OAuth credential-file writes on the standard `OPENAI_OAUTH_CLIENT_ID`
  path
- `/auth key` execution now uses the Rust auth-key-command contract for
  composer-mode transition, transcript entry, and secure entry panel payload,
  keeping the secret-entry UX state change in the native core
- secure API key entry submit now uses the Rust auth-key-submit-result contract
  for success/error/unavailable feedback, retry/status panels, auth state
  patches, and trace lines, tightening the most sensitive terminal auth flow
- OAuth progress updates now use the Rust auth-progress-result contract for
  live panel patches, so browser/device auth feedback no longer hand-builds UI
  shape in the TypeScript runtime
- secure input cancellation now uses the Rust sensitive-input-cancel-result
  contract for the cancel transcript entry, composer reset, and route-aware
  status panel, tightening Esc recovery from secret-entry UX
- prompt-turn failures now use the Rust prompt-failure-result contract for
  visible failure copy, auth-label/duration patches, and auth-failure status
  recovery panels with route/proxy/context issue lines
- prompt-turn success now uses the Rust prompt-success-result contract for
  assistant transcript entry plus bridge/memory/duration state patch shape
- prompt-turn start/finalize now use Rust prompt-start-result and
  prompt-finalize-result contracts for busy/thinking state and idle cleanup
- post-turn bridge/memory effects now use the Rust post-turn-success-result
  contract for bridge-line merging and synthetic trace event payloads
- work-turn intent classification, fallback complex-task generation, and
  changed-file extraction now use `unclecode rust orchestrator`, keeping
  prompt interpretation and planner fallback shape in the native core
- work-agent planner, guardian-review, and synthesis prompt text now use
  `unclecode rust orchestrator`, so agent-facing orchestration copy is native
  instead of TypeScript string templates
- work-agent planner LLM response parsing now uses `unclecode rust orchestrator
  parse-plan-response`, removing the TypeScript regex/JSON extraction path while
  preserving the public `parseAgentPlanResponse` compatibility export
- mode worker-budget policy now uses `unclecode rust orchestrator worker-budget`,
  so `/queue`, `/harness`, and complex-turn `maxWorkers` share one native
  concurrency policy while preserving the public `resolveWorkerBudget` export
- turn-orchestrator structural, executor, planner-complete, and guardian trace
  payloads now use `unclecode rust orchestrator trace-event`; TypeScript keeps
  async timing/dispatch while Rust owns status, role/kind, summary, stepId, and
  duration payload shape
- work-agent planner-running and synthesis reviewer trace payloads now also use
  `unclecode rust orchestrator trace-event`, closing the remaining TypeScript
  trace string templates on the complex-turn path
- terminal responses must preserve polished typography, Korean/CJK display
  width, status legibility, and low-noise feedback
- `/model` slash picker panel now uses the Rust UX panel contract for selected
  rows, current model/reasoning summary, support labels, and controls copy
- `/model` execution now returns Rust-built transcript entries and Model picker
  payloads from the same native contract, so the chooser and command result no
  longer diverge between TypeScript callbacks and Rust panel rendering
- `/model` execution-result panels now use the same "Current model" / "Catalog"
  hierarchy as the live picker, with control copy that matches the Rust
  submit-action behavior for bare model filters
- `/model` root selection now highlights the first concrete model row, model
  no-match panels show the active filter, and bare input typed while the Model
  picker is active is converted by the Rust submit-action contract into a
  `/model <filter>` edit instead of being sent as a chat turn
- general slash command panels now use the Rust UX panel contract for match
  headings, selected rows, and command controls copy
- auth slash panels now use the Rust UX panel contract for current auth state,
  route guidance, remembered launcher copy, route rows, and auth tips
- work-shell help and status panels now use the Rust UX panel contract for
  default shell guidance, runtime status, auth display, and workspace status
- `/status` now includes Rust-rendered context source/health lines plus the
  first guidance, issue, bridge, memory, or live trace signal, making hidden
  context state inspectable without opening `/context`
- `/reasoning` updates now return a Rust-rendered Session status panel, so the
  user immediately sees the new reasoning mode together with route/proxy,
  auth, and context health instead of a detached one-line confirmation
- `/clear` now gets its transcript reset entry from Rust, so high-frequency
  cleanup actions preserve the same low-noise native terminal copy as other
  builtin commands
- `/sessions` now gets its overlay-opening transcript entry from Rust and its
  panels from Rust, keeping resumable-session discovery on one native UX path
- top-level `unclecode config explain` now resolves and formats source order,
  active mode, settings, prompt sections, and plugin prompt overlays in Rust
  instead of entering the TypeScript bridge
- top-level `unclecode mcp list` and slash-form `/mcp list` now load merged
  user/project MCP config and format the server registry in Rust
- top-level `unclecode setup` now builds the readiness guide in Rust, including
  auth readiness, local runtime availability, session-store creation, and
  next-step recovery copy
- top-level native help for `config`, `mcp`, `mode`, `harness`, `sessions`,
  `setup`, `doctor`, and `work --help` now exits cleanly from Rust instead of
  presenting usage as an error path or requiring the temporary TypeScript
  work-entry build for static help text
- top-level `unclecode doctor`, `/doctor`, `doctor --verbose`, and
  `doctor --json` now build readiness verdicts, labels, latency counters, and
  machine-readable thresholds in Rust
- top-level `unclecode research status`, `research status --json`, and
  slash-form `/research status` now show the research profile, configured MCP
  server count, latest research session, state, summary, and machine-readable
  status from Rust
- top-level `unclecode research run <prompt...>` now writes the local research
  artifact, session snapshot, JSON latency report, and
  `.unclecode/research-runs.jsonl` ledger from Rust; Node CLI compatibility
  calls the same native report
- recent sessions overlays now use the Rust UX panel contract for loading and
  loaded session lists
- inline command result panels now use the Rust UX panel contract for titles,
  no-output fallback copy, and transcript summaries
- inline command transcript summaries now use the Rust UX text contract, keeping
  panel and history one-liners on the same native title/empty-output rules
- markdown cleanup, busy status text normalization, trace line formatting, and
  image attachment preview/support copy now use the Rust UX text contract with
  TUI-side caching for render-path stability
- work-shell live trace-event policy now uses the Rust UX trace contract for
  busy patch decisions, turn-start timestamps, transcript role, and
  minimal/verbose visibility before TypeScript applies the patch
- work-shell trace-line state patching now uses the Rust state contract for
  trace-line capping and pinned panel preservation before TypeScript rebuilds
  an unpinned context panel
- work-shell trace-mode state patching now uses the Rust state contract for
  verbose/minimal patch shape, minimal trace clearing, and context-panel rebuild
  decisions
- work-shell busy state patching now uses the Rust state contract for busy
  status and current-turn-start timestamp set/clear decisions
- work-shell auth state patching now uses the Rust state contract for auth-label
  updates and launcher-line set/preserve decisions
- work-shell initial state now uses the Rust state contract for boot-time empty
  collections, composer/busy defaults, and mode-sensitive trace-mode defaults
- work-shell transcript append patches now use the Rust state contract for
  ordered entry concatenation before TypeScript applies the entries array
- work-shell mode-default reasoning normalization now uses the Rust state
  contract to preserve unsupported reasoning and tag supported reasoning
- work-shell provider/auth error formatting now uses the Rust UX text contract,
  so 401/403, missing `model.request`, browser OAuth availability, and routed
  provider failures produce the same operator guidance from native code
- work-shell header title, empty-state hint, composer hints, thinking/status
  lines, usage timing, and footer compaction/truncation now use the Rust UX text
  contract, including CJK/Hangul display-width aware truncation without stray
  spaces before ellipses
- work-shell conversation body wrapping now uses the Rust UX text contract, so
  assistant/user/tool text uses one CJK/Hangul display-width implementation
  before the Ink renderer paints the cached line array
- attachment lifecycle trace copy now uses `unclecode rust ux text trace-line`,
  so clipboard attach/drop diagnostics are Rust-owned while TypeScript only
  emits the lifecycle event
- work-shell panel-line classification now uses the Rust UX text contract for
  section headers, facts, slash suggestions, warnings, auth states, tips, and
  indented rows; Ink now maps native classifications to colors instead of
  re-running panel semantics in TypeScript
- work-shell panel layout now uses the Rust UX text contract for border role,
  display mode, placement, anchor, and bottom drawer min-height, keeping slash
  pickers, context overlays, and status panels on one native UX decision path
- work-shell entry presentation now uses the Rust UX text contract for
  user/assistant/tool/system labels, badges, colors, conversation layout, and
  border style, leaving Ink as a renderer for native role semantics
- work-shell composer hint height and attachment placement/min-height/line
  color roles now use the Rust UX text contract, keeping attachment readability
  and composer spacing out of ad-hoc TypeScript constants
- work-shell viewport layout now uses the Rust UX text contract for
  conversation width and composer dock width, so side/bottom panel terminals use
  the same native width decisions before Ink renders text and borders
- work-shell keyboard and submit actions now use the Rust UX input contract for
  slash completion, mode cycling, Esc behavior, busy submission, and partial
  slash blocking while preserving a TS fast path for ordinary text typing
- slash submit blocking now uses the Rust UX input contract for `/model` picker
  blocking, exact model-pick passthrough, and unresolved slash-with-suggestions
  decisions
- work-shell prompt-turn summaries, read-only edit guarding, and permission-stall
  auto-continue cleanup now use the Rust prompt-turn UX contract
- proxy/router failures must explain provider, endpoint, auth, and retry state
  in operator language
- provider HTTP failures now preserve Rust route/proxy diagnostics in terminal
  errors instead of collapsing back to an opaque status line
- provider route/proxy status now reports OpenAI as a native Rust route for
  `/v1/responses` and redacts proxy credentials across route JSON, key/value
  CLI output, status panels, trace lines, and HTTP proxy-policy diagnostics
- Session status runtime rows no longer duplicate `native`; Rust now renders
  native routes as `Runtime · OpenAI (openai) · native` and unsupported compat
  routes as `compat · unsupported`
- context surfaces must make "what the agent knows now" inspectable and useful
  instead of hidden state
- `/context` now uses the Rust UX panel to show source classes, health state,
  issues, guidance, bridge lines, memory lines, and live steps from one
  terminal-facing contract
- Rust harness work must improve perceived startup, command latency, and
  long-running session reliability
- `/harness` now gets its transcript and panel payload from Rust, keeping
  harness controls and runtime affordances aligned with the native CLI harness
  path instead of a TypeScript-only work-shell copy
- `UNCLECODE_RUST_BIN` must remain stable from temporary work directories:
  relative paths are resolved against the UncleCode workspace before falling
  back to the caller cwd, so tests and resumed sessions do not fail after a cwd
  hop
- Rust command shims now prefer an existing `target/release/unclecode` or
  `target/debug/unclecode` binary before falling back to `cargo run`, avoiding
  cargo artifact lock contention and multi-minute provider test stalls during
  normal harness runs
- the sessions fast path now uses the same existing-binary rule instead of
  rescanning Rust source mtimes, keeping `unclecode sessions` responsive after
  source edits
- `unclecode work` runtime argv parsing now uses `unclecode rust work-runtime
  parse-args`, so cwd/provider/model/reasoning/session/help/tools/prompt
  interpretation is owned by Rust before the TUI/work runtime bootstraps
- work command forwarding and caller-cwd injection now use `unclecode rust
  work-runtime build-command-args|with-cwd`, keeping Commander-to-work argv
  assembly in the native runtime contract
- work entrypoint candidate discovery now uses `unclecode rust work-runtime
  entrypoint-paths`, so dist-work/local-dist fallback ordering and existence
  filtering are Rust-owned before TS imports the module URL
- root bin missing-build recovery copy now points users at `cargo build -p
  unclecode` first, with `npm run build` clearly labeled as the temporary Node
  fallback
- top-level `unclecode model ...`, slash-form `unclecode "/model ..."`, and
  root-bin model invocations now use the Rust CLI for catalog, route, route
  JSON, reasoning, price, cost estimate, provider detection, capability checks,
  and bare model summaries before any TypeScript command bridge can run
- `unclecode team run` scalar runtime config now uses `unclecode rust team
  run-config`, so persona/gate/runtime validation, data-root selection,
  created-by fallback, dispatch entrypoint capture, and worker timeout parsing
  are Rust-owned before the native dispatch coordinator or temporary live
  worker adapter bridge runs
- `unclecode team worker` option normalization now uses `unclecode rust team
  worker-options`, so worker persona/runtime validation, default runtime
  selection, required worker/task fields, and string-only extras parsing are
  Rust-owned before TypeScript enters the remaining worker adapter bridge
- team lane spec parsing now uses `unclecode rust team lanes`, so numeric lane
  expansion, heterogeneous runtime/model/extras parsing, runtime validation, and
  the 16-lane cap are Rust-owned before TypeScript dispatches worker processes
- team worker spawn argv construction now uses `unclecode rust team
  worker-spawn-args`, so worker runtime defaulting and the
  `--worker-id/--persona/--task/--runtime/--model/--extras` argument contract
  are Rust-owned before TypeScript calls `spawn`
- team dispatch final status now uses `unclecode rust team dispatch-status`,
  so accepted/killed/errored result classification is Rust-owned after worker
  subprocesses finish
- team child environment construction now uses `unclecode rust team child-env`,
  so base env string filtering and binding/extra env precedence are Rust-owned
  before TypeScript calls `spawn`
- team worker close outcome classification now uses `unclecode rust team
  worker-close-outcome`, so exit-code/signal/timeout mapping to
  completed/failed/killed is Rust-owned for both compatibility helpers and the
  native dispatch coordinator
- team run listing now uses `unclecode rust team list-runs`, so recorded run
  directory filtering and runRoot construction are Rust-owned while TypeScript
  keeps the compatibility export for existing CLI call sites
- top-level `unclecode team`, `unclecode team --help`,
  `unclecode team run [options] <objective...>`,
  `unclecode team ls`, `unclecode team status [runId]`,
  `unclecode team inspect [--verify] <runId>`, `unclecode team abort <runId>`,
  `unclecode team doctor`, and slash-form `unclecode "/team status"` now use
  Rust for help text, run manifest/checkpoint creation, `team run --dispatch`
  coordinator execution, worker process spawning, timeout/kill handling,
  stdout/stderr capture, stale-lock sweep, final accepted/killed/errored
  checkpointing, dry-run worker envelope execution under
  `UNCLECODE_TEAM_WORKER_LIVE=0`, live `openai`, `anthropic`, `gemini`,
  `cursor`, `codex`, `opencode`, `hermes`, and `glm` worker adapters with
  task-received checkpoint emission plus mini-loop tool checkpoints for SDK
  lanes, legacy
  `team-...`/current `tr_...` run discovery, latest-status selection, compact
  list output, status summaries, checkpoint hash-chain verification, aborted
  checkpoint append, and lane readiness checks before the temporary TypeScript
  team runner bridge is considered
- top-level `unclecode queue <list|push|pop|len|clear> <session-id>` now uses
  the Rust persistent work queue directly, so users can inspect and repair
  queued follow-ups from the terminal without entering the TypeScript bridge
- top-level `unclecode auth login --print` now generates the browser OAuth
  authorization URL in Rust with PKCE state/challenge construction; browser
  callback waiting and standard device polling are also Rust-owned on the root
  CLI path
- auth issue context merging now uses `unclecode rust context auth-issues`, so
  stale `Auth issue:` removal and refreshed auth diagnostics are Rust-owned
  before `/context` rebuilds the panel
- slash picker selection navigation now uses `unclecode rust ux
  slash-selection`, so clamp/wrap behavior for command/model/auth picker
  movement is Rust-owned while the TUI hook keeps only React state wiring
- clipboard attachment cap decisions now use `unclecode rust ux
  clipboard-cap`, so pasted-image count/size rejection and visible error copy
  are Rust-owned while the TUI hook keeps attachment state and trace emission
- attachment dedup now uses `unclecode rust ux attachment-dedup`, so
  text-derived and clipboard image merge ordering by `dataUrl` is Rust-owned
  while the TUI hook keeps memoized preview state
- composer preview mode now uses `unclecode rust ux composer-preview-mode`,
  so empty/fast/slow preview classification for plain text, `@file`, and
  image-path input is Rust-owned while expensive attachment resolution remains
  on the existing slow resolver path
- composer dock chrome now uses `unclecode rust ux text composer-dock-layout`,
  so slash-input accent, full-attachment warning color role, divider width, and
  CJK-aware footer padding are Rust-owned while React keeps only Ink rendering
- dashboard home sync now uses `unclecode rust ux
  dashboard-home-patch|dashboard-home-sync-state|dashboard-home-refresh`, so
  work-shell-to-home refresh decisions are Rust-owned while React keeps the
  effect lifecycle
- auth label display now uses `unclecode rust ux auth-label`, so
  oauth/api-key/none labels shown in auth panels, status surfaces, and secure
  input flows are Rust-owned instead of duplicated in TUI helpers
- auth label extraction now uses `unclecode rust ux auth-extract-label`, so
  `Auth:`, `Source:`, and `Auth source:` parsing after auth operations is
  Rust-owned instead of a TypeScript regular expression
- auth launcher copy now uses `unclecode rust ux auth-launcher-lines`, so
  route selection, status blurb, next-action copy, and remembered auth result
  normalization are Rust-owned while TUI keeps only panel wiring
- auth status panel copy now uses `unclecode rust ux auth-status-panel-lines`,
  so `/auth status` source/auth/expiry parsing and actionable remediation copy
  are Rust-owned while TUI keeps only the inline command panel hook
- browser OAuth failure copy now uses `unclecode rust ux
  auth-browser-failure-lines`, so missing `OPENAI_OAUTH_CLIENT_ID` detection,
  saved-auth fallback guidance, and API-key/browser remediation copy are
  Rust-owned while TUI keeps only inline command routing
- no-match slash command copy now uses `unclecode rust ux panel commands`, so
  empty command searches get the same Rust-owned guidance as populated command
  picker rows instead of a TypeScript fallback message
- model picker submit context now uses `unclecode rust ux submit-action`, so
  text typed while the Model picker is active submits as `/model <name>` in one
  Enter instead of falling through as an unrelated chat prompt or requiring a
  second confirmation
- model command execution now rejects unknown model ids without changing the
  runtime model, so typos like `/model gkdl` keep the current model and produce
  explicit no-match copy instead of creating a broken ad-hoc model selection
- successful model command execution now returns the work shell to a status
  panel, so selecting a model does not leave the Model picker drawer as a
  ghost panel under the composer
- model command result panels now use Rust-owned "Current model" / "Catalog"
  sections and exact `/model <name>` control copy, matching the live picker
  behavior instead of the older generic chooser text
- model picker no-match copy now says Enter reports the failed match while
  keeping the current model, which matches the protected `/model <typed>` submit
  behavior instead of implying a silent no-op
- Esc session/history recovery now paints a loading panel immediately, shows a
  Rust-owned empty-state panel when there are no sessions, and surfaces session
  store failures as visible Recent sessions guidance instead of appearing to do
  nothing
- queue/steer drain copy now uses Rust-owned queued id and prompt preview text,
  and Queue panels reserve `Next` for the immediate follow-up instead of
  duplicating it in the queued backlog list
- busy `/queue clear` now routes through the queue-clear builtin once, so the
  transcript shows a single clear acknowledgement while the active turn keeps
  running instead of appending a second "Queue shown" entry
- Composer cursor movement, Backspace, and Delete now snap to JavaScript
  character boundaries before editing, preventing emoji/CJK prompt text from
  being split across UTF-16 surrogate boundaries during terminal input
- Composer cursor recovery now distinguishes local edits from parent-driven
  replacements, so Tab completion, submit-time clears, and model-picker
  replacements move the cursor to a safe end position instead of leaving the
  next keystroke in the middle of stale text
- root-bin empty `unclecode work` integration smoke now sends `하이 🙂` through
  the Rust line-session provider request path, covering mixed-width prompt
  preservation outside isolated unit tests
- expanded `/context` panels now stay expanded across trace-line rebuilds and
  `/reload`, then collapse back to the refreshed context on Esc/close instead
  of snapping to stale collapsed copy mid-flow
- built `unclecode tui --help` now receives real work options instead of the
  Commander command object, preventing circular JSON failures in the forwarded
  Rust-native work help path
- built `unclecode center` now forwards directly to the Rust-native center
  line surface, including `center --help`, so the package CLI no longer opens
  the TypeScript/Ink center for the normal center entrypoint
- built `unclecode tui` now uses a Rust stdio passthrough helper and forwards
  to the Rust-native work/tui path, retiring the package CLI's normal TUI
  command from the TypeScript work entrypoint while preserving captured output
  for tests and inherited stdio for interactive shells
- built `unclecode work` now uses the same Rust stdio passthrough helper and
  forwards to the Rust-native work path, so `work --tools`, `work --help`, and
  normal package work sessions no longer depend on the TypeScript work
  entrypoint for the primary command path
- built no-argument `unclecode` startup now uses Rust stdio passthrough to the
  native work line session instead of dynamically opening the TypeScript work
  entrypoint
- built `unclecode resume <session-id>` now calls the Rust-native resume
  summary/JSON path directly, retiring the package CLI's TTY-only jump into the
  TypeScript/Ink session center for normal resume commands
- model picker no-match panels now keep the active model visible and say the
  current model remains unchanged, so typing an unknown model filter does not
  look like the picker lost state or selected a dead row
- `/status` panels now include a Rust-owned Activity section with running/idle
  state, current busy detail, elapsed time, or last-reply timing alongside the
  existing route/proxy/context diagnostics
- CJK/Hangul readability QA now covers Composer character-boundary editing,
  display-width slicing/truncation, CJK footer layout, Rust line-session prompt
  preservation, and full TUI/dashboard smoke contracts
- legacy `launchSessionCenter` no longer loads the TypeScript embedded work pane
  by default; work handoff without an explicit test/compat `loadWorkModule`
  injection now forwards to Rust `work`
- OpenAI auth resolution now sends default and single fallback credential paths
  through Rust; TypeScript keeps only explicit `readFallbackFile` and multi-path
  injected compatibility tests
- OpenAI compat model ordering now mirrors the Rust frontier registry, keeping
  `o4-mini` with newer reasoning-capable picks instead of after older fallback
  models
- runtime status labels now use `unclecode rust ux text runtime-label`, so
  terminal runtime facts shown in TUI diagnostics are Rust-owned rather than a
  TypeScript template string
