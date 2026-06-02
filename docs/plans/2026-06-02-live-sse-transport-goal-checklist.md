# Live HTTP/SSE Transport Goal Checklist

## Continuation Hook

If context is compacted, resume from this file. The local `/goal` intent is:

> Replace UncleCode's current whole-response HTTP/SSE handling with a live stream reader that consumes provider SSE chunks as they arrive, emits assistant/reasoning/tool deltas through provider trace events in real time, keeps WorkShell/TUI rendering smooth, and includes tests plus compaction-safe handoff documentation.

The platform `create_goal` tool could not create a second goal in this thread because the earlier sandbox-theory goal is already recorded as complete. Treat this document as the active handoff checklist.

## Completed

- [x] Verified official OpenAI streaming guidance for HTTP `stream=true` over SSE.
- [x] Mapped buffered path: `OpenAIProvider.requestCodexMessage()` -> whole-body HTTP read -> Rust SSE parser -> trace replay.
- [x] Added live Codex Responses stream reader on the provider fetch path.
- [x] Production Codex runtime now prefers `globalThis.fetch` live streaming when available.
- [x] Existing Rust OpenAI transport remains as buffered fallback.
- [x] Added incremental SSE parser for chunked `data:` blocks.
- [x] Emits `assistant.delta` live for `response.output_text.delta`.
- [x] Emits `reasoning.delta` live for reasoning summary/text deltas.
- [x] Suppresses buffered replay of streamed assistant/reasoning deltas.
- [x] Added controlled stream tests for live assistant and reasoning deltas.

## Verification

- [x] `node --conditions=source --import tsx --test --test-name-pattern "Codex assistant deltas|streams Codex reasoning" tests/work/openai-provider.test.mjs`
- [x] `node --conditions=source --import tsx --test --test-name-pattern "global fetch live stream|Codex assistant deltas|streams Codex reasoning" tests/work/openai-provider.test.mjs`
- [x] `node --conditions=source --import tsx --test --test-name-pattern "Codex backend|Codex assistant deltas|streams Codex reasoning|Codex Responses tool calls" tests/work/openai-provider.test.mjs`
- [x] `node --conditions=source --import tsx --test tests/work/openai-provider.test.mjs`
- [x] `node --conditions=source --import tsx --test --test-name-pattern "assistant delta" tests/orchestrator/work-shell-engine.test.mjs`
- [x] `npm run check --silent`
- [x] `npm run lint --silent`
- [x] `npm run test:tui --silent`
- [x] `git diff --check`

## Remaining Work

- [ ] Add live function-call argument buffering and a new contract-safe trace/event for tool-call preview.
- [ ] Run full provider/orchestrator/TUI regression after final diff review.
- [ ] Decide whether Rust HTTP transport should gain its own streaming stdout protocol or stay buffered fallback.
- [ ] Measure TUI render latency from first SSE chunk to visible token in a local WorkShell run.
- [ ] Commit this live transport slice separately from the earlier review/cleanup commits.
