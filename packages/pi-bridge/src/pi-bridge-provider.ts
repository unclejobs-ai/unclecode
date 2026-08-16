import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context as PiContext,
  Message as PiMessage,
  Model,
  Models,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
  AgentTurnResult,
  LlmProvider,
  ProviderInputAttachment,
  ProviderName,
  ProviderQueryAction,
  ProviderQueryMessage,
  ProviderQueryOptions,
  ProviderQueryResult,
  ProviderTraceListener,
  ProviderTurnOptions,
  RuntimeReasoningConfig,
  ToolRuntime,
} from "@unclecode/providers";
import {
  createToolResultMessage,
  isPiToolCall,
  mapQueryMessagesToPi,
  piAssistantText,
  toPiImageContent,
  toPiTools,
} from "./pi-message-map.js";
import {
  getSharedPiModels,
  resolvePiModel,
  toPiThinkingLevel,
} from "./pi-model.js";

export type PiBridgeStreamFn = (
  model: Model<Api>,
  context: PiContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type CreatePiBridgeProviderArgs = {
  readonly provider: ProviderName;
  readonly apiKey: string;
  readonly model: string;
  readonly cwd: string;
  readonly reasoning: RuntimeReasoningConfig;
  readonly baseUrl?: string | undefined;
  readonly systemPrompt?: string;
  readonly toolRuntime?: ToolRuntime;
  readonly piProvider?: string;
  readonly models?: Models;
  readonly piModel?: Model<Api>;
  readonly streamFn?: PiBridgeStreamFn;
  readonly toolLoopMax?: number;
  readonly costLimitUsd?: number;
};

const DEFAULT_TOOL_LOOP_MAX = 64;

function resolveToolLoopMax(env: NodeJS.ProcessEnv): number {
  const raw = env.UNCLECODE_PI_BRIDGE_TOOL_LOOP_MAX;
  if (!raw) return DEFAULT_TOOL_LOOP_MAX;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_LOOP_MAX;
}

function addCodexHostedWebSearchTool(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return payload;
  }
  const request = payload as Record<string, unknown>;
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const alreadyIncluded = tools.some(
    (tool) =>
      typeof tool === "object"
      && tool !== null
      && !Array.isArray(tool)
      && (tool as Record<string, unknown>).type === "web_search",
  );
  return alreadyIncluded
    ? payload
    : { ...request, tools: [...tools, { type: "web_search" }] };
}

class PiBridgeProvider implements LlmProvider {
  private history: PiMessage[] = [];
  private piModel: Model<Api>;
  private reasoning: RuntimeReasoningConfig;
  private apiKey: string;
  private traceListener: ProviderTraceListener | undefined;
  private readonly toolLoopMax: number;
  private readonly costLimitUsd: number | undefined;

  constructor(private readonly args: CreatePiBridgeProviderArgs) {
    this.piModel = args.piModel
      ?? resolvePiModel(args.provider, args.model, args.models, args.piProvider, args.baseUrl);
    this.reasoning = args.reasoning;
    this.apiKey = args.apiKey;
    this.toolLoopMax = args.toolLoopMax ?? resolveToolLoopMax(process.env);
    this.costLimitUsd = args.costLimitUsd;
    if (!Number.isSafeInteger(this.toolLoopMax) || this.toolLoopMax <= 0) {
      throw new Error("pi-bridge: toolLoopMax must be a positive integer.");
    }
    if (
      this.costLimitUsd !== undefined
      && (!Number.isFinite(this.costLimitUsd) || this.costLimitUsd <= 0)
    ) {
      throw new Error("pi-bridge: costLimitUsd must be a positive finite number.");
    }
  }

  async runTurn(
    prompt: string,
    attachments: readonly ProviderInputAttachment[] = [],
    options: ProviderTurnOptions = {},
  ): Promise<AgentTurnResult> {
    const historyLength = this.history.length;
    let steps = 0;
    let costUsd = 0;
    const userContent: PiMessage = {
      role: "user",
      content:
        attachments.length > 0
          ? [
              { type: "text", text: prompt },
              ...attachments.map((attachment) => toPiImageContent(attachment)),
            ]
          : prompt,
      timestamp: Date.now(),
    };
    this.history.push(userContent);

    try {
      for (;;) {
        if (steps >= this.toolLoopMax) {
          throw new Error(`pi-bridge: step limit of ${this.toolLoopMax} exceeded.`);
        }
        const assistant = await this.streamOnce(this.history, options.signal, true);
        steps += 1;
        costUsd += assistant.usage.cost.total;
        if (this.costLimitUsd !== undefined && costUsd > this.costLimitUsd) {
          throw new Error(`pi-bridge: cost limit of $${this.costLimitUsd} exceeded.`);
        }
        this.history.push(assistant);
        const toolCalls = assistant.content.filter(isPiToolCall);
        if (toolCalls.length === 0) {
          return { text: piAssistantText(assistant), steps, costUsd };
        }
        for (const call of toolCalls) {
          const startedAt = Date.now();
          this.traceListener?.({
            type: "tool.started",
            level: "default",
            provider: this.args.provider,
            toolName: call.name,
            toolCallId: call.id,
            input: call.arguments,
            startedAt,
          });
          const executor = this.args.toolRuntime?.executor;
          let result: { readonly content: string; readonly isError?: boolean };
          if (!executor) {
            result = {
              isError: true,
              content: `pi-bridge: no tool runtime registered for tool "${call.name}".`,
            };
          } else {
            try {
              result = await executor.execute({
                toolName: call.name,
                input: call.arguments,
                cwd: this.args.cwd,
                signal: options.signal,
              });
            } catch (error) {
              if (
                options.signal?.aborted
                || (error instanceof Error && error.name === "AbortError")
              ) {
                throw error;
              }
              result = {
                isError: true,
                content: error instanceof Error ? error.message : String(error),
              };
            }
          }
          this.traceListener?.({
            type: "tool.completed",
            level: "default",
            provider: this.args.provider,
            toolName: call.name,
            toolCallId: call.id,
            input: call.arguments,
            isError: result.isError ?? false,
            output: result.content,
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          });
          this.history.push(
            createToolResultMessage(call, result.content, result.isError ?? false),
          );
        }
      }
    } catch (error) {
      this.history.length = historyLength;
      throw error;
    }
  }

  async query(
    messages: ReadonlyArray<ProviderQueryMessage>,
    options: ProviderQueryOptions = {},
  ): Promise<ProviderQueryResult> {
    const model = options.model
      ? resolvePiModel(
          this.args.provider,
          options.model,
          this.args.models,
          this.args.piProvider,
          this.args.baseUrl,
        )
      : this.piModel;
    const mapped = mapQueryMessagesToPi(messages, model);
    const reasoning = options.reasoning ?? this.reasoning;
    const assistant = await this.streamWith(model, mapped.messages, {
      signal: undefined,
      systemPrompt: mapped.systemPrompt,
      tools: options.tools ? toPiTools(options.tools) : undefined,
      reasoning,
      trace: false,
    });
    const actions: ProviderQueryAction[] = assistant.content
      .filter(isPiToolCall)
      .map((call) => ({ callId: call.id, tool: call.name, input: call.arguments }));
    return {
      content: piAssistantText(assistant),
      actions,
      costUsd: assistant.usage.cost.total,
    };
  }

  clear(): void {
    this.history = [];
  }

  updateRuntimeSettings(settings: {
    reasoning?: RuntimeReasoningConfig | undefined;
    model?: string | undefined;
  }): void {
    if (settings.reasoning) {
      this.reasoning = settings.reasoning;
    }
    if (settings.model && settings.model !== this.piModel.id) {
      this.piModel = resolvePiModel(
        this.args.provider,
        settings.model,
        this.args.models,
        this.args.piProvider,
        this.args.baseUrl,
      );
    }
  }

  updateAuthToken(apiKey: string): void {
    this.apiKey = apiKey;
  }

  setTraceListener(listener?: ProviderTraceListener): void {
    this.traceListener = listener;
  }

  private streamOnce(
    messages: readonly PiMessage[],
    signal: AbortSignal | undefined,
    trace: boolean,
  ): Promise<AssistantMessage> {
    return this.streamWith(this.piModel, messages, {
      signal,
      systemPrompt: this.args.systemPrompt,
      tools: this.args.toolRuntime ? toPiTools(this.args.toolRuntime.definitions) : undefined,
      reasoning: this.reasoning,
      trace,
    });
  }

  private async streamWith(
    model: Model<Api>,
    messages: readonly PiMessage[],
    input: {
      signal: AbortSignal | undefined;
      systemPrompt: string | undefined;
      tools: ReturnType<typeof toPiTools> | undefined;
      reasoning: RuntimeReasoningConfig;
      trace: boolean;
    },
  ): Promise<AssistantMessage> {
    const hostedWebSearch =
      model.api === "openai-codex-responses"
      && input.tools?.some((tool) => tool.name === "web_search") === true;
    const requestTools = hostedWebSearch
      ? input.tools?.filter((tool) => tool.name !== "web_search")
      : input.tools;
    const context: PiContext = { messages: [...messages] };
    if (input.systemPrompt) context.systemPrompt = input.systemPrompt;
    if (requestTools && requestTools.length > 0) context.tools = requestTools;

    const options: SimpleStreamOptions = {};
    if (this.apiKey) options.apiKey = this.apiKey;
    if (input.signal) options.signal = input.signal;
    if (hostedWebSearch) options.onPayload = addCodexHostedWebSearchTool;
    const thinking = toPiThinkingLevel(model, input.reasoning);
    if (thinking && thinking !== "off") {
      options.reasoning = thinking;
    }

    const streamFn = this.args.streamFn ?? this.defaultStreamFn();
    const stream = streamFn(model, context, options);

    if (input.trace) {
      for await (const event of stream) {
        if (event.type === "text_delta") {
          this.traceListener?.({
            type: "assistant.delta",
            level: "default",
            provider: this.args.provider,
            model: model.id,
            itemId: `pi-text-${event.contentIndex}`,
            delta: event.delta,
          });
        } else if (event.type === "thinking_delta") {
          this.traceListener?.({
            type: "reasoning.delta",
            level: "default",
            provider: this.args.provider,
            model: model.id,
            kind: "text",
            itemId: `pi-thinking-${event.contentIndex}`,
            delta: event.delta,
          });
        }
      }
      return assertPiStreamSucceeded(await stream.result());
    }

    return assertPiStreamSucceeded(await stream.result());
  }

  private defaultStreamFn(): PiBridgeStreamFn {
    const models = this.args.models ?? getSharedPiModels();
    return (model, context, options) => models.streamSimple(model, context, options);
  }
}

function assertPiStreamSucceeded(message: AssistantMessage): AssistantMessage {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(
      `pi-bridge: pi-ai stream failed (${message.stopReason}): ${message.errorMessage ?? "no error message"}`,
    );
  }
  return message;
}

export function createPiBridgeProvider(args: CreatePiBridgeProviderArgs): LlmProvider {
  return new PiBridgeProvider(args);
}
