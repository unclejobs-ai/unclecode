# Live HTTP/SSE Transport PRD

## Goal

Replace UncleCode's buffered Codex Responses transport with a live HTTP/SSE reader so assistant and reasoning deltas reach the WorkShell/TUI while the model is still generating.

## Source Of Truth

- OpenAI streaming guide: https://developers.openai.com/api/docs/guides/streaming-responses
- Required request mode: `stream=true` over SSE.
- Primary live events: `response.output_text.delta`, `response.completed`, `error`.
- Advanced live events to preserve: `response.reasoning_summary_text.delta`, `response.reasoning_text.delta`, function-call argument events.

## Problem

Before this work, the Codex Responses path requested an SSE stream but read the whole HTTP body before emitting provider traces. The TUI could only display response deltas after the provider request had already completed, which made chat feel blocked even when the upstream API was streaming.

## Requirements

- Production Codex runtime must prefer a live-readable HTTP transport when `globalThis.fetch` is available.
- Injected test fetch must keep deterministic behavior and must not silently fall back to Rust on test-controlled failures.
- Existing Rust transport remains as a buffered fallback when no live fetch exists or when global fetch transport fails.
- SSE `data:` records must be parsed incrementally across arbitrary chunk boundaries.
- `assistant.delta` and `reasoning.delta` traces must be emitted as soon as complete SSE payloads arrive.
- Final message/tool-call parsing must continue to use the existing Rust parser until incremental tool parsing is implemented.
- Streamed traces must not be replayed from the final buffered parse.
- Non-2xx responses must retain existing provider error formatting, including transient retry attempt counts.

## Non-Goals

- Do not migrate Chat Completions/query transport in this slice.
- Do not remove the Rust HTTP transport fallback.
- Do not execute tools before the final completed item parser confirms the tool call payload.

## Acceptance Criteria

- A controlled stream test observes `assistant.delta` before the stream closes.
- A controlled stream test observes `reasoning.delta` once, without buffered replay duplication.
- Existing Codex Responses tool-call tests still pass.
- `npm run check --silent` passes.
- Targeted OpenAI provider tests pass.

## Follow-Up

- Add incremental function-call argument buffering and a UI-safe tool-call preview trace.
- Add live reader support to Rust transport if Node fetch proxy/retry behavior proves weaker in production.
- Add E2E TUI latency measurement from first HTTP chunk to first rendered assistant token.
