# Context Lifecycle Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable packet-proof ledger, deterministic context optimizer, and provenance-preserving memory governor for UncleCode Work Shell.

**Architecture:** Keep `context_sources`, the CRP selector, and existing source mutations authoritative. Add typed AgentOps persistence for packet receipts, policy suggestions, and memory lineage; wire those adapters through the CRP runtime into the Work Shell engine; render proof and advice from the same records that control provider submission.

**Tech Stack:** Node.js 22, TypeScript, `node:sqlite`, React/Ink TUI, Node test runner, Rust-owned Work Shell helper surfaces where already present.

## Global Constraints

- No new dependencies.
- Packet bodies and raw source content MUST NOT be copied into lifecycle tables.
- `source_refs_json` stores identifiers and selection metadata only.
- Provider invocation MUST NOT begin unless the submitted receipt is durable.
- Optimizer suggestions MUST NOT mutate CRP state until explicitly accepted.
- Resumed preview receipts are stale and MUST be rebuilt before submission.
- Existing CRP selection and source mutation behavior remains the source of truth.
- Every new database migration is additive and rollback-safe.
- Use test-first changes and commit each task independently.

---

## File Structure

### Contracts

- Create `packages/contracts/src/context-lifecycle.ts`: lifecycle states, source references, packet receipts, change classifications, suggestions, and memory lineage records.
- Modify `packages/contracts/src/index.ts`: export the lifecycle contracts.

### AgentOps persistence

- Modify `packages/agentops-db/src/schema-sql.ts`: migrations 6–8 and initial-schema definitions for lifecycle tables.
- Create `packages/agentops-db/src/store-context-receipts.ts`: packet receipt transitions and reads.
- Create `packages/agentops-db/src/store-context-suggestions.ts`: suggestion persistence and status transitions.
- Create `packages/agentops-db/src/store-memory-lineage.ts`: lineage writes, supersede/expire transitions, and active-state queries.
- Modify `packages/agentops-db/src/store-types.ts`, `store.ts`, and `index.ts`: expose typed store methods.
- Extend `tests/agentops-db/context-sources.test.mjs`: persistence, uniqueness, redaction, transition, and rollback contracts.

### CRP and Work Shell

- Create `apps/unclecode-cli/src/work-runtime-context-ledger.ts`: adapter that owns receipt, suggestion, and lineage operations over the CRP AgentOps store.
- Modify `apps/unclecode-cli/src/work-runtime-crp.ts`: expose the shared store/project identity, ordered source refs, deterministic suggestion inputs, and accepted CRP mutation seam.
- Modify `apps/unclecode-cli/src/work-runtime-bootstrap.ts`: wire lifecycle adapters into Work Shell.
- Modify `apps/unclecode-cli/src/work-runtime-dashboard.ts`: thread typed callbacks to the engine.
- Create `packages/orchestrator/src/context-packet-change.ts`: pure packet comparison and safety/meaning classification.
- Create `packages/orchestrator/src/context-policy-evaluator.ts`: deterministic suggestion evaluator.
- Modify `packages/orchestrator/src/work-shell-engine.ts`, `work-shell-engine-factory.ts`, and prompt/post-turn helper files: preview, revalidate, submit, turn-bind, advice, and memory lineage lifecycle.
- Extend `tests/work/work-runtime-crp.test.mjs` and `tests/orchestrator/work-shell-engine.test.mjs`.

### TUI

- Modify `packages/tui/src/work-shell-context-inspector-header.tsx`: preview/submitted/invalidated status and packet transition copy.
- Create `packages/tui/src/work-shell-context-receipt.tsx`: read-only submitted-turn receipt.
- Create `packages/tui/src/work-shell-context-advice.tsx`: suggestions and resolution state.
- Modify `packages/tui/src/work-shell-context-workbench.tsx`, `work-shell-context-inspector.tsx`, `work-shell-view.tsx`, `work-shell-pane.tsx`, and `work-shell-hooks.ts`: display and actions.
- Extend `tests/tui/work-shell-context-inspector-render.test.mjs` and `tests/contracts/tui-work-shell.contract.test.mjs`.

### Memory

- Modify `packages/context-broker/src/context-memory.ts`: lineage-aware promotion and active-memory filtering through an injected adapter.
- Modify `packages/context-broker/src/memory-prefetch.ts`: exclude superseded/expired memories.
- Extend `tests/context-broker/context-memory.test.mjs` and `memory-prefetch.test.mjs`.

---

### Task 1: Define Lifecycle Contracts

**Files:**
- Create: `packages/contracts/src/context-lifecycle.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `tests/contracts/context-lifecycle.contract.test.mjs`

**Interfaces:**
- Produces `ContextPacketReceipt`, `ContextPacketReceiptSourceRef`, `ContextPacketChangeClassification`, `ContextPolicySuggestion`, `MemoryLineageRecord`, and all write-input types used by later tasks.
- Consumes existing `ContextPacketSourceCategory`, `ContextPacketTokenEstimateState`, and `ContextPacketViewTrustTier`.

- [ ] **Step 1: Write the failing contract test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_PACKET_RECEIPT_STATES,
  CONTEXT_POLICY_ACTIONS,
  MEMORY_LINEAGE_STATES,
  isContextPacketReceiptState,
} from "@unclecode/contracts";

test("context lifecycle contracts expose closed state sets", () => {
  assert.deepEqual(CONTEXT_PACKET_RECEIPT_STATES, ["previewed", "submitted", "invalidated"]);
  assert.deepEqual(CONTEXT_POLICY_ACTIONS, ["keep", "summarize", "hold-back", "refresh"]);
  assert.deepEqual(MEMORY_LINEAGE_STATES, ["active", "superseded", "expired"]);
  assert.equal(isContextPacketReceiptState("submitted"), true);
  assert.equal(isContextPacketReceiptState("pending"), false);
});
```

- [ ] **Step 2: Run the contract test and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/contracts/context-lifecycle.contract.test.mjs
```

Expected: FAIL because `context-lifecycle.ts` and its exports do not exist.

- [ ] **Step 3: Add the lifecycle contracts**

```ts
import type {
  ContextPacketSourceCategory,
  ContextPacketTokenEstimateState,
  ContextPacketViewTrustTier,
} from "./context-packet-view.js";

export const CONTEXT_PACKET_RECEIPT_STATES = ["previewed", "submitted", "invalidated"] as const;
export type ContextPacketReceiptState = (typeof CONTEXT_PACKET_RECEIPT_STATES)[number];

export type ContextPacketReceiptSourceRef = {
  readonly sourceId: string;
  readonly category: ContextPacketSourceCategory;
  readonly sha256?: string | undefined;
  readonly trustTier?: ContextPacketViewTrustTier | undefined;
  readonly salience: number;
  readonly includedInModel: boolean;
};

export type ContextPacketReceipt = {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly packetId: string;
  readonly state: ContextPacketReceiptState;
  readonly replacesReceiptId?: string | undefined;
  readonly profile: string;
  readonly tokenEstimate?: number | undefined;
  readonly tokenEstimateState: ContextPacketTokenEstimateState;
  readonly sourceCount: number;
  readonly sourceRefs: readonly ContextPacketReceiptSourceRef[];
  readonly createdAt: string;
};

export type RecordContextPacketPreviewInput = Omit<
  ContextPacketReceipt,
  "state" | "turnId" | "createdAt"
> & { readonly createdAt?: string | undefined };

export type SubmitContextPacketReceiptInput = {
  readonly projectId: string;
  readonly receiptId: string;
  readonly sessionId: string;
  readonly turnId: string;
};

export type ContextPacketChangeClassification = {
  readonly kind: "unchanged" | "safety-refresh" | "meaning-change";
  readonly removedSourceIds: readonly string[];
  readonly addedSourceIds: readonly string[];
  readonly protectedSourceIds: readonly string[];
  readonly reason: string;
};

export const CONTEXT_POLICY_ACTIONS = ["keep", "summarize", "hold-back", "refresh"] as const;
export type ContextPolicyAction = (typeof CONTEXT_POLICY_ACTIONS)[number];
export const CONTEXT_POLICY_SUGGESTION_STATES = ["proposed", "accepted", "rejected", "stale"] as const;
export type ContextPolicySuggestionState = (typeof CONTEXT_POLICY_SUGGESTION_STATES)[number];

export type ContextPolicySuggestion = {
  readonly id: string;
  readonly packetReceiptId: string;
  readonly sourceId: string;
  readonly action: ContextPolicyAction;
  readonly reasonCode: string;
  readonly reasonText: string;
  readonly estimatedTokenSaving?: number | undefined;
  readonly status: ContextPolicySuggestionState;
  readonly createdAt: string;
  readonly resolvedAt?: string | undefined;
};

export type AddContextPolicySuggestionInput = Omit<
  ContextPolicySuggestion,
  "status" | "createdAt" | "resolvedAt"
> & { readonly createdAt?: string | undefined };

export const MEMORY_LINEAGE_STATES = ["active", "superseded", "expired"] as const;
export type MemoryLineageState = (typeof MEMORY_LINEAGE_STATES)[number];
export type MemoryLineageRecord = {
  readonly memoryId: string;
  readonly sourceId: string;
  readonly originTurnId: string;
  readonly originPacketReceiptId: string;
  readonly supersedesMemoryId?: string | undefined;
  readonly state: MemoryLineageState;
  readonly confidence: number;
  readonly createdAt: string;
  readonly expiresAt?: string | undefined;
};

export type RecordMemoryLineageInput = Omit<
  MemoryLineageRecord,
  "createdAt"
> & { readonly createdAt?: string | undefined };

export function isContextPacketReceiptState(value: unknown): value is ContextPacketReceiptState {
  return typeof value === "string" && CONTEXT_PACKET_RECEIPT_STATES.some((state) => state === value);
}
```

Export the module from `packages/contracts/src/index.ts`:

```ts
export * from "./context-lifecycle.js";
```

- [ ] **Step 4: Run contract tests and type-check**

Run:

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/contracts/context-lifecycle.contract.test.mjs
npm run build
npm run check
```

Expected: contract test PASS; build and check exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/context-lifecycle.ts packages/contracts/src/index.ts tests/contracts/context-lifecycle.contract.test.mjs
git commit -m "feat(context): define lifecycle ledger contracts"
```

---

### Task 2: Persist Packet Receipts Atomically

**Files:**
- Modify: `packages/agentops-db/src/schema-sql.ts`
- Create: `packages/agentops-db/src/store-context-receipts.ts`
- Modify: `packages/agentops-db/src/store-types.ts`
- Modify: `packages/agentops-db/src/store.ts`
- Modify: `packages/agentops-db/src/index.ts`
- Test: `tests/agentops-db/context-sources.test.mjs`

**Interfaces:**
- Consumes `RecordContextPacketPreviewInput` and `SubmitContextPacketReceiptInput` from Task 1.
- Produces store methods `recordContextPacketPreview`, `invalidateContextPacketReceipt`, `submitContextPacketReceipt`, `getContextPacketReceipt`, and `getActiveContextPacketPreview`.

- [ ] **Step 1: Add failing persistence tests**

```js
test("packet receipt lifecycle records one submitted receipt per turn", () => {
  const receipt = store.recordContextPacketPreview({
    id: "receipt-1",
    projectId: "project-1",
    sessionId: "session-1",
    packetId: "crp-1",
    profile: "build",
    tokenEstimate: 1200,
    tokenEstimateState: "estimated",
    sourceCount: 1,
    sourceRefs: [{ sourceId: "AGENTS.md", category: "workspace-guidance", salience: 1, includedInModel: true }],
  });
  assert.equal(receipt.state, "previewed");
  const submitted = store.submitContextPacketReceipt({
    receiptId: receipt.id,
    projectId: "project-1",
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(submitted.state, "submitted");
  assert.equal(submitted.turnId, "turn-1");
  assert.throws(
    () => store.submitContextPacketReceipt({ receiptId: "receipt-2", projectId: "project-1", sessionId: "session-1", turnId: "turn-1" }),
    /submitted receipt already exists/i,
  );
});

test("packet receipts never persist raw source content", () => {
  store.recordContextPacketPreview({
    id: "receipt-safe",
    projectId: "project-1",
    sessionId: "session-safe",
    packetId: "crp-safe",
    profile: "build",
    tokenEstimateState: "unknown",
    sourceCount: 1,
    sourceRefs: [{ sourceId: "secret-source", category: "system", salience: 1, includedInModel: true }],
  });
  const raw = db.prepare("SELECT source_refs_json FROM context_packet_receipts WHERE id = ?").get("receipt-safe");
  assert.doesNotMatch(String(raw.source_refs_json), /content|sk-[A-Za-z0-9]/);
});
```

- [ ] **Step 2: Run the AgentOps test and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/agentops-db/context-sources.test.mjs
```

Expected: FAIL because migration 6 and receipt store methods do not exist.

- [ ] **Step 3: Add migration 6 to both initial and incremental schema**

```sql
CREATE TABLE IF NOT EXISTS context_packet_receipts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  packet_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('previewed', 'submitted', 'invalidated')),
  replaces_receipt_id TEXT REFERENCES context_packet_receipts(id) ON DELETE SET NULL,
  profile TEXT NOT NULL,
  token_estimate INTEGER,
  token_estimate_state TEXT NOT NULL CHECK (token_estimate_state IN ('exact', 'estimated', 'unknown')),
  source_count INTEGER NOT NULL,
  source_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_packet_receipts_project_session_state
  ON context_packet_receipts(project_id, session_id, state, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_packet_receipts_submitted_turn
  ON context_packet_receipts(project_id, session_id, turn_id)
  WHERE state = 'submitted' AND turn_id IS NOT NULL;
```

Use migration version `6` and name `add_context_packet_receipts`.

- [ ] **Step 4: Implement guarded receipt transitions**

`store-context-receipts.ts` must validate JSON through typed parsing and use a transaction for submit uniqueness:

```ts
export function submitContextPacketReceipt(
  db: DatabaseSync,
  input: SubmitContextPacketReceiptInput,
): ContextPacketReceipt {
  db.exec("BEGIN IMMEDIATE");
  try {
    const duplicate = db.prepare(
      "SELECT id FROM context_packet_receipts WHERE project_id = ? AND session_id = ? AND turn_id = ? AND state = 'submitted'",
    ).get(input.projectId, input.sessionId, input.turnId);
    if (duplicate !== undefined) throw new Error(`Submitted receipt already exists for turn: ${input.turnId}`);
    const result = db.prepare(
      "UPDATE context_packet_receipts SET state = 'submitted', turn_id = ? WHERE id = ? AND project_id = ? AND session_id = ? AND state = 'previewed'",
    ).run(input.turnId, input.receiptId, input.projectId, input.sessionId);
    if (result.changes !== 1) throw new Error(`Preview receipt is not submittable: ${input.receiptId}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getContextPacketReceiptOrThrow(db, input.projectId, input.receiptId);
}
```

`recordContextPacketPreview` must reject any source-ref object containing keys outside `sourceId`, `category`, `sha256`, `trustTier`, `salience`, and `includedInModel`. `invalidateContextPacketReceipt` must update only `previewed` rows. `getActiveContextPacketPreview` returns the newest preview for a session.

- [ ] **Step 5: Expose store methods**

Add these exact signatures to `AgentOpsStore`:

```ts
recordContextPacketPreview(input: RecordContextPacketPreviewInput): ContextPacketReceipt;
invalidateContextPacketReceipt(projectId: string, receiptId: string): ContextPacketReceipt;
submitContextPacketReceipt(input: SubmitContextPacketReceiptInput): ContextPacketReceipt;
getContextPacketReceipt(projectId: string, receiptId: string): ContextPacketReceipt | undefined;
getActiveContextPacketPreview(projectId: string, sessionId: string): ContextPacketReceipt | undefined;
```

Delegate from `store.ts` and export the module from `index.ts`.

- [ ] **Step 6: Run focused and package tests**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/agentops-db/context-sources.test.mjs
npm run test:agentops-db
npm run build
npm run check
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/agentops-db/src/schema-sql.ts packages/agentops-db/src/store-context-receipts.ts packages/agentops-db/src/store-types.ts packages/agentops-db/src/store.ts packages/agentops-db/src/index.ts tests/agentops-db/context-sources.test.mjs
git commit -m "feat(context): persist packet lifecycle receipts"
```

---

### Task 3: Build Packet Change Classification

**Files:**
- Create: `packages/orchestrator/src/context-packet-change.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Test: `tests/orchestrator/context-packet-change.test.mjs`

**Interfaces:**
- Consumes `ContextPacketReceiptSourceRef`, `ContextPacketView`, and active-session protected source IDs.
- Produces `buildContextPacketSourceRefs(packet)` and `classifyContextPacketChange(input)`.

- [ ] **Step 1: Write failing pure-logic tests**

```js
test("packet change blocks when a protected source disappears", () => {
  const result = classifyContextPacketChange({
    before: [{ sourceId: "rules", category: "workspace-guidance", salience: 1, includedInModel: true }],
    after: [],
    protectedSourceIds: new Set(["rules"]),
  });
  assert.equal(result.kind, "meaning-change");
  assert.deepEqual(result.removedSourceIds, ["rules"]);
});

test("mandatory guidance replacement is a safety refresh", () => {
  const result = classifyContextPacketChange({
    before: [{ sourceId: "rules", category: "workspace-guidance", sha256: "sha-old", salience: 0.95, includedInModel: true }],
    after: [{ sourceId: "rules", category: "workspace-guidance", sha256: "sha-new", salience: 0.95, includedInModel: true }],
    protectedSourceIds: new Set(),
    mandatorySourceIds: new Set(["rules"]),
  });
  assert.equal(result.kind, "safety-refresh");
});
```

- [ ] **Step 2: Verify tests fail**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/context-packet-change.test.mjs
```

Expected: FAIL because classifier exports are missing.

- [ ] **Step 3: Implement deterministic classification**

```ts
export function classifyContextPacketChange(input: {
  readonly before: readonly ContextPacketReceiptSourceRef[];
  readonly after: readonly ContextPacketReceiptSourceRef[];
  readonly protectedSourceIds: ReadonlySet<string>;
  readonly mandatorySourceIds?: ReadonlySet<string>;
}): ContextPacketChangeClassification {
  const beforeIncluded = input.before.filter((ref) => ref.includedInModel);
  const afterIncluded = input.after.filter((ref) => ref.includedInModel);
  const beforeById = new Map(beforeIncluded.map((ref) => [ref.sourceId, ref]));
  const afterById = new Map(afterIncluded.map((ref) => [ref.sourceId, ref]));
  const removed = [...beforeById.keys()].filter((id) => !afterById.has(id)).sort();
  const added = [...afterById.keys()].filter((id) => !beforeById.has(id)).sort();
  const changedSha = [...beforeById.keys()].filter((id) => {
    const before = beforeById.get(id);
    const after = afterById.get(id);
    return after !== undefined && before?.sha256 !== after.sha256;
  }).sort();
  const protectedRemoved = removed.filter((id) => input.protectedSourceIds.has(id));
  if (protectedRemoved.length > 0) {
    return { kind: "meaning-change", removedSourceIds: removed, addedSourceIds: added, protectedSourceIds: protectedRemoved, reason: "A pinned or explicitly included source disappeared." };
  }
  if (removed.length === 0 && added.length === 0 && changedSha.length === 0) {
    return { kind: "unchanged", removedSourceIds: [], addedSourceIds: [], protectedSourceIds: [], reason: "Packet source selection is unchanged." };
  }
  const mandatory = input.mandatorySourceIds ?? new Set<string>();
  const safetyCandidates = [...added, ...changedSha];
  const safetyOnly = removed.length === 0
    && safetyCandidates.length > 0
    && safetyCandidates.every((id) => mandatory.has(id));
  return {
    kind: safetyOnly ? "safety-refresh" : "meaning-change",
    removedSourceIds: removed,
    addedSourceIds: added,
    protectedSourceIds: [],
    reason: safetyOnly ? "Mandatory guidance was refreshed." : "The selected source set changed.",
  };
}
```

`buildContextPacketSourceRefs` must preserve packet order and map only metadata fields: `sourceId = item.id`, `category`, `sha256 = item.provenance?.sha256`, `trustTier`, `salience = item.salience ?? 0.5`, and `includedInModel = item.includedInModel ?? true`. It must never copy `preview` or `reason`. Derive `mandatorySourceIds` from `packet.manifest.policy` entries whose `authority === "mandatory"`; when a policy ID does not match a packet source ID, treat the change conservatively as `meaning-change`.

- [ ] **Step 4: Run tests and check**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/context-packet-change.test.mjs
npm run build
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/context-packet-change.ts packages/orchestrator/src/index.ts tests/orchestrator/context-packet-change.test.mjs
git commit -m "feat(context): classify packet lifecycle changes"
```

---

### Task 4: Add the CRP Ledger Adapter

**Files:**
- Create: `apps/unclecode-cli/src/work-runtime-context-ledger.ts`
- Modify: `apps/unclecode-cli/src/work-runtime-crp.ts`
- Test: `tests/work/work-runtime-crp.test.mjs`

**Interfaces:**
- Consumes AgentOps receipt methods from Task 2 and source-ref builder from Task 3.
- Produces `ContextLedgerRuntime` with `previewPacket`, `invalidatePreview`, `submitPreview`, `getActivePreview`, and `protectedSourceIds`.

- [ ] **Step 1: Write failing runtime tests**

```js
test("CRP runtime persists preview replacement and submission", async () => {
  const first = await runtime.resolveContextPacket(input);
  const firstReceipt = runtime.contextLedger.previewPacket({ sessionId: input.sessionId, packet: first, profile: "build" });
  runtime.mutateContextSource({ kind: "pin", id: first.included[0].id });
  const second = await runtime.resolveContextPacket(input);
  const secondReceipt = runtime.contextLedger.previewPacket({ sessionId: input.sessionId, packet: second, profile: "build" });
  assert.equal(runtime.contextLedger.getReceipt(firstReceipt.id)?.state, "invalidated");
  assert.equal(secondReceipt.replacesReceiptId, firstReceipt.id);
  assert.equal(runtime.contextLedger.submitPreview({ receiptId: secondReceipt.id, sessionId: input.sessionId, turnId: "turn-1" }).state, "submitted");
});
```

- [ ] **Step 2: Verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/work/work-runtime-crp.test.mjs
```

Expected: FAIL because `contextLedger` is absent.

- [ ] **Step 3: Implement the runtime adapter**

```ts
export type ContextLedgerRuntime = {
  previewPacket(input: { sessionId: string; packet: ContextPacketView; profile: string }): ContextPacketReceipt;
  invalidatePreview(receiptId: string): ContextPacketReceipt;
  submitPreview(input: Omit<SubmitContextPacketReceiptInput, "projectId">): ContextPacketReceipt;
  getReceipt(receiptId: string): ContextPacketReceipt | undefined;
  getActivePreview(sessionId: string): ContextPacketReceipt | undefined;
  protectedSourceIds(): ReadonlySet<string>;
};
```

`previewPacket` must:

1. Build source refs without content.
2. Reuse the active receipt when packet ID and source refs are identical.
3. Invalidate a different active preview.
4. Create the replacement with `replacesReceiptId`.

`protectedSourceIds` derives from active-session CRP action receipts whose latest action is `pin` or `include`; `unpin` or `hold-back` removes protection.

- [ ] **Step 4: Expose shared store ownership from `createCrpRuntime`**

Add lazy accessors rather than creating a second AgentOps store:

```ts
readonly contextLedger: ContextLedgerRuntime;
readonly getProjectId: () => string | undefined;
```

The adapter must resolve the same `crpState.store` and `crpState.projectId` used by packet selection. Calling it before first CRP resolution throws a friendly local error; `/context` always resolves a packet before recording preview.

- [ ] **Step 5: Run focused tests and type-check**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/work/work-runtime-crp.test.mjs
npm run build
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/unclecode-cli/src/work-runtime-context-ledger.ts apps/unclecode-cli/src/work-runtime-crp.ts tests/work/work-runtime-crp.test.mjs
git commit -m "feat(context): add CRP lifecycle ledger runtime"
```

---

### Task 5: Enforce Preview, Revalidation, and Submitted Proof

**Files:**
- Modify: `packages/orchestrator/src/work-shell-engine.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-factory.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-state.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-prompt-runtime.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-turns.ts`
- Modify: `apps/unclecode-cli/src/work-runtime-bootstrap.ts`
- Modify: `apps/unclecode-cli/src/work-runtime-dashboard.ts`
- Test: `tests/orchestrator/work-shell-engine.test.mjs`

**Interfaces:**
- Consumes `ContextLedgerRuntime` and packet classifier.
- Produces engine state fields `contextPreviewReceipt`, `contextSubmittedReceipt`, and `contextPacketChange` plus provider-call gating.

- [ ] **Step 1: Write failing engine tests for exact proof**

```js
test("WorkShellEngine submits exactly the inspected packet receipt", async () => {
  await engine.handleSubmit("/context");
  const previewId = engine.getState().contextPreviewReceipt?.id;
  await engine.handleSubmit("inspect auth");
  assert.equal(providerPrompts.length, 1);
  assert.equal(ledgerSubmissions.length, 1);
  assert.equal(ledgerSubmissions[0].receiptId, previewId);
  assert.equal(engine.getState().contextSubmittedReceipt?.packetId, packet.id);
});

test("WorkShellEngine blocks provider when a protected source disappears", async () => {
  await engine.handleSubmit("/context");
  removePinnedSourceBeforeSubmit();
  await engine.handleSubmit("inspect auth");
  assert.equal(providerPrompts.length, 0);
  assert.equal(engine.getState().contextPacketChange?.kind, "meaning-change");
  assert.equal(engine.getState().panel.title, "Context expanded");
});

test("WorkShellEngine aborts provider call when receipt submission fails", async () => {
  ledger.submitPreview = () => { throw new Error("ledger unavailable"); };
  await engine.handleSubmit("inspect auth");
  assert.equal(providerPrompts.length, 0);
  assert.match(engine.getState().entries.at(-1)?.text ?? "", /context proof unavailable/i);
});
```

- [ ] **Step 2: Verify the new tests fail**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test --test-name-pattern="packet receipt|protected source|proof unavailable" tests/orchestrator/work-shell-engine.test.mjs
```

Expected: FAIL before provider lifecycle wiring exists.

- [ ] **Step 3: Add lifecycle callbacks to engine input**

```ts
readonly previewContextPacket?: (input: { sessionId: string; packet: ContextPacketView; profile: string }) => ContextPacketReceipt;
readonly revalidateContextPacket?: (input: {
  sessionId: string;
  preview: ContextPacketReceipt;
  packet: ContextPacketView;
}) => ContextPacketChangeClassification;
readonly submitContextPacketReceipt?: (input: Omit<SubmitContextPacketReceiptInput, "projectId">) => ContextPacketReceipt;
```

Thread these through the factory, dashboard options, and bootstrap using `crpRuntime.contextLedger`.

- [ ] **Step 4: Record preview when Context Desk opens or source mutation refreshes**

After `refreshContextPacket(true)`, record the preview and set:

```ts
{
  contextPreviewReceipt: receipt,
  contextSubmittedReceipt: undefined,
  contextPacketChange: undefined,
}
```

The existing `contextActionReceipt` remains the source-action UX; do not replace it.

- [ ] **Step 5: Revalidate and submit before `agent.runTurn`**

Create a private preparation method:

```ts
private async prepareSubmittedContext(turnId: string): Promise<{
  readonly packet: ContextPacketView;
  readonly receipt: ContextPacketReceipt;
} | undefined>
```

It must resolve the latest candidate, compare it with the preview, block `meaning-change`, allow `unchanged` or `safety-refresh`, and call `submitContextPacketReceipt` before returning. Both chat and prompt-command routes use the returned packet. Neither route may call `agent.runTurn` when the method returns `undefined` or throws.

Generate `turnId` once per prompt turn with `turn-${sessionId}-${turnEpoch}` and pass the same value to turn recording and memory lineage.

- [ ] **Step 6: Attach submitted receipt to turn state**

Extend turn execution input and success result with:

```ts
readonly turnId: string;
readonly contextReceipt: ContextPacketReceipt;
```

Persist the receipt in engine state before the provider call and retain it after success/failure so the attempt remains auditable.

- [ ] **Step 7: Run focused and full orchestrator tests**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-engine.test.mjs
npm run test:orchestrator
npm run build
npm run check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/orchestrator/src/work-shell-engine.ts packages/orchestrator/src/work-shell-engine-factory.ts packages/orchestrator/src/work-shell-engine-state.ts packages/orchestrator/src/work-shell-engine-prompt-runtime.ts packages/orchestrator/src/work-shell-engine-turns.ts apps/unclecode-cli/src/work-runtime-bootstrap.ts apps/unclecode-cli/src/work-runtime-dashboard.ts tests/orchestrator/work-shell-engine.test.mjs
git commit -m "feat(context): prove provider packet submission"
```

---

### Task 6: Render Packet Transitions and Turn Receipts

**Files:**
- Modify: `packages/tui/src/work-shell-context-inspector-header.tsx`
- Create: `packages/tui/src/work-shell-context-receipt.tsx`
- Modify: `packages/tui/src/work-shell-context-workbench.tsx`
- Modify: `packages/tui/src/work-shell-view.tsx`
- Modify: `packages/tui/src/work-shell-pane.tsx`
- Modify: `packages/tui/src/work-shell-hooks.ts`
- Test: `tests/tui/work-shell-context-inspector-render.test.mjs`
- Test: `tests/contracts/tui-work-shell.contract.test.mjs`

**Interfaces:**
- Consumes engine receipt/change state from Task 5.
- Produces `renderContextTurnReceipt` and visible preview/change/submitted labels.

- [ ] **Step 1: Write failing rendering tests**

```js
test("Context Desk renders preview and meaning-change proof", () => {
  const output = renderContextInspectorHeaderText({
    receipt: previewReceipt,
    packetChange: {
      kind: "meaning-change",
      removedSourceIds: ["rules"],
      addedSourceIds: [],
      protectedSourceIds: ["rules"],
      reason: "A pinned or explicitly included source disappeared.",
    },
    modelWindow: 128000,
  });
  assert.match(output, /PACKET CHANGED/);
  assert.match(output, /crp-a91f.*crp-b203/);
  assert.match(output, /review required/i);
});

test("turn receipt exposes submitted packet aggregates without source content", () => {
  const output = formatContextTurnReceiptLine(submittedReceipt);
  assert.equal(output, "ctx crp-b203 · 14 sources · ~18.1k · 2 memories");
  assert.doesNotMatch(output, /preview|reason|content/);
});
```

- [ ] **Step 2: Verify rendering tests fail**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-context-inspector-render.test.mjs tests/contracts/tui-work-shell.contract.test.mjs
```

Expected: FAIL for missing receipt renderer and state props.

- [ ] **Step 3: Implement header states**

Render exactly one primary state:

- `NEXT REQUEST {packetId} previewed {estimate} / {window}`
- `PACKET CHANGED {beforePacketId} -> {afterPacketId}` plus reason and `review required`
- `SUBMITTED {packetId} {turnId}` for read-only history views.

Use `tokenEstimateState` to render exact, `~`, or `unknown`; do not render `~0` for unknown.

- [ ] **Step 4: Implement read-only turn receipt**

`work-shell-context-receipt.tsx` exposes:

```ts
export function formatContextTurnReceiptLine(receipt: ContextPacketReceipt): string;
export function renderContextTurnReceipt(input: {
  readonly receipt: ContextPacketReceipt;
  readonly width: number;
  readonly expanded: boolean;
}): React.ReactNode;
```

The expanded view lists source ID, category, SHA availability, trust tier, token state, and memory-category count. It never reads source content.

- [ ] **Step 5: Thread props without adding mirrored React state**

Pass receipt/change data directly from engine state through `work-shell-hooks.ts`, pane, and view. Do not use `useEffect`; rendering is derived from engine state.

- [ ] **Step 6: Run TUI tests**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/tui/work-shell-context-inspector-render.test.mjs tests/contracts/tui-work-shell.contract.test.mjs
npm run test:tui
npm run build
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/tui/src/work-shell-context-inspector-header.tsx packages/tui/src/work-shell-context-receipt.tsx packages/tui/src/work-shell-context-workbench.tsx packages/tui/src/work-shell-view.tsx packages/tui/src/work-shell-pane.tsx packages/tui/src/work-shell-hooks.ts tests/tui/work-shell-context-inspector-render.test.mjs tests/contracts/tui-work-shell.contract.test.mjs
git commit -m "feat(context): show packet proof in Work Shell"
```

---

### Task 7: Persist Context Optimizer Suggestions

**Files:**
- Modify: `packages/agentops-db/src/schema-sql.ts`
- Create: `packages/agentops-db/src/store-context-suggestions.ts`
- Modify: `packages/agentops-db/src/store-types.ts`
- Modify: `packages/agentops-db/src/store.ts`
- Modify: `packages/agentops-db/src/index.ts`
- Test: `tests/agentops-db/context-sources.test.mjs`

**Interfaces:**
- Consumes `ContextPolicySuggestion` contracts.
- Produces `addContextPolicySuggestion`, `resolveContextPolicySuggestion`, `markContextPolicySuggestionsStale`, and `listContextPolicySuggestions`.

- [ ] **Step 1: Add failing suggestion lifecycle tests**

```js
test("suggestions resolve once and stale with their invalidated packet", () => {
  const suggestion = store.addContextPolicySuggestion({
    id: "suggestion-1",
    packetReceiptId: "receipt-1",
    sourceId: "trace-1",
    action: "hold-back",
    reasonCode: "duplicate-fingerprint",
    reasonText: "Duplicate runtime trace.",
    estimatedTokenSaving: 450,
  });
  assert.equal(suggestion.status, "proposed");
  assert.equal(store.resolveContextPolicySuggestion(suggestion.id, "rejected").status, "rejected");
  assert.throws(() => store.resolveContextPolicySuggestion(suggestion.id, "accepted"), /already resolved/i);
});
```

- [ ] **Step 2: Verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/agentops-db/context-sources.test.mjs
```

Expected: FAIL for missing migration and methods.

- [ ] **Step 3: Add migration 7**

```sql
CREATE TABLE IF NOT EXISTS context_policy_suggestions (
  id TEXT PRIMARY KEY,
  packet_receipt_id TEXT NOT NULL REFERENCES context_packet_receipts(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('keep', 'summarize', 'hold-back', 'refresh')),
  reason_code TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  estimated_token_saving INTEGER,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'stale')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_context_policy_suggestions_receipt_status
  ON context_policy_suggestions(packet_receipt_id, status, created_at);
```

- [ ] **Step 4: Implement status-guarded methods**

Only `proposed` may transition to `accepted`, `rejected`, or `stale`. `markContextPolicySuggestionsStale` updates all still-proposed suggestions for an invalidated receipt in one statement. `estimated_token_saving` remains nullable.

- [ ] **Step 5: Run tests and commit**

```bash
npm run test:agentops-db
npm run build
npm run check
git add packages/agentops-db/src/schema-sql.ts packages/agentops-db/src/store-context-suggestions.ts packages/agentops-db/src/store-types.ts packages/agentops-db/src/store.ts packages/agentops-db/src/index.ts tests/agentops-db/context-sources.test.mjs
git commit -m "feat(context): persist optimizer suggestions"
```

Expected: tests, build, and check PASS before commit.

---

### Task 8: Implement the Deterministic Optimizer

**Files:**
- Create: `packages/orchestrator/src/context-policy-evaluator.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Test: `tests/orchestrator/context-policy-evaluator.test.mjs`

**Interfaces:**
- Consumes submitted receipt source refs plus current `ContextPacketViewItem` metadata.
- Produces `evaluateContextPolicy(input): readonly ContextPolicySuggestion[]` with stable ordering and reason codes.

- [ ] **Step 1: Write table-driven failing tests**

```js
const cases = [
  { name: "duplicate SHA", expected: ["duplicate-fingerprint", "hold-back"] },
  { name: "stale condensed history", expected: ["stale-condensed-history", "summarize"] },
  { name: "expired source", expected: ["expired-source", "refresh"] },
  { name: "mandatory guidance", expected: ["mandatory-guidance", "keep"] },
];
for (const fixture of cases) {
  test(`optimizer classifies ${fixture.name}`, () => {
    const [result] = evaluateContextPolicy(buildFixture(fixture.name));
    assert.equal(result.reasonCode, fixture.expected[0]);
    assert.equal(result.action, fixture.expected[1]);
  });
}
```

Also assert identical input returns deep-equal suggestion ordering and IDs derived from receipt/source/action rather than random UUIDs.

- [ ] **Step 2: Verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/context-policy-evaluator.test.mjs
```

Expected: FAIL for missing evaluator.

- [ ] **Step 3: Implement rule precedence**

Apply exactly this precedence per source:

1. mandatory guidance → `keep` / `mandatory-guidance`;
2. expired → `refresh` / `expired-source`;
3. stale condensed history → `summarize` / `stale-condensed-history`;
4. duplicate SHA after first ordered occurrence → `hold-back` / `duplicate-fingerprint`;
5. low-trust source using more than 20% of packet tokens → `hold-back` / `low-trust-token-hotspot`;
6. otherwise no suggestion.

Sort suggestions by action priority `refresh`, `summarize`, `hold-back`, `keep`, then descending known savings, then source ID. Unknown savings remain `undefined` and sort after known values.

- [ ] **Step 4: Run tests, build, and check**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/context-policy-evaluator.test.mjs
npm run build
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/context-policy-evaluator.ts packages/orchestrator/src/index.ts tests/orchestrator/context-policy-evaluator.test.mjs
git commit -m "feat(context): add deterministic packet optimizer"
```

---

### Task 9: Wire Advice Generation and Explicit Application

**Files:**
- Modify: `apps/unclecode-cli/src/work-runtime-context-ledger.ts`
- Modify: `apps/unclecode-cli/src/work-runtime-bootstrap.ts`
- Modify: `packages/orchestrator/src/work-shell-engine.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-post-turns.ts`
- Create: `packages/tui/src/work-shell-context-advice.tsx`
- Modify: `packages/tui/src/work-shell-context-workbench.tsx`
- Modify: `packages/tui/src/work-shell-hooks.ts`
- Test: `tests/orchestrator/work-shell-engine.test.mjs`
- Test: `tests/tui/work-shell-context-inspector-render.test.mjs`

**Interfaces:**
- Consumes evaluator and suggestion store methods from Tasks 7–8.
- Produces engine methods `acceptContextSuggestion(id)` and `rejectContextSuggestion(id)` and state `contextPolicySuggestions`.

- [ ] **Step 1: Write failing behavior tests**

```js
test("rejecting advice never mutates CRP", async () => {
  await engine.rejectContextSuggestion("suggestion-1");
  assert.equal(mutations.length, 0);
  assert.equal(engine.getState().contextPolicySuggestions[0].status, "rejected");
});

test("accepting hold-back advice uses CRP mutation and creates replacement preview", async () => {
  await engine.acceptContextSuggestion("suggestion-1");
  assert.deepEqual(mutations, [{ kind: "forget", id: "trace-1" }]);
  assert.equal(engine.getState().contextActionReceipt?.action, "hold-back");
  assert.notEqual(engine.getState().contextPreviewReceipt?.packetId, submittedPacketId);
});
```

- [ ] **Step 2: Verify tests fail**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test --test-name-pattern="advice" tests/orchestrator/work-shell-engine.test.mjs
```

Expected: FAIL for missing engine methods/state.

- [ ] **Step 3: Generate suggestions after a completed turn**

After assistant response persistence, evaluate the submitted packet, persist each suggestion, and set `contextPolicySuggestions`. Suggestion failure is caught separately and sets an operator-facing `contextAdviceUnavailable` string; it must not remove or replace the assistant response.

- [ ] **Step 4: Apply only accepted mutations**

Map accepted actions:

- `hold-back` → existing `{ kind: "forget", id }`;
- `refresh` → force CRP provider sync and packet rebuild without direct source mutation;
- `summarize` → invoke the existing condensed-history provider refresh path, then rebuild;
- `keep` → resolve accepted state only; no mutation.

Reject updates status only. Invalidate all proposed suggestions when their receipt is invalidated.

- [ ] **Step 5: Render Advice**

`work-shell-context-advice.tsx` must render:

```text
SAVE ~3.2k  summarize old condensed history
HOLD ~1.1k  duplicate runtime trace
KEEP        AGENTS.md · mandatory
```

Unknown savings omit the number. Keys/actions are exposed only when accept/reject callbacks exist. Thread state directly; no mirrored React state or effect.

- [ ] **Step 6: Run focused and package tests**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/orchestrator/work-shell-engine.test.mjs tests/tui/work-shell-context-inspector-render.test.mjs
npm run test:orchestrator
npm run test:tui
npm run build
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/unclecode-cli/src/work-runtime-context-ledger.ts apps/unclecode-cli/src/work-runtime-bootstrap.ts packages/orchestrator/src/work-shell-engine.ts packages/orchestrator/src/work-shell-engine-post-turns.ts packages/tui/src/work-shell-context-advice.tsx packages/tui/src/work-shell-context-workbench.tsx packages/tui/src/work-shell-hooks.ts tests/orchestrator/work-shell-engine.test.mjs tests/tui/work-shell-context-inspector-render.test.mjs
git commit -m "feat(context): add actionable optimizer advice"
```

---

### Task 10: Persist Memory Lineage

**Files:**
- Modify: `packages/agentops-db/src/schema-sql.ts`
- Create: `packages/agentops-db/src/store-memory-lineage.ts`
- Modify: `packages/agentops-db/src/store-types.ts`
- Modify: `packages/agentops-db/src/store.ts`
- Modify: `packages/agentops-db/src/index.ts`
- Test: `tests/agentops-db/context-sources.test.mjs`

**Interfaces:**
- Consumes `MemoryLineageRecord`.
- Produces `recordMemoryLineage`, `supersedeMemoryLineage`, `expireMemoryLineage`, `getMemoryLineage`, and `listActiveMemoryLineage`.

- [ ] **Step 1: Add failing lineage transition tests**

```js
test("memory lineage supersedes one active predecessor atomically", () => {
  store.recordMemoryLineage({
    memoryId: "memory-old",
    sourceId: "source-a",
    originTurnId: "turn-1",
    originPacketReceiptId: "receipt-1",
    state: "active",
    confidence: 0.8,
  });
  store.recordMemoryLineage({
    memoryId: "memory-new",
    sourceId: "source-a",
    originTurnId: "turn-2",
    originPacketReceiptId: "receipt-2",
    supersedesMemoryId: "memory-old",
    state: "active",
    confidence: 0.9,
  });
  assert.equal(store.getMemoryLineage("memory-old").state, "superseded");
  assert.deepEqual(store.listActiveMemoryLineage().map((item) => item.memoryId), ["memory-new"]);
});
```

- [ ] **Step 2: Verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/agentops-db/context-sources.test.mjs
```

Expected: FAIL for missing migration and methods.

- [ ] **Step 3: Add migration 8**

```sql
CREATE TABLE IF NOT EXISTS memory_lineage (
  memory_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  origin_turn_id TEXT NOT NULL,
  origin_packet_receipt_id TEXT NOT NULL REFERENCES context_packet_receipts(id) ON DELETE RESTRICT,
  supersedes_memory_id TEXT REFERENCES memory_lineage(memory_id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'expired')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_lineage_state_created
  ON memory_lineage(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_lineage_source
  ON memory_lineage(source_id, state);
```

- [ ] **Step 4: Implement atomic promotion**

When `supersedesMemoryId` is present, one transaction must verify the predecessor is active, update it to `superseded`, and insert the new active record. Failure rolls back both operations. Expiry transitions only active rows whose `expires_at <= now`.

- [ ] **Step 5: Run AgentOps tests and commit**

```bash
npm run test:agentops-db
npm run build
npm run check
git add packages/agentops-db/src/schema-sql.ts packages/agentops-db/src/store-memory-lineage.ts packages/agentops-db/src/store-types.ts packages/agentops-db/src/store.ts packages/agentops-db/src/index.ts tests/agentops-db/context-sources.test.mjs
git commit -m "feat(context): persist memory provenance lineage"
```

Expected: PASS before commit.

---

### Task 11: Make Scoped Memory Promotion Lineage-Aware

**Files:**
- Modify: `packages/context-broker/src/context-memory.ts`
- Modify: `packages/context-broker/src/memory-prefetch.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-post-turns.ts`
- Modify: `packages/orchestrator/src/work-shell-engine.ts`
- Modify: `apps/unclecode-cli/src/work-runtime-context-ledger.ts`
- Modify: `apps/unclecode-cli/src/work-runtime-bootstrap.ts`
- Test: `tests/context-broker/context-memory.test.mjs`
- Test: `tests/context-broker/memory-prefetch.test.mjs`
- Test: `tests/orchestrator/work-shell-engine.test.mjs`

**Interfaces:**
- Consumes submitted receipt/turn ID and memory lineage store methods.
- Produces `promoteScopedMemory` with provenance and lineage-filtered `listScopedMemoryEntries`.

- [ ] **Step 1: Write failing promotion and filtering tests**

```js
test("memory promotion requires submitted packet lineage", async () => {
  await assert.rejects(
    () => promoteScopedMemory({ scope: "session", cwd, summary: "fact", sourceId: "assistant-summary", turnId: "turn-1" }),
    /submitted packet receipt required/i,
  );
});

test("superseded and expired memories are excluded from prefetch", async () => {
  const entries = await listScopedMemoryEntries({ scope: "session", cwd, sessionId, lineage });
  assert.deepEqual(entries.map((entry) => entry.memoryId), ["memory-active"]);
});
```

- [ ] **Step 2: Verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/context-broker/context-memory.test.mjs tests/context-broker/memory-prefetch.test.mjs
```

Expected: FAIL for missing promotion adapter and lineage filtering.

- [ ] **Step 3: Add an injected lineage adapter**

```ts
export type MemoryLineageAdapter = {
  record(input: Omit<MemoryLineageRecord, "createdAt">): MemoryLineageRecord;
  get(memoryId: string): MemoryLineageRecord | undefined;
  isActive(memoryId: string): boolean;
};
```

Keep the context-broker independent of AgentOps by accepting the adapter in `promoteScopedMemory` and list functions. Existing callers without an adapter preserve legacy listing; Work Shell must always provide the adapter when lifecycle ledger is enabled.

- [ ] **Step 4: Promote only after lineage succeeds**

Create the memory payload and ID first, write lineage, then persist the memory content. If content persistence fails, remove or invalidate the newly inserted lineage in the same adapter operation. Do not report `memory.written` until both succeed.

Pass `turnId`, submitted receipt ID, source ID `assistant-summary`, confidence, and optional predecessor from Work Shell post-turn effects.

- [ ] **Step 5: Filter inactive memories**

`listScopedMemoryEntries` and `memory-prefetch` filter entries when an adapter is present:

```ts
const visible = lineage === undefined
  ? entries
  : entries.filter((entry) => lineage.isActive(entry.memoryId));
```

Run expiry before listing. Preserve transparency metadata for active entries.

- [ ] **Step 6: Run context and orchestrator tests**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/context-broker/context-memory.test.mjs tests/context-broker/memory-prefetch.test.mjs tests/orchestrator/work-shell-engine.test.mjs
npm run test:context-broker
npm run test:orchestrator
npm run build
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/context-broker/src/context-memory.ts packages/context-broker/src/memory-prefetch.ts packages/orchestrator/src/work-shell-engine-post-turns.ts packages/orchestrator/src/work-shell-engine.ts apps/unclecode-cli/src/work-runtime-context-ledger.ts apps/unclecode-cli/src/work-runtime-bootstrap.ts tests/context-broker/context-memory.test.mjs tests/context-broker/memory-prefetch.test.mjs tests/orchestrator/work-shell-engine.test.mjs
git commit -m "feat(context): govern memory with packet lineage"
```

---

### Task 12: Validate Resume Integrity and End-to-End Lifecycle

**Files:**
- Modify: `apps/unclecode-cli/src/work-runtime-session.ts`
- Modify: `apps/unclecode-cli/src/work-runtime-bootstrap.ts`
- Modify: `packages/orchestrator/src/work-shell-engine-persistence.ts`
- Modify: `packages/contracts/src/session.ts`
- Test: `tests/work/work-runtime.test.mjs`
- Test: `tests/work/context-lifecycle.e2e.test.mjs`

**Interfaces:**
- Consumes all prior lifecycle contracts and adapters.
- Produces resume behavior that treats preview receipts as stale and verifies memory lineage before context injection.

- [ ] **Step 1: Write failing resume tests**

```js
test("resumed preview receipt is invalidated before the next submit", async () => {
  const resumed = await loadWorkCliBootstrap({ argv: ["--cwd", cwd, "--session-id", sessionId] });
  assert.equal(resumed.options.initialContextPreviewReceipt, undefined);
  assert.equal(store.getContextPacketReceipt(oldPreview.id).state, "invalidated");
});

test("resume excludes active memory with broken lineage", async () => {
  const resumed = await loadWorkCliBootstrap({ argv: ["--cwd", cwd, "--session-id", sessionId] });
  assert.equal(resumed.options.initialMemoryLines.some((line) => line.includes("orphan-memory")), false);
  assert.ok(resumed.options.contextSummaryLines.some((line) => /memory lineage/i.test(line)));
});
```

- [ ] **Step 2: Verify failure**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/work/work-runtime.test.mjs
```

Expected: FAIL before resume integrity checks exist.

- [ ] **Step 3: Persist submitted receipt identity only**

Extend session metadata with:

```ts
readonly lastSubmittedContextReceiptId?: string | undefined;
```

Do not persist an active preview as resumable state. On bootstrap, invalidate any AgentOps preview rows for the resumed session and resolve a fresh packet on first `/context` or submit.

- [ ] **Step 4: Validate active memory lineage**

Before memory prefetch, mark expired lineage and exclude any memory whose lineage references a missing or non-submitted packet receipt. Emit one bounded local warning count; do not leak memory contents in the warning.

- [ ] **Step 5: Add end-to-end lifecycle test**

The E2E test must exercise:

1. `/context` creates preview `A`.
2. Pin creates invalidated `A` and preview `B`.
3. Submit records `B` before provider invocation.
4. Assistant turn references `B`.
5. Optimizer creates deterministic suggestions.
6. Reject leaves CRP unchanged.
7. Accept creates preview `C` through CRP mutation.
8. Memory promotion references the submitted receipt for `B`.
9. Resume invalidates unsubmitted `C` and excludes broken lineage.
10. Raw secret fixture is absent from all lifecycle-table text columns.

- [ ] **Step 6: Run focused lifecycle verification**

```bash
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/work/context-lifecycle.e2e.test.mjs tests/work/work-runtime.test.mjs
npm run test:work
npm run build
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/unclecode-cli/src/work-runtime-session.ts apps/unclecode-cli/src/work-runtime-bootstrap.ts packages/orchestrator/src/work-shell-engine-persistence.ts packages/contracts/src/session.ts tests/work/work-runtime.test.mjs tests/work/context-lifecycle.e2e.test.mjs
git commit -m "feat(context): verify lifecycle integrity on resume"
```

---

### Task 13: Run Full Verification and Runtime Smoke QA

**Files:**
- Modify only if a verified failure traces to lifecycle code from Tasks 1–12.
- Do not change unrelated pre-existing tests or formatting.

**Interfaces:**
- Consumes the complete implementation.
- Produces release evidence; no new production API.

- [ ] **Step 1: Run formatting and whitespace checks**

```bash
git diff --check
npx biome check packages/contracts/src/context-lifecycle.ts packages/agentops-db/src/store-context-receipts.ts packages/agentops-db/src/store-context-suggestions.ts packages/agentops-db/src/store-memory-lineage.ts packages/orchestrator/src/context-packet-change.ts packages/orchestrator/src/context-policy-evaluator.ts apps/unclecode-cli/src/work-runtime-context-ledger.ts packages/tui/src/work-shell-context-receipt.tsx packages/tui/src/work-shell-context-advice.tsx
```

Expected: exit 0.

- [ ] **Step 2: Run full build and type-check**

```bash
npm run build
npm run check
```

Expected: exit 0.

- [ ] **Step 3: Run full Node test suite**

```bash
npm test
```

Expected: all suites PASS. If a known workspace-path assertion fails only because the checkout path lacks `/unclecode/`, report it separately and preserve the focused lifecycle proof.

- [ ] **Step 4: Run Rust regression suite**

```bash
cargo test -p unclecode-core
```

Expected: PASS; the lifecycle feature does not alter Rust provider behavior.

- [ ] **Step 5: Run a local Work Shell lifecycle smoke scenario**

Use a temporary AgentOps home and an injected/local test provider so no real API key is required. Exercise `/context`, pin, submit, Advice rejection, Advice acceptance, and session resume. Query only aggregate columns:

```sql
SELECT state, COUNT(*) FROM context_packet_receipts GROUP BY state ORDER BY state;
SELECT status, COUNT(*) FROM context_policy_suggestions GROUP BY status ORDER BY status;
SELECT state, COUNT(*) FROM memory_lineage GROUP BY state ORDER BY state;
```

Expected: at least one submitted receipt, one invalidated receipt, one resolved suggestion, and one active lineage row; no raw content columns exist in lifecycle tables.

- [ ] **Step 6: Review the final change set**

Run CodeRabbit when available:

```bash
coderabbit review --agent -t uncommitted
```

If rate-limited, perform the repository manual-review workflow and record the rate-limit response. Fix all Critical and Warning findings, then rerun affected focused tests.

- [ ] **Step 7: Commit verification-only fixes if any**

If no fix is required, do not create an empty commit. If verified lifecycle defects were fixed, stage each corrected file by its exact path (never `git add .`) and commit:

```bash
git commit -m "fix(context): close lifecycle verification gaps"
```
