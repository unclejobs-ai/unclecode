/**
 * Context Runbook Protocol (CRP) — providers.
 *
 * Each provider scans its source (guidance files, bridge trail, loop trail,
 * memory, runtime trace) and upserts rows into the `context_sources` table.
 * The per-turn selector then queries and ranks them under a token budget.
 *
 * See docs/design/crp-context-runbook-protocol.md.
 */
import type { AgentOpsStore } from "@unclecode/agentops-db";
import {
  CONTEXT_SOURCE_DEFAULT_SALIENCE,
  type UpsertContextSourceInput,
} from "@unclecode/contracts";

import { listProjectBridgeLines } from "./context-memory.js";
import {
  deriveSalience,
  estimateTokens,
  type ContextProvider,
  type ProviderSyncInput,
} from "./crp-provider-utils.js";
import { createWorkspaceGuidanceProvider } from "./crp-workspace-provider.js";
import { loadOmoContextSnapshot } from "./omo-context.js";

export type { ContextProvider, ProviderSyncInput } from "./crp-provider-utils.js";
export { createWorkspaceGuidanceProvider } from "./crp-workspace-provider.js";

// ── 2. BridgeProvider ────────────────────────────────────────────────

export function createBridgeProvider(): ContextProvider {
  return {
    providerId: "bridge",
    categories: ["bridge"],
    refresh: "on-turn",
    trustTier: "builtin",
    async sync(input) {
      const touched: string[] = [];
      const env = input.env ?? process.env;
      const lines = await listProjectBridgeLines(input.cwd, env);
      // Bridge lines arrive newest-first; earlier index = higher salience.
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line === undefined) continue;
        const id = `context-bridge-${i + 1}`;
        const upsert: UpsertContextSourceInput = {
          id,
          projectId: input.projectId,
          category: "bridge",
          label: line.slice(0, 120),
          content: line,
          reason: "project context bridge",
          salience: deriveSalience({ base: 0.65, ageTurns: i, length: line.length }),
          tokenEstimate: estimateTokens(line),
        };
        input.store.upsertContextSource(upsert);
        touched.push(id);
      }
      return touched;
    },
  };
}

// ── 3. LoopTrailProvider ─────────────────────────────────────────────

export function createLoopTrailProvider(): ContextProvider {
  return {
    providerId: "loop-trail",
    categories: ["loop-trail"],
    refresh: "on-turn",
    trustTier: "builtin",
    async sync(input) {
      const touched: string[] = [];
      const snapshot = await loadOmoContextSnapshot(input.cwd);

      for (const item of snapshot.included) {
        const id =
          item.kind === "omo-goal"
            ? `loop-trail-goal-${item.sessionId}-${item.goalId}`
            : `loop-trail-criterion-${item.sessionId}-${item.goalId}-${item.criterionId}`;
        const label =
          item.kind === "omo-goal"
            ? `${item.goalId} · ${item.status}`
            : `${item.goalId}/${item.criterionId} · ${item.status}`;
        const upsert: UpsertContextSourceInput = {
          id,
          projectId: input.projectId,
          category: "loop-trail",
          label,
          content: item.summary,
          reason:
            item.kind === "omo-goal"
              ? "active loop trail goal context"
              : "loop trail success criterion context",
          salience: deriveSalience({ base: 0.75, length: item.summary.length }),
          tokenEstimate: estimateTokens(item.summary),
        };
        input.store.upsertContextSource(upsert);
        touched.push(id);
      }

      // Excluded artifacts are held back locally — visible in Runbook but
      // never sent to the model. This replaces buildOmoExcludedPacketItems.
      for (const item of snapshot.excluded) {
        const id = `loop-trail-excluded-${item.path.replace(/[^a-z0-9]/gi, "-").slice(0, 80)}`;
        const upsert: UpsertContextSourceInput = {
          id,
          projectId: input.projectId,
          category: "loop-trail",
          // User-facing label — never leak the raw .omo/ disk path.
          label: "session loop trail artifact",
          content: item.path,
          reason: item.reason,
          includedInModel: false,
          salience: CONTEXT_SOURCE_DEFAULT_SALIENCE,
        };
        input.store.upsertContextSource(upsert);
        touched.push(id);
      }

      return touched;
    },
  };
}

// ── 4. MemoryProvider ────────────────────────────────────────────────

export function createMemoryProvider(
  listScopedMemoryLines: (input: {
    readonly scope: "session" | "project" | "user" | "agent";
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly sessionId?: string;
    readonly agentId?: string;
  }) => Promise<readonly string[]>,
): ContextProvider {
  return {
    providerId: "memory",
    categories: ["memory"],
    refresh: "on-turn",
    trustTier: "builtin",
    async sync(input) {
      const touched: string[] = [];
      const env = input.env ?? process.env;
      const [sessionLines, projectLines] = await Promise.all([
        listScopedMemoryLines({
          scope: "session",
          cwd: input.cwd,
          env,
          sessionId: input.sessionId,
        }),
        listScopedMemoryLines({ scope: "project", cwd: input.cwd, env }),
      ]);
      const all = [...sessionLines, ...projectLines];
      for (let i = 0; i < all.length; i += 1) {
        const line = all[i];
        if (line === undefined) continue;
        const id = `context-memory-${i + 1}`;
        const upsert: UpsertContextSourceInput = {
          id,
          projectId: input.projectId,
          category: "memory",
          label: line.slice(0, 120),
          content: line,
          reason: "scoped memory",
          salience: deriveSalience({ base: 0.6, ageTurns: i, length: line.length }),
          tokenEstimate: estimateTokens(line),
        };
        input.store.upsertContextSource(upsert);
        touched.push(id);
      }
      return touched;
    },
  };
}

// ── 5. RuntimeProvider ───────────────────────────────────────────────
// Unlike the others, runtime trace lines are pushed one-at-a-time by the
// engine. This provider upserts a snapshot of the current trace buffer.
// Salience is based on position (last N lines) — most recent ranks highest.

export function createRuntimeProvider(): ContextProvider & {
  readonly pushTraceLine: (line: string) => void;
  readonly clearTrace: () => void;
} {
  let traceBuffer: string[] = [];
  const MAX_TRACE = 12;
  return {
    providerId: "runtime",
    categories: ["runtime"],
    refresh: "on-turn",
    trustTier: "builtin",
    pushTraceLine(line: string) {
      traceBuffer.push(line);
      if (traceBuffer.length > MAX_TRACE) traceBuffer = traceBuffer.slice(-MAX_TRACE);
    },
    clearTrace() {
      traceBuffer = [];
    },
    async sync(input) {
      const touched: string[] = [];
      const lines = traceBuffer;
      const total = lines.length;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line === undefined) continue;
        const id = `runtime-trace-${i + 1}`;
        // Newer lines (higher index) get higher salience.
        const ageFromEnd = total - 1 - i;
        const upsert: UpsertContextSourceInput = {
          id,
          projectId: input.projectId,
          category: "runtime",
          label: line.slice(0, 120),
          content: line,
          reason: "live work-shell trace",
          salience: deriveSalience({ base: 0.55, ageTurns: ageFromEnd, length: line.length }),
          tokenEstimate: estimateTokens(line),
        };
        input.store.upsertContextSource(upsert);
        touched.push(id);
      }
      input.store.deleteContextSourcesByIdPrefix({
        projectId: input.projectId,
        idPrefix: "runtime-trace-",
        keepIds: touched,
      });
      return touched;
    },
  };
}

// ── Registry ─────────────────────────────────────────────────────────

export class ContextProviderRegistry {
  private readonly providers: ContextProvider[] = [];
  constructor(private readonly store: AgentOpsStore, private readonly projectId: string) {}

  register(provider: ContextProvider): void {
    this.providers.push(provider);
  }

  /** Run all registered providers and return touched IDs. */
  async syncAll(input: Omit<ProviderSyncInput, "store" | "projectId">): Promise<readonly string[]> {
    const all: string[] = [];
    for (const provider of this.providers) {
      const touched = await provider.sync({
        store: this.store,
        projectId: this.projectId,
        ...input,
      });
      all.push(...touched);
    }
    return all;
  }

  listProviders(): readonly ContextProvider[] {
    return this.providers;
  }
}

// Factory: wire all built-in providers to a registry.
export function createBuiltinProviderRegistry(
  store: AgentOpsStore,
  projectId: string,
  listScopedMemoryLines: (input: {
    readonly scope: "session" | "project" | "user" | "agent";
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly sessionId?: string;
    readonly agentId?: string;
  }) => Promise<readonly string[]>,
): ContextProviderRegistry & { readonly runtime: ReturnType<typeof createRuntimeProvider> } {
  const registry = new ContextProviderRegistry(store, projectId);
  const runtime = createRuntimeProvider();
  registry.register(createWorkspaceGuidanceProvider());
  registry.register(createBridgeProvider());
  registry.register(createLoopTrailProvider());
  registry.register(createMemoryProvider(listScopedMemoryLines));
  registry.register(runtime);
  return Object.assign(registry, { runtime });
}
