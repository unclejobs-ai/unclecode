# UncleCode Stdio JSONL RPC Contract

Date: 2026-06-03

## Scope

UncleCode uses a custom newline-delimited JSON protocol over stdio for child processes and local adapters. This is not JSON-RPC 2.0. Frames are line-oriented and each frame must be valid JSON followed by `\n`.

Contract source: `packages/contracts/src/rpc.ts`.

## Handshake

The child process must emit one ready frame before accepting commands:

```json
{"type":"ready","protocol":"unclecode.rpc.jsonl.v1","transport":"stdio-jsonl","capabilities":["session.run","tool.call"]}
```

The host must reject children that advertise another protocol or a missing transport.

## Frame Types

`command` frames are host-to-child requests:

```json
{"type":"command","id":"cmd-1","command":{"name":"session.run","input":{"prompt":"inspect providers","cwd":"/workspace"}}}
```

`response` frames are child-to-host replies for a command id:

```json
{"type":"response","id":"cmd-1","ok":true,"result":{"sessionId":"sess-1"}}
```

Error responses use the same `response` type with `ok:false`:

```json
{"type":"response","id":"cmd-1","ok":false,"error":{"code":"provider.auth.missing","message":"OpenAI credentials are unavailable"}}
```

`event` frames are child-to-host asynchronous events:

```json
{"type":"event","event":{"name":"tool.call","data":{"sessionId":"sess-1","callId":"call-1","name":"shell","input":{"cmd":"pwd"}}}}
```

## Baseline Commands

- `session.run`: start a coding session with prompt, optional cwd, provider id, and model id.
- `session.cancel`: cancel a running session.
- `auth.status`: report credential state without returning secrets.
- `provider.route`: resolve route metadata and OpenAI-compatible policy.
- `tool.result`: host-supplied result for a pending tool call.

## Non-Goals

- No JSON-RPC `jsonrpc`, `method`, or `params` envelope.
- No remote transport in v1.
- No credential material in any frame.
- No binary payloads; attachments must be referenced out-of-band or encoded by an explicit future capability.
