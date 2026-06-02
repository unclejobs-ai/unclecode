# Image Attachment Flow — Composer Ctrl+V → Model Provider

**RUN_ID:** `team-20260429-113220`
**Date:** 2026-04-29
**Type:** Design memo (plan-only — no code changes in this run)
**Manifest:** `~/.data/team-runs/team-20260429-113220/manifest.json`

---

## 0. Brief reconciliation (read this first)

The original mission brief stated:

> `provider.runTurn` (packages/providers) signature still takes a string prompt — no path for image bytes to actually reach Anthropic vision / Gemini multimodal endpoints.

**This claim is empirically false** as of commit `287f8da`. The provider boundary, the orchestrator turn flow, and most of the engine plumbing are already wired to carry `attachments`. Concrete primary-source evidence:

| Layer | File:line | What's already there |
|---|---|---|
| Provider interface | `packages/providers/src/runtime.ts:101-104` | `LlmProvider.runTurn(prompt, attachments?: readonly ProviderInputAttachment[])` |
| Provider attachment shape | `packages/providers/src/runtime.ts:23-30` | `{ type: "image", mimeType, dataUrl, path, displayName }` |
| OpenAI provider | `packages/providers/src/runtime.ts:408+, 416-421` | Builds `image_url` blocks in user message |
| Anthropic provider | `packages/providers/src/runtime.ts:671+, 688-704` | Builds `type: "image"` content blocks with base64 source |
| Gemini provider | `packages/providers/src/runtime.ts:927+, 941` | Builds `inlineData: { mimeType, data }` parts |
| Coding agent | `packages/orchestrator/src/coding-agent.ts:21, 32, 71, 89` | `runTurn(prompt, attachments)` interface + delegation to provider |
| Work agent | `packages/orchestrator/src/work-agent.ts:202-208` | Threads attachments into `executeComplexTask`, simple turn, research turn |
| Engine prompt runtime | `packages/orchestrator/src/work-shell-engine-prompt-runtime.ts:25, 68` | `runAgentTurn(prompt, attachments?)` |
| Engine turn input | `packages/orchestrator/src/work-shell-engine-turns.ts:11, 27, 33` | `WorkShellPromptTurnInput.composer.attachments` |
| Contracts | `packages/contracts/src/attachments.ts:7-19` | `ClipboardImageAttachment` SSOT type, exported via `index.ts:17` |
| TUI composer (capture site) | `packages/tui/src/composer.tsx:299-307` | Ctrl+V handler invokes `props.onClipboardImage(attachment)` |
| TUI work shell pane | `packages/tui/src/work-shell-pane.tsx:127-132` | **Renders `<Composer>` but does NOT pass `onClipboardImage` prop** |
| TUI preview hook | `packages/tui/src/work-shell-hooks.ts:439-475` | Re-runs `resolveComposerInput(value, cwd)` on every keystroke; ignores any clipboard buffer |

**The actual gap is narrow:** the composer fires `onClipboardImage` into the void. The pane never installs a handler, the preview hook never sees the event, the engine-turn `composer.attachments` field is therefore always populated only from text-derived references. Once an attachment lands in pane state and reaches `composer.attachments`, the rest of the rails carry it all the way to `provider.runTurn` with no further changes.

**Type triplication is real.** Three structurally identical types live in three packages:

1. `ClipboardImageAttachment` — `packages/contracts/src/attachments.ts:7` (readonly fields, has companion `ClipboardImageError`)
2. `WorkShellComposerImageAttachment` — `packages/orchestrator/src/composer-input.ts:6` (mutable fields)
3. `ProviderInputAttachment` — `packages/providers/src/runtime.ts:23` (mutable fields)

All five fields (`type`, `mimeType`, `dataUrl`, `path`, `displayName`) match exactly. This is a real layering question that became Q7 below.

The user-supplied brief made this assumption explicit ("Use `ClipboardImageAttachment` from contracts as the source of truth and derive provider-specific shapes at the adapter") but did not notice the duplicates already exist in providers + orchestrator.

---

## 1. Lane provenance (honest)

The brief asked for a 5-model fan-out. Empirical reality:

| Lane | Model | Status | Reason |
|---|---|---|---|
| agent-teams | Claude Opus 4.7 (1M ctx) | **completed** (synthesizer) | Read primary sources; produced verdicts |
| hermes-fanout / coder | Kimi K2.6 | **completed** | Returned full structured 7-question JSON |
| external-codex-orchestration | GPT-5.4 (Codex) | **skipped** | refresh token reused; requires interactive `codex login` |
| hermes-fanout / glmbuilder | GLM-5.1 | **skipped** | `GLM_API_KEY` env var not set |
| mmbridge | multi-tool (kimi/codex/gemini) | **skipped** | `mmbridge debate` is a git-diff review tool. Codex returned a security review of the repo, not answers to design questions. Gemini + Kimi tools silently returned empty positions. |
| unclecode | Gemini side | **skipped** | `better-sqlite3` ABI mismatch (Node 25 shell vs module compiled for Node 22) |

**Result: 2 voting lanes (Claude + Kimi). Per spec § Failure handling, only 3+ *failed* lanes abort; *skipped* lanes do not.** The decision matrix below is honest about who voted; agreement between two distinct models (Anthropic Claude Opus 4.7 + Moonshot Kimi K2.6) on every question is a stronger signal than 5-way fabricated unanimity would have been.

Lane outputs preserved at:
- `~/.data/team-runs/team-20260429-113220/hermes-fanout/coder.txt` (Kimi raw JSON)
- `~/.data/team-runs/team-20260429-113220/manifest.json` (provenance + skip reasons)

---

## 2. Decision matrix (Q1-Q7)

For each question: **Kimi vote** | **Claude vote** | **Synthesis (resolution)**.

### Q1 — Composer → pane wiring: where does pending-clipboard-attachment state live?

| | Vote | Rationale (1-line) |
|---|---|---|
| **Kimi K2.6** | **(B)** state in `work-shell-pane.tsx`, pass into hook | Pane already bridges Composer ↔ engine; hooks shouldn't own UI-level transient state |
| **Claude Opus 4.7** | **(B)** with caveat | The current pane already coordinates `useWorkShellPaneState`, so `pendingClipboardAttachments` lives naturally beside it. Option (A) lifting into the hook conflates derived (text) state with driven (event) state — different reactivity models. Option (C) adds an abstraction layer with no second consumer to justify it. |
| **Synthesis** | **(B) — Pane owns `pendingClipboardAttachments` state slice; preview hook receives it as input** | Both lanes converge. Implementation note: pane stores the attachment list using `useState`, exposes a setter to the Composer's `onClipboardImage` callback, and passes the slice into `useWorkShellComposerPreview` as a new input field. **Pre-flight cap (Kimi flag, accepted): max 5 images, max 5 MB each, enforced in the pane setter** to prevent OOM from accidental large pastes. |

**Risks (merged):**
- Composer's `useInput` Ctrl+V handler is synchronous; pane `setState` inside that callback must use the functional form to avoid stale-closure issues with Ink's batching.
- React state batching on rapid pastes is fine; Ink re-renders won't reset focus as long as the Composer key is stable.
- `dataUrl` strings are large — keep only N attachments, not history.

---

### Q2 — Preview merge strategy: how to combine text-derived and clipboard attachments without dropping/double-counting

| | Vote | Rationale (1-line) |
|---|---|---|
| **Kimi K2.6** | **Merge at hook input boundary; dedup by `dataUrl`; clear on submit** | `path` is unreliable for clipboard images (synthetic `(clipboard)` per `attachments.ts:12-17`); `dataUrl` is the byte-level identity. |
| **Claude Opus 4.7** | **Merge at hook input boundary; dedup by `dataUrl`; clear on submit** | Same conclusion. The hook already returns `composerPreview.attachments` (an array consumed at `work-shell-hooks.ts:101-108`); the merge just changes how that array is computed. |
| **Synthesis** | **Merge at the preview hook layer, dedup by `dataUrl`, clear on submit** | Both lanes agree on key + cleanup point. Mechanism: `useWorkShellComposerPreview` gains a new input `pendingClipboardAttachments: readonly ClipboardImageAttachment[]`. After `resolveComposerInput(value, cwd)` returns text-derived attachments, the hook merges with `pendingClipboardAttachments`, deduping by `dataUrl` (Set keyed on `dataUrl`). On submit, the engine handler calls `setPendingClipboardAttachments([])` to flush. The fast-path branch `createFastWorkShellComposerPreview` (`work-shell-hooks.ts:46-52`) which currently returns `attachments: []` unconditionally **must also merge pending attachments** — Kimi flagged this in concerns_outside_questions. |

**Risks:**
- Same image pasted twice silently dedups (acceptable; future UX could surface a toast).
- Memory pressure if pending attachments are not capped. See Q1 cap recommendation.
- Cleanup ordering: pane must clear `pendingClipboardAttachments` *after* engine `handleSubmit` resolves, not before (to avoid races where the engine sees an empty list).

---

### Q3 — `resolveComposerInput` contract change: should it gain `pendingAttachments` parameter?

| | Vote | Rationale (1-line) |
|---|---|---|
| **Kimi K2.6** | **Keep text-only; merge at hook layer** | Function is a pure async helper with unit-test coverage; adding clipboard-state parameter muddies the contract and complicates tests. |
| **Claude Opus 4.7** | **Keep text-only; merge at hook layer** | `resolveComposerInput` is a deterministic text→attachments parser. Threading transient UI state through it breaks single-responsibility and the `WorkShellComposerResolution<Attachment>` generic shape (which is supposed to be a *resolution result*, not an event sink). |
| **Synthesis** | **Keep `resolveComposerInput(value, cwd)` text-only. Merge at the hook layer.** | Unanimous. `transcriptText` does need to mention clipboard-attached images so the conversation log is honest; this happens at the hook merge step (after merge, hook builds an augmented transcript line `Attached image (clipboard): <displayName>` for each non-text-derived attachment). |

**Risks:**
- Downstream consumers must understand `resolveComposerInput.attachments` is text-only; the canonical attachment list lives at the hook output. Document this in the function's JSDoc.
- The generic `Attachment` parameter on `WorkShellComposerResolution<Attachment>` (currently `WorkShellComposerImageAttachment`) and on the hook's input must be compatible with `ClipboardImageAttachment` post-Q7 unification. If Q7 lands first, this is automatic.

---

### Q4 — Provider boundary: is `LlmProvider.runTurn(prompt, attachments)` sufficient?

| | Vote | Rationale (1-line) |
|---|---|---|
| **Kimi K2.6** | **No signature change required. Provider-internal validation gaps exist.** | All three providers convert correctly today. Real gaps: no Anthropic `cache_control`, no PDF/document support, no max-image-count enforcement, no base64 size pre-flight check, hardcoded mime allow-list at `runtime.ts:676` silently drops `image/bmp`. |
| **Claude Opus 4.7** | **No signature change required. Provider-internal hardening recommended.** | Confirmed via primary read: OpenAI builds `image_url` blocks (`runtime.ts:416-421`), Anthropic builds `type: "image"` blocks with `source: { type: "base64", media_type, data }` (`runtime.ts:688-704`), Gemini builds `inlineData: { mimeType, data }` (`runtime.ts:941`). All three branches read `attachment.dataUrl`, strip the `data:<mime>;base64,` prefix, pass the bytes through. |
| **Synthesis** | **NO signature change to `LlmProvider.runTurn`. Defer multimodal hardening to a follow-up.** | Both lanes converge on no signature change. The hardening list (cache_control, doc support, count limits, size validation, mime allow-list expansion) is a real but separate workstream — file as a follow-up issue, do not block the Ctrl+V wiring on it. |

**Hardening backlog (file as separate issue):**
- Anthropic `cache_control: { type: "ephemeral" }` for large images repeated across turns.
- Pre-flight base64 size check (~5 MB Anthropic, ~20 MB Gemini per request, model-dependent).
- Mime allow-list at `AnthropicProvider` (`runtime.ts:676`) currently png/jpeg/gif/webp; either expand or surface a "dropped: unsupported mime" trace event.
- Max-image-count enforcement (e.g., 20 for Claude 3.5 Sonnet) — fail fast with a `userMessage` rather than letting the API 400.
- Document attachments (PDF, text) — out of scope for clipboard image flow; gate behind a later `type: "document"` extension to `ProviderInputAttachment`.

---

### Q5 — Turn flow: are attachments stripped mid-flight?

| | Vote | Rationale (1-line) |
|---|---|---|
| **Kimi K2.6** | **NOT all paths safe. Three confirmed leaks.** | (a) `WorkAgent.runTurn:215, 234, 275` calls `directAgent.runTurn(..., [])` for sub-tasks/review/synthesis. (b) `finalizeWorkShellAssistantReply` at `work-shell-engine-turns.ts:175` calls `runTurn(prompt)` with no attachments on permission-stall follow-up. (c) `createPromptCommandTurnInput` at `work-shell-engine-turns.ts:39-47` hardcodes `<never>` so prompt commands (`/review`) cannot carry images. |
| **Claude Opus 4.7** | **Confirmed all three leaks via primary read.** | The work-agent leaks at `:215, :234, :275` *appear* intentional from the prompt-construction context (synthetic re-prompts for orchestrated sub-turns; re-attaching the original user image into a per-task or guardian-review prompt would be semantically odd and token-expensive) — but this should be **verified against `git blame` / commit message** during the implementation pass before declaring it the canonical interpretation. The follow-up leak at `work-shell-engine-turns.ts:175` is a **bug** — it's a continuation of the same user request after a permission stall and should re-attach. The `<never>` typing on prompt-command turns is a **design choice** that should become `<ClipboardImageAttachment>` if `/review` etc. need image input. |
| **Synthesis** | **Follow-up policy:** | <ul><li>**First user turn:** attach images. (already wired)</li><li>**Permission-stall continuation (`work-shell-engine-turns.ts:175`):** **re-attach** the original images. This is a real bug; fix in the implementation pass.</li><li>**Orchestrator sub-turns (`work-agent.ts:215, 234, 275`):** keep empty `[]` as the working assumption (synthetic prompts for planner/reviewer/synthesizer; original images live in conversation context). **Verify against `git blame` before locking this in** — the "intentional" label here is inferred from prompt-construction context, not from the original commit message.</li><li>**Prompt-command turns (`work-shell-engine-turns.ts:39-47`):** keep `<never>` for now (leave `/review` as text-only); revisit only when a user-facing feature needs image-carrying prompt commands.</li></ul> |

**Risks:**
- Re-attaching images on the permission-stall follow-up doubles the per-turn token budget for those flows. Acceptable — the alternative is the model losing visual context mid-conversation.
- Documenting the "intentional leak" at `work-agent.ts:215, 234, 275` requires a comment so future maintainers don't mistake it for a bug. Add a short comment block when the implementation pass touches that area.

---

### Q6 — Trace honesty: do we need new `ExecutionTraceEvent` variants?

| | Vote | Rationale (1-line) |
|---|---|---|
| **Kimi K2.6** | **Yes — add `attachment.attached` and `attachment.dropped`** | Honesty requires tracing source (clipboard vs text), mimeType, displayName on attach, and reason on drop. `dispatched` is redundant because `turn.started` already signals the provider call. |
| **Claude Opus 4.7** | **Yes — minimal pair: `attachment.attached`, `attachment.dropped`** | Consistent with the discriminated-union refactor in commit `c91cd24` (flat type/level shape, no nested namespaces). |
| **Synthesis** | **Add two new events to `ExecutionTraceEvent` (or `OrchestratorStepTraceEvent`, whichever houses turn-scoped events post-c91cd24):** | <pre>{ type: "attachment.attached", level: "default", source: "clipboard" \| "text", mimeType: string, displayName: string, sizeBytes?: number }<br>{ type: "attachment.dropped", level: "low-signal", reason: "orchestrator-sub-turn" \| "follow-up-missing" \| "unsupported-mime" \| "size-cap" \| "count-cap", displayName: string }</pre> |

**Why both:** `attached` is the user-visible affirmation that the image entered the turn; `dropped` is the auditable trail when an attachment is lost (whether by design at orchestrator sub-turns or by failure at provider validation). Together they make the system self-honest about visual context.

**Risks:**
- Adding events to a discriminated union is a non-breaking extension only if all consumers use exhaustive `switch` with no default. Verify with `tsc --noEmit` after the Q6 implementation pass.
- `dataUrl` MUST NOT be included in trace events (PII / size). Only metadata (`mimeType`, `displayName`, `sizeBytes`).

---

### Q7 — Type unification: should provider/orchestrator types alias `ClipboardImageAttachment`?

| | Vote | Rationale (1-line) |
|---|---|---|
| **Kimi K2.6** | **Partial unification: alias both with `Readonly<ClipboardImageAttachment>` from contracts; keep `ClipboardImageError` only in contracts** | One-way dependency rule satisfied (contracts is the lowest layer). `ClipboardImageError` only makes sense at capture boundary. |
| **Claude Opus 4.7** | **Partial unification, same shape** | Confirmed structural identity by reading all three declarations. Contracts is already the SSOT-by-position (lowest layer, no upstream deps); making providers + orchestrator alias it eliminates 2 duplicate type definitions and forces future changes to flow from contracts outward. |
| **Synthesis** | **Partial unification:** | <ul><li>`packages/providers/src/runtime.ts:23-30` → `export type ProviderInputAttachment = ClipboardImageAttachment;` (re-export from `@unclecode/contracts`)</li><li>`packages/orchestrator/src/composer-input.ts:6-12` → `export type WorkShellComposerImageAttachment = ClipboardImageAttachment;` (re-export from `@unclecode/contracts`)</li><li>`ClipboardImageError` stays in contracts; not re-exported by providers/orchestrator (only the capture site needs it).</li><li>`packages/tui/src/composer.tsx` import path change: switch from `@unclecode/orchestrator` to `@unclecode/contracts` to drop the indirect coupling Kimi flagged.</li></ul> |

**Risks:**
- `readonly` propagation: if any downstream code mutates `ProviderInputAttachment` fields today (e.g., adding `id` in-place), the alias surfaces a compile error. Audit revealed providers only *read* the fields — should be safe. Verify with `tsc --noEmit` during implementation.
- ABI break across packages: the implementation pass must be a single atomic commit touching `contracts`, `providers`, `orchestrator`, `tui` together. No package can lag.
- Future divergence (e.g., contracts adds `sizeBytes`) propagates to all packages — that's a feature, not a bug.

---

## 3. Concerns surfaced outside the 7 questions (both lanes)

Both lanes flagged these. None are blockers for the wiring fix; all are real:

1. **`work-shell-pane.tsx:127-132`** — `<Composer>` element does not currently pass `onClipboardImage` or `onClipboardImageError` props. This is the literal one-line missing wiring. (Both lanes.)
2. **`createFastWorkShellComposerPreview`** at `work-shell-hooks.ts:46-52` — fast-path returns `attachments: []` unconditionally; must also merge pending clipboard attachments to avoid losing them when the hook short-circuits. (Kimi.)
3. **No size/count caps** on clipboard images — accidental 50 MB paste will OOM the TUI or fail at provider time. Pre-flight cap in pane state layer (5 images × 5 MB). (Kimi; Claude concurs.)
4. **`composer.tsx` imports `ClipboardImageAttachment` from `@unclecode/orchestrator`** today, not contracts. Update import path during Q7 unification pass. (Kimi.)
5. **`transcriptText` does not currently enumerate clipboard-pasted images.** After merge, the hook should append `Attached image (clipboard): <displayName>` lines so the on-screen transcript matches the model's actual input. (Both lanes.)

---

## 4. Implementation plan (suggested ordering for the next run)

This memo is plan-only. When implementation begins, the suggested ordering is:

| Step | Touches | Why first/last |
|---|---|---|
| **1. Q7 type unification** | contracts (no change), providers/runtime.ts, orchestrator/composer-input.ts, tui/composer.tsx imports | Simplifies all subsequent steps; lets later code use one shared type. Low risk: structural identity already verified. |
| **2. Q1+Q2 pane wiring + merge** | tui/work-shell-pane.tsx, tui/work-shell-hooks.ts (`useWorkShellComposerPreview` and `createFastWorkShellComposerPreview`) | The actual user-visible fix. Uses unified type from step 1. Q3 implicitly resolved (no `resolveComposerInput` change). |
| **3. Pre-flight caps** | tui/work-shell-pane.tsx (in the `setPendingClipboardAttachments` setter) | Defensive; prevents OOM. Tiny diff. |
| **4. Q5 follow-up leak fix** | orchestrator/work-shell-engine-turns.ts:175 (thread attachments through `finalizeWorkShellAssistantReply`) | One bug fix. Requires `runTurn` re-call to receive original attachments. |
| **5. Q6 trace events** | contracts/orchestrator-step-trace OR contracts/execution-trace (whichever houses turn-scoped events post-c91cd24); emit at attach/drop sites | Honesty over plumbing; lands after the data path is correct. |
| **6. Q4 provider hardening (separate workstream)** | providers/runtime.ts (Anthropic mime list, size pre-flight, max-count) | File as a follow-up issue. Not blocking. |

**Out-of-scope for the next implementation pass:** prompt-command image input (`/review`-with-image), document/PDF attachments, Anthropic `cache_control` for image caching. Each is its own design memo.

**Test plan stubs (for the implementation run, not this one):**
- `work-shell-pane.test.tsx`: paste-then-keystroke does not drop attachment.
- `work-shell-pane.test.tsx`: submit clears `pendingClipboardAttachments`.
- `work-shell-hooks.test.ts`: text-derived + clipboard merge dedupes by `dataUrl`.
- `work-shell-hooks.test.ts`: fast path includes pending clipboard attachments.
- `work-shell-engine-turns.test.ts`: permission-stall follow-up re-attaches original images.
- `runtime.test.ts`: still passes after type unification (no behavior change expected).
- `composer.test.tsx` (existing `handleComposerClipboardPaste` tests): unchanged — pure helper contract preserved.

---

## 5. Final synthesis

**Provenance, stated honestly:** Kimi K2.6 (via `hermes coder`) produced an *independent* verdict on all 7 questions, returning the structured JSON in `~/.data/team-runs/team-20260429-113220/hermes-fanout/coder.txt`. Claude Opus 4.7 (the synthesizer) had previously read all cited files end-to-end (Q1–Q7 grounded in primary-source citations recorded under § 0), then reviewed Kimi's output against that primary read and concurred on every question. This is **one independent vote (Kimi) plus a synthesizer concurrence grounded in primary sources** — *not* two fully independent samples. The agreement is still informative (different model families, different read paths, same verdict) but the rhetorical weight should not exceed that. Three additional lanes (external-codex-orchestration/Codex, glmbuilder/GLM, mmbridge multi-tool, unclecode/Gemini) were skipped due to environmental/auth issues unrelated to the design work; their absence is documented in the manifest rather than being papered over.

**The chosen direction:**

> Lift `pendingClipboardAttachments` state into `work-shell-pane.tsx`. Pass it as a new input into `useWorkShellComposerPreview`, where it merges with text-derived attachments using `dataUrl` as the dedup key. Clear the slice after submit. Keep `resolveComposerInput` text-only — no signature change. Apply pre-flight caps (5 images × 5 MB) in the pane setter to bound TUI memory. Unify `ProviderInputAttachment` and `WorkShellComposerImageAttachment` as `Readonly` aliases of `ClipboardImageAttachment` from contracts. Add two new trace events (`attachment.attached`, `attachment.dropped`) consistent with the discriminated-union shape from commit c91cd24. Fix the permission-stall follow-up leak at `work-shell-engine-turns.ts:175`. Defer Anthropic/Gemini multimodal hardening (cache_control, mime allow-list, size/count enforcement) to a separate workstream.

**The provider boundary does not need to change.** That part of the brief was based on stale information.

---

## 6. Authoritative outputs

- This memo: `/Users/parkeungje/project/unclecode/docs/plans/team-20260429-113220-image-attachment-flow.md`
- Run manifest: `/Users/parkeungje/.data/team-runs/team-20260429-113220/manifest.json`
- Lane raw outputs: `/Users/parkeungje/.data/team-runs/team-20260429-113220/{hermes-fanout/coder.txt, mmbridge/output.json}`
- Lane prompt: `/Users/parkeungje/.data/team-runs/team-20260429-113220/lane-prompt.md`

When implementation begins, this memo is the authoritative design reference. Apply Q1–Q7 in the suggested order under § 4. Do not re-litigate solved questions during implementation — file new design memos for any new design questions.
