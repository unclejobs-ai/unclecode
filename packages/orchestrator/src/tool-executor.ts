import { randomUUID } from "node:crypto";

import type {
  AskUserQuestionRequest,
  ExecutionPolicyCapability,
  ExecutionPolicyProfile,
  ExecutionPolicyRule,
  ToolDeclaredResource,
} from "@unclecode/contracts";
import {
  evaluateExecutionPolicy,
  resolveToolConfirmationDecision,
  type ToolConfirmationPolicy,
} from "@unclecode/policy-engine";

import type {
  ToolDefinition,
  ToolHandler,
  ToolResult,
} from "./tools.js";
import type { WorkShellInteractionBridge } from "./work-shell-interaction-bridge.js";
import {
  checkpointExecutionPause,
  runExecutionNonInterruptible,
} from "./execution-pause.js";
import {
  createCanonicalPermissionRule,
  createCanonicalPermissionRuleStore,
  matchesCanonicalPermissionRule,
  resolveCanonicalPermissionScope,
  resolveOneShotShellApproval,
  type CanonicalPermissionRule,
  type CanonicalPermissionScope,
  type CanonicalPermissionRuleStore,
} from "./permission-scope.js";

/**
 * The single request shape every provider and Pi loop uses to reach a tool.
 * Structurally identical to `@unclecode/providers`' `ToolExecutionRequest`.
 */
export type ToolExecutionRequest = {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
};

export type ToolExecutor = {
  execute(request: ToolExecutionRequest): Promise<ToolResult>;
};

/**
 * Raw name -> handler registration. Internal only: AST, LSP, and the built-in
 * ACI tools register here, and the registry is never handed to a model loop.
 * Every public surface exposes {@link ToolExecutor} instead.
 */
export type ToolRegistry = {
  readonly definitions: readonly ToolDefinition[];
  readonly handlers: Readonly<Record<string, ToolHandler>>;
};

/**
 * Modes that are an explicit full-autonomy opt-in: the operator already chose
 * to let the agent open files and run builds without a per-call gate.
 */
const SHELL_AUTONOMY_MODES: Record<string, true> = {
  yolo: true,
  ultrawork: true,
};

/**
 * Resolves the execution policy profile for one agent instance. Shell access
 * is the only capability the runtime mode changes; everything else stays on
 * the profile default so tool behaviour is unchanged.
 */
export function resolveModeExecutionPolicyProfile(input: {
  readonly mode: string;
  readonly envShellOptIn: boolean;
}): ExecutionPolicyProfile {
  const autonomyMode = SHELL_AUTONOMY_MODES[input.mode] === true;
  const shellRule: ExecutionPolicyRule = autonomyMode || input.envShellOptIn
    ? {
      id: "unclecode.runtime.shell.granted",
      capability: "shell.run",
      effect: "allow",
      reason: autonomyMode
        ? `Shell execution is granted by the ${input.mode} autonomy mode.`
        : "Shell execution is granted by the explicit UNCLECODE_ALLOW_RUN_SHELL=1 opt-in.",
    }
    : {
      id: "unclecode.runtime.shell.denied",
      capability: "shell.run",
      effect: "deny",
      reason:
        "run_shell is disabled by default. Use yolo or ultrawork mode, or set UNCLECODE_ALLOW_RUN_SHELL=1 to enable it.",
    };

  return {
    id: `unclecode.runtime.${input.mode}`,
    mode: "enforce",
    defaultEffect: "allow",
    rules: [shellRule],
  };
}

export const CONFIRMATION_QUESTION_ID = "policy-confirmation";
const APPROVE_LABEL = "Approve";
const ALWAYS_APPROVE_LABEL = "Always allow";
const REJECT_LABEL = "Reject";

export type PolicyAwareToolExecutorInput = {
  readonly definitions: readonly ToolDefinition[];
  readonly handlers: Readonly<Record<string, ToolHandler>>;
  readonly policyProfile: ExecutionPolicyProfile | (() => ExecutionPolicyProfile);
  readonly runtimeMode: string | (() => string);
  readonly interactionBridge?: WorkShellInteractionBridge | undefined;
  readonly confirmationPolicy?: ToolConfirmationPolicy | (() => ToolConfirmationPolicy) | undefined;
  readonly permissionRuleStore?: CanonicalPermissionRuleStore | undefined;
};

/**
 * Derives every execution capability guarded by a tool's declared resources.
 * Missing or unsupported metadata fails closed before policy evaluation.
 */
export function deriveToolCapabilities(
  definition: ToolDefinition | undefined,
): readonly ExecutionPolicyCapability[] | undefined {
  const resources = definition?.metadata?.resources;
  if (resources === undefined || resources.length === 0) {
    return undefined;
  }
  const capabilities = new Set<ExecutionPolicyCapability>();
  for (const resource of resources) {
    const capability = deriveResourceCapability(resource);
    if (capability === undefined) {
      return undefined;
    }
    capabilities.add(capability);
  }
  return [...capabilities];
}

function deriveResourceCapability(
  resource: ToolDeclaredResource,
): ExecutionPolicyCapability | undefined {
  if (resource.kind === "network") {
    return "network.egress";
  }
  switch (resource.mode) {
    case "execute":
      return "shell.run";
    case "write":
    case "delete":
      return "filesystem.write";
    case "read":
      return "filesystem.read";
    default:
      return undefined;
  }
}

function refuse(content: string): ToolResult {
  return { isError: true, content };
}

async function isConfirmed(
  bridge: WorkShellInteractionBridge | undefined,
  requestInput: ToolExecutionRequest,
  reason: string,
  signal: AbortSignal | undefined,
  options: {
    readonly scope?: CanonicalPermissionScope | undefined;
    readonly oneShotOnly?: boolean | undefined;
  } = {},
): Promise<"once" | "always" | "rejected"> {
  if (bridge === undefined) {
    return "rejected";
  }
  const scope = options.scope ?? resolveCanonicalPermissionScope(requestInput);
  const approvalOptions = options.oneShotOnly
    ? [
        { label: APPROVE_LABEL, description: "Run this specific tool call once." },
        { label: REJECT_LABEL, description: "Refuse this tool call." },
      ]
    : [
        { label: APPROVE_LABEL, description: "Run this tool call once." },
        { label: ALWAYS_APPROVE_LABEL, description: `Persist exactly this scope: ${scope.key}.` },
        { label: REJECT_LABEL, description: "Refuse this tool call." },
      ];
  const request: AskUserQuestionRequest = {
    kind: "security-approval",
    id: `${CONFIRMATION_QUESTION_ID}:${randomUUID()}`,
    title: `Security approval · ${scope.label}`,
    questions: [{
      id: CONFIRMATION_QUESTION_ID,
      question: `Allow ${scope.label}? ${scope.detail} ${reason}`,
      options: approvalOptions,
      recommended: options.oneShotOnly ? 0 : 1,
    }],
  };
  const result = await bridge.ask(request, signal);
  if (result.status !== "answered") {
    return "rejected";
  }
  const answer = result.answers.find((candidate) => candidate.id === CONFIRMATION_QUESTION_ID);
  if (!options.oneShotOnly && answer?.selectedOptions.includes(ALWAYS_APPROVE_LABEL)) return "always";
  if (answer?.selectedOptions.includes(APPROVE_LABEL)) return "once";
  return "rejected";
}

type ApprovalResolution = "once" | "always" | "rejected";

type PendingApproval = {
  readonly settled: Promise<ApprovalResolution>;
};

/**
 * Waiters observe that the current owner settled, but never inherit its
 * one-shot answer. An abort only detaches this waiter; it cannot cancel the
 * prompt owner or leave an abort listener behind.
 */
function waitForApprovalOwner(
  approval: PendingApproval,
  signal: AbortSignal | undefined,
): Promise<"settled" | "aborted"> {
  if (signal?.aborted) return Promise.resolve("aborted");
  if (signal === undefined) return approval.settled.then(() => "settled");
  return new Promise((resolve) => {
    let completed = false;
    const finish = (result: "settled" | "aborted") => {
      if (completed) return;
      completed = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    void approval.settled.then(() => finish("settled"), () => finish("settled"));
  });
}

/**
 * Wraps a raw tool registry so every call is evaluated against the canonical
 * execution policy first. Denied and unconfirmed calls return an error result
 * and never reach the underlying handler.
 */
export function createPolicyAwareToolExecutor(
  input: PolicyAwareToolExecutorInput,
): ToolExecutor {
  const definitions = new Map(input.definitions.map((definition) => [definition.name, definition]));
  const resolveProfile = typeof input.policyProfile === "function"
    ? input.policyProfile
    : () => input.policyProfile as ExecutionPolicyProfile;
  const resolveRuntimeMode = typeof input.runtimeMode === "function"
    ? input.runtimeMode
    : () => input.runtimeMode as string;
  // The executor has session lifetime. Rules are keyed by the same canonical
  // scope shown in the approval card, and an in-flight prompt is shared so two
  // simultaneous calls cannot surface duplicate cards for one scope.
  const permissionRules = input.permissionRuleStore ?? createCanonicalPermissionRuleStore();
  const pendingApprovals = new Map<string, PendingApproval>();

  return {
    async execute(request: ToolExecutionRequest): Promise<ToolResult> {
      const handler = input.handlers[request.toolName];
      if (handler === undefined) {
        return refuse(`${request.toolName} is not a registered tool.`);
      }

      const definition = definitions.get(request.toolName);
      const capabilities = deriveToolCapabilities(definition);
      if (capabilities === undefined) {
        return refuse(
          `${request.toolName} declares no usable resource metadata, so execution policy cannot authorize it.`,
        );
      }

      await checkpointExecutionPause("before_policy");
      const profile = resolveProfile();
      const runtimeMode = resolveRuntimeMode();
      const { path, command } = request.input;
      const evaluations = capabilities.map((capability) =>
        evaluateExecutionPolicy(profile, {
          capability,
          runtimeMode,
          ...(typeof path === "string" && path.length > 0 ? { path } : {}),
          ...(typeof command === "string" && command.length > 0 ? { command } : {}),
        })
      );
      const denied = evaluations.find((evaluation) => evaluation.effect === "deny");
      await checkpointExecutionPause("after_policy");
      if (denied !== undefined) {
        return refuse(`${request.toolName} blocked by execution policy: ${denied.reason}`);
      }

      const oneShotShellApproval = resolveOneShotShellApproval(request);

      const explicitCapabilityGrant = evaluations.every(
        (evaluation) =>
          evaluation.effect === "allow"
          && evaluation.matchedRule !== `${profile.id}.${evaluation.capability}.default`,
      );
      const confirmationPolicy = oneShotShellApproval
        ? "risky"
        : input.confirmationPolicy === undefined
          ? SHELL_AUTONOMY_MODES[runtimeMode] === true || explicitCapabilityGrant
            ? "never"
            : "risky"
          : typeof input.confirmationPolicy === "function"
            ? input.confirmationPolicy()
            : input.confirmationPolicy;
      const confirmation = oneShotShellApproval
        ? {
            effect: "prompt" as const,
            reason: `${oneShotShellApproval.scope.label} requires fresh one-shot confirmation.`,
          }
        : resolveToolConfirmationDecision({
            toolName: request.toolName,
            metadata: definition?.metadata,
            policy: confirmationPolicy,
          });
      const promptReasons = [
        ...evaluations
          .filter((evaluation) => evaluation.effect === "prompt")
          .map((evaluation) => evaluation.reason),
        ...(confirmation.effect === "prompt" ? [confirmation.reason] : []),
      ];
      if (promptReasons.length > 0) {
        const reason = [...new Set(promptReasons)].join(" ");
        const scope = oneShotShellApproval?.scope ?? resolveCanonicalPermissionScope(request);
        const oneShotOnly = oneShotShellApproval !== undefined;
        let confirmation: ApprovalResolution = "rejected";
        while (!request.signal?.aborted) {
          const alreadyAllowed = !oneShotOnly && permissionRules.list().some((rule) =>
            matchesCanonicalPermissionRule(rule, request)
          );
          if (alreadyAllowed) {
            confirmation = "always";
            break;
          }

          const active = pendingApprovals.get(scope.key);
          if (active !== undefined) {
            const waitResult = await waitForApprovalOwner(active, request.signal);
            if (waitResult === "aborted") break;
            // `always` is now visible in the store. Every other answer belongs
            // only to the prompt owner, so this waiter competes to own a fresh
            // prompt rather than consuming a stale one-shot decision.
            continue;
          }

          let settle!: (resolution: ApprovalResolution) => void;
          const owned: PendingApproval = {
            settled: new Promise((resolve) => { settle = resolve; }),
          };
          pendingApprovals.set(scope.key, owned);
          try {
            await checkpointExecutionPause("before_approval");
            confirmation = await isConfirmed(
              input.interactionBridge,
              request,
              reason,
              request.signal,
              { scope, oneShotOnly },
            );
            await checkpointExecutionPause("after_approval");
            if (!oneShotOnly && confirmation === "always" && !request.signal?.aborted) {
              permissionRules.add(createCanonicalPermissionRule(scope));
            }
          } catch {
            confirmation = "rejected";
          } finally {
            if (pendingApprovals.get(scope.key) === owned) pendingApprovals.delete(scope.key);
            settle(confirmation);
          }
          break;
        }
        // A resolution arriving after cancellation is stale and cannot start
        // the action, even when another call persisted the same rule.
        if (request.signal?.aborted || confirmation === "rejected") {
          return refuse(
            `${request.toolName} requires confirmation that was not granted: ${reason}`,
          );
        }
      }

      return await runExecutionNonInterruptible(
        "tool.dispatch",
        () => handler(
          request.input,
          request.cwd,
          request.signal ? { signal: request.signal } : {},
        ),
      );
    },
  };
}
