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
import type {
  QualityHarnessStage,
  QualityProfile,
  WorkGraph,
  WorkNode,
  WorkNodeDispatchOutcome,
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
  toolExecuteBefore?: (event: { toolName: string; input: Record<string, unknown> }) => Promise<void> | void;
  toolExecuteAfter?: (event: { toolName: string; output: string; isError: boolean }) => Promise<void> | void;
  fileEdited?: (event: { path: string; sha256: string }) => Promise<void> | void;
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
};

export type PluginContext = {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  log(message: string): void;
};

export type PluginRegistration = {
  readonly name: string;
  readonly hooks: PluginHooks;
  readonly source: "memory" | "workspace" | "builtin";
};

export type PluginEntry = (ctx: PluginContext) => PluginHooks | Promise<PluginHooks>;

export class PluginHost {
  private readonly registrations: PluginRegistration[] = [];

  register(name: string, hooks: PluginHooks, source: PluginRegistration["source"] = "memory"): void {
    HookKeysSchema.parse(hooks);
    this.registrations.push({ name, hooks, source });
  }

  registerBuiltIn(name: string, hooks: PluginHooks): void {
    this.register(name, hooks, "builtin");
  }

  async loadEntries(workspaceRoot: string, entries: ReadonlyArray<{ name: string; entry: PluginEntry }>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    for (const { name, entry } of entries) {
      const log = (message: string) => process.stderr.write(`[plugin:${name}] ${message}\n`);
      const hooks = await entry({ workspaceRoot, env, log });
      this.register(name, hooks, "memory");
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
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(
      (name) => name.endsWith(".ts") || name.endsWith(".mjs") || name.endsWith(".js"),
    );
    if (files.length === 0) return [];
    if (requireTrust && !isWorkspaceTrusted(workspaceRoot, options.homeDir)) {
      throw new PluginTrustError(resolve(workspaceRoot));
    }
    const env = options.env ?? process.env;
    const loaded: string[] = [];
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
      const hooks = await entry({ workspaceRoot, env, log });
      this.register(name, hooks, "workspace");
      loaded.push(name);
    }
    return loaded;
  }

  list(): ReadonlyArray<PluginRegistration> {
    return this.registrations.slice();
  }

  async dispatchToolExecuteBefore(event: { toolName: string; input: Record<string, unknown> }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.toolExecuteBefore?.(event);
    }
  }

  async dispatchToolExecuteAfter(event: { toolName: string; output: string; isError: boolean }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.toolExecuteAfter?.(event);
    }
  }

  async dispatchFileEdited(event: { path: string; sha256: string }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.fileEdited?.(event);
    }
  }

  async dispatchSessionCompacted(event: { sessionId: string; messagesBefore: number; messagesAfter: number }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.sessionCompacted?.(event);
    }
  }

  async dispatchRunStarted(event: { runId: string; persona?: string }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.runStarted?.(event);
    }
  }

  async dispatchRunCompleted(event: { runId: string; status: string }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.runCompleted?.(event);
    }
  }

  async dispatchRunClassified(event: PluginRunClassifiedEvent): Promise<PluginDecisionAggregate> {
    return this.dispatchDecision(event, (hooks, value) => hooks.runClassified?.(value));
  }

  async dispatchPlanCreated(event: PluginPlanCreatedEvent): Promise<PluginDecisionAggregate> {
    return this.dispatchDecision(event, (hooks, value) => hooks.planCreated?.(value));
  }

  async dispatchBeforeNodeDispatch(
    event: PluginBeforeNodeDispatchEvent,
  ): Promise<PluginBeforeNodeDispatchAggregate> {
    let node = copyReplacementNode(event.node);
    const decisions: AttributedPluginDecision[] = [];
    let action: PluginDecisionAction = "proceed";
    let blocked = false;
    for (const reg of this.registrations) {
      const raw = await reg.hooks.beforeNodeDispatch?.({ ...event, node });
      if (raw === undefined) continue;
      const decision = parseDecision(raw, reg.name);
      decisions.push(attributeDecision(reg.name, decision));
      action = strongerDecision(action, decision.action);
      blocked ||= decision.action === "block";
      if (!blocked && decision.action === "proceed" && raw.replacementNode !== undefined) {
        node = parseReplacementNode(raw.replacementNode, reg.name);
      }
    }
    return aggregateDecision(action, decisions, { node });
  }

  async dispatchAfterNodeCompleted(event: PluginAfterNodeCompletedEvent): Promise<PluginDecisionAggregate> {
    return this.dispatchDecision(event, (hooks, value) => hooks.afterNodeCompleted?.(value));
  }

  async dispatchBeforeRunComplete(event: PluginBeforeRunCompleteEvent): Promise<PluginDecisionAggregate> {
    return this.dispatchDecision(event, (hooks, value) => hooks.beforeRunComplete?.(value));
  }

  async dispatchEvolutionProposed(event: PluginEvolutionProposedEvent): Promise<PluginDecisionAggregate> {
    return this.dispatchDecision(event, (hooks, value) => hooks.evolutionProposed?.(value));
  }

  async dispatchContextContribute(
    event: PluginContextContributeEvent,
  ): Promise<readonly AttributedPluginContextContribution[]> {
    const contributions: AttributedPluginContextContribution[] = [];
    let remaining = MAX_CONTEXT_CONTRIBUTION_TOTAL_CHARS;
    for (const reg of this.registrations) {
      if (remaining === 0) break;
      const raw = await reg.hooks.contextContribute?.(event);
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
    event: Event,
    invoke: (
      hooks: PluginHooks,
      event: Event,
    ) => PluginLifecycleDecision | void | Promise<PluginLifecycleDecision | void>,
  ): Promise<PluginDecisionAggregate> {
    const decisions: AttributedPluginDecision[] = [];
    let action: PluginDecisionAction = "proceed";
    for (const reg of this.registrations) {
      const raw = await invoke(reg.hooks, event);
      if (raw === undefined) continue;
      const decision = parseDecision(raw, reg.name);
      decisions.push(attributeDecision(reg.name, decision));
      action = strongerDecision(action, decision.action);
    }
    return aggregateDecision(action, decisions);
  }
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

function parseReplacementNode(value: unknown, pluginName: string): WorkNode {
  if (!value || typeof value !== "object") {
    throw new TypeError(`Plugin ${pluginName} returned an invalid replacement node.`);
  }
  const node = value as Partial<WorkNode>;
  if (
    typeof node.id !== "string"
    || !node.id.trim()
    || typeof node.title !== "string"
    || typeof node.prompt !== "string"
    || !Array.isArray(node.dependsOn)
    || !Array.isArray(node.fileOwnership)
    || !Array.isArray(node.evidenceRefs)
    || !Array.isArray(node.artifactRefs)
    || typeof node.attempt !== "number"
    || !Number.isSafeInteger(node.attempt)
    || node.attempt < 0
    || typeof node.reviewRequired !== "boolean"
  ) {
    throw new TypeError(`Plugin ${pluginName} returned an invalid replacement node.`);
  }
  return copyReplacementNode(node as WorkNode);
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
    beforeRunComplete: (event) => {
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
    },
    contextContribute: (event) => ({
      content: qualityStandards(event.profile, event.stage),
    }),
    evolutionProposed: (event) => validationDecision(
      validateEvolutionProposal(event.proposal, event.context),
    ),
  });
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
