# Agent Memory & Context Strategy (2026-07)

> **Status:** research-backed master plan (Planner, 2026-07-05)  
> **Thesis:** UncleCode wins as a **context-native coding agent** — not another chat shell.  
> **Constraint:** theory informs architecture; Executor ships one vertical slice at a time with `qa:health` gates.

---

## 1. Why this document

T11–T15 shipped bootstrap, modes, TUI conversation design, and the Work board. The next leap is not more chrome — it is **memory + context engineering** grounded in 2025–2026 research.

Operator pain today (Korean input, noisy transcript) is real but **symptomatic**. Root product leverage:

1. **Next-call packet inspectability** — what enters the model, why, and what was withheld.  
2. **Write–manage–read memory loop** — not append-only chat history.  
3. **Long-horizon stability** — compaction, contradiction handling, selective forgetting.

---

## 2. Research map (Jul 2025 – Jul 2026)

### 2.1 Evolution: Storage → Reflection → Experience

**Source:** *From Storage to Experience: A Survey on the Evolution of LLM Agent Memory* (ACL 2026 Findings)

| Stage | Meaning | UncleCode today | Gap |
| --- | --- | --- | --- |
| **Storage** | Preserve trajectories & artifacts | session-store, agentops SQLite, bootstrap.json, transcript | OK baseline |
| **Reflection** | Refine noisy traces into usable state | prefetch degrade warnings, sanitize leaks, `/context` overlay | No milestone summarization; no contradiction pass |
| **Experience** | Abstract cross-trajectory knowledge | `.unclecode/sop/` procedural store (partial) | No project-level semantic memory; no learned consolidation |

**Design rule:** every new memory feature must declare which stage it advances.

---

### 2.2 Write–Manage–Read loop

**Source:** *Memory for Autonomous LLM Agents* (arXiv:2603.07670, early 2026)

Formal loop coupled with perception and action:

```
Perceive → Write? → Manage (index/update/forget) → Read? → Act
```

**Three-axis taxonomy** (use in `ContextPacketView` tags):

| Axis | Values | UncleCode mapping |
| --- | --- | --- |
| Temporal scope | STM / LTM / cross-session | turn buffer / session scoped memory / project bridge |
| Substrate | parametric / structured / unstructured | model weights (none) / bootstrap.json + packet items / guidance text |
| Control | heuristic / agent policy / learned | prefetch timeout, pinned skills / future tool-based memory ops |

**Five mechanism families** → UncleCode modules:

| Family | Research | UncleCode module | Maturity |
| --- | --- | --- | --- |
| Context compression | Summarize, compact | sanitize, packet compact lines, future CAT-style workspace | Partial |
| Retrieval-augmented store | Vector + metadata | `memory-prefetch`, session-store scoped lines | Partial |
| Reflective self-improvement | Post-turn critique | guardian synthesis (hidden); no memory critique yet | Low |
| Hierarchical virtual context | STM buffer + LTM archive | ContextPacket included/excluded/warnings | Medium |
| Policy-learned management | RL / tool policy for store/forget | Not started | None |

---

### 2.3 Six atomic operations

**Source:** *Rethinking Memory in LLM based Agents* (arXiv:2505.00675)

| Operation | Definition | UncleCode hook |
| --- | --- | --- |
| **Consolidation** | Merge episodes into durable facts | Post-turn bridge (partial); bootstrap ingest |
| **Updating** | Patch stale facts | Scoped memory write; bootstrap regen on `/reload` |
| **Indexing** | Keys for retrieval (entity, time, intent) | Packet item `source` + scope; missing intent index |
| **Forgetting** | Remove low-value / wrong facts | **Missing** — synthetic bootstrap pollutes prefetch (fixed filter); no general forget |
| **Retrieval** | Select for current step | `prefetchScopedMemory`, `/context` reload |
| **Compression** | Fit budget | `truncateForDisplayWidth`, packet line caps, token budget in research packet |

**Executor priority:** Indexing + Forgetting + Consolidation (in that order for coding-agent workload).

---

### 2.4 Agent-native memory systems

**Source:** *Are We Ready For An Agent-Native Memory System?* (arXiv:2606.24775)

Decompose into four modules — **no monolithic “memory score”**:

1. **Representation & storage** — `.unclecode/context/bootstrap.json`, session-store scopes  
2. **Extraction** — guidance walk, skills catalog, cursor rules, OMO summaries  
3. **Retrieval & routing** — prefetch, classify-intent, pinned skills  
4. **Maintenance** — `/reload`, bootstrap regen, **localized updates** (not full re-ingest every turn)

Finding: **localized maintenance beats global reorganization** on cost-performance. Prefer patch bootstrap manifest + invalidate cache over full workspace re-walk each turn.

---

### 2.5 Context engineering (industry + ACL 2026)

| Framework | Idea | UncleCode alignment |
| --- | --- | --- |
| **Anthropic — context engineering** | Smallest high-signal token set; compaction + structured notes + subagents | Hidden orchestrator = isolate; `/context` = inspect; bootstrap = structured notes |
| **LangChain — write / select / compress / isolate** | Externalize state; checkpoint scratchpad | session-store + engine state; team-runner isolation |
| **ARC** (ACL 2026 Findings) | Active, reflection-driven context; fight **context rot** | Replace append-only trace with **revisable working state** at milestones |
| **CAT** (ACL 2026 Findings) | Context maintenance as **callable tool**; stable semantics + LTM summary + STM | Expose `context_compact`, `memory_store`, `memory_forget` as agent/slash tools |
| **AgeMem** (ACL 2026 Long) | Unified LTM/STM via tool actions + RL policy | Long-term: memory ops in agent tool registry with step-wise rewards from task success |

**Context rot** (ARC): passive summarization preserves early errors. UncleCode mitigation:

- Sanitize orchestration leaks (shipped T12–T13).  
- Next: **milestone compaction** after complex turns — synthesis summary replaces executor trace in *packet*, not chat.

---

### 2.6 Benchmarks to adopt (eval harness, not product features)

**Source:** Mem0 State of Agent Memory 2026; survey papers

| Benchmark | Stress | UncleCode eval idea |
| --- | --- | --- |
| **LoCoMo** | Multi-session conversational recall | Fixture: 3 synthetic sessions → prefetch must surface fact X on turn 4 |
| **LongMemEval** | Long interactive memory | `/reload` + scoped memory across 50-turn fixture |
| **BEAM** | 1M–10M token scale | Packet budget stress — bootstrap + memory must stay under cap with ranked exclusion |
| **MemoryArena** | Active memory use during decisions | Agent must retrieve pinned skill, not full guidance dump |

Categories to unit-test in broker: **temporal**, **multi-hop**, **contradiction**, **knowledge update**, **abstention**.

---

## 3. UncleCode product architecture (context-native)

```mermaid
flowchart TB
  subgraph write["Write path"]
    W1[Bootstrap ingest → bootstrap.json]
    W2[Turn outcomes → scoped memory]
    W3[User pins → pinned-skills.json]
    W4[Agent tool: memory_store — planned]
  end

  subgraph manage["Manage path"]
    M1[Deduplicate + SHA classify]
    M2[Contradiction detect — planned]
    M3[Forget / TTL — planned]
    M4[Milestone compact — planned]
  end

  subgraph read["Read path"]
    R1[prefetchScopedMemory]
    R2[assemble ContextPacketView]
    R3[classify-intent routing slice]
    R4[/context overlay + footer chip]
  end

  subgraph surface["Operator surfaces"]
    S1[Work Shell chat — final answers only]
    S2[/context — packet inspector]
    S3[/queue Work board — task state]
    S4[Session Center — traces]
  end

  write --> manage --> read
  read --> WSE[WorkShellEngine next-call]
  WSE --> surface
```

**North star metric:** operator can answer in ≤10s: *“What context will the next model call see, and why?”*

---

## 4. Phased roadmap (T17–T20)

### T17 — Context packet v2 (Experience-oriented read path)

**Goal:** Packet is the product; chat is output.

| ID | Deliverable | Research anchor |
| --- | --- | --- |
| T17-E1 | Footer chip: `맥락 N항목 · M 토큰예상` from packet stats | Anthropic minimal high-signal |
| T17-E2 | `/context` groups: **포함 / 보류 / 제외 / 경고** with KO labels + source path | Agent-native representation module |
| T17-E3 | Intent-aware retrieval slice: routing prompt excludes full guidance for simple KO questions | Write–manage–read “select” |
| T17-E4 | Contradiction warning when bootstrap sources conflict (extend Rust conflict heuristic → packet warning) | BEAM contradiction category |
| T17-GATE | LoCoMo-style fixture test in `test:context-broker` | LoCoMo |

### T18 — Memory maintenance loop

| ID | Deliverable | Research anchor |
| --- | --- | --- |
| T18-E1 | `forgetScopedMemory` + `/memory forget <key>` (localized) | Forgetting operation |
| T18-E2 | Post-turn consolidation: one-line session fact extract (no bridge spam) | Consolidation + AgeMem store |
| T18-E3 | Bootstrap patch-on-change (git-aware file watcher debounce) | Localized maintenance |
| T18-E4 | Temporal metadata on memory lines (`observedAt`, `supersedes`) | Mem0 temporal benchmark |
| T18-GATE | LongMemEval-style 3-session fixture | LongMemEval |

### T19 — Context-as-tool (CAT / AgeMem)

| ID | Deliverable | Research anchor |
| --- | --- | --- |
| T19-E1 | Agent tools: `context_status`, `context_compact`, `memory_search` | CAT, AgeMem |
| T19-E2 | Milestone compaction after complex turns (executor trace → packet LTM summary) | ARC reflection |
| T19-E3 | Policy: ultrawork planner may call memory tools; simple turns forbidden | Control policy axis |
| T19-GATE | MemoryArena-style scenario in orchestrator contract tests | MemoryArena |

### T20 — Evaluation & runbook

| ID | Deliverable |
| --- | --- |
| T20-E1 | `scripts/eval/context-memory/` harness (LoCoMo + contradiction fixtures) |
| T20-E2 | Runbook § Agent memory SSOT + benchmark cadence |
| T20-E3 | Devil's advocate re-run vs T17–T19 |

---

## 5. Korean input & context UX (parallel track)

Research does not replace terminal IME work. Bundle under **T16** (operator ergonomics):

- Composer Hangul: mid-cursor jamo + prefix-anchored IME merge (`composer.tsx`).  
- KO-first hints: `/context`, `/queue`, busy/queue copy.  
- Display-width: Rust + TS single owner audit (remaining `Ink truncate-end` edges).

**Rule:** Korean copy explains **context actions** (“맥락 확인”, “다음 호출에 포함”) not generic IDE chrome.

---

## 6. Anti-patterns (from 2026 evals)

| Anti-pattern | Why it fails | UncleCode guard |
| --- | --- | --- |
| Full guidance every turn | Token bloat; BEAM-scale collapse | Skills catalog vs inject; pinned skills |
| Append-only session log as “memory” | Context rot (ARC) | Packet compaction; hidden orchestrator |
| Silent prefetch failure | False confidence | Degrade → packet warning (shipped) |
| End-to-end task score only | Black-box memory (2606.24775) | Per-module fixtures: extract/retrieve/maintain |
| English-only operator surface | Product incoherence (우리) | KO packet labels + hints |

---

## 7. Immediate next Executor step

**Recommended:** **T17-E1 + T17-E2** (packet footer chip + KO `/context` grouping) — visible proof of “context-native tool” without new dependencies.

**Defer:** RL-trained memory policy (AgeMem) until tool-based memory ops exist (T19).

---

## References

1. ACL 2026 Findings — *From Storage to Experience: A Survey on the Evolution of LLM Agent Memory*  
2. arXiv:2603.07670 — *Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers*  
3. arXiv:2505.00675 — *Rethinking Memory in LLM based Agents*  
4. arXiv:2606.24775 — *Are We Ready For An Agent-Native Memory System?*  
5. ACL 2026 Findings — *ARC: Active and Reflection-driven Context Management*  
6. ACL 2026 Findings — *Context as a Tool (CAT)*  
7. ACL 2026 Long — *Agentic Memory (AgeMem)*  
8. Anthropic — *Effective context engineering for AI agents* (2025)  
9. LangChain — *Context engineering for agents* (write/select/compress/isolate)  
10. Mem0 — *State of AI Agent Memory 2026* (LoCoMo, LongMemEval, BEAM)

**Internal:** [`persistent-context-architecture.md`](./persistent-context-architecture.md), [`context-bootstrap-pipeline.md`](./context-bootstrap-pipeline.md), [`unclecode-holistic-roadmap-2026-07.md`](./unclecode-holistic-roadmap-2026-07.md)
