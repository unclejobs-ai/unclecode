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
import { toolDefinitions, toolHandlers } from "./tools.js";
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
};

const toolRuntime = {
  definitions: toolDefinitions,
  handlers: toolHandlers,
} as const;

export class RuntimeCodingAgent
  extends BaseCodingAgent<
    ProviderInputAttachment,
    AppReasoningConfig,
    ProviderToolTraceEvent
  >
  implements WorkTurnAgent
{
  private readonly runtimeProvider: RuntimeProvider;

  constructor(
    args: RuntimeProviderArgs & {
      providerOverride?: RuntimeProvider;
    },
  ) {
    const runtimeProvider = args.providerOverride ?? createRuntimeProvider({
      ...args,
      toolRuntime,
    });
    super({
      providerName: args.provider === "openai" ? "openai-api" : args.provider,
      model: args.model,
      provider: runtimeProvider,
    });
    this.runtimeProvider = runtimeProvider;
  }

  refreshAuthToken(apiKey: string): void {
    this.runtimeProvider.updateAuthToken?.(apiKey);
  }
}

export async function createRuntimeCodingAgent(
  args: RuntimeProviderArgs & {
    providerOverride?: RuntimeProvider;
  },
): Promise<RuntimeCodingAgent> {
  return new RuntimeCodingAgent(args);
}
