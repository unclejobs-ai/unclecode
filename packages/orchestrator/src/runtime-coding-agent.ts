import type { ExecutionTraceEvent } from "@unclecode/contracts";
import {
  createRuntimeProvider,
  type LlmProvider,
  type ProviderInputAttachment,
  type ProviderName,
  type ProviderToolTraceEvent,
} from "@unclecode/providers";

import {
  CodingAgent as BaseCodingAgent,
  type CodingAgentTraceEvent,
  type TurnAgent,
} from "./coding-agent.js";
import { createToolRuntime } from "./tools.js";
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
  interactionBridge?: WorkShellInteractionBridge;
};

export type RuntimeCodingAgentOptions = RuntimeProviderArgs & {
  providerOverride?: RuntimeProvider;
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

  constructor(args: RuntimeCodingAgentOptions) {
    const interactionBridge = args.interactionBridge ?? createWorkShellInteractionBridge();
    const runtimeProvider = args.providerOverride ?? createRuntimeProvider({
      provider: args.provider,
      apiKey: args.apiKey,
      model: args.model,
      cwd: args.cwd,
      reasoning: args.reasoning,
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
      ...(args.openAIRuntime ? { openAIRuntime: args.openAIRuntime } : {}),
      ...(args.openAIAccountId !== undefined ? { openAIAccountId: args.openAIAccountId } : {}),
      toolRuntime: createToolRuntime({
        interactionBridge,
        webSearch: {
          provider: args.provider,
          apiKey: args.apiKey,
          model: args.model,
          ...(args.openAIRuntime ? { openAIRuntime: args.openAIRuntime } : {}),
        },
      }),
    });
    super({
      providerName: args.provider,
      model: args.model,
      provider: runtimeProvider,
    });
    this.runtimeProvider = runtimeProvider;
    this.interactionBridge = interactionBridge;
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
