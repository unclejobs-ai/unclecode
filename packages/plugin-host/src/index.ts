/**
 * Plugin host — UncleCode in-process extension point.
 *
 * A plugin is a TS module exporting either a default function or a named
 * `register(ctx)` that returns a partial Hooks record. Plugins live in
 * .unclecode/plugins/<name>.ts and are loaded by name; the host validates
 * each registration with a Zod schema before wiring.
 *
 * Loading plugin code from a workspace is gated by an explicit user-granted
 * trust decision recorded in `~/.unclecode/trust.json`. The trust check is
 * skipped for in-memory `loadEntries` callers, which already have the plugin
 * code in hand — the threat is an attacker-supplied .unclecode/plugins
 * directory in a freshly cloned repo.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  classifyQualityProfile,
  evaluateGate,
  validateEvolutionProposal,
  validatePlan,
  validateRunCompletion,
  type EvolutionProposal,
  type EvolutionValidationContext,
  type GateEvidence,
  type GateFinding,
  type QualityRunProjection,
  type RiskLevel,
  type UncleCodeComplexity,
} from "@second-claude/core";
import {
  createPluginDiagnosticProjection,
  QUALITY_HARNESS_STAGES,
  WORK_NODE_ROLES,
  WORK_NODE_STATUSES,
  type QualityHarnessStage,
  type QualityProfile,
  type WorkGraph,
  type WorkNode,
  type WorkNodeDispatchOutcome,
} from "@unclecode/contracts";
import { z } from "zod";

const HookKeysSchema = z.object({
  toolExecuteBefore: z.function().optional(),
  toolExecuteAfter: z.function().optional(),
  fileEdited: z.function().optional(),
  sessionCompacted: z.function().optional(),
  runStarted: z.function().optional(),
  runCompleted: z.function().optional(),
  runClassified: z.function().optional(),
  planCreated: z.function().optional(),
  beforeNodeDispatch: z.function().optional(),
  afterNodeCompleted: z.function().optional(),
  beforeRunComplete: z.function().optional(),
  contextContribute: z.function().optional(),
  evolutionProposed: z.function().optional(),
  dispose: z.function().optional(),
});

export type PluginDecisionAction = "proceed" | "refine" | "pivot" | "block" | "unproven";

export type PluginLifecycleDecision = {
  readonly action: PluginDecisionAction;
  readonly reason?: string;
  readonly failures?: readonly string[];
};

export type PluginRunClassifiedEvent = {
  readonly runId: string;
  readonly prompt: string;
  readonly complexity: UncleCodeComplexity;
  readonly risk: RiskLevel;
  readonly creatorIntent: boolean;
  readonly proposedProfile: QualityProfile;
};

export type PluginPlanCreatedEvent = {
  readonly runId: string;
  readonly graph: WorkGraph;
};

export type PluginBeforeNodeDispatchEvent = PluginPlanCreatedEvent & {
  readonly node: WorkNode;
};

export type PluginBeforeNodeDispatchDecision = PluginLifecycleDecision & {
  readonly replacementNode?: WorkNode;
};

export type PluginAfterNodeCompletedEvent = PluginBeforeNodeDispatchEvent & {
  readonly outcome: WorkNodeDispatchOutcome;
  readonly artifactHash: string;
  readonly producerId: string;
  readonly evidence: readonly GateEvidence[];
  readonly findings: readonly GateFinding[];
  readonly independentProviderAvailable: boolean;
  readonly independentReviewerAvailable: boolean;
  readonly refineCount: number;
  readonly pivotCount: number;
};

export type PluginBeforeRunCompleteEvent = PluginPlanCreatedEvent & {
  readonly projection: QualityRunProjection;
  readonly evidence: readonly GateEvidence[];
  readonly currentArtifactHash: string;
  readonly producerId: string;
  readonly independentReviewerAvailable: boolean;
  readonly reviewRequired?: boolean;
  /**
   * Host-recorded creator result. The runtime supplies this only after the
   * proposal crossed `evolutionProposed`; profile selection and ordinary gate
   * success never synthesize it.
   */
  readonly evolution?: PluginCreatorEvolutionCompletion;
};

export type PluginCreatorEvolutionCompletion = {
  readonly proposalId: string;
  readonly proposal?: EvolutionProposal;
  readonly context?: EvolutionValidationContext;
  readonly state: "pr-ready" | "rejected" | "failed" | "cancelled" | "stale";
  readonly recorded: boolean;
  readonly stale: boolean;
};

export type PluginContextContributeEvent = {
  readonly runId: string;
  readonly graphId: string;
  readonly profile: QualityProfile;
  readonly stage: QualityHarnessStage;
};

export type PluginContextContribution = {
  readonly content: string;
};

export type AttributedPluginContextContribution = PluginContextContribution & {
  readonly pluginName: string;
};

export type PluginEvolutionProposedEvent = {
  readonly runId: string;
  readonly proposal: EvolutionProposal;
  readonly context: EvolutionValidationContext;
};

export type AttributedPluginDecision = PluginLifecycleDecision & {
  readonly pluginName: string;
};

export type PluginDecisionAggregate = {
  readonly action: PluginDecisionAction;
  readonly decisions: readonly AttributedPluginDecision[];
  readonly failures: readonly string[];
};

export type PluginBeforeNodeDispatchAggregate = PluginDecisionAggregate & {
  readonly node: WorkNode;
};

export const MAX_CONTEXT_CONTRIBUTION_CHARS = 2_000;
export const MAX_CONTEXT_CONTRIBUTION_TOTAL_CHARS = 6_000;

export type PluginHooks = {
  toolExecuteBefore?: (event: { runId: string; toolName: string; input: Record<string, unknown> }) => Promise<void> | void;
  toolExecuteAfter?: (event: { runId: string; toolName: string; output: string; isError: boolean }) => Promise<void> | void;
  fileEdited?: (event: { runId: string; path: string; sha256: string }) => Promise<void> | void;
  sessionCompacted?: (event: { sessionId: string; messagesBefore: number; messagesAfter: number }) => Promise<void> | void;
  runStarted?: (event: { runId: string; persona?: string }) => Promise<void> | void;
  runCompleted?: (event: { runId: string; status: string }) => Promise<void> | void;
  runClassified?: (event: PluginRunClassifiedEvent) => Promise<PluginLifecycleDecision | void> | PluginLifecycleDecision | void;
  planCreated?: (event: PluginPlanCreatedEvent) => Promise<PluginLifecycleDecision | void> | PluginLifecycleDecision | void;
  beforeNodeDispatch?: (event: PluginBeforeNodeDispatchEvent) => Promise<PluginBeforeNodeDispatchDecision | void> | PluginBeforeNodeDispatchDecision | void;
  afterNodeCompleted?: (event: PluginAfterNodeCompletedEvent) => Promise<PluginLifecycleDecision | void> | PluginLifecycleDecision | void;
  beforeRunComplete?: (event: PluginBeforeRunCompleteEvent) => Promise<PluginLifecycleDecision | void> | PluginLifecycleDecision | void;
  contextContribute?: (event: PluginContextContributeEvent) => Promise<PluginContextContribution | void> | PluginContextContribution | void;
  evolutionProposed?: (event: PluginEvolutionProposedEvent) => Promise<PluginLifecycleDecision | void> | PluginLifecycleDecision | void;
  dispose?: () => Promise<void> | void;
};

export type PluginContext = {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  log(message: string): void;
};

export type PluginRegistration = {
  readonly name: string;
  readonly hooks: PluginHooks;
  readonly source: PluginSource;
};

export type PluginSource = "memory" | "workspace" | "cached" | "builtin";
export type PluginTrustLane =
  | "host-provided"
  | "workspace-trusted"
  | "cached-external"
  | "builtin-trusted";
export type PluginHookName = Exclude<keyof PluginHooks, "dispose">;

export type PluginInvocationDiagnostic = {
  readonly runId: string;
  readonly source: PluginSource;
  readonly trustLane: PluginTrustLane;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly hookName: PluginHookName;
  readonly status: "error";
  readonly errorName: string;
  readonly errorMessage: string;
  readonly exitStatus: string | undefined;
  readonly dedupeKey: string;
};

export type PluginHostOptions = {
  readonly onDiagnostic?: (diagnostic: PluginInvocationDiagnostic) => void;
};

export type PluginLifecycleRegistrationSnapshot = {
  readonly name: string;
  readonly source: PluginSource;
  readonly trustLane: PluginTrustLane;
  readonly hookCount: number;
};

export type PluginLifecycleSnapshot = {
  readonly status: "active" | "disposing" | "disposed";
  readonly registrationCount: number;
  readonly pendingCleanupCount: number;
  readonly registrations: readonly PluginLifecycleRegistrationSnapshot[];
  readonly truncated: boolean;
};

export type PluginEntry = (ctx: PluginContext) => PluginHooks | Promise<PluginHooks>;

export class PluginHost {
  private readonly registrations: PluginRegistration[] = [];
  private registrationGeneration = 0;
  private readonly registrationHookCounts = new WeakMap<PluginRegistration, number>();
  private readonly diagnosticKeysByRun = new Map<string, Set<string>>();
  private readonly pendingCleanupByName = new Map<string, Promise<void>>();
  private readonly onDiagnostic: ((diagnostic: PluginInvocationDiagnostic) => void) | undefined;
  private disposed = false;
  private disposeSettled = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: PluginHostOptions = {}) {
    this.onDiagnostic = options.onDiagnostic;
  }

  async register(
    name: string,
    hooks: PluginHooks,
    source: PluginRegistration["source"] = "memory",
  ): Promise<void> {
    this.assertActive();
    HookKeysSchema.parse(hooks);
    const hookCount = Object.keys(hooks).filter((key) => key !== "dispose").length;
    const nextRegistration: PluginRegistration = { name, hooks, source };
    this.registrationHookCounts.set(nextRegistration, hookCount);
    const pendingCleanup = this.pendingCleanupByName.get(name);
    if (pendingCleanup) {
      await pendingCleanup;
      this.assertActive();
    }

    const conflicting = this.registrations.find(
      (registration) => registration.name === name && registration.source !== source,
    );
    if (conflicting) {
      throw new PluginRegistrationConflictError(name, conflicting.source, source);
    }

    const existingIndex = this.registrations.findIndex(
      (registration) => registration.name === name && registration.source === source,
    );
    if (existingIndex === -1) {
      this.registrations.push(nextRegistration);
      this.registrationGeneration += 1;
      return;
    }

    const existing = this.registrations[existingIndex];
    if (!existing) return;
    this.registrations.splice(existingIndex, 1);
    this.registrationGeneration += 1;
    this.diagnosticKeysByRun.clear();
    const cleanupResult = existing.hooks.dispose?.();
    if (!isPromiseLike(cleanupResult)) {
      this.registrations.splice(
        Math.min(existingIndex, this.registrations.length),
        0,
        nextRegistration,
      );
      this.registrationGeneration += 1;
      return;
    }
    const cleanup = Promise.resolve(cleanupResult);
    this.pendingCleanupByName.set(name, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.pendingCleanupByName.get(name) === cleanup) {
        this.pendingCleanupByName.delete(name);
      }
    }
    this.assertActive();
    this.registrations.splice(
      Math.min(existingIndex, this.registrations.length),
      0,
      nextRegistration,
    );
    this.registrationGeneration += 1;
  }

  registerBuiltIn(name: string, hooks: PluginHooks): Promise<void> {
    return this.register(name, hooks, "builtin");
  }

  async loadEntries(workspaceRoot: string, entries: ReadonlyArray<{ name: string; entry: PluginEntry }>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const prepared: Array<{ readonly name: string; readonly hooks: PluginHooks }> = [];
    try {
      for (const { name, entry } of entries) {
        const log = (message: string) => process.stderr.write(`[plugin:${name}] ${message}\n`);
        prepared.push({ name, hooks: await entry({ workspaceRoot, env, log }) });
      }
    } catch (error) {
      await disposePreparedAfterFailure(prepared, error);
    }
    const registered: string[] = [];
    for (const { name, hooks } of prepared) {
      try {
        await this.register(name, hooks, "memory");
        registered.push(name);
      } catch (error) {
        await hooks.dispose?.();
        await this.rollbackBatch(registered, "memory", error);
        throw error;
      }
    }
  }

  async loadFromDisk(
    workspaceRoot: string,
    options: {
      readonly env?: NodeJS.ProcessEnv;
      readonly homeDir?: string;
      readonly requireTrust?: boolean;
    } = {},
  ): Promise<ReadonlyArray<string>> {
    const requireTrust = options.requireTrust ?? true;
    const dir = resolve(workspaceRoot, ".unclecode", "plugins");
    const files = existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".ts") || name.endsWith(".mjs") || name.endsWith(".js"))
          .sort()
      : [];
    if (files.length === 0) {
      await this.unloadMissing("workspace", new Set());
      return [];
    }
    if (requireTrust && !isWorkspaceTrusted(workspaceRoot, options.homeDir)) {
      throw new PluginTrustError(resolve(workspaceRoot));
    }
    const env = options.env ?? process.env;
    const prepared: Array<{ readonly name: string; readonly hooks: PluginHooks }> = [];
    try {
      for (const file of files) {
        const name = file.replace(/\.(ts|mjs|js)$/, "");
        const moduleUrl = new URL(`file://${join(dir, file)}`);
        const imported = (await import(moduleUrl.href)) as {
          default?: PluginEntry;
          register?: PluginEntry;
        };
        const entry = imported.default ?? imported.register;
        if (typeof entry !== "function") continue;
        const log = (message: string) => process.stderr.write(`[plugin:${name}] ${message}\n`);
        prepared.push({ name, hooks: await entry({ workspaceRoot, env, log }) });
      }
    } catch (error) {
      await disposePreparedAfterFailure(prepared, error);
    }
    const loaded: string[] = [];
    for (const { name, hooks } of prepared) {
      try {
        await this.register(name, hooks, "workspace");
      } catch (error) {
        await hooks.dispose?.();
        await this.rollbackBatch(loaded, "workspace", error);
        throw error;
      }
      loaded.push(name);
    }
    await this.unloadMissing("workspace", new Set(loaded));
    return loaded;
  }

  list(): ReadonlyArray<PluginRegistration> {
    return this.registrations.slice();
  }

  /** Monotonic identity used by callers to fail closed across hot reloads. */
  getRegistrationGeneration(): number {
    return this.registrationGeneration;
  }

  getLifecycleSnapshot(): PluginLifecycleSnapshot {
    const registrationCount = this.registrations.length;
    const registrations = this.registrations.slice(0, 64).map((registration) => ({
      name: registration.name,
      source: registration.source,
      trustLane: pluginTrustLane(registration.source),
      hookCount: this.registrationHookCounts.get(registration) ?? 0,
    }));
    return Object.freeze({
      status: !this.disposed ? "active" : this.disposeSettled ? "disposed" : "disposing",
      registrationCount,
      pendingCleanupCount: this.pendingCleanupByName.size,
      registrations: Object.freeze(registrations),
      truncated: registrationCount > registrations.length,
    });
  }

  async unload(name: string, source?: PluginSource): Promise<boolean> {
    if (this.disposed) return false;
    const pendingCleanup = this.pendingCleanupByName.get(name);
    if (pendingCleanup) await pendingCleanup;
    if (this.disposed) return false;

    const removed = this.registrations.filter(
      (registration) => registration.name === name && (source === undefined || registration.source === source),
    );
    if (removed.length === 0) return false;
    const removedSet = new Set(removed);
    for (let index = this.registrations.length - 1; index >= 0; index -= 1) {
      const registration = this.registrations[index];
      if (registration && removedSet.has(registration)) this.registrations.splice(index, 1);
    }
    this.registrationGeneration += 1;
    this.diagnosticKeysByRun.clear();
    await disposeRegistrations(removed);
    return true;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const registrations = this.registrations.splice(0);
    if (registrations.length > 0) this.registrationGeneration += 1;
    const pendingCleanups = [...this.pendingCleanupByName.values()];
    this.diagnosticKeysByRun.clear();
    this.disposePromise = (async () => {
      const pendingResults = await Promise.allSettled(pendingCleanups);
      const cleanupResults = await Promise.allSettled(
        registrations.map((registration) => this.disposeRegistration(registration)),
      );
      throwCleanupFailures([...pendingResults, ...cleanupResults]);
    })().finally(() => {
      this.disposeSettled = true;
    });
    return this.disposePromise;
  }

  async dispatchToolExecuteBefore(event: { runId: string; toolName: string; input: Record<string, unknown> }): Promise<void> {
    requirePluginInvocationRunId(event);
    for (const reg of this.registrations) {
      await this.invokeExternalHook(reg, "toolExecuteBefore", event, () => reg.hooks.toolExecuteBefore?.(event));
    }
  }

  async dispatchToolExecuteAfter(event: { runId: string; toolName: string; output: string; isError: boolean }): Promise<void> {
    requirePluginInvocationRunId(event);
    for (const reg of this.registrations) {
      await this.invokeExternalHook(reg, "toolExecuteAfter", event, () => reg.hooks.toolExecuteAfter?.(event));
    }
  }

  async dispatchFileEdited(event: { runId: string; path: string; sha256: string }): Promise<void> {
    requirePluginInvocationRunId(event);
    for (const reg of this.registrations) {
      await this.invokeExternalHook(reg, "fileEdited", event, () => reg.hooks.fileEdited?.(event));
    }
  }

  async dispatchSessionCompacted(event: { sessionId: string; messagesBefore: number; messagesAfter: number }): Promise<void> {
    for (const reg of this.registrations) {
      await this.invokeExternalHook(reg, "sessionCompacted", event, () => reg.hooks.sessionCompacted?.(event));
    }
  }

  async dispatchRunStarted(event: { runId: string; persona?: string }): Promise<void> {
    for (const reg of this.registrations) {
      await this.invokeExternalHook(reg, "runStarted", event, () => reg.hooks.runStarted?.(event));
    }
  }

  async dispatchRunCompleted(event: { runId: string; status: string }): Promise<void> {
    for (const reg of this.registrations) {
      await this.invokeExternalHook(reg, "runCompleted", event, () => reg.hooks.runCompleted?.(event));
    }
  }

  async dispatchRunClassified(event: PluginRunClassifiedEvent): Promise<PluginDecisionAggregate> {
    return this.dispatchDecision("runClassified", event, (hooks, value) => hooks.runClassified?.(value));
  }

  async dispatchPlanCreated(event: PluginPlanCreatedEvent): Promise<PluginDecisionAggregate> {
    return this.dispatchDecision("planCreated", event, (hooks, value) => hooks.planCreated?.(value));
  }

  async dispatchBeforeNodeDispatch(
    event: PluginBeforeNodeDispatchEvent,
  ): Promise<PluginBeforeNodeDispatchAggregate> {
    let node = copyReplacementNode(event.node);
    const decisions: AttributedPluginDecision[] = [];
    let action: PluginDecisionAction = "proceed";
    let blocked = false;
    for (const reg of this.registrations) {
      const hookEvent = { ...event, node };
      const raw = await this.invokeExternalHook(
        reg,
        "beforeNodeDispatch",
        hookEvent,
        () => reg.hooks.beforeNodeDispatch?.(hookEvent),
      );
      if (raw === undefined) continue;
      const decision = parseDecision(raw, reg.name);
      decisions.push(attributeDecision(reg.name, decision));
      action = strongerDecision(action, decision.action);
      blocked ||= decision.action === "block";
      if (!blocked && decision.action === "proceed" && raw.replacementNode !== undefined) {
        node = parseReplacementNode(raw.replacementNode, reg.name);
      }
    }
    const revalidation = validateReplacementNodeForDispatch(event, node);
    if (revalidation.action !== "proceed") {
      decisions.push(attributeDecision("unclecode-plugin-host", revalidation));
      action = strongerDecision(action, revalidation.action);
    }
    return aggregateDecision(action, decisions, { node });
  }

  async dispatchAfterNodeCompleted(event: PluginAfterNodeCompletedEvent): Promise<PluginDecisionAggregate> {
    return this.dispatchDecision("afterNodeCompleted", event, (hooks, value) => hooks.afterNodeCompleted?.(value));
  }

  async dispatchBeforeRunComplete(event: PluginBeforeRunCompleteEvent): Promise<PluginDecisionAggregate> {
    const hostEvent = immutablePluginSnapshot(event);
    const decisions: AttributedPluginDecision[] = [];
    let action: PluginDecisionAction = "proceed";
    for (const reg of this.registrations) {
      const hookEvent = immutablePluginSnapshot(hostEvent);
      const raw = await this.invokeExternalHook(
        reg,
        "beforeRunComplete",
        hookEvent,
        () => reg.hooks.beforeRunComplete?.(hookEvent),
      );
      if (raw === undefined) continue;
      const decision = parseDecision(raw, reg.name);
      decisions.push(attributeDecision(reg.name, decision));
      action = strongerDecision(action, decision.action);
    }
    const finalValidation = validateRunCompletionDecision(hostEvent);
    if (finalValidation.action !== "proceed") {
      decisions.push(attributeDecision("unclecode-plugin-host", finalValidation));
      action = strongerDecision(action, finalValidation.action);
    }
    return aggregateDecision(action, decisions);
  }

  async dispatchEvolutionProposed(event: PluginEvolutionProposedEvent): Promise<PluginDecisionAggregate> {
    return this.dispatchDecision("evolutionProposed", event, (hooks, value) => hooks.evolutionProposed?.(value));
  }

  async dispatchContextContribute(
    event: PluginContextContributeEvent,
  ): Promise<readonly AttributedPluginContextContribution[]> {
    const contributions: AttributedPluginContextContribution[] = [];
    let remaining = MAX_CONTEXT_CONTRIBUTION_TOTAL_CHARS;
    for (const reg of this.registrations) {
      if (remaining === 0) break;
      const raw = await this.invokeExternalHook(
        reg,
        "contextContribute",
        event,
        () => reg.hooks.contextContribute?.(event),
      );
      if (raw === undefined) continue;
      if (!raw || typeof raw !== "object" || typeof raw.content !== "string") {
        throw new TypeError(`Plugin ${reg.name} returned an invalid context contribution.`);
      }
      const content = raw.content.trim().slice(
        0,
        Math.min(MAX_CONTEXT_CONTRIBUTION_CHARS, remaining),
      );
      if (!content) continue;
      contributions.push({ pluginName: reg.name, content });
      remaining -= content.length;
    }
    return contributions;
  }

  private async dispatchDecision<Event>(
    hookName: PluginHookName,
    event: Event,
    invoke: (
      hooks: PluginHooks,
      event: Event,
    ) => PluginLifecycleDecision | void | Promise<PluginLifecycleDecision | void>,
  ): Promise<PluginDecisionAggregate> {
    const decisions: AttributedPluginDecision[] = [];
    let action: PluginDecisionAction = "proceed";
    for (const reg of this.registrations) {
      const raw = await this.invokeExternalHook(
        reg,
        hookName,
        event,
        () => invoke(reg.hooks, event),
      );
      if (raw === undefined) continue;
      const decision = parseDecision(raw, reg.name);
      decisions.push(attributeDecision(reg.name, decision));
      action = strongerDecision(action, decision.action);
    }
    return aggregateDecision(action, decisions);
  }

  private async invokeExternalHook<Result>(
    registration: PluginRegistration,
    hookName: PluginHookName,
    event: unknown,
    invoke: () => Result | Promise<Result>,
  ): Promise<Result> {
    try {
      return await invoke();
    } catch (cause) {
      if (registration.source !== "builtin") {
        this.emitInvocationDiagnostic(registration, hookName, event, cause);
      }
      throw cause;
    }
  }

  private emitInvocationDiagnostic(
    registration: PluginRegistration,
    hookName: PluginHookName,
    event: unknown,
    cause: unknown,
  ): void {
    if (registration.source === "builtin") return;
    const runId = pluginInvocationRunId(event);
    const trustLane = registration.source === "workspace"
      ? "workspace-trusted"
      : registration.source === "cached"
        ? "cached-external"
        : "host-provided";
    const errorName = cause instanceof Error && cause.name ? cause.name : "Error";
    const errorMessage = cause instanceof Error ? cause.message : String(cause);
    const exitStatus = pluginErrorExitStatus(cause);
    const safeFields = createPluginDiagnosticProjection({
      runId,
      source: registration.source,
      trustLane,
      pluginId: registration.name,
      pluginName: registration.name,
      hookName,
      status: "error",
      errorName,
      errorMessage,
      ...(exitStatus === undefined ? {} : { exitStatus }),
      dedupeKey: `sha256:${"0".repeat(64)}`,
      startedAt: 0,
    });
    const dedupeKey = `sha256:${createHash("sha256")
      .update([
        safeFields.source,
        safeFields.pluginId,
        safeFields.hookName,
        safeFields.errorName,
        safeFields.errorMessage,
        safeFields.exitStatus ?? "",
      ].join(":"))
      .digest("hex")}`;
    let keys = this.diagnosticKeysByRun.get(runId);
    if (!keys) {
      if (this.diagnosticKeysByRun.size >= 256) {
        const oldest = this.diagnosticKeysByRun.keys().next().value as string | undefined;
        if (oldest !== undefined) this.diagnosticKeysByRun.delete(oldest);
      }
      keys = new Set<string>();
      this.diagnosticKeysByRun.set(runId, keys);
    }
    if (keys.has(dedupeKey)) return;
    if (keys.size >= 64) {
      const oldest = keys.values().next().value as string | undefined;
      if (oldest !== undefined) keys.delete(oldest);
    }
    keys.add(dedupeKey);
    try {
      this.onDiagnostic?.({
        runId: safeFields.runId,
        source: safeFields.source,
        trustLane: safeFields.trustLane,
        pluginId: safeFields.pluginId,
        pluginName: safeFields.pluginName,
        hookName: safeFields.hookName as PluginHookName,
        status: "error",
        errorName: safeFields.errorName,
        errorMessage: safeFields.errorMessage,
        exitStatus: safeFields.exitStatus,
        dedupeKey,
      });
    } catch {
      // Diagnostics are observational. A broken telemetry sink must not replace
      // the plugin hook cause that determines the existing gate semantics.
    }
  }

  private async disposeRegistration(registration: PluginRegistration): Promise<void> {
    await registration.hooks.dispose?.();
  }

  private async unloadMissing(source: PluginSource, activeNames: ReadonlySet<string>): Promise<void> {
    const staleNames = [...new Set(
      this.registrations
        .filter((registration) => registration.source === source && !activeNames.has(registration.name))
        .map((registration) => registration.name),
    )];
    for (const name of staleNames) await this.unload(name, source);
  }

  private async rollbackBatch(names: readonly string[], source: PluginSource, cause: unknown): Promise<never> {
    const failures: unknown[] = [cause];
    for (const name of [...names].reverse()) {
      try {
        await this.unload(name, source);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw cause;
    throw new AggregateError(failures, "Plugin batch registration and rollback failed.");
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("PluginHost has been disposed.");
  }
}

export class PluginRegistrationConflictError extends Error {
  readonly pluginName: string;
  readonly existingSource: PluginSource;
  readonly incomingSource: PluginSource;

  constructor(pluginName: string, existingSource: PluginSource, incomingSource: PluginSource) {
    super(
      `Plugin registration conflict for ${pluginName}: ${incomingSource} cannot replace ${existingSource}.`,
    );
    this.name = "PluginRegistrationConflictError";
    this.pluginName = pluginName;
    this.existingSource = existingSource;
    this.incomingSource = incomingSource;
  }
}

async function disposePreparedAfterFailure(
  prepared: readonly { readonly hooks: PluginHooks }[],
  cause: unknown,
): Promise<never> {
  const results = await Promise.allSettled(
    prepared.map(async ({ hooks }) => hooks.dispose?.()),
  );
  const cleanupFailures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (cleanupFailures.length === 0) throw cause;
  throw new AggregateError([cause, ...cleanupFailures], "Plugin batch initialization and cleanup failed.");
}

async function disposeRegistrations(registrations: readonly PluginRegistration[]): Promise<void> {
  const results = await Promise.allSettled(
    registrations.map(async (registration) => registration.hooks.dispose?.()),
  );
  throwCleanupFailures(results);
}

function throwCleanupFailures(results: readonly PromiseSettledResult<void>[]): void {
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Multiple plugin cleanup callbacks failed.");
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return Boolean(value && typeof value === "object" && "then" in value
    && typeof (value as { readonly then?: unknown }).then === "function");
}

function pluginInvocationRunId(event: unknown): string {
  if (event && typeof event === "object") {
    const record = event as { runId?: unknown; sessionId?: unknown };
    if (typeof record.runId === "string" && record.runId.trim()) return record.runId;
    if (typeof record.sessionId === "string" && record.sessionId.trim()) {
      return `session:${record.sessionId}`;
    }
  }
  return "unscoped";
}

function requirePluginInvocationRunId(event: { readonly runId?: unknown }): string {
  if (typeof event.runId !== "string" || event.runId.trim().length === 0) {
    throw new TypeError("Plugin tool/file hook dispatch requires a non-empty runId.");
  }
  return event.runId;
}

function pluginTrustLane(source: PluginSource): PluginTrustLane {
  if (source === "builtin") return "builtin-trusted";
  if (source === "workspace") return "workspace-trusted";
  if (source === "cached") return "cached-external";
  return "host-provided";
}

function pluginErrorExitStatus(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const value = (cause as { exitStatus?: unknown; status?: unknown }).exitStatus
    ?? (cause as { status?: unknown }).status;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function immutablePluginSnapshot<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

const DECISION_PRECEDENCE: Readonly<Record<PluginDecisionAction, number>> = {
  proceed: 0,
  unproven: 1,
  refine: 2,
  pivot: 3,
  block: 4,
};

function strongerDecision(
  current: PluginDecisionAction,
  candidate: PluginDecisionAction,
): PluginDecisionAction {
  return DECISION_PRECEDENCE[candidate] > DECISION_PRECEDENCE[current]
    ? candidate
    : current;
}

function parseDecision(value: unknown, pluginName: string): PluginLifecycleDecision {
  if (!value || typeof value !== "object") {
    throw new TypeError(`Plugin ${pluginName} returned an invalid lifecycle decision.`);
  }
  const record = value as Record<string, unknown>;
  const action = record.action;
  if (
    action !== "proceed"
    && action !== "refine"
    && action !== "pivot"
    && action !== "block"
    && action !== "unproven"
  ) {
    throw new TypeError(`Plugin ${pluginName} returned an invalid lifecycle decision.`);
  }
  if (record.reason !== undefined && typeof record.reason !== "string") {
    throw new TypeError(`Plugin ${pluginName} returned an invalid lifecycle reason.`);
  }
  const failures = record.failures;
  if (failures !== undefined && (!Array.isArray(failures) || failures.some((item) => typeof item !== "string"))) {
    throw new TypeError(`Plugin ${pluginName} returned invalid lifecycle failures.`);
  }
  return {
    action,
    ...(typeof record.reason === "string" && record.reason.trim()
      ? { reason: record.reason.trim() }
      : {}),
    ...(Array.isArray(failures) ? { failures: failures.slice() as string[] } : {}),
  };
}

function attributeDecision(
  pluginName: string,
  decision: PluginLifecycleDecision,
): AttributedPluginDecision {
  return { pluginName, ...decision };
}

function aggregateDecision<Extra extends object>(
  action: PluginDecisionAction,
  decisions: readonly AttributedPluginDecision[],
  extra?: Extra,
): PluginDecisionAggregate & Extra {
  return {
    action,
    decisions,
    failures: [...new Set(decisions.flatMap((decision) => decision.failures ?? []))],
    ...(extra ?? {} as Extra),
  };
}

function copyReplacementNode(node: WorkNode): WorkNode {
  return {
    ...node,
    dependsOn: [...node.dependsOn],
    fileOwnership: [...node.fileOwnership],
    ...(node.acceptanceCriteria ? { acceptanceCriteria: [...node.acceptanceCriteria] } : {}),
    evidenceRefs: [...node.evidenceRefs],
    artifactRefs: [...node.artifactRefs],
  };
}

const NonEmptyReplacementStringSchema = z.string().trim().min(1);
const ReplacementNodeSchema = z.object({
  id: NonEmptyReplacementStringSchema,
  title: NonEmptyReplacementStringSchema,
  prompt: NonEmptyReplacementStringSchema,
  status: z.enum(WORK_NODE_STATUSES),
  dependsOn: z.array(NonEmptyReplacementStringSchema),
  fileOwnership: z.array(NonEmptyReplacementStringSchema),
  manifestId: NonEmptyReplacementStringSchema.optional(),
  acceptanceCriteria: z.array(NonEmptyReplacementStringSchema).optional(),
  evidenceRefs: z.array(NonEmptyReplacementStringSchema),
  stage: z.enum(QUALITY_HARNESS_STAGES),
  role: z.enum(WORK_NODE_ROLES),
  attempt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  artifactRefs: z.array(NonEmptyReplacementStringSchema),
  reviewRequired: z.boolean(),
}).strict();

function parseReplacementNode(value: unknown, pluginName: string): WorkNode {
  const parsed = ReplacementNodeSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Plugin ${pluginName} returned an invalid replacement node.`);
  }
  const { manifestId, acceptanceCriteria, ...required } = parsed.data;
  return copyReplacementNode({
    ...required,
    ...(manifestId === undefined ? {} : { manifestId }),
    ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
  });
}

function validateReplacementNodeForDispatch(
  event: PluginBeforeNodeDispatchEvent,
  node: WorkNode,
): PluginLifecycleDecision {
  const nodeIndex = event.graph.nodes.findIndex((candidate) => candidate.id === event.node.id);
  if (nodeIndex < 0 || node.id !== event.node.id) {
    return {
      action: "block",
      reason: "A replacement node must preserve the approved graph node identity.",
      failures: ["REPLACEMENT_NODE_ID_MISMATCH"],
    };
  }
  const graph = {
    ...event.graph,
    nodes: event.graph.nodes.map((candidate, index) => index === nodeIndex ? node : candidate),
  };
  return validationDecision(validatePlan(planForCore(graph)));
}

function planForCore(graph: WorkGraph): {
  readonly nodes: readonly {
    readonly id: string;
    readonly acceptanceCriteria: readonly string[];
    readonly dependencies: readonly string[];
    readonly fileOwnership: readonly string[];
  }[];
} {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      acceptanceCriteria: node.acceptanceCriteria ?? [],
      dependencies: node.dependsOn,
      fileOwnership: node.fileOwnership,
    })),
  };
}

function validationDecision(result: { readonly valid: boolean; readonly issues: readonly { readonly code: string }[] }): PluginLifecycleDecision {
  const failures = result.issues.map((issue) => issue.code);
  return result.valid
    ? { action: "proceed" }
    : { action: "block", reason: "SCC quality validation failed.", failures };
}

/**
 * Registers the reviewed, compiled SCC core as an in-process built-in. This
 * path never discovers workspace code, starts SCC services, or writes SCC
 * state; external `.unclecode/plugins` remain governed by `loadFromDisk` trust.
 */
export function registerBuiltInSccQualityEngine(
  host: PluginHost,
  options: { readonly workspaceRoot: string; readonly env?: NodeJS.ProcessEnv },
): void {
  // Resolve once to reject a malformed host path without reading from it.
  resolve(options.workspaceRoot);
  host.registerBuiltIn("scc-quality-engine", {
    runClassified: (event) => {
      const classified = classifyQualityProfile({
        complexity: event.complexity,
        risk: event.risk,
        creatorIntent: event.creatorIntent,
      });
      return classified === event.proposedProfile
        ? { action: "proceed" }
        : {
            action: "block",
            reason: `SCC classified this run as ${classified}, not ${event.proposedProfile}.`,
            failures: ["QUALITY_PROFILE_MISMATCH"],
          };
    },
    planCreated: (event) => validationDecision(validatePlan(planForCore(event.graph))),
    beforeNodeDispatch: (event) => validationDecision(validatePlan(planForCore(event.graph))),
    afterNodeCompleted: (event) => ({
      action: evaluateGate({
        findings: event.findings,
        evidence: event.evidence,
        currentArtifactHash: event.artifactHash,
        producerId: event.producerId,
        // A worker artifact is evaluated before the guardian/critic exists.
        // Requiring reviewer evidence here would make every standard run stop
        // before it can reach the stage that produces that evidence; final
        // review is enforced by `beforeRunComplete` below.
        reviewRequired: false,
        independentProviderAvailable: event.independentProviderAvailable,
        independentReviewerAvailable: event.independentReviewerAvailable,
        refineCount: event.refineCount,
        pivotCount: event.pivotCount,
      }),
    }),
    beforeRunComplete: validateRunCompletionDecision,
    contextContribute: (event) => ({
      content: qualityStandards(event.profile, event.stage),
    }),
    evolutionProposed: (event) => validationDecision(
      validateEvolutionProposal(event.proposal, event.context),
    ),
  });
}

function validateRunCompletionDecision(
  event: PluginBeforeRunCompleteEvent,
): PluginLifecycleDecision {
  if (event.projection.profile === "creator") {
    const evolutionDecision = validateCreatorEvolutionCompletion(event.evolution);
    if (evolutionDecision !== undefined) return evolutionDecision;
  }
  const result = validateRunCompletion(
    event.projection,
    event.evidence,
    {
      currentArtifactHash: event.currentArtifactHash,
      producerId: event.producerId,
      independentReviewerAvailable: event.independentReviewerAvailable,
      ...(event.reviewRequired === undefined ? {} : { reviewRequired: event.reviewRequired }),
    },
  );
  if (result.valid) return { action: "proceed" };
  const failures = result.issues.map((issue) => issue.code);
  return {
    action: failures.includes("INDEPENDENT_REVIEW_UNAVAILABLE") ? "unproven" : "block",
    reason: "SCC run-completion validation failed.",
    failures,
  };
}

function validateCreatorEvolutionCompletion(
  evolution: PluginCreatorEvolutionCompletion | undefined,
): PluginLifecycleDecision | undefined {
  if (evolution === undefined) {
    return {
      action: "block",
      reason: "Creator completion requires a recorded isolated evolution proposal; this runtime has not produced one.",
      failures: ["CREATOR_EVOLUTION_LIFECYCLE_UNAVAILABLE"],
    };
  }
  if (!evolution.recorded) {
    return {
      action: "block",
      reason: "Creator evolution exists only as an unrecorded runtime claim.",
      failures: ["CREATOR_EVOLUTION_NOT_RECORDED"],
    };
  }
  if (evolution.stale || evolution.state === "stale") {
    return {
      action: "block",
      reason: "Creator evolution evidence is stale for the current candidate.",
      failures: ["CREATOR_EVOLUTION_STALE"],
    };
  }
  if (evolution.state !== "pr-ready") {
    return {
      action: "block",
      reason: `Creator evolution candidate is ${evolution.state}, not PR-ready.`,
      failures: ["CREATOR_EVOLUTION_NOT_PR_READY"],
    };
  }
  if (!evolution.proposal || !evolution.context) {
    return {
      action: "block",
      reason: "Creator evolution is marked PR-ready without its validated proposal evidence.",
      failures: ["CREATOR_EVOLUTION_EVIDENCE_MISSING"],
    };
  }
  const validation = validateEvolutionProposal(evolution.proposal, evolution.context);
  return validation.valid ? undefined : validationDecision(validation);
}

function qualityStandards(profile: QualityProfile, stage: QualityHarnessStage): string {
  const shared = `SCC Quality Engine (${profile}/${stage}): preserve acceptance criteria, bind evidence to the current artifact hash, and never let a worker approve its own output.`;
  if (profile === "minimal") return shared;
  if (profile === "creator") {
    return `${shared} Creator changes require isolated branch/worktree evidence, a distinct evaluator, a held-out benchmark, and pending human approval.`;
  }
  return `${shared} Completion requires a critic followed by a synthesis-only promote stage; unavailable independent review remains unproven.`;
}

export function discoverPluginNames(workspaceRoot: string): ReadonlyArray<string> {
  const dir = resolve(workspaceRoot, ".unclecode", "plugins");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".mjs") || name.endsWith(".js"))
    .map((name) => name.replace(/\.(ts|mjs|js)$/, ""));
}

const TRUST_FILE_RELATIVE = join(".unclecode", "trust.json");

export type TrustStore = { readonly trustedRoots: ReadonlyArray<string> };

export class PluginTrustError extends Error {
  readonly workspaceRoot: string;
  constructor(workspaceRoot: string) {
    super(
      `Workspace ${workspaceRoot} contains plugins under .unclecode/plugins but has not been granted trust. Run "unclecode trust grant" to enable plugin loading.`,
    );
    this.workspaceRoot = workspaceRoot;
    this.name = "PluginTrustError";
  }
}

export function getTrustStorePath(home: string = homedir()): string {
  return join(home, TRUST_FILE_RELATIVE);
}

function readTrustStore(home?: string): TrustStore {
  const path = getTrustStorePath(home);
  if (!existsSync(path)) return { trustedRoots: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { trustedRoots?: unknown };
    const roots = Array.isArray(parsed.trustedRoots)
      ? parsed.trustedRoots.filter((entry): entry is string => typeof entry === "string")
      : [];
    return { trustedRoots: roots };
  } catch {
    return { trustedRoots: [] };
  }
}

export function isWorkspaceTrusted(workspaceRoot: string, home?: string): boolean {
  const target = resolve(workspaceRoot);
  return readTrustStore(home).trustedRoots.includes(target);
}

export function listTrustedWorkspaces(home?: string): ReadonlyArray<string> {
  return readTrustStore(home).trustedRoots.slice();
}

export function recordWorkspaceTrust(workspaceRoot: string, home?: string): void {
  const target = resolve(workspaceRoot);
  const path = getTrustStorePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const current = readTrustStore(home);
  if (current.trustedRoots.includes(target)) return;
  const next = { trustedRoots: [...current.trustedRoots, target] };
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
}

export function revokeWorkspaceTrust(workspaceRoot: string, home?: string): void {
  const target = resolve(workspaceRoot);
  const current = readTrustStore(home);
  if (!current.trustedRoots.includes(target)) return;
  const path = getTrustStorePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const next = { trustedRoots: current.trustedRoots.filter((root) => root !== target) };
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
}
