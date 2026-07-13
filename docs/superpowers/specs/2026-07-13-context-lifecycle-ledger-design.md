# Context Lifecycle Ledger Design

Date: 2026-07-13
Status: Approved design

## 1. Decision

UncleCode will extend the existing Context Runbook Protocol (CRP) with a Context Lifecycle Ledger. The ledger will prove which context packet was previewed, changed, and submitted for each provider request. A deterministic optimizer and provenance-preserving memory governor will build on that proof layer in later slices.

The existing `context_sources` store, selector, packet formatter, and source mutations remain authoritative. The ledger does not become a second source of truth for inclusion state. It records lifecycle transitions and provenance.

## 2. Goals

1. Bind every assistant turn to the exact context packet sent to the provider.
2. Expose when a packet inspected in `/context` changes before submission.
3. Generate explainable keep, summarize, hold-back, and refresh suggestions without silently mutating context.
4. Preserve source and turn provenance when facts become long-term memory.
5. Keep raw ledgers, secrets, and held-back content local unless CRP explicitly includes them in the submitted packet.

## 3. Non-goals

- Replacing the CRP selector or `context_sources` schema.
- Event-sourcing every existing context mutation.
- Allowing an LLM to remove context autonomously.
- Persisting duplicate packet bodies in receipt tables.
- Adding a remote context service or new dependency.
- Reworking unrelated Work Shell panels.

## 4. Current Baseline

The current implementation already provides:

- CRP-backed packet selection and shared formatter-derived provider previews.
- A Context Desk with source navigation, local detail expansion, pin/unpin, include/hold-back, token attribution, freshness indicators, and action receipts.
- Packet action receipts with before and after packet IDs.
- Adaptive model-window display.
- Reuse of an inspected packet for the next submit while the Context Desk remains open.

The remaining architectural gap is lifecycle proof. The engine retains a packet in memory but does not persist a durable preview/submission relationship or attach the submitted packet to the resulting assistant turn. It also cannot distinguish a harmless safety refresh from a user-meaningful packet change.

## 5. Architecture

```text
Context Sources
    |
    v
CRP Selector ---> Context Packet
                    |
                    +-- previewed receipt
                    +-- submitted receipt ---> assistant turn
                    +-- invalidated receipt
                                           |
                                           v
                               Policy Evaluator
                          keep / summarize / hold
                                           |
                                           v
                                Memory Governor
                        promote / supersede / expire
```

### 5.1 Invariants

1. Only the packet actually sent to the provider may enter `submitted` state.
2. Every completed assistant turn references exactly one submitted packet receipt.
3. A previewed packet that changes is invalidated rather than silently overwritten.
4. Optimizer suggestions never mutate CRP state directly.
5. Accepted suggestions use the existing CRP mutation path and produce normal action and replacement-packet receipts.
6. Long-term memories retain their originating source, turn, and submitted packet receipt.
7. A newer memory supersedes an older memory through lineage; it does not erase provenance.
8. Receipt storage contains identifiers, state, and aggregates, not duplicated raw source content.
9. Provider invocation is forbidden when the submitted receipt cannot be durably recorded.

## 6. Data Model

### 6.1 `context_packet_receipts`

| Column | Type/values | Purpose |
|---|---|---|
| `id` | text primary key | Durable receipt identifier |
| `project_id` | text foreign key | Owning CRP project; prevents cross-workspace receipt lookup |
| `session_id` | text | Owning Work Shell session |
| `turn_id` | text nullable | Set when submitted for a turn |
| `packet_id` | text | Existing CRP packet identifier |
| `state` | `previewed \| submitted \| invalidated` | Lifecycle state |
| `replaces_receipt_id` | text nullable | Previous preview replaced by this receipt |
| `profile` | text | Context profile used by selection |
| `token_estimate` | integer nullable | Packet estimate when known |
| `token_estimate_state` | `exact \| estimated \| unknown` | Prevents fake precision |
| `source_count` | integer | Included source count |
| `source_refs_json` | JSON array | Ordered source IDs plus category, SHA, trust tier, salience, and inclusion state; never raw content |
| `created_at` | timestamp | Durable ordering |

Packet bodies are not copied into this table. `source_refs_json` persists the minimal metadata needed to prove and compare the submitted selection while the existing packet manifest and `context_sources` rows remain authoritative for content. Direct pin/include protection during an active session is derived from CRP action receipts; resumed previews are always stale and must be rebuilt.

### 6.2 `context_policy_suggestions`

| Column | Type/values | Purpose |
|---|---|---|
| `id` | text primary key | Suggestion identifier |
| `packet_receipt_id` | text | Preview/submission evaluated |
| `source_id` | text | Target source |
| `action` | `keep \| summarize \| hold_back \| refresh` | Proposed action |
| `reason_code` | text | Stable machine-readable explanation |
| `reason_text` | text | Operator-facing explanation |
| `estimated_token_saving` | integer nullable | Nullable when unknown |
| `status` | `proposed \| accepted \| rejected \| stale` | Resolution state |
| `created_at` | timestamp | Creation time |
| `resolved_at` | timestamp nullable | Acceptance or rejection time |

The evaluator initially supports deterministic rules only:

- duplicate SHA or content fingerprint;
- stale or expired source;
- disproportionate token cost from a low-trust source;
- stale condensed history;
- runtime trace unrelated to the active work graph.

### 6.3 `memory_lineage`

| Column | Type/values | Purpose |
|---|---|---|
| `memory_id` | text primary key | Existing memory record |
| `source_id` | text | Originating context source |
| `origin_turn_id` | text | Turn that established the memory |
| `origin_packet_receipt_id` | text | Submitted context proof |
| `supersedes_memory_id` | text nullable | Prior memory replaced by this fact |
| `state` | `active \| superseded \| expired` | Selector-visible lifecycle |
| `confidence` | real | Recorded confidence |
| `created_at` | timestamp | Creation time |
| `expires_at` | timestamp nullable | Optional expiry |

Only `active` memories are eligible for normal context selection. Superseded and expired memories remain inspectable but are not injected as duplicate active facts.

## 7. Lifecycle

### 7.1 Preview

1. `/context` resolves a CRP packet.
2. The ledger records a `previewed` receipt.
3. The Context Desk shows the packet ID, estimate state, token estimate, model window, and source count.
4. Reopening the same unchanged packet may reuse the active preview receipt rather than append duplicates.

### 7.2 Source Mutation

1. The user chooses pin, unpin, include, or hold-back.
2. The existing CRP mutator changes `context_sources`.
3. The engine resolves a replacement packet.
4. The previous preview becomes `invalidated`.
5. A replacement `previewed` receipt references the prior receipt.
6. The existing source action receipt links the before/after packet transition.

### 7.3 Submit Revalidation

Immediately before provider invocation, the engine resolves or validates the candidate packet and compares it with the active preview.

Changes are classified as:

- **Safety-preserving:** mandatory guidance refresh, secret redaction, or equivalent policy correction. The latest packet is recorded and submitted, and the replacement is shown in the receipt.
- **Meaning-changing:** a source explicitly pinned or included by the user disappears, or a held-back source becomes included without the user's action. Submission stops and the Context Desk shows the diff for review.

If the packet is unchanged, the preview receipt transitions to `submitted`. If it changed, the old preview is invalidated and the replacement receipt becomes the submission candidate.

The provider call starts only after the submitted receipt and turn binding are durable.

### 7.4 Post-turn Evaluation

1. The assistant turn completes and retains its submitted receipt reference.
2. The deterministic evaluator generates suggestions for the submitted packet.
3. Suggestions appear in the Context Desk Advice section.
4. Rejection records resolution without changing CRP.
5. Acceptance invokes the existing mutation path, creates an action receipt, and produces a replacement preview packet.
6. Memory candidates are promoted only with complete lineage.

## 8. User Experience

### 8.1 Context Desk Header

Normal preview:

```text
NEXT REQUEST  crp-a91f  previewed  ~18.4k / 128k
```

Meaning-changing replacement:

```text
PACKET CHANGED  crp-a91f -> crp-b203
Reason: pinned source changed · review required
```

### 8.2 Turn Receipt

Each assistant turn receives a compact footer:

```text
ctx crp-b203 · 14 sources · ~18.1k · 2 memories
```

Opening the footer shows a read-only receipt with:

- the actual submitted packet ID;
- included source identities;
- held-back source count;
- exact, estimated, or unknown token state;
- applied source mutations;
- memory provenance;
- optimizer suggestions and their resolutions.

### 8.3 Advice

Optimizer output stays separate from authoritative packet content:

```text
SAVE ~3.2k  summarize old condensed history
HOLD ~1.1k  duplicate runtime trace
KEEP        AGENTS.md · mandatory
```

No suggestion changes the next provider request until accepted.

## 9. Error Handling

- **Ledger write failure:** abort provider invocation. UncleCode must not create an unprovable request.
- **Suggestion evaluation failure:** preserve the request and assistant response; mark Advice unavailable.
- **Memory lineage failure:** preserve the assistant response, cancel memory promotion, and expose a local warning.
- **Receipt/manifest mismatch:** mark the receipt corrupt, exclude it from reuse, and resolve a fresh packet.
- **Resumed preview receipt:** mark stale and compare against a newly resolved packet; never promote it directly to submitted.
- **Missing token estimate:** store and render `unknown`; never coerce to zero.
- **Sensitive content:** store only source IDs and aggregates in the ledger. Existing redaction remains authoritative for provider payloads.

## 10. Delivery Slices

### Slice 1: Packet Proof

- Add receipt schema and store operations.
- Add previewed, invalidated, and submitted transitions.
- Bind submitted receipts to Work Shell turns.
- Classify submit-time packet changes.
- Show packet transitions and turn receipts in the Context Desk.

### Slice 2: Context Optimizer

- Add deterministic suggestion evaluator.
- Add suggestion persistence and Advice UI.
- Apply accepted suggestions through existing CRP mutators.
- Invalidate stale suggestions when their packet is replaced.

### Slice 3: Memory Governor

- Add lineage persistence.
- Implement promote, supersede, and expire transitions.
- Filter superseded and expired memories from active selection.
- Expose memory provenance in the turn receipt and Context Desk.
- Validate lineage during session resume.

Each slice is independently deployable. Later slices add tables and behavior without changing the meaning of earlier receipt records.

## 11. Acceptance Tests

### Packet Proof

- A completed assistant turn has exactly one submitted receipt.
- The provider-bound packet ID equals the submitted receipt packet ID.
- Losing a user-pinned or explicitly included source blocks submission.
- A mandatory-guidance safety refresh records a replacement and proceeds with the latest packet.
- A stale resumed preview cannot transition directly to submitted.
- A ledger write failure prevents provider invocation.
- Receipt rows do not contain raw source content or secrets.

### Context Optimizer

- A rejected suggestion leaves CRP state unchanged.
- An accepted suggestion creates a CRP action receipt and replacement preview.
- Suggestions become stale when their referenced packet is invalidated.
- Unknown token estimates remain nullable and never render as zero savings.
- Deterministic inputs produce deterministic reason codes and ordering.

### Memory Governor

- Promoted memory references its origin source, turn, and submitted packet receipt.
- A superseded memory is not selected as a second active fact.
- Expired memory remains inspectable but is excluded from provider context.
- Lineage write failure prevents promotion without removing the assistant response.
- Session resume rejects active memories with broken lineage.

## 12. Rollback

- Slice 1 can be disabled at the Work Shell integration seam while leaving receipt tables intact.
- Slice 2 can stop generating suggestions without affecting packet selection or receipts.
- Slice 3 can stop promoting memories without altering existing CRP source records.
- Migrations are additive. Rollback does not require destructive table removal.
