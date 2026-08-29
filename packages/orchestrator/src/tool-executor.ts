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
import { runExecutionNonInterruptible } from "./execution-pause.js";
import { resolveOneShotShellApproval } from "./permission-scope.js";

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
const REJECT_LABEL = "Reject";

export type PolicyAwareToolExecutorInput = {
  readonly definitions: readonly ToolDefinition[];
  readonly handlers: Readonly<Record<string, ToolHandler>>;
  readonly policyProfile: ExecutionPolicyProfile | (() => ExecutionPolicyProfile);
  readonly runtimeMode: string | (() => string);
  readonly interactionBridge?: WorkShellInteractionBridge | undefined;
  readonly confirmationPolicy?: ToolConfirmationPolicy | (() => ToolConfirmationPolicy) | undefined;
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
  toolName: string,
  reason: string,
  signal: AbortSignal | undefined,
  actionDetail?: string | undefined,
): Promise<boolean> {
  if (bridge === undefined) {
    return false;
  }
    kind: "security-approval",
  const request: AskUserQuestionRequest = {
    id: `${CONFIRMATION_QUESTION_ID}:${toolName}`,
    title: "Execution policy confirmation",
    questions: [{
      id: CONFIRMATION_QUESTION_ID,
      question: `Allow ${toolName}? ${actionDetail ? `${actionDetail} ` : ""}${reason}`,
      options: [
        { label: APPROVE_LABEL, description: "Run this tool call once." },
        { label: REJECT_LABEL, description: "Refuse this tool call." },
      ],
      recommended: 1,
    }],
  };
  const result = await bridge.ask(request, signal);
  if (result.status !== "answered") {
    return false;
  }
  return result.answers.some(
    (answer) =>
      answer.id === CONFIRMATION_QUESTION_ID
      && answer.selectedOptions.includes(APPROVE_LABEL),
  );
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

      const profile = resolveProfile();
      const runtimeMode = resolveRuntimeMode();
      const { path, command } = request.input;
      const evaluations = await runExecutionNonInterruptible(
        "policy.evaluate",
        async () => capabilities.map((capability) =>
          evaluateExecutionPolicy(profile, {
            capability,
            runtimeMode,
            ...(typeof path === "string" && path.length > 0 ? { path } : {}),
            ...(typeof command === "string" && command.length > 0 ? { command } : {}),
          })
        ),
      );
      const denied = evaluations.find((evaluation) => evaluation.effect === "deny");
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
        const confirmed = await runExecutionNonInterruptible(
          "approval.wait",
          () => isConfirmed(
            input.interactionBridge,
            oneShotShellApproval?.scope.label ?? request.toolName,
            reason,
            request.signal,
            oneShotShellApproval?.scope.detail,
          ),
        );
        if (!confirmed) {
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
