import type { ExecutionPolicyProfile, ExecutionTraceEvent } from "@unclecode/contracts";
import {
  createRuntimeProvider,
  type LlmProvider,
  type ProviderInputAttachment,
  type ProviderName,
  type ProviderToolTraceEvent,
  type ToolRuntime,
} from "@unclecode/providers";

import {
  CodingAgent as BaseCodingAgent,
  type CodingAgentTraceEvent,
  type TurnAgent,
} from "./coding-agent.js";
import { createToolRuntime } from "./tools.js";
import { resolveModeExecutionPolicyProfile } from "./tool-executor.js";
import {
  createWorkShellInteractionBridge,
  type WorkShellInteractionBridge,
} from "./work-shell-interaction-bridge.js";
import type { AppReasoningConfig } from "./work-config.js";

export type AgentTraceEvent =
  | CodingAgentTraceEvent<ProviderToolTraceEvent>
  | Extract<ExecutionTraceEvent, { type: "orchestrator.step" }>;

export interface WorkTurnAgent
  extends TurnAgent<ProviderInputAttachment, AppReasoningConfig, AgentTraceEvent> {}

type RuntimeProvider = LlmProvider & {
  updateAuthToken?(apiKey: string): void;
};

type RuntimeProviderArgs = {
  provider: ProviderName;
  apiKey: string;
  model: string;
  cwd: string;
  reasoning: AppReasoningConfig;
  systemPrompt?: string;
  openAIRuntime?: "api" | "codex";
  openAIAccountId?: string | null;
  baseUrl?: string;
  interactionBridge?: WorkShellInteractionBridge;
  mode?: string;
};

export type RuntimeCodingAgentOptions = RuntimeProviderArgs & {
  /** Quality critic/promote capability boundary: advertise and execute no tools. */
  toolAccess?: "full" | "none";
  providerOverride?: RuntimeProvider;
  /**
   * Builds the LLM provider with access to the agent's tool runtime. Used by
   * alternate engines (e.g. the pi-mono bridge) that execute tool calls inside
   * the provider's own turn loop.
   */
  providerOverrideFactory?: (context: { toolRuntime: ToolRuntime }) => RuntimeProvider;
};

const READ_ONLY_QUALITY_TOOL_RUNTIME: ToolRuntime = {
  definitions: [],
  executor: {
    async execute() {
      return {
        isError: true,
        content: "Quality review is read-only; tools are unavailable.",
      };
    },
  },
};

export class RuntimeCodingAgent
  extends BaseCodingAgent<
    ProviderInputAttachment,
    AppReasoningConfig,
    ProviderToolTraceEvent
  >
  implements WorkTurnAgent
{
  private readonly runtimeProvider: RuntimeProvider;
  private readonly interactionBridge: WorkShellInteractionBridge;
  // The explicit env opt-in is read once, at construction. The runtime never
  // assigns or deletes UNCLECODE_ALLOW_RUN_SHELL.
  private readonly envShellOptIn: boolean;
  // Mutable box so the tool executor always reads the live profile after
  // updateMode() without rebuilding the runtime or the provider.
  private readonly policyProfile: { current: ExecutionPolicyProfile };
  private readonly runtimeMode: { current: string };

  constructor(args: RuntimeCodingAgentOptions) {
    const interactionBridge = args.interactionBridge ?? createWorkShellInteractionBridge();
    const envShellOptIn = process.env.UNCLECODE_ALLOW_RUN_SHELL === "1";
    // `profileRef` lets the executor read the live instance profile after
    // updateMode() without rebuilding the tool runtime or the provider.
    const modeRef = { current: args.mode ?? "default" };
    const profileRef = {
      current: resolveModeExecutionPolicyProfile({ mode: modeRef.current, envShellOptIn }),
    };
    const toolRuntime = args.toolAccess === "none"
      ? READ_ONLY_QUALITY_TOOL_RUNTIME
      : createToolRuntime({
          interactionBridge,
          policyProfile: () => profileRef.current,
          runtimeMode: () => modeRef.current,
          ...(args.provider === "deepseek"
            ? {}
            : {
                webSearch: {
                  provider: args.provider,
                  apiKey: args.apiKey,
                  model: args.model,
                  ...(args.openAIRuntime ? { openAIRuntime: args.openAIRuntime } : {}),
                },
              }),
        });
    const runtimeProvider = args.providerOverride
      ?? args.providerOverrideFactory?.({ toolRuntime })
      ?? createRuntimeProvider({
        provider: args.provider,
        apiKey: args.apiKey,
        model: args.model,
        cwd: args.cwd,
        reasoning: args.reasoning,
        ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
        ...(args.openAIRuntime ? { openAIRuntime: args.openAIRuntime } : {}),
        ...(args.openAIAccountId !== undefined ? { openAIAccountId: args.openAIAccountId } : {}),
        ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
        toolRuntime,
      });
    super({
      providerName: args.provider,
      model: args.model,
      provider: runtimeProvider,
    });
    this.runtimeProvider = runtimeProvider;
    this.interactionBridge = interactionBridge;
    this.envShellOptIn = envShellOptIn;
    this.policyProfile = profileRef;
    this.runtimeMode = modeRef;
  }

  updateMode(mode: string): void {
    this.runtimeMode.current = mode;
    this.policyProfile.current = resolveModeExecutionPolicyProfile({
      mode,
      envShellOptIn: this.envShellOptIn,
    });
  }

  getExecutionPolicyProfile(): ExecutionPolicyProfile {
    return this.policyProfile.current;
  }

  refreshAuthToken(apiKey: string): void {
    this.runtimeProvider.updateAuthToken?.(apiKey);
  }

  getInteractionBridge(): WorkShellInteractionBridge {
    return this.interactionBridge;
  }
}


export async function createRuntimeCodingAgent(
  args: RuntimeCodingAgentOptions,
): Promise<RuntimeCodingAgent> {
  return new RuntimeCodingAgent(args);
}
