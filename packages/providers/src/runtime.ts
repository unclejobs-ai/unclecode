import { createHash } from "node:crypto";

import type {
  ClipboardImageAttachment,
  ExecutionTraceEvent,
  ModeReasoningEffort,
  ToolMetadata,
} from "@unclecode/contracts";

import { estimateCostUsd } from "./model-pricing.js";
import { runRustCommand, runRustCommandSync } from "./rust-command.js";
import type { ReasoningSupport } from "./types.js";

/**
 * Canonical provider usage. Input buckets are disjoint: `inputTokens` excludes
 * tokens reported in `cacheReadTokens` and `cacheWriteTokens`.
 */
export type ProviderTokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
};

export type AgentTurnResult = {
  text: string;
  steps?: number;
  costUsd?: number;
  usage?: ProviderTokenUsage;
};

export type ProviderToolTraceEvent = Extract<
  ExecutionTraceEvent,
  { type: "tool.started" | "tool.completed" | "reasoning.delta" | "assistant.delta" }
>;

/**
 * Provider-side input attachment payload. Aliased to the canonical
 * ClipboardImageAttachment from @unclecode/contracts so that the TUI
 * composer, the orchestrator clipboard utility, and every provider
 * adapter share a single source-of-truth shape. No fields differ — the
 * three formerly-duplicate types had identical structure; this alias
 * removes the drift risk without any wire-format change.
 */
export type ProviderInputAttachment = ClipboardImageAttachment;

let cachedProviderToolLoopMax: number | undefined;
const runtimeReasoningEffortCache = new Map<string, string | undefined>();
const providerSystemPromptCache = new Map<string, string>();
const providerToolPolicyCache = new Map<string, ProviderToolPolicy>();

export function applyProviderAttachmentCaps(
  attachments: readonly ProviderInputAttachment[],
): readonly ProviderInputAttachment[] {
  const raw = runRustCommandSync(
    ["rust", "provider", "attachment-caps"],
    process.cwd(),
    process.env,
    JSON.stringify(attachments),
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.changed !== "boolean" || !Array.isArray(parsed.attachments)) {
    throw new Error("Rust provider attachment caps returned an invalid payload.");
  }
  return parsed.changed ? (parsed.attachments as ProviderInputAttachment[]) : attachments;
}

export type ProviderTraceListener = (event: ProviderToolTraceEvent) => void;

export type ProviderTurnOptions = {
  readonly signal?: AbortSignal | undefined;
};

export type ProviderName = "anthropic" | "gemini" | "openai" | "deepseek";
type RuntimeProviderName = ProviderName;
type RuntimeProviderKind = RuntimeProviderName | "unsupported";

type RuntimeProviderDecision = {
  readonly providerId: string;
  readonly runtimeSupported: boolean;
  readonly runtimeKind: RuntimeProviderKind;
  readonly error: string | null;
};

export type RuntimeReasoningConfig = {
  effort: ModeReasoningEffort | "unsupported";
  source: "mode-default" | "override" | "model-capability";
  support: ReasoningSupport;
};

function resolveRuntimeReasoningEffort(reasoning: RuntimeReasoningConfig): string | undefined {
  const cacheKey = JSON.stringify(reasoning);
  if (runtimeReasoningEffortCache.has(cacheKey)) {
    return runtimeReasoningEffortCache.get(cacheKey);
  }
  const raw = runRustCommandSync(
    ["rust", "provider", "reasoning-effort"],
    process.cwd(),
    process.env,
    cacheKey,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.enabled !== true && parsed.enabled !== false) {
    throw new Error("Rust provider reasoning effort returned an invalid payload.");
  }
  const effort = parsed.enabled && typeof parsed.effort === "string" && parsed.effort.trim()
    ? parsed.effort.trim()
    : undefined;
  runtimeReasoningEffortCache.set(cacheKey, effort);
  return effort;
}

function resolveProviderSystemPrompt(appendix?: string): string {
  const key = appendix ?? "";
  const cached = providerSystemPromptCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const prompt = runRustCommandSync(
    ["rust", "provider", "system-prompt"],
    process.cwd(),
    process.env,
    key,
  ).trimEnd();
  providerSystemPromptCache.set(key, prompt);
  return prompt;
}

type ProviderToolPolicySurface =
  | "openai-chat-live"
  | "openai-chat-query"
  | "openai-codex-live"
  | "gemini-live"
  | "gemini-query";

type ProviderToolPolicy = {
  readonly includeTools: boolean;
  readonly toolChoice: "auto" | "none";
};

function resolveProviderToolPolicy(
  surface: ProviderToolPolicySurface,
  tools: readonly ToolDefinition[],
): ProviderToolPolicy {
  const cacheKey = `${surface}\0${JSON.stringify(tools)}`;
  const cached = providerToolPolicyCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const raw = runRustCommandSync(
    ["rust", "provider", "tool-policy", surface],
    process.cwd(),
    process.env,
    JSON.stringify(tools),
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed)
    || parsed.includeTools !== true && parsed.includeTools !== false
    || parsed.toolChoice !== "auto" && parsed.toolChoice !== "none"
  ) {
    throw new Error("Rust provider tool policy returned an invalid payload.");
  }
  const policy: ProviderToolPolicy = {
    includeTools: parsed.includeTools,
    toolChoice: parsed.toolChoice,
  };
  providerToolPolicyCache.set(cacheKey, policy);
  return policy;
}

function resolveRuntimeProviderDecision(provider: string, model: string): RuntimeProviderDecision {
  const args = ["rust", "model", "provider-runtime-json", provider];
  const normalizedModel = model.trim();
  if (normalizedModel) {
    args.push(normalizedModel);
  }
  const raw = runRustCommandSync(args, process.cwd()).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed)
    || typeof parsed.providerId !== "string"
    || parsed.runtimeSupported !== true && parsed.runtimeSupported !== false
    || typeof parsed.runtimeKind !== "string"
    || !isRuntimeProviderKind(parsed.runtimeKind)
    || parsed.error !== null && typeof parsed.error !== "string"
  ) {
    throw new Error("Rust provider runtime decision returned an invalid payload.");
  }
  return {
    providerId: parsed.providerId,
    runtimeSupported: parsed.runtimeSupported,
    runtimeKind: parsed.runtimeKind,
    error: parsed.error,
  };
}

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  metadata?: ToolMetadata;
};

export type ToolResult = {
  isError?: boolean;
  content: string;
};

export type ToolExecutionRequest = {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
};

export type ToolExecutor = {
  execute(request: ToolExecutionRequest): Promise<ToolResult>;
};

export type ToolRuntime = {
  readonly definitions: readonly ToolDefinition[];
  readonly executor: ToolExecutor;
};

export type ProviderQueryMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: ReadonlyArray<{
        readonly callId: string;
        readonly name: string;
        readonly argumentsJson: string;
      }>;
    }
  | {
      readonly role: "tool";
      readonly content: string;
      readonly callId: string;
    };

export type ProviderQueryAction = {
  readonly callId: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
};

export type ProviderQueryResult = {
  readonly content: string;
  readonly actions: ReadonlyArray<ProviderQueryAction>;
  readonly costUsd: number;
  readonly usage?: ProviderTokenUsage;
};

function createProviderTokenUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  inputIncludesCacheRead = false,
): ProviderTokenUsage {
  const normalizedCacheRead = Math.max(0, cacheReadTokens);
  const normalizedCacheWrite = Math.max(0, cacheWriteTokens);
  const normalizedInput = Math.max(0, inputTokens);
  return {
    inputTokens: inputIncludesCacheRead
      ? Math.max(0, normalizedInput - normalizedCacheRead)
      : normalizedInput,
    outputTokens: Math.max(0, outputTokens),
    ...(normalizedCacheRead > 0 ? { cacheReadTokens: normalizedCacheRead } : {}),
    ...(normalizedCacheWrite > 0 ? { cacheWriteTokens: normalizedCacheWrite } : {}),
  };
}

function mergeProviderTokenUsage(
  current: ProviderTokenUsage,
  next: ProviderTokenUsage,
): ProviderTokenUsage {
  const cacheReadTokens = (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0);
  const cacheWriteTokens = (current.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0);
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  };
}

function estimateProviderUsageCostUsd(
  modelId: string,
  usage: ProviderTokenUsage,
): number {
  try {
    return estimateCostUsd({
      modelId,
      promptTokens:
        usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      completionTokens: usage.outputTokens,
    });
  } catch {
    return 0;
  }
}

/**
 * Folds one model response cost into the running turn total. Unknown pricing
 * arrives as 0 and non-finite or negative values are provider noise, so only
 * real positive costs contribute.
 */
function accumulateResponseCostUsd(costUsd: number, responseCostUsd: number): number {
  return Number.isFinite(responseCostUsd) && responseCostUsd > 0
    ? costUsd + responseCostUsd
    : costUsd;
}

function createAgentTurnResult(
  text: string,
  usage: ProviderTokenUsage,
  costUsd: number,
  steps: number,
): AgentTurnResult {
  const hasUsage = usage.inputTokens > 0
    || usage.outputTokens > 0
    || (usage.cacheReadTokens ?? 0) > 0
    || (usage.cacheWriteTokens ?? 0) > 0;
  return {
    text,
    steps,
    ...(hasUsage ? { usage } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
  };
}

function createProviderQueryResult(
  content: string,
  actions: ReadonlyArray<ProviderQueryAction>,
  costUsd: number,
  usage: ProviderTokenUsage,
): ProviderQueryResult {
  const hasUsage = usage.inputTokens > 0
    || usage.outputTokens > 0
    || (usage.cacheReadTokens ?? 0) > 0
    || (usage.cacheWriteTokens ?? 0) > 0;
  return {
    content,
    actions,
    costUsd,
    ...(hasUsage ? { usage } : {}),
  };
}

export type ProviderQueryOptions = {
  readonly tools?: readonly ToolDefinition[];
  readonly model?: string;
  readonly reasoning?: RuntimeReasoningConfig;
};

export interface LlmProvider {
  runTurn(
    prompt: string,
    attachments?: readonly ProviderInputAttachment[],
    options?: ProviderTurnOptions,
  ): Promise<AgentTurnResult>;
  /**
   * Stateless one-shot query for caller-managed message histories
   * (e.g. MiniLoopAgent). Caller owns the message log; the provider
   * does not mutate internal state and does not execute tool actions —
   * tool intents come back as `actions[]` for the caller to dispatch.
   */
  query?(
    messages: ReadonlyArray<ProviderQueryMessage>,
    options?: ProviderQueryOptions,
  ): Promise<ProviderQueryResult>;
  clear(): void;
  updateRuntimeSettings(settings: {
    reasoning?: RuntimeReasoningConfig | undefined;
    model?: string | undefined;
  }): void;
  updateAuthToken?(apiKey: string): void;
  setTraceListener(listener?: ProviderTraceListener): void;
}

export type CreateRuntimeProviderArgs = {
  provider: ProviderName;
  apiKey: string;
  model: string;
  cwd: string;
  reasoning: RuntimeReasoningConfig;
  systemPrompt?: string;
  toolRuntime?: ToolRuntime;
  providerOverride?: LlmProvider;
  openAIRuntime?: "api" | "codex";
  openAIAccountId?: string | null;
  baseUrl?: string;
};

const EMPTY_TOOL_RUNTIME: ToolRuntime = {
  definitions: [],
  executor: {
    async execute(request: ToolExecutionRequest): Promise<ToolResult> {
      return {
        isError: true,
        content: `No tool runtime is registered for tool "${request.toolName}".`,
      };
    },
  },
};

type RustRequestSpec = {
  readonly url: string;
  readonly headers: Record<string, string>;
};

type RustOpenAIChatResponse = {
  readonly content: string;
  readonly reasoning: string;
  readonly toolCalls: Array<{
    readonly id: string;
    readonly name: string;
    readonly argumentsJson: string;
  }>;
  readonly actions: RustProviderAction[];
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
};

type RustOpenAIChatCompletionResult = {
  readonly content: string;
  readonly reasoning: string;
  readonly toolCalls: Array<{
    readonly id: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
  readonly actions: RustProviderAction[];
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
};

type RustHttpResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
  readonly attempts?: number;
};

type OpenAIResponsesHttpResponse = RustHttpResponse & {
  readonly streamed: boolean;
};

type ProviderToolResultOutcome = {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly kind: "success" | "error";
  readonly isError: boolean;
  readonly content: string;
};

type ProviderTurnStepResult = RustProviderLoopDecision & {
  readonly assistantText: string;
};

type ProviderToolDispatchPlan = {
  readonly dispatches: RustProviderAction[];
  readonly outcomes: ProviderToolResultOutcome[];
};

type ProviderToolExecutionResult = {
  readonly trace: ProviderToolTraceEvent;
  readonly outcome: ProviderToolResultOutcome;
};

type ProviderToolExecutionStart = {
  readonly startedAt: number;
  readonly trace: ProviderToolTraceEvent;
};

type OpenAIMessage =
  | {
      role: "system" | "assistant";
      content: string;
      tool_calls?: unknown[];
      reasoning_content?: string;
    }
  | {
      role: "user";
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | { type: "image_url"; image_url: { url: string } }
          >;
      tool_calls?: unknown[];
    }
  | { role: "tool"; content: string; tool_call_id: string };

type OpenAIFetch = typeof fetch;

export class OpenAIProvider implements LlmProvider {
  private apiKey: string;
  private model: string;
  private readonly cwd: string;
  private readonly fetchImpl: OpenAIFetch | undefined;
  private readonly systemPrompt: string;
  private readonly toolRuntime: ToolRuntime;
  private reasoning: RuntimeReasoningConfig;
  private traceListener: ProviderTraceListener | undefined;
  private readonly messages: OpenAIMessage[];
  private readonly runtime: "api" | "codex";
  private readonly openAIAccountId: string | null;
  private readonly promptCacheKey: string;
  private readonly providerName: Extract<ProviderName, "openai" | "deepseek">;
  private readonly endpointUrl: string | undefined;

  constructor(args: {
    apiKey: string;
    model: string;
    cwd: string;
    reasoning: RuntimeReasoningConfig;
    toolRuntime?: ToolRuntime;
    fetchImpl?: OpenAIFetch;
    traceListener?: ProviderTraceListener;
    systemPrompt?: string;
    runtime?: "api" | "codex";
    openAIAccountId?: string | null;
    providerName?: Extract<ProviderName, "openai" | "deepseek">;
    endpointUrl?: string;
  }) {
    this.apiKey = args.apiKey;
    this.model = args.model;
    this.cwd = args.cwd;
    this.systemPrompt = resolveProviderSystemPrompt(args.systemPrompt);
    this.toolRuntime = args.toolRuntime ?? EMPTY_TOOL_RUNTIME;
    this.reasoning = args.reasoning;
    this.fetchImpl = args.fetchImpl;
    this.traceListener = args.traceListener;
    this.messages = [{ role: "system", content: this.systemPrompt }];
    this.runtime = args.runtime ?? "api";
    this.openAIAccountId = args.openAIAccountId ?? null;
    this.promptCacheKey = createOpenAIPromptCacheKey(this.cwd, this.systemPrompt);
    this.providerName = args.providerName ?? "openai";
    this.endpointUrl = args.endpointUrl?.trim() || undefined;
  }

  updateRuntimeSettings(settings: {
    reasoning?: RuntimeReasoningConfig | undefined;
    model?: string | undefined;
  }): void {
    const resolved = resolveProviderRuntimeSettings(this.providerName, this.model, this.reasoning, settings);
    this.model = resolved.model;
    if (resolved.reasoning) {
      this.reasoning = resolved.reasoning;
    }
  }

  clear(): void {
    resetProviderTurnState(this.providerName, this.messages, this.systemPrompt);
  }

  setTraceListener(listener?: ProviderTraceListener): void {
    this.traceListener = listener;
  }

  updateAuthToken(apiKey: string): void {
    this.apiKey = apiKey.trim();
  }

  private async requestOpenApiMessage(
    model: string,
    reasoning: RuntimeReasoningConfig,
    options: ProviderTurnOptions = {},
  ): Promise<{
    content?: string | null;
    reasoning?: string;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
    actions: RustProviderAction[];
    usage: ProviderTokenUsage;
    costUsd: number;
  }> {
    // Live streaming needs a fetch transport. When an explicit proxy is
    // configured we stay on the proxy-aware Rust transport instead, because
    // Node's fetch does not honour HTTP(S)_PROXY. Injected fetch (tests)
    // always wins so fixtures stay deterministic.
    const fetchImpl = this.fetchImpl
      ?? (hasExplicitProxyConfig() ? undefined : resolveGlobalFetchImpl());
    const requestSpec = this.buildChatRequestSpec();
    const toolsJson = buildOpenAIChatTools(this.toolRuntime.definitions);
    const toolPolicy = resolveProviderToolPolicy("openai-chat-live", this.toolRuntime.definitions);
    const body = buildOpenAIChatBody({
      model,
      messagesJson: JSON.stringify(this.messages),
      toolsJson,
      includeTools: toolPolicy.includeTools,
      reasoningEffort: resolveRuntimeReasoningEffort(reasoning),
      ...(isOfficialOpenAIRequestUrl(requestSpec.url)
        ? {
            promptCacheKey: this.promptCacheKey,
            promptCacheRetention: resolveOpenAIPromptCacheRetention(model),
          }
        : {}),
    });
    let response: OpenAIResponsesHttpResponse | undefined;
    if (fetchImpl) {
      try {
        response = await postOpenAIChatWithLiveStream({
          fetchImpl,
          url: this.endpointUrl ?? resolveOpenAIChatUrl(requestSpec.url),
          headers: requestSpec.headers,
          body: enableOpenAIChatStreamBody(body),
          model,
          traceListener: this.traceListener,
          maxAttempts: this.fetchImpl ? 1 : 3,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (
          this.fetchImpl
          || isAbortError(error)
          || error instanceof OpenAIChatLiveStreamReadError
        ) {
          throw error;
        }
        // Transport failed before any stream output was consumed; retry
        // once through the Rust transport so chat turns keep working.
      }
    }

    if (!response) {
      if (this.endpointUrl) {
        response = {
          ...(await postWithRustHttpAsync(
            this.endpointUrl,
            requestSpec.headers,
            body,
            options.signal,
          )),
          streamed: false,
        };
      } else {
        const parsed = await runOpenAIChatCompletionWithRustAsync({
          apiKey: this.apiKey,
          model,
          messages: this.messages,
          tools: this.toolRuntime.definitions,
          reasoningEffort: resolveRuntimeReasoningEffort(reasoning),
          signal: options.signal,
        });
        if (parsed.reasoning.length > 0) {
          emitProviderTrace(
            this.traceListener,
            buildProviderReasoningDeltaTrace(this.providerName, model, "text", parsed.reasoning),
          );
        }
        return {
          content: parsed.content,
          reasoning: parsed.reasoning,
          tool_calls: parsed.toolCalls,
          actions: parsed.actions,
          usage: createProviderTokenUsage(
            parsed.promptTokens,
            parsed.completionTokens,
            parsed.cacheReadTokens,
            0,
            true,
          ),
          costUsd: parsed.costUsd,
        };
      }
    }

    if (!response.ok) {
      throw new Error(buildProviderRequestError(this.providerName, response.status, response.text, response.attempts));
    }

    const parsed = parseOpenAIChatResponse(response.text, model);
    // When the response was consumed as a live stream, reasoning deltas were
    // already emitted incrementally — re-emitting the aggregate would
    // duplicate the trace.
    if (!response.streamed && parsed.reasoning.length > 0) {
      emitProviderTrace(
        this.traceListener,
        buildProviderReasoningDeltaTrace(this.providerName, model, "text", parsed.reasoning),
      );
    }
    return {
      content: parsed.content,
      reasoning: parsed.reasoning,
      tool_calls: parsed.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        function: { name: toolCall.name, arguments: toolCall.argumentsJson },
      })),
      actions: parsed.actions,
      usage: createProviderTokenUsage(
        parsed.promptTokens,
        parsed.completionTokens,
        parsed.cacheReadTokens,
        0,
        true,
      ),
      costUsd: parsed.costUsd,
    };
  }

  private async requestCodexMessage(
    model: string,
    reasoning: RuntimeReasoningConfig,
    options: ProviderTurnOptions = {},
  ): Promise<{
    content?: string | null;
    reasoning?: string;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
    actions: RustProviderAction[];
    usage: ProviderTokenUsage;
    costUsd: number;
  }> {
    const inputJson = buildOpenAIResponsesInput(this.messages);
    const toolsJson = buildOpenAIResponsesTools(this.toolRuntime.definitions);
    const toolPolicy = resolveProviderToolPolicy("openai-codex-live", this.toolRuntime.definitions);

    const body = buildOpenAICodexBody({
      model,
      instructions: this.systemPrompt,
      inputJson,
      toolsJson,
      toolChoice: toolPolicy.toolChoice,
      reasoningEffort: resolveRuntimeReasoningEffort(reasoning),
      promptCacheKey: this.promptCacheKey,
      promptCacheRetention: "24h",
    });
    const response = await this.postCodexResponses(model, body, options.signal);

    if (!response.ok) {
      throw new Error(buildProviderRequestError("openai", response.status, response.text, response.attempts));
    }

    const parsed = parseOpenAIResponsesMessage(response.text, model, {
      includeStreamingTraces: !response.streamed,
    });
    for (const trace of parsed.traces) {
      emitProviderTrace(this.traceListener, trace);
    }
    const usage = parsed.usage;
    return {
      ...parsed.message,
      actions: parsed.actions,
      usage,
      costUsd: estimateProviderUsageCostUsd(model, usage),
    };
  }

  private async postCodexResponses(
    model: string,
    body: string,
    signal?: AbortSignal | undefined,
  ): Promise<OpenAIResponsesHttpResponse> {
    const requestSpec = buildOpenAIRequestSpec("codex", this.apiKey, this.openAIAccountId);
    const fetchImpl = this.fetchImpl ?? resolveGlobalFetchImpl();

    if (fetchImpl) {
      try {
        return await postOpenAIResponsesWithLiveStream({
          fetchImpl,
          url: requestSpec.url,
          headers: requestSpec.headers,
          body,
          model,
          traceListener: this.traceListener,
          maxAttempts: this.fetchImpl ? 1 : 3,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (error instanceof OpenAIResponsesLiveStreamReadError) {
          throw error;
        }
        if (this.fetchImpl) {
          throw error;
        }
      }
    }

    return {
      ...(await postOpenAIWithRustAsync("codex", this.apiKey, body, this.openAIAccountId, signal)),
      streamed: false,
    };
  }

  async runTurn(
    prompt: string,
    attachments: readonly ProviderInputAttachment[] = [],
    options: ProviderTurnOptions = {},
  ): Promise<AgentTurnResult> {
    const maxIterations = getProviderToolLoopMax();
    const model = this.model;
    const reasoning = this.reasoning;
    const rollbackLength = this.messages.length;
    startProviderTurnState(this.providerName, this.messages, prompt, attachments);

    try {
      let assistantText = "";
      let usage = createProviderTokenUsage(0, 0);
      let costUsd = 0;
      let steps = 0;

      for (let i = 0; i < maxIterations; i += 1) {
        throwIfAborted(options.signal);
        const message = this.runtime === "codex"
          ? await this.requestCodexMessage(model, reasoning, options)
          : await this.requestOpenApiMessage(model, reasoning, options);
        throwIfAborted(options.signal);
        assistantText = typeof message?.content === "string" ? message.content : "";
        const reasoningContent = this.providerName === "deepseek"
          && typeof message.reasoning === "string"
          ? message.reasoning
          : undefined;
        const toolCalls = message?.tool_calls ?? [];
        const actions = message.actions;
        steps += 1;
        usage = mergeProviderTokenUsage(usage, message.usage);
        costUsd = accumulateResponseCostUsd(costUsd, message.costUsd);

        const actionPlan = resolveProviderIterationActionPlan(i, actions.length, maxIterations, assistantText);
        const toolResultOutcomes = actionPlan.shouldDispatchTools
          ? await executeProviderToolDispatches(
          this.providerName,
          actions,
          this.toolRuntime.definitions,
          this.toolRuntime.executor,
          this.cwd,
          this.traceListener,
          options,
        )
          : [];
        throwIfAborted(options.signal);

        const turnStep = completeProviderTurnStep(
          this.providerName,
          i,
          maxIterations,
          assistantText,
          assistantText,
          actions.length,
          this.messages,
          [buildOpenAIAssistantMessage(assistantText, toolCalls, reasoningContent)],
          toolResultOutcomes,
        );
        assistantText = turnStep.assistantText;
        if (turnStep.decision === "final" || turnStep.decision === "limit") {
          return createAgentTurnResult(turnStep.text, usage, costUsd, steps);
        }
      }

      return createAgentTurnResult(
        resolveProviderLoopDecision(maxIterations - 1, 1, maxIterations, assistantText).text,
        usage,
        costUsd,
        steps,
      );
    } catch (error) {
      if (isAbortError(error)) {
        this.messages.splice(rollbackLength);
      }
      throw error;
    }
  }

  async query(
    messages: ReadonlyArray<ProviderQueryMessage>,
    options: ProviderQueryOptions = {},
  ): Promise<ProviderQueryResult> {
    const tools = options.tools ?? this.toolRuntime.definitions;
    const model = options.model?.trim() ? options.model.trim() : this.model;
    const reasoning = options.reasoning ?? this.reasoning;
    if (!this.fetchImpl && !this.endpointUrl) {
      return runOpenAIChatQueryWithRust({
        apiKey: this.apiKey,
        model,
        systemPrompt: this.systemPrompt,
        messages,
        tools,
        reasoningEffort: resolveRuntimeReasoningEffort(reasoning),
      });
    }

    const messagesJson = buildOpenAIQueryMessages(messages, this.systemPrompt);

    const toolsJson = buildOpenAIChatTools(tools);
    const toolPolicy = resolveProviderToolPolicy("openai-chat-query", tools);
    const requestSpec = this.buildChatRequestSpec();
    const body = buildOpenAIChatBody({
      model,
      messagesJson,
      toolsJson,
      includeTools: toolPolicy.includeTools,
      reasoningEffort: resolveRuntimeReasoningEffort(reasoning),
      ...(isOfficialOpenAIRequestUrl(requestSpec.url)
        ? {
            promptCacheKey: this.promptCacheKey,
            promptCacheRetention: resolveOpenAIPromptCacheRetention(model),
          }
        : {}),
    });

    const response = await this.postText(
      this.endpointUrl ?? resolveOpenAIChatUrl(requestSpec.url),
      requestSpec.headers,
      body,
    );

    if (!response.ok) {
      throw new Error(buildProviderRequestError(this.providerName, response.status, response.text, response.attempts));
    }

    const parsed = parseOpenAIChatResponse(response.text, model);

    return createProviderQueryResult(
      parsed.content,
      parsed.actions,
      parsed.costUsd,
      createProviderTokenUsage(
        parsed.promptTokens,
        parsed.completionTokens,
        parsed.cacheReadTokens,
        0,
        true,
      ),
    );
  }

  private buildChatRequestSpec(): RustRequestSpec {
    const spec = buildOpenAIRequestSpec("api", this.apiKey);
    return this.endpointUrl ? { ...spec, url: this.endpointUrl } : spec;
  }

  private async postText(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal | undefined,
  ): Promise<RustHttpResponse> {
    if (!this.fetchImpl) {
      return await postWithRustHttpAsync(url, headers, body, signal);
    }
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body,
      ...(signal ? { signal } : {}),
    });
    return {
      ok: response.ok,
      status: typeof response.status === "number" ? response.status : response.ok ? 200 : 0,
      text: await readResponseText(response),
    };
  }
}

export class AnthropicProvider implements LlmProvider {
  private readonly client: AnthropicMessagesClient | undefined;
  private readonly usesInjectedClient: boolean;
  private readonly apiKey: string;
  private model: string;
  private readonly cwd: string;
  private readonly systemPrompt: string;
  private readonly toolRuntime: ToolRuntime;
  private traceListener: ProviderTraceListener | undefined;
  private readonly messages: AnthropicMessage[] = [];

  constructor(args: {
    apiKey: string;
    model: string;
    cwd: string;
    toolRuntime?: ToolRuntime;
    traceListener?: ProviderTraceListener;
    systemPrompt?: string;
    client?: AnthropicMessagesClient;
  }) {
    this.apiKey = args.apiKey;
    this.usesInjectedClient = args.client !== undefined;
    this.client = args.client;
    this.model = args.model;
    this.cwd = args.cwd;
    this.systemPrompt = resolveProviderSystemPrompt(args.systemPrompt);
    this.toolRuntime = args.toolRuntime ?? EMPTY_TOOL_RUNTIME;
    this.traceListener = args.traceListener;
  }

  clear(): void {
    resetProviderTurnState("anthropic", this.messages, this.systemPrompt);
  }

  setTraceListener(listener?: ProviderTraceListener): void {
    this.traceListener = listener;
  }

  updateRuntimeSettings(settings: {
    reasoning?: RuntimeReasoningConfig | undefined;
    model?: string | undefined;
  }): void {
    this.model = resolveProviderRuntimeSettings("anthropic", this.model, undefined, settings).model;
  }

  async runTurn(
    prompt: string,
    attachments: readonly ProviderInputAttachment[] = [],
    options: ProviderTurnOptions = {},
  ): Promise<AgentTurnResult> {
    const maxIterations = getProviderToolLoopMax();
    const model = this.model;
    const rollbackLength = this.messages.length;
    startProviderTurnState("anthropic", this.messages, prompt, attachments);

    try {
      let assistantText = "";
      let usage = createProviderTokenUsage(0, 0);
      let costUsd = 0;
      let steps = 0;

      for (let i = 0; i < maxIterations; i += 1) {
        throwIfAborted(options.signal);
        const request = buildAnthropicMessagesRequest({
          model,
          system: this.systemPrompt,
          messages: this.messages,
          tools: this.toolRuntime.definitions,
        });
        const parsed = this.usesInjectedClient
          ? parseAnthropicResponse(await this.requireInjectedClient().messages.create(request), model)
          : parseAnthropicResponseText(await this.postMessagesWithRust(JSON.stringify(request), options.signal), model);
        throwIfAborted(options.signal);
        steps += 1;
        usage = mergeProviderTokenUsage(
          usage,
          createProviderTokenUsage(
            parsed.promptTokens,
            parsed.completionTokens,
            parsed.cacheReadTokens,
            parsed.cacheWriteTokens,
          ),
        );
        costUsd = accumulateResponseCostUsd(costUsd, parsed.costUsd);

        const actionPlan = resolveProviderIterationActionPlan(i, parsed.actions.length, maxIterations, parsed.content);
        const toolResultOutcomes = actionPlan.shouldDispatchTools
          ? await executeProviderToolDispatches(
          "anthropic",
          parsed.actions,
          this.toolRuntime.definitions,
          this.toolRuntime.executor,
          this.cwd,
          this.traceListener,
          options,
        )
          : [];
        throwIfAborted(options.signal);

        const turnStep = completeProviderTurnStep(
          "anthropic",
          i,
          maxIterations,
          assistantText,
          parsed.content,
          parsed.actions.length,
          this.messages,
          [parsed.assistantMessage],
          toolResultOutcomes,
        );
        assistantText = turnStep.assistantText;
        if (turnStep.decision === "final" || turnStep.decision === "limit") {
          return createAgentTurnResult(turnStep.text, usage, costUsd, steps);
        }
      }

      return createAgentTurnResult(
        resolveProviderLoopDecision(maxIterations - 1, 1, maxIterations, assistantText).text,
        usage,
        costUsd,
        steps,
      );
    } catch (error) {
      if (isAbortError(error)) {
        this.messages.splice(rollbackLength);
      }
      throw error;
    }
  }

  async query(
    messages: ReadonlyArray<ProviderQueryMessage>,
    options: ProviderQueryOptions = {},
  ): Promise<ProviderQueryResult> {
    const tools = options.tools ?? this.toolRuntime.definitions;
    const model = options.model?.trim() ? options.model.trim() : this.model;
    const { system, messages: wireMessages } = buildAnthropicQueryMessages(messages, this.systemPrompt);

    const request = buildAnthropicMessagesRequest({
      model,
      system,
      messages: wireMessages,
      tools,
    });
    const parsed = this.usesInjectedClient
      ? parseAnthropicResponse(await this.requireInjectedClient().messages.create(request), model)
      : parseAnthropicResponseText(await this.postMessagesWithRust(JSON.stringify(request)), model);

    return createProviderQueryResult(
      parsed.content,
      parsed.actions,
      parsed.costUsd,
      createProviderTokenUsage(
        parsed.promptTokens,
        parsed.completionTokens,
        parsed.cacheReadTokens,
        parsed.cacheWriteTokens,
      ),
    );
  }

  private async postMessagesWithRust(body: string, signal?: AbortSignal | undefined): Promise<string> {
    const response = await postAnthropicWithRustAsync(this.apiKey, body, signal);
    if (!response.ok) {
      throw new Error(buildProviderRequestError("anthropic", response.status, response.text, response.attempts));
    }
    return response.text;
  }

  private requireInjectedClient(): AnthropicMessagesClient {
    if (!this.client) {
      throw new Error("Anthropic SDK client was not injected.");
    }
    return this.client;
  }
}

type GeminiContent = {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
};

type AnthropicMessage = {
  role: "user" | "assistant";
  content: unknown;
};

type AnthropicMessagesRequest = Record<string, unknown>;

type AnthropicMessagesClient = {
  messages: {
    create(request: AnthropicMessagesRequest): Promise<unknown>;
  };
};

type GeminiGenerateContentRequest = Record<string, unknown>;

type GeminiClient = {
  models: {
    generateContent(request: GeminiGenerateContentRequest): Promise<unknown>;
  };
};

type RustGeminiQueryMessages = {
  readonly systemInstruction: string;
  readonly contents: GeminiContent[];
};

type RustAnthropicQueryMessages = {
  readonly system: string;
  readonly messages: AnthropicMessage[];
};

type RustProviderAction = {
  readonly callId: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
};

type RustProviderLoopDecision = {
  readonly decision: "continue" | "final" | "limit";
  readonly text: string;
};

type RustProviderIterationActionPlan = RustProviderLoopDecision & {
  readonly shouldDispatchTools: boolean;
};

type RustGeminiResponse = {
  readonly content: string;
  readonly actions: RustProviderAction[];
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
  readonly modelContent: GeminiContent;
};

type RustAnthropicResponse = {
  readonly content: string;
  readonly actions: RustProviderAction[];
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly assistantMessage: AnthropicMessage;
};

export class GeminiProvider implements LlmProvider {
  private readonly client: GeminiClient | undefined;
  private readonly usesInjectedClient: boolean;
  private readonly apiKey: string;
  private model: string;
  private readonly cwd: string;
  private readonly systemPrompt: string;
  private readonly toolRuntime: ToolRuntime;
  private traceListener: ProviderTraceListener | undefined;
  private readonly contents: GeminiContent[] = [];

  constructor(args: {
    apiKey: string;
    model: string;
    cwd: string;
    toolRuntime?: ToolRuntime;
    traceListener?: ProviderTraceListener;
    systemPrompt?: string;
    client?: GeminiClient;
  }) {
    this.apiKey = args.apiKey;
    this.usesInjectedClient = args.client !== undefined;
    this.client = args.client;
    this.model = args.model;
    this.cwd = args.cwd;
    this.systemPrompt = resolveProviderSystemPrompt(args.systemPrompt);
    this.toolRuntime = args.toolRuntime ?? EMPTY_TOOL_RUNTIME;
    this.traceListener = args.traceListener;
  }

  clear(): void {
    resetProviderTurnState("gemini", this.contents, this.systemPrompt);
  }

  setTraceListener(listener?: ProviderTraceListener): void {
    this.traceListener = listener;
  }

  updateRuntimeSettings(settings: {
    reasoning?: RuntimeReasoningConfig | undefined;
    model?: string | undefined;
  }): void {
    this.model = resolveProviderRuntimeSettings("gemini", this.model, undefined, settings).model;
  }

  async runTurn(
    prompt: string,
    attachments: readonly ProviderInputAttachment[] = [],
    options: ProviderTurnOptions = {},
  ): Promise<AgentTurnResult> {
    const maxIterations = getProviderToolLoopMax();
    const model = this.model;
    const rollbackLength = this.contents.length;
    startProviderTurnState("gemini", this.contents, prompt, attachments);

    try {
      let assistantText = "";
      let usage = createProviderTokenUsage(0, 0);
      let costUsd = 0;
      let steps = 0;

      for (let i = 0; i < maxIterations; i += 1) {
        throwIfAborted(options.signal);
        const request = buildGeminiGenerateContentRequest({
          model,
          systemInstruction: this.systemPrompt,
          contents: this.contents,
          functionDeclarations: buildGeminiFunctionDeclarations(this.toolRuntime.definitions),
          includeTools: resolveProviderToolPolicy("gemini-live", this.toolRuntime.definitions).includeTools,
        });
        const parsed = this.usesInjectedClient
          ? parseGeminiResponse(await this.requireInjectedClient().models.generateContent(request), model)
          : parseGeminiResponseText(await this.postGenerateContentWithRust(model, request, options.signal), model);
        throwIfAborted(options.signal);
        steps += 1;
        usage = mergeProviderTokenUsage(
          usage,
          createProviderTokenUsage(
            parsed.promptTokens,
            parsed.completionTokens,
            parsed.cacheReadTokens,
            0,
            true,
          ),
        );
        costUsd = accumulateResponseCostUsd(costUsd, parsed.costUsd);

        const actionPlan = resolveProviderIterationActionPlan(i, parsed.actions.length, maxIterations, parsed.content);
        const toolResultOutcomes = actionPlan.shouldDispatchTools
          ? await executeProviderToolDispatches(
          "gemini",
          parsed.actions,
          this.toolRuntime.definitions,
          this.toolRuntime.executor,
          this.cwd,
          this.traceListener,
          options,
        )
          : [];
        throwIfAborted(options.signal);

        const turnStep = completeProviderTurnStep(
          "gemini",
          i,
          maxIterations,
          assistantText,
          parsed.content,
          parsed.actions.length,
          this.contents,
          [parsed.modelContent],
          toolResultOutcomes,
        );
        assistantText = turnStep.assistantText;
        if (turnStep.decision === "final" || turnStep.decision === "limit") {
          return createAgentTurnResult(turnStep.text, usage, costUsd, steps);
        }
      }

      return createAgentTurnResult(
        resolveProviderLoopDecision(maxIterations - 1, 1, maxIterations, assistantText).text,
        usage,
        costUsd,
        steps,
      );
    } catch (error) {
      if (isAbortError(error)) {
        this.contents.splice(rollbackLength);
      }
      throw error;
    }
  }

  async query(
    messages: ReadonlyArray<ProviderQueryMessage>,
    options: ProviderQueryOptions = {},
  ): Promise<ProviderQueryResult> {
    const tools = options.tools ?? this.toolRuntime.definitions;
    const model = options.model?.trim() ? options.model.trim() : this.model;
    const { systemInstruction, contents } = buildGeminiQueryMessages(messages, this.systemPrompt);
    const functionDeclarations = buildGeminiFunctionDeclarations(tools);
    const toolPolicy = resolveProviderToolPolicy("gemini-query", tools);

    const request = buildGeminiGenerateContentRequest({
      model,
      systemInstruction,
      contents,
      functionDeclarations,
      includeTools: toolPolicy.includeTools,
    });
    const parsed = this.usesInjectedClient
      ? parseGeminiResponse(await this.requireInjectedClient().models.generateContent(request), model)
      : parseGeminiResponseText(await this.postGenerateContentWithRust(model, request), model);

    return createProviderQueryResult(
      parsed.content,
      parsed.actions,
      parsed.costUsd,
      createProviderTokenUsage(
        parsed.promptTokens,
        parsed.completionTokens,
        parsed.cacheReadTokens,
        0,
        true,
      ),
    );
  }

  private async postGenerateContentWithRust(
    model: string,
    request: GeminiGenerateContentRequest,
    signal?: AbortSignal | undefined,
  ): Promise<string> {
    const body = JSON.stringify(buildGeminiRestGenerateContentRequest(request));
    const response = await postGeminiWithRustAsync(this.apiKey, model, body, signal);
    if (!response.ok) {
      throw new Error(buildProviderRequestError("gemini", response.status, response.text, response.attempts));
    }
    return response.text;
  }

  private requireInjectedClient(): GeminiClient {
    if (!this.client) {
      throw new Error("Gemini SDK client was not injected.");
    }
    return this.client;
  }
}

export function createRuntimeProvider(args: CreateRuntimeProviderArgs): LlmProvider {
  if (args.providerOverride) {
    return args.providerOverride;
  }

  const decision = resolveRuntimeProviderDecision(args.provider, args.model);
  if (!decision.runtimeSupported) {
    throw new Error(decision.error ?? `Unsupported runtime provider: ${args.provider}`);
  }

  if (decision.runtimeKind === "openai") {
    return new OpenAIProvider({
      apiKey: args.apiKey,
      model: args.model,
      cwd: args.cwd,
      reasoning: args.reasoning,
      ...(args.toolRuntime ? { toolRuntime: args.toolRuntime } : {}),
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
      ...(args.openAIRuntime ? { runtime: args.openAIRuntime } : {}),
      ...(args.openAIAccountId !== undefined ? { openAIAccountId: args.openAIAccountId } : {}),
    });
  }

  if (decision.runtimeKind === "deepseek") {
    return new OpenAIProvider({
      providerName: "deepseek",
      endpointUrl: args.baseUrl ?? "https://api.deepseek.com/chat/completions",
      apiKey: args.apiKey,
      model: args.model,
      cwd: args.cwd,
      reasoning: args.reasoning,
      ...(args.toolRuntime ? { toolRuntime: args.toolRuntime } : {}),
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    });
  }

  if (decision.runtimeKind === "gemini") {
    return new GeminiProvider({
      apiKey: args.apiKey,
      model: args.model,
      cwd: args.cwd,
      ...(args.toolRuntime ? { toolRuntime: args.toolRuntime } : {}),
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    });
  }

  if (decision.runtimeKind === "anthropic") {
    return new AnthropicProvider({
      apiKey: args.apiKey,
      model: args.model,
      cwd: args.cwd,
      ...(args.toolRuntime ? { toolRuntime: args.toolRuntime } : {}),
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    });
  }

  throw new Error(decision.error ?? `Unsupported runtime provider: ${decision.providerId}`);
}

function parseOpenAIResponsesMessage(
  sseText: string,
  model: string,
  options: { readonly includeStreamingTraces?: boolean } = {},
): {
  responseId: string | null;
  message: {
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  actions: RustProviderAction[];
  traces: ProviderToolTraceEvent[];
  usage: ProviderTokenUsage;
} {
  const raw = runRustCommandSync(
    ["rust", "provider", "openai-responses-message", model],
    process.cwd(),
    process.env,
    sseText ?? "",
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.provider !== "openai" || !isRecord(parsed.message) || !Array.isArray(parsed.traces)) {
    throw new Error("Rust OpenAI Responses message parsing returned an invalid payload.");
  }

  const includeStreamingTraces = options.includeStreamingTraces !== false;
  const assistantDeltaTraces = includeStreamingTraces
    ? parseOpenAIResponsesAssistantDeltaTraces(sseText, model)
    : [];
  const rustTraces = parsed.traces
    .map((trace) => parseProviderTraceEvent(JSON.stringify(trace)))
    .filter((trace) => includeStreamingTraces || trace.type !== "reasoning.delta");

  return {
    responseId: typeof parsed.responseId === "string" ? parsed.responseId : null,
    message: parsed.message as {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    },
    actions: parseProviderActions(Array.isArray(parsed.actions) ? parsed.actions : []),
    usage: parseOpenAIResponsesUsage(sseText),
    traces: [
      ...assistantDeltaTraces,
      ...rustTraces,
    ],
  };
}
function parseOpenAIResponsesUsage(sseText: string): ProviderTokenUsage {
  const payloads = parseSseDataJsonPayloads(sseText);
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const payload = payloads[index];
    const response = isRecord(payload?.response) ? payload.response : undefined;
    const usage = response && isRecord(response.usage)
      ? response.usage
      : isRecord(payload?.usage)
        ? payload.usage
        : undefined;
    if (!usage) {
      continue;
    }
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
    const cacheReadTokens = details && typeof details.cached_tokens === "number"
      ? details.cached_tokens
      : 0;
    return createProviderTokenUsage(inputTokens, outputTokens, cacheReadTokens, 0, true);
  }
  return createProviderTokenUsage(0, 0);
}


function parseOpenAIResponsesAssistantDeltaTraces(
  sseText: string,
  model: string,
): ProviderToolTraceEvent[] {
  const traces: ProviderToolTraceEvent[] = [];
  let fallbackCounter = 0;

  for (const payload of parseSseDataJsonPayloads(sseText)) {
    if (payload.type !== "response.output_text.delta") {
      continue;
    }
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    if (delta.length === 0) {
      continue;
    }
    const itemId = typeof payload.item_id === "string" && payload.item_id.trim().length > 0
      ? payload.item_id
      : `msg_${++fallbackCounter}`;
    traces.push({
      type: "assistant.delta",
      level: "default",
      provider: "openai",
      model,
      itemId,
      delta,
    });
  }

  return traces;
}

function parseSseDataJsonPayloads(sseText: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const raw = current.join("\n").trim();
    current = [];
    if (raw.length === 0 || raw === "[DONE]") {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) {
        payloads.push(parsed);
      }
    } catch {
      // Ignore malformed stream chunks; the canonical Rust parser handles
      // final response validation.
    }
  };

  for (const rawLine of sseText.split(/\r?\n/)) {
    if (rawLine.length === 0) {
      flush();
      continue;
    }
    const data = rawLine.startsWith("data:")
      ? rawLine.slice("data:".length).trim()
      : "";
    if (data.length > 0) {
      current.push(data);
    }
  }
  flush();

  return payloads;
}

type OpenAIResponsesLivePostInput = {
  readonly fetchImpl: OpenAIFetch;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly model: string;
  readonly traceListener?: ProviderTraceListener | undefined;
  readonly maxAttempts: number;
  readonly signal?: AbortSignal | undefined;
};

async function postOpenAIResponsesWithLiveStream(
  input: OpenAIResponsesLivePostInput,
): Promise<OpenAIResponsesHttpResponse> {
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let readingStream = false;
    try {
      throwIfAborted(input.signal);
      const response = await input.fetchImpl(input.url, {
        method: "POST",
        headers: input.headers,
        body: input.body,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const status = typeof response.status === "number" ? response.status : response.ok ? 200 : 0;

      if (!response.ok) {
        const text = await readResponseText(response);
        if (shouldRetryHttpStatus(status) && attempt < maxAttempts) {
          await sleepBeforeRetry(125);
          continue;
        }
        return { ok: false, status, text, attempts: attempt, streamed: false };
      }

      const traceEmitter = createOpenAIResponsesStreamingTraceEmitter(
        input.model,
        input.traceListener,
      );
      readingStream = true;
      const streamResult = await readResponseStreamText(response, traceEmitter);
      return {
        ok: true,
        status,
        text: streamResult.text,
        attempts: attempt,
        streamed: streamResult.streamed,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (readingStream) {
        throw new OpenAIResponsesLiveStreamReadError(lastError);
      }
      if (attempt < maxAttempts) {
        await sleepBeforeRetry(125);
        continue;
      }
    }
  }

  throw new Error(`HTTP POST failed after ${maxAttempts} attempts: ${lastError ?? "unknown transport error"}`);
}

class OpenAIResponsesLiveStreamReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIResponsesLiveStreamReadError";
  }
}

class OpenAIChatLiveStreamReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIChatLiveStreamReadError";
  }
}

function hasExplicitProxyConfig(): boolean {
  return [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ].some((key) => Boolean(process.env[key]?.trim()));
}
function createOpenAIPromptCacheKey(cwd: string, systemPrompt: string): string {
  return `unclecode-${createHash("sha256")
    .update(cwd)
    .update("\0")
    .update(systemPrompt)
    .digest("hex")
    .slice(0, 40)}`;
}

function resolveOpenAIPromptCacheRetention(model: string): "24h" | undefined {
  const match = /^gpt-5\.(\d+)/i.exec(model.trim());
  return match && Number(match[1]) >= 2 ? "24h" : undefined;
}

function isOfficialOpenAIRequestUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Mirror of the Rust chat transport's OPENAI_API_BASE_URL override so the
 * live-stream fetch path targets the same endpoint as the Rust fallback
 * (local QA fake servers and OpenAI-compatible backends).
 */
function resolveOpenAIChatUrl(specUrl: string): string {
  const base = process.env.OPENAI_API_BASE_URL?.trim();
  if (!base) {
    return specUrl;
  }
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

function enableOpenAIChatStreamBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) {
      return body;
    }
    return JSON.stringify({ ...parsed, stream: true });
  } catch {
    return body;
  }
}

type OpenAIChatLivePostInput = {
  readonly fetchImpl: OpenAIFetch;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly model: string;
  readonly traceListener?: ProviderTraceListener | undefined;
  readonly maxAttempts: number;
  readonly signal?: AbortSignal | undefined;
};

async function postOpenAIChatWithLiveStream(
  input: OpenAIChatLivePostInput,
): Promise<OpenAIResponsesHttpResponse> {
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let readingStream = false;
    try {
      throwIfAborted(input.signal);
      const response = await input.fetchImpl(input.url, {
        method: "POST",
        headers: input.headers,
        body: input.body,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const status = typeof response.status === "number" ? response.status : response.ok ? 200 : 0;

      if (!response.ok) {
        const text = await readResponseText(response);
        if (shouldRetryHttpStatus(status) && attempt < maxAttempts) {
          await sleepBeforeRetry(125);
          continue;
        }
        return { ok: false, status, text, attempts: attempt, streamed: false };
      }

      const traceEmitter = createOpenAIChatStreamingTraceEmitter(
        input.model,
        input.traceListener,
      );
      readingStream = true;
      const streamResult = await readResponseStreamText(response, traceEmitter.onPayload);
      traceEmitter.flush();
      return {
        ok: true,
        status,
        text: streamResult.text,
        attempts: attempt,
        // OpenAI-compatible backends may ignore `stream:true` and answer
        // with plain JSON; only report a streamed response when the payload
        // is actually SSE so buffered reasoning still gets emitted once.
        streamed: streamResult.streamed && streamResult.text.trimStart().startsWith("data:"),
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
      if (readingStream) {
        // Deltas may already be on screen; retrying would duplicate them.
        throw new OpenAIChatLiveStreamReadError(lastError);
      }
      if (attempt < maxAttempts) {
        await sleepBeforeRetry(125);
        continue;
      }
    }
  }

  throw new Error(`HTTP POST failed after ${maxAttempts} attempts: ${lastError ?? "unknown transport error"}`);
}

/**
 * Emit live traces for OpenAI chat-completions SSE chunks. Assistant
 * content deltas flow straight through; reasoning deltas share the same
 * secret-boundary hold-back buffer the Codex Responses stream uses.
 */
function createOpenAIChatStreamingTraceEmitter(
  model: string,
  listener?: ProviderTraceListener,
): {
  readonly onPayload: (payload: Record<string, unknown>) => void;
  readonly flush: () => void;
} {
  let fallbackCounter = 0;
  let reasoningItemId = "";
  let pendingReasoning = "";

  const emitReasoning = (delta: string, forceFlush = false) => {
    pendingReasoning += delta;
    const { safe, pending } = forceFlush
      ? { safe: pendingReasoning, pending: "" }
      : splitReasoningDeltaForSecretBoundary(pendingReasoning);
    pendingReasoning = pending;
    if (safe) {
      emitProviderTrace(
        listener,
        buildProviderReasoningDeltaTraceWithItemId(
          "openai",
          model,
          "text",
          reasoningItemId || "chat_reasoning",
          safe,
        ),
      );
    }
  };

  return {
    onPayload(payload) {
      if (!listener) {
        return;
      }
      const chunkId = typeof payload.id === "string" && payload.id.trim() ? payload.id : "";
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      for (const choice of choices) {
        if (!isRecord(choice)) {
          continue;
        }
        const delta = isRecord(choice.delta) ? choice.delta : {};
        const content = typeof delta.content === "string" ? delta.content : "";
        if (content) {
          emitProviderTrace(listener, {
            type: "assistant.delta",
            level: "default",
            provider: "openai",
            model,
            itemId: chunkId || `chat_stream_${++fallbackCounter}`,
            delta: content,
          });
        }
        const reasoningDelta = typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string"
            ? delta.reasoning
            : "";
        if (reasoningDelta) {
          reasoningItemId = chunkId || reasoningItemId;
          emitReasoning(reasoningDelta);
        }
      }
    },
    flush() {
      if (pendingReasoning) {
        emitReasoning("", true);
      }
    },
  };
}

function createOpenAIResponsesStreamingTraceEmitter(
  model: string,
  listener?: ProviderTraceListener,
): (payload: Record<string, unknown>) => void {
  let fallbackCounter = 0;
  const pendingReasoningDeltas = new Map<string, {
    readonly itemId: string;
    readonly kind: "summary" | "text";
    pending: string;
  }>();

  const emitReasoningDelta = (
    itemId: string,
    kind: "summary" | "text",
    delta: string,
    forceFlush = false,
  ) => {
    const key = `${kind}:${itemId}`;
    const state = pendingReasoningDeltas.get(key) ?? { itemId, kind, pending: "" };
    state.pending += delta;
    const { safe, pending } = forceFlush
      ? { safe: state.pending, pending: "" }
      : splitReasoningDeltaForSecretBoundary(state.pending);
    state.pending = pending;

    if (safe) {
      emitProviderTrace(
        listener,
        buildProviderReasoningDeltaTraceWithItemId("openai", model, kind, itemId, safe),
      );
    }

    if (state.pending) {
      pendingReasoningDeltas.set(key, state);
    } else {
      pendingReasoningDeltas.delete(key);
    }
  };

  const flushReasoningItem = (itemId: string) => {
    for (const [key, state] of pendingReasoningDeltas.entries()) {
      if (state.itemId === itemId) {
        emitReasoningDelta(state.itemId, state.kind, "", true);
        pendingReasoningDeltas.delete(key);
      }
    }
  };

  const flushAllReasoningItems = () => {
    for (const state of [...pendingReasoningDeltas.values()]) {
      emitReasoningDelta(state.itemId, state.kind, "", true);
    }
  };

  return (payload) => {
    const type = typeof payload.type === "string" ? payload.type : "";
    if (type === "response.output_item.done" && isRecord(payload.item) && typeof payload.item.id === "string") {
      flushReasoningItem(payload.item.id);
      return;
    }
    if (type === "response.completed") {
      flushAllReasoningItems();
      return;
    }

    const delta = typeof payload.delta === "string" ? payload.delta : "";
    if (!delta) {
      return;
    }
    const itemId = typeof payload.item_id === "string" && payload.item_id.trim()
      ? payload.item_id
      : `stream_${++fallbackCounter}`;

    if (type === "response.output_text.delta") {
      emitProviderTrace(listener, {
        type: "assistant.delta",
        level: "default",
        provider: "openai",
        model,
        itemId,
        delta,
      });
      return;
    }

    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      emitReasoningDelta(
        itemId,
        type === "response.reasoning_summary_text.delta" ? "summary" : "text",
        delta,
      );
    }
  };
}

const STREAM_SECRET_PREFIXES = [
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "glpat-",
  "AIza",
  "npm_",
  "hf_",
  "dapi",
  "sk-",
  "sk-ant-api03-",
  "sk-proj-",
  "sk-svcacct-",
  "sk-admin-",
] as const;

function splitReasoningDeltaForSecretBoundary(delta: string): { readonly safe: string; readonly pending: string } {
  let holdStart = delta.length;

  for (const prefix of STREAM_SECRET_PREFIXES) {
    for (let length = 1; length < prefix.length; length += 1) {
      if (delta.endsWith(prefix.slice(0, length))) {
        holdStart = Math.min(holdStart, delta.length - length);
      }
    }

    let index = delta.indexOf(prefix);
    while (index !== -1) {
      const tail = delta.slice(index + prefix.length);
      if (tail === "" || [...tail].every(isStreamSecretTokenChar)) {
        holdStart = Math.min(holdStart, index);
      }
      index = delta.indexOf(prefix, index + 1);
    }
  }

  return {
    safe: delta.slice(0, holdStart),
    pending: delta.slice(holdStart),
  };
}

function isStreamSecretTokenChar(char: string): boolean {
  return /[A-Za-z0-9_.-]/.test(char);
}

async function readResponseStreamText(
  response: Response,
  onPayload: (payload: Record<string, unknown>) => void,
): Promise<{ readonly text: string; readonly streamed: boolean }> {
  const reader = getResponseBodyReader(response);
  if (!reader) {
    return { text: await readResponseText(response), streamed: false };
  }

  const decoder = new TextDecoder();
  const parser = createSseJsonStreamParser(onPayload);
  let text = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = decodeResponseChunk(decoder, result.value);
      if (!chunk) {
        continue;
      }
      text += chunk;
      parser.push(chunk);
    }
    const tail = decoder.decode();
    if (tail) {
      text += tail;
      parser.push(tail);
    }
    parser.finish();
  } finally {
    reader.releaseLock?.();
  }

  return { text, streamed: true };
}

type ResponseBodyReader = {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  releaseLock?: () => void;
};

function getResponseBodyReader(response: Response): ResponseBodyReader | undefined {
  const body = (response as Response & {
    body?: { getReader?: () => ResponseBodyReader };
  }).body;
  return typeof body?.getReader === "function" ? body.getReader() : undefined;
}

function decodeResponseChunk(
  decoder: TextDecoder,
  value: Uint8Array | undefined,
): string {
  if (value === undefined) {
    return "";
  }
  return decoder.decode(value, { stream: true });
}

function createSseJsonStreamParser(onPayload: (payload: Record<string, unknown>) => void): {
  readonly push: (chunk: string) => void;
  readonly finish: () => void;
} {
  let pendingLine = "";
  let currentDataLines: string[] = [];

  const flush = () => {
    if (currentDataLines.length === 0) {
      return;
    }
    const raw = currentDataLines.join("\n").trim();
    currentDataLines = [];
    if (!raw || raw === "[DONE]") {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) {
        onPayload(parsed);
      }
    } catch {
      // Ignore partial or malformed SSE records; the final Rust parser still
      // validates the complete response before tool execution.
    }
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      flush();
      return;
    }
    if (line.startsWith("data:")) {
      const data = line.slice("data:".length).trim();
      if (data) {
        currentDataLines.push(data);
      }
    }
  };

  return {
    push(chunk: string) {
      if (!chunk) {
        return;
      }
      const lines = `${pendingLine}${chunk}`.split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    },
    finish() {
      if (pendingLine) {
        processLine(pendingLine);
        pendingLine = "";
      }
      flush();
    },
  };
}

function parseOpenAIChatResponse(raw: string, model?: string): RustOpenAIChatResponse {
  const stdout = runRustCommandSync(
    ["rust", "provider", "openai-chat-response-json", model ?? "-"],
    process.cwd(),
    process.env,
    raw,
  ).trim();
  const parsed = JSON.parse(stdout) as unknown;
  if (
    !isRecord(parsed)
    || typeof parsed.content !== "string"
    || typeof parsed.reasoning !== "string"
    || !Array.isArray(parsed.toolCalls)
    || typeof parsed.promptTokens !== "number"
    || typeof parsed.completionTokens !== "number"
    || typeof parsed.costUsd !== "number"
  ) {
    throw new Error("Rust OpenAI chat response parsing returned an invalid payload.");
  }

  return {
    content: parsed.content,
    reasoning: parsed.reasoning,
    toolCalls: parsed.toolCalls
      .filter((toolCall): toolCall is Record<string, unknown> => isRecord(toolCall))
      .map((toolCall) => ({
        id: typeof toolCall.id === "string" ? toolCall.id : "",
        name: typeof toolCall.name === "string" ? toolCall.name : "",
        argumentsJson: typeof toolCall.argumentsJson === "string" ? toolCall.argumentsJson : "{}",
      })),
    promptTokens: parsed.promptTokens,
    completionTokens: parsed.completionTokens,
    cacheReadTokens: typeof parsed.cacheReadTokens === "number" ? parsed.cacheReadTokens : 0,
    costUsd: parsed.costUsd,
    actions: parseProviderActions(Array.isArray(parsed.actions) ? parsed.actions : []),
  };
}

async function readResponseText(response: Response): Promise<string> {
  if (typeof response.text === "function") {
    return await response.text();
  }
  const responseWithJson = response as Response & { json?: () => Promise<unknown> };
  if (typeof responseWithJson.json === "function") {
    return JSON.stringify(await responseWithJson.json());
  }
  return "";
}

function resolveGlobalFetchImpl(): OpenAIFetch | undefined {
  return typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : undefined;
}

function shouldRetryHttpStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function sleepBeforeRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function throwIfAborted(signal?: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function postWithRustHttp(
  url: string,
  headers: Record<string, string>,
  body: string,
): RustHttpResponse {
  const raw = runRustCommandSync(
    ["rust", "http", "post", url],
    process.cwd(),
    process.env,
    `${JSON.stringify(headers)}\0${body}`,
  ).trim();
  return parseRustHttpResponse(raw, "Rust HTTP transport");
}

async function postWithRustHttpAsync(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal | undefined,
): Promise<RustHttpResponse> {
  const raw = (await runRustCommand(
    ["rust", "http", "post", url],
    process.cwd(),
    `${JSON.stringify(headers)}\0${body}`,
    process.env,
    { signal },
  )).trim();
  return parseRustHttpResponse(raw, "Rust HTTP transport");
}

function postAnthropicWithRust(apiKey: string, body: string): RustHttpResponse {
  return postProviderWithRust(["rust", "provider", "anthropic-post"], `${apiKey}\0${body}`, "Anthropic");
}

async function postAnthropicWithRustAsync(
  apiKey: string,
  body: string,
  signal?: AbortSignal | undefined,
): Promise<RustHttpResponse> {
  return await postProviderWithRustAsync(["rust", "provider", "anthropic-post"], `${apiKey}\0${body}`, "Anthropic", signal);
}

function postOpenAIWithRust(
  runtime: "api" | "codex",
  apiKey: string,
  body: string,
  accountId?: string | null,
): RustHttpResponse {
  const args = ["rust", "provider", "openai-post", runtime];
  if (runtime === "codex") {
    args.push(accountId?.trim() ? accountId.trim() : "-");
  }
  return postProviderWithRust(args, `${apiKey}\0${body}`, "OpenAI");
}

async function postOpenAIWithRustAsync(
  runtime: "api" | "codex",
  apiKey: string,
  body: string,
  accountId?: string | null,
  signal?: AbortSignal | undefined,
): Promise<RustHttpResponse> {
  const args = ["rust", "provider", "openai-post", runtime];
  if (runtime === "codex") {
    args.push(accountId?.trim() ? accountId.trim() : "-");
  }
  return await postProviderWithRustAsync(args, `${apiKey}\0${body}`, "OpenAI", signal);
}

function postGeminiWithRust(apiKey: string, model: string, body: string): RustHttpResponse {
  return postProviderWithRust(["rust", "provider", "gemini-post", model], `${apiKey}\0${body}`, "Gemini");
}

async function postGeminiWithRustAsync(
  apiKey: string,
  model: string,
  body: string,
  signal?: AbortSignal | undefined,
): Promise<RustHttpResponse> {
  return await postProviderWithRustAsync(["rust", "provider", "gemini-post", model], `${apiKey}\0${body}`, "Gemini", signal);
}

function postProviderWithRust(args: readonly string[], stdin: string, providerName: string): RustHttpResponse {
  const raw = runRustCommandSync([...args], process.cwd(), process.env, stdin).trim();
  return parseRustHttpResponse(raw, `Rust ${providerName} HTTP transport`);
}

async function postProviderWithRustAsync(
  args: readonly string[],
  stdin: string,
  providerName: string,
  signal?: AbortSignal | undefined,
): Promise<RustHttpResponse> {
  const raw = (await runRustCommand([...args], process.cwd(), stdin, process.env, { signal })).trim();
  return parseRustHttpResponse(raw, `Rust ${providerName} HTTP transport`);
}

function parseRustHttpResponse(raw: string, transportName: string): RustHttpResponse {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean" || typeof parsed.status !== "number") {
    throw new Error(`${transportName} returned an invalid response envelope.`);
  }
  const text = typeof parsed.text === "string"
    ? parsed.text
    : typeof parsed.body === "string"
      ? parsed.body
      : "";
  return {
    ok: parsed.ok,
    status: parsed.status,
    text,
    ...(typeof parsed.attempts === "number" ? { attempts: parsed.attempts } : {}),
  };
}

function buildProviderRequestError(
  provider: RuntimeProviderName,
  status: number,
  responseText: string,
  attempts?: number | undefined,
): string {
  const args = ["rust", "provider", "request-error", provider, String(status)];
  if (typeof attempts === "number") {
    args.push(String(attempts));
  }
  return runRustCommandSync(
    args,
    process.cwd(),
    process.env,
    responseText,
  ).trim();
}

function runOpenAIChatQueryWithRust(input: {
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: ReadonlyArray<ProviderQueryMessage>;
  readonly tools: readonly ToolDefinition[];
  readonly reasoningEffort?: string | undefined;
}): ProviderQueryResult {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "openai-chat-query",
      input.model,
      input.reasoningEffort ?? "-",
    ],
    process.cwd(),
    process.env,
    `${input.apiKey}\0${input.systemPrompt}\0${JSON.stringify(input.messages)}\0${JSON.stringify(input.tools)}`,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.content !== "string" || !Array.isArray(parsed.actions)) {
    throw new Error("Rust OpenAI query returned an invalid response envelope.");
  }
  return createProviderQueryResult(
    parsed.content,
    parseProviderActions(parsed.actions),
    typeof parsed.costUsd === "number" ? parsed.costUsd : 0,
    createProviderTokenUsage(
      typeof parsed.promptTokens === "number" ? parsed.promptTokens : 0,
      typeof parsed.completionTokens === "number" ? parsed.completionTokens : 0,
      typeof parsed.cacheReadTokens === "number" ? parsed.cacheReadTokens : 0,
      0,
      true,
    ),
  );
}

function runOpenAIChatCompletionWithRust(input: {
  readonly apiKey: string;
  readonly model: string;
  readonly messages: readonly OpenAIMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly reasoningEffort?: string | undefined;
}): RustOpenAIChatCompletionResult {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "openai-chat-complete",
      input.model,
      input.reasoningEffort ?? "-",
    ],
    process.cwd(),
    process.env,
    `${input.apiKey}\0${JSON.stringify(input.messages)}\0${JSON.stringify(input.tools)}`,
  ).trim();
  return parseOpenAIChatCompletionRustResult(raw);
}

async function runOpenAIChatCompletionWithRustAsync(input: {
  readonly apiKey: string;
  readonly model: string;
  readonly messages: readonly OpenAIMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly reasoningEffort?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<RustOpenAIChatCompletionResult> {
  const raw = (await runRustCommand(
    [
      "rust",
      "provider",
      "openai-chat-complete",
      input.model,
      input.reasoningEffort ?? "-",
    ],
    process.cwd(),
    `${input.apiKey}\0${JSON.stringify(input.messages)}\0${JSON.stringify(input.tools)}`,
    process.env,
    { signal: input.signal },
  )).trim();
  return parseOpenAIChatCompletionRustResult(raw);
}

function parseOpenAIChatCompletionRustResult(raw: string): RustOpenAIChatCompletionResult {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed)
    || typeof parsed.content !== "string"
    || !Array.isArray(parsed.toolCalls)
    || typeof parsed.promptTokens !== "number"
    || typeof parsed.completionTokens !== "number"
    || typeof parsed.costUsd !== "number"
  ) {
    throw new Error("Rust OpenAI chat completion returned an invalid response envelope.");
  }
  return {
    content: parsed.content,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    toolCalls: parsed.toolCalls
      .filter((toolCall): toolCall is Record<string, unknown> => isRecord(toolCall))
      .map((toolCall) => {
        const fn = isRecord(toolCall.function) ? toolCall.function : {};
        return {
          id: typeof toolCall.id === "string" ? toolCall.id : "",
          function: {
            name: typeof fn.name === "string" ? fn.name : "",
            arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
          },
        };
      }),
    promptTokens: parsed.promptTokens,
    completionTokens: parsed.completionTokens,
    cacheReadTokens: typeof parsed.cacheReadTokens === "number" ? parsed.cacheReadTokens : 0,
    costUsd: parsed.costUsd,
    actions: parseProviderActions(Array.isArray(parsed.actions) ? parsed.actions : []),
  };
}

function emitProviderTrace(
  listener: ProviderTraceListener | undefined,
  event: ProviderToolTraceEvent,
): void {
  if (!listener) {
    return;
  }

  try {
    listener(event);
  } catch {
    // Ignore trace sink failures so the work loop stays hot.
  }
}

function getProviderToolLoopMax(): number {
  if (cachedProviderToolLoopMax !== undefined) {
    return cachedProviderToolLoopMax;
  }
  const raw = runRustCommandSync(
    ["rust", "provider", "loop-limit"],
    process.cwd(),
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.maxIterations !== "number" || parsed.maxIterations < 1) {
    throw new Error("Rust provider loop limit returned an invalid payload.");
  }
  cachedProviderToolLoopMax = Math.floor(parsed.maxIterations);
  return cachedProviderToolLoopMax;
}

function buildOpenAIRequestSpec(runtime: "api" | "codex", apiKey: string, accountId?: string | null): RustRequestSpec {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "openai-request-spec-json",
      runtime,
      accountId?.trim() ? accountId.trim() : "-",
    ],
    process.cwd(),
    process.env,
    apiKey,
  ).trim();
  return parseRustRequestSpec(raw, "OpenAI");
}

function parseRustRequestSpec(raw: string, providerName: string): RustRequestSpec {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.url !== "string" || !isRecord(parsed.headers)) {
    throw new Error(`Rust ${providerName} request spec returned an invalid payload.`);
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.headers)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  if (!parsed.url) {
    throw new Error(`Rust ${providerName} request spec did not return a URL.`);
  }
  return { url: parsed.url, headers };
}

function buildOpenAIChatBody(input: {
  readonly model: string;
  readonly messagesJson: string;
  readonly toolsJson: string;
  readonly includeTools: boolean;
  readonly reasoningEffort?: string | undefined;
  readonly promptCacheKey?: string | undefined;
  readonly promptCacheRetention?: string | undefined;
}): string {
  return runRustCommandSync(
    [
      "rust",
      "provider",
      "openai-chat-body",
      input.model,
      input.reasoningEffort ?? "-",
      input.includeTools ? "yes" : "no",
      input.promptCacheKey ?? "-",
      input.promptCacheRetention ?? "-",
    ],
    process.cwd(),
    process.env,
    `${input.messagesJson}\0${input.toolsJson}`,
  ).trim();
}

function buildOpenAIChatTools(tools: readonly ToolDefinition[]): string {
  return runRustCommandSync(
    ["rust", "provider", "openai-chat-tools"],
    process.cwd(),
    process.env,
    JSON.stringify(tools),
  ).trim();
}

function buildOpenAIAssistantMessage(
  content: string,
  toolCalls: readonly unknown[],
  reasoningContent?: string | undefined,
): OpenAIMessage {
  const raw = runRustCommandSync(
    ["rust", "provider", "openai-assistant-message"],
    process.cwd(),
    process.env,
    `${content}\0${JSON.stringify(toolCalls)}\0${reasoningContent ?? ""}`,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.role !== "assistant" || typeof parsed.content !== "string") {
    throw new Error("Rust OpenAI assistant message conversion returned an invalid payload.");
  }
  return parsed as OpenAIMessage;
}

function buildOpenAIQueryMessages(messages: ReadonlyArray<ProviderQueryMessage>, defaultSystemPrompt: string): string {
  return runRustCommandSync(
    ["rust", "provider", "openai-query-messages"],
    process.cwd(),
    process.env,
    `${defaultSystemPrompt}\0${JSON.stringify(messages)}`,
  ).trim();
}

function buildOpenAICodexBody(input: {
  readonly model: string;
  readonly instructions: string;
  readonly inputJson: string;
  readonly toolsJson: string;
  readonly toolChoice: "auto" | "none";
  readonly reasoningEffort?: string | undefined;
  readonly promptCacheKey?: string | undefined;
  readonly promptCacheRetention?: string | undefined;
}): string {
  return runRustCommandSync(
    [
      "rust",
      "provider",
      "openai-codex-body",
      input.model,
      input.reasoningEffort ?? "-",
      input.toolChoice,
      input.promptCacheKey ?? "-",
      input.promptCacheRetention ?? "-",
    ],
    process.cwd(),
    process.env,
    `${input.instructions}\0${input.inputJson}\0${input.toolsJson}`,
  ).trim();
}

function buildOpenAIResponsesInput(messages: readonly OpenAIMessage[]): string {
  return runRustCommandSync(
    ["rust", "provider", "openai-responses-input"],
    process.cwd(),
    process.env,
    JSON.stringify(messages),
  ).trim();
}

function buildOpenAIResponsesTools(tools: readonly ToolDefinition[]): string {
  return runRustCommandSync(
    ["rust", "provider", "openai-responses-tools"],
    process.cwd(),
    process.env,
    JSON.stringify(tools),
  ).trim();
}

function buildGeminiQueryMessages(
  messages: ReadonlyArray<ProviderQueryMessage>,
  defaultSystemPrompt: string,
): RustGeminiQueryMessages {
  const raw = runRustCommandSync(
    ["rust", "provider", "gemini-query-messages"],
    process.cwd(),
    process.env,
    `${defaultSystemPrompt}\0${JSON.stringify(messages)}`,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.systemInstruction !== "string" || !Array.isArray(parsed.contents)) {
    throw new Error("Rust Gemini query message conversion returned an invalid payload.");
  }
  return {
    systemInstruction: parsed.systemInstruction,
    contents: parsed.contents as GeminiContent[],
  };
}

function buildGeminiFunctionDeclarations(tools: readonly ToolDefinition[]): Array<Record<string, unknown>> {
  const raw = runRustCommandSync(
    ["rust", "provider", "gemini-tools"],
    process.cwd(),
    process.env,
    JSON.stringify(tools),
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
}

function buildGeminiGenerateContentRequest(input: {
  readonly model: string;
  readonly systemInstruction: string;
  readonly contents: readonly GeminiContent[];
  readonly functionDeclarations: readonly Record<string, unknown>[];
  readonly includeTools: boolean;
}): GeminiGenerateContentRequest {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "gemini-generate-request",
      input.model,
      input.includeTools ? "yes" : "no",
    ],
    process.cwd(),
    process.env,
    `${input.systemInstruction}\0${JSON.stringify(input.contents)}\0${JSON.stringify(input.functionDeclarations)}`,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed)
    || typeof parsed.model !== "string"
    || !Array.isArray(parsed.contents)
    || !isRecord(parsed.config)
  ) {
    throw new Error("Rust Gemini request envelope conversion returned an invalid payload.");
  }
  return parsed as GeminiGenerateContentRequest;
}

function buildGeminiRestGenerateContentRequest(
  request: GeminiGenerateContentRequest,
): GeminiGenerateContentRequest {
  const contents = request.contents;
  const config = request.config;
  if (!Array.isArray(contents) || !isRecord(config)) {
    throw new Error("Gemini SDK request envelope cannot be converted to REST JSON.");
  }

  const rest: Record<string, unknown> = { contents };
  const generationConfig: Record<string, unknown> = {};
  let toolConfig: unknown;
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) {
      continue;
    }
    if (key === "systemInstruction") {
      rest.systemInstruction = normalizeGeminiRestSystemInstruction(value);
      continue;
    }
    if (key === "tools") {
      if (Array.isArray(value) && value.length > 0) {
        rest.tools = value.map(normalizeGeminiRestTool);
      }
      continue;
    }
    if (key === "toolConfig") {
      toolConfig = value;
      continue;
    }
    if (["safetySettings", "cachedContent", "serviceTier", "store"].includes(key)) {
      rest[key] = value;
      continue;
    }
    generationConfig[key] = value;
  }
  if (Object.keys(generationConfig).length > 0) {
    rest.generationConfig = generationConfig;
  }
  if (rest.tools !== undefined && toolConfig !== undefined) {
    rest.toolConfig = toolConfig;
  }
  return rest as GeminiGenerateContentRequest;
}

function normalizeGeminiRestSystemInstruction(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return { parts: [{ text: value }] };
}

function normalizeGeminiRestTool(tool: unknown): unknown {
  if (!isRecord(tool)) {
    return tool;
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tool)) {
    normalized[key] = key === "functionDeclarations" && Array.isArray(value)
      ? value.map(normalizeGeminiRestFunctionDeclaration)
      : value;
  }
  return normalized;
}

function normalizeGeminiRestFunctionDeclaration(declaration: unknown): unknown {
  if (!isRecord(declaration)) {
    return declaration;
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(declaration)) {
    if (key === "parametersJsonSchema") {
      if (declaration.parameters === undefined) {
        normalized.parameters = value;
      }
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function parseGeminiResponse(response: unknown, model?: string): RustGeminiResponse {
  const responseRecord = isRecord(response) ? response : {};
  return parseGeminiResponsePayload(JSON.stringify({
    ...responseRecord,
    text: typeof responseRecord.text === "string" ? responseRecord.text : undefined,
  }), model);
}

function parseGeminiResponseText(responseText: string, model?: string): RustGeminiResponse {
  return parseGeminiResponsePayload(responseText, model);
}

function parseGeminiResponsePayload(responseJson: string, model?: string): RustGeminiResponse {
  const raw = runRustCommandSync(
    ["rust", "provider", "gemini-response", model ?? "-"],
    process.cwd(),
    process.env,
    responseJson,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed)
    || typeof parsed.content !== "string"
    || !Array.isArray(parsed.actions)
    || typeof parsed.promptTokens !== "number"
    || typeof parsed.completionTokens !== "number"
    || typeof parsed.costUsd !== "number"
    || !isRecord(parsed.modelContent)
    || parsed.modelContent.role !== "model"
    || !Array.isArray(parsed.modelContent.parts)
  ) {
    throw new Error("Rust Gemini response parsing returned an invalid payload.");
  }
  return {
    content: parsed.content,
    actions: parseProviderActions(parsed.actions),
    promptTokens: parsed.promptTokens,
    completionTokens: parsed.completionTokens,
    cacheReadTokens: typeof parsed.cacheReadTokens === "number" ? parsed.cacheReadTokens : 0,
    costUsd: parsed.costUsd,
    modelContent: parsed.modelContent as GeminiContent,
  };
}

function buildAnthropicMessagesRequest(input: {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly AnthropicMessage[];
  readonly tools: readonly ToolDefinition[];
}): AnthropicMessagesRequest {
  const raw = runRustCommandSync(
    ["rust", "provider", "anthropic-messages-request", input.model],
    process.cwd(),
    process.env,
    `${input.system}\0${JSON.stringify(input.messages)}\0${JSON.stringify(input.tools)}`,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed)
    || typeof parsed.model !== "string"
    || (parsed.system !== undefined && !Array.isArray(parsed.system))
    || !Array.isArray(parsed.messages)
    || !Array.isArray(parsed.tools)
  ) {
    throw new Error("Rust Anthropic request envelope conversion returned an invalid payload.");
  }
  return parsed as AnthropicMessagesRequest;
}

function parseAnthropicResponse(response: unknown, model?: string): RustAnthropicResponse {
  return parseAnthropicResponsePayload(JSON.stringify(response ?? {}), model);
}

function parseAnthropicResponseText(responseText: string, model?: string): RustAnthropicResponse {
  return parseAnthropicResponsePayload(responseText, model);
}

function parseAnthropicResponsePayload(responseJson: string, model?: string): RustAnthropicResponse {
  const raw = runRustCommandSync(
    ["rust", "provider", "anthropic-response", model ?? "-"],
    process.cwd(),
    process.env,
    responseJson,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed)
    || typeof parsed.content !== "string"
    || !Array.isArray(parsed.actions)
    || typeof parsed.promptTokens !== "number"
    || typeof parsed.completionTokens !== "number"
    || typeof parsed.costUsd !== "number"
    || !isRecord(parsed.assistantMessage)
    || parsed.assistantMessage.role !== "assistant"
    || !Array.isArray(parsed.assistantMessage.content)
  ) {
    throw new Error("Rust Anthropic response parsing returned an invalid payload.");
  }
  return {
    content: parsed.content,
    actions: parseProviderActions(parsed.actions),
    promptTokens: parsed.promptTokens,
    completionTokens: parsed.completionTokens,
    cacheReadTokens: typeof parsed.cacheReadTokens === "number" ? parsed.cacheReadTokens : 0,
    cacheWriteTokens: typeof parsed.cacheWriteTokens === "number" ? parsed.cacheWriteTokens : 0,
    costUsd: parsed.costUsd,
    assistantMessage: parsed.assistantMessage as AnthropicMessage,
  };
}

function buildAnthropicQueryMessages(
  messages: ReadonlyArray<ProviderQueryMessage>,
  defaultSystemPrompt: string,
): RustAnthropicQueryMessages {
  const raw = runRustCommandSync(
    ["rust", "provider", "anthropic-query-messages"],
    process.cwd(),
    process.env,
    `${defaultSystemPrompt}\0${JSON.stringify(messages)}`,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.system !== "string" || !Array.isArray(parsed.messages)) {
    throw new Error("Rust Anthropic query message conversion returned an invalid payload.");
  }
  return {
    system: parsed.system,
    messages: parsed.messages as AnthropicMessage[],
  };
}

function resolveProviderLoopDecision(
  iteration: number,
  actionCount: number,
  maxIterations: number,
  assistantText: string,
): RustProviderLoopDecision {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "loop-decision",
      String(iteration),
      String(actionCount),
      String(maxIterations),
    ],
    process.cwd(),
    process.env,
    assistantText,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed)
    || (parsed.decision !== "continue" && parsed.decision !== "final" && parsed.decision !== "limit")
    || typeof parsed.text !== "string"
  ) {
    throw new Error("Rust provider loop decision returned an invalid payload.");
  }
  return parsed as RustProviderLoopDecision;
}

function resolveProviderIterationActionPlan(
  iteration: number,
  actionCount: number,
  maxIterations: number,
  assistantText: string,
): RustProviderIterationActionPlan {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "iteration-action-plan",
      String(iteration),
      String(actionCount),
      String(maxIterations),
    ],
    process.cwd(),
    process.env,
    assistantText,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed)
    || (parsed.decision !== "continue" && parsed.decision !== "final" && parsed.decision !== "limit")
    || typeof parsed.text !== "string"
    || typeof parsed.shouldDispatchTools !== "boolean"
  ) {
    throw new Error("Rust provider iteration action plan returned an invalid payload.");
  }
  return parsed as RustProviderIterationActionPlan;
}

function completeProviderTurnStep<T>(
  provider: RuntimeProviderName,
  iteration: number,
  maxIterations: number,
  previousAssistantText: string,
  responseText: string,
  actionCount: number,
  state: T[],
  responseEntries: readonly T[],
  toolResultOutcomes: readonly ProviderToolResultOutcome[],
): ProviderTurnStepResult {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "complete-turn-step",
      provider,
      String(iteration),
      String(actionCount),
      String(maxIterations),
    ],
    process.cwd(),
    process.env,
    `${previousAssistantText}\0${responseText}\0${JSON.stringify(state)}\0${JSON.stringify(responseEntries)}\0${JSON.stringify(toolResultOutcomes)}`,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed)
    || parsed.provider !== provider
    || !Array.isArray(parsed.state)
    || typeof parsed.assistantText !== "string"
    || (parsed.decision !== "continue" && parsed.decision !== "final" && parsed.decision !== "limit")
    || typeof parsed.text !== "string"
  ) {
    throw new Error("Rust provider complete turn step returned an invalid payload.");
  }
  state.splice(0, state.length, ...(parsed.state as T[]));
  return {
    decision: parsed.decision,
    text: parsed.text,
    assistantText: parsed.assistantText,
  };
}

function buildProviderToolExecutionStart(
  provider: RuntimeProviderName,
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
): ProviderToolExecutionStart {
  const raw = runRustCommandSync(
    ["rust", "provider", "tool-execution-start", provider, toolName, toolCallId],
    process.cwd(),
    process.env,
    JSON.stringify(input),
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.provider !== provider || typeof parsed.startedAt !== "number" || !isRecord(parsed.trace)) {
    throw new Error("Rust provider tool execution start returned an invalid payload.");
  }
  return {
    startedAt: parsed.startedAt,
    trace: parseProviderTraceEvent(JSON.stringify(parsed.trace)),
  };
}

async function executeProviderToolDispatches(
  provider: RuntimeProviderName,
  actions: readonly RustProviderAction[],
  definitions: readonly ToolDefinition[],
  executor: ToolExecutor,
  cwd: string,
  traceListener?: ProviderTraceListener,
  options: ProviderTurnOptions = {},
): Promise<ProviderToolResultOutcome[]> {
  const dispatchPlan = buildProviderToolDispatchPlan(provider, actions, definitions);
  const outcomes: ProviderToolResultOutcome[] = [...dispatchPlan.outcomes];
  for (const batch of buildProviderToolDispatchBatches(dispatchPlan.dispatches, definitions)) {
    throwIfAborted(options.signal);
    const executions = await Promise.all(batch.map((action) =>
      executeProviderToolAction(provider, action, executor, cwd, traceListener, options)
    ));
    outcomes.push(...executions.map((execution) => execution.outcome));
  }
  return outcomes;
}

async function executeProviderToolAction(
  provider: RuntimeProviderName,
  action: RustProviderAction,
  executor: ToolExecutor,
  cwd: string,
  traceListener?: ProviderTraceListener,
  options: ProviderTurnOptions = {},
): Promise<ProviderToolExecutionResult> {
  throwIfAborted(options.signal);

  const started = buildProviderToolExecutionStart(provider, action.tool, action.callId, action.input);
  emitProviderTrace(traceListener, started.trace);
  try {
    const result = await executor.execute({
      toolName: action.tool,
      input: action.input,
      cwd,
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    const execution = attachDisplayToolInput(
      buildProviderToolExecutionFinishResult(provider, action.tool, action.callId, started.startedAt, result),
      action.input,
    );
    emitProviderTrace(traceListener, execution.trace);
    return execution;
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const execution = attachDisplayToolInput(
      buildProviderToolExecutionFinish(provider, action.tool, action.callId, started.startedAt, true, message),
      action.input,
    );
    emitProviderTrace(traceListener, execution.trace);
    return execution;
  }
}

function buildProviderToolDispatchBatches(
  dispatches: readonly RustProviderAction[],
  definitions: readonly ToolDefinition[],
): readonly (readonly RustProviderAction[])[] {
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const batches: RustProviderAction[][] = [];
  let currentBatch: RustProviderAction[] = [];
  let currentResources = new Set<string>();

  const flush = () => {
    if (currentBatch.length === 0) {
      return;
    }
    batches.push(currentBatch);
    currentBatch = [];
    currentResources = new Set();
  };

  for (const action of dispatches) {
    const resources = resolveProviderToolDispatchResources(
      action,
      definitionsByName.get(action.tool)?.metadata,
    );
    if (!resources) {
      flush();
      batches.push([action]);
      continue;
    }
    if (resources.some((resource) => currentResources.has(resource))) {
      flush();
    }
    currentBatch.push(action);
    for (const resource of resources) {
      currentResources.add(resource);
    }
  }
  flush();
  return batches;
}

function resolveProviderToolDispatchResources(
  action: RustProviderAction,
  metadata: ToolMetadata | undefined,
): readonly string[] | undefined {
  if (!metadata || metadata.resources.length === 0) {
    return undefined;
  }
  const resolved: string[] = [];
  for (const resource of metadata.resources) {
    if (!resource.declared) {
      return undefined;
    }
    if (resource.resolver === "apply-patch-files") {
      const patchFiles = resolveApplyPatchResourceFiles(action.input.patch);
      if (patchFiles.length === 0) {
        return undefined;
      }
      resolved.push(...patchFiles.map((filePath) => `file:${filePath}`));
      continue;
    }
    resolved.push(resolveToolResourceTemplate(resource.template, action.input));
  }
  return resolved;
}

function resolveApplyPatchResourceFiles(patch: unknown): readonly string[] {
  if (typeof patch !== "string") {
    return [];
  }
  const files = new Set<string>();
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const filePath = match[1]?.trim();
    if (filePath) {
      files.add(filePath);
    }
  }
  return [...files];
}

function resolveToolResourceTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{([^}:]+)(?::-(.+?))?\}/g, (_match, key: string, fallback: string | undefined) => {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    return fallback ?? "*";
  });
}

function buildProviderReasoningDeltaTrace(
  provider: RuntimeProviderName,
  model: string,
  kind: "summary" | "text",
  delta: string,
): ProviderToolTraceEvent {
  const raw = runRustCommandSync(
    ["rust", "provider", "reasoning-delta", provider, model, kind],
    process.cwd(),
    process.env,
    delta,
  ).trim();
  return parseProviderTraceEvent(raw);
}

function buildProviderReasoningDeltaTraceWithItemId(
  provider: RuntimeProviderName,
  model: string,
  kind: "summary" | "text",
  itemId: string,
  delta: string,
): ProviderToolTraceEvent {
  const raw = runRustCommandSync(
    ["rust", "provider", "reasoning-delta-record", provider, model, kind, itemId],
    process.cwd(),
    process.env,
    delta,
  ).trim();
  return parseProviderTraceEvent(raw);
}

function buildProviderToolExecutionFinish(
  provider: RuntimeProviderName,
  toolName: string,
  toolCallId: string,
  startedAt: number,
  isError: boolean,
  content: string,
): ProviderToolExecutionResult {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "tool-execution-finish",
      provider,
      toolName,
      toolCallId,
      String(startedAt),
      isError ? "yes" : "no",
    ],
    process.cwd(),
    process.env,
    content,
  ).trim();
  return parseProviderToolExecutionResultPayload(provider, raw);
}

function buildProviderToolExecutionFinishResult(
  provider: RuntimeProviderName,
  toolName: string,
  toolCallId: string,
  startedAt: number,
  result: ToolResult,
): ProviderToolExecutionResult {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "tool-execution-finish-result",
      provider,
      toolName,
      toolCallId,
      String(startedAt),
    ],
    process.cwd(),
    process.env,
    JSON.stringify(result),
  ).trim();
  return parseProviderToolExecutionResultPayload(provider, raw);
}

function attachDisplayToolInput(
  execution: ProviderToolExecutionResult,
  input: Record<string, unknown>,
): ProviderToolExecutionResult {
  if (execution.trace.type !== "tool.completed") {
    return execution;
  }

  const displayInput: Record<string, string> = {};
  for (const key of ["path", "query", "command"] as const) {
    const value = input[key];
    if (typeof value === "string") {
      displayInput[key] = value;
    }
  }

  return {
    ...execution,
    trace: {
      ...execution.trace,
      input: displayInput,
    },
  };
}

function parseProviderToolExecutionResultPayload(
  provider: RuntimeProviderName,
  raw: string,
): ProviderToolExecutionResult {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.provider !== provider || !isRecord(parsed.trace) || !isRecord(parsed.outcome)) {
    throw new Error("Rust provider tool execution returned an invalid payload.");
  }
  const outcome = parsed.outcome;
  const kind: "success" | "error" = outcome.kind === "success" ? "success" : "error";
  return {
    trace: parseProviderTraceEvent(JSON.stringify(parsed.trace)),
    outcome: {
      toolName: typeof outcome.toolName === "string" ? outcome.toolName : "",
      toolCallId: typeof outcome.toolCallId === "string" ? outcome.toolCallId : "",
      kind,
      isError: outcome.isError !== false,
      content: typeof outcome.content === "string" ? outcome.content : "",
    },
  };
}

function buildProviderToolDispatchPlan(
  provider: RuntimeProviderName,
  actions: readonly RustProviderAction[],
  definitions: readonly ToolDefinition[],
): ProviderToolDispatchPlan {
  const raw = runRustCommandSync(
    ["rust", "provider", "tool-dispatch-plan", provider],
    process.cwd(),
    process.env,
    `${JSON.stringify(actions)}\0${JSON.stringify(definitions.map((definition) => definition.name))}`,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.provider !== provider || !Array.isArray(parsed.dispatches) || !Array.isArray(parsed.outcomes)) {
    throw new Error("Rust provider tool dispatch plan returned an invalid payload.");
  }
  return {
    dispatches: parseProviderActions(parsed.dispatches),
    outcomes: parsed.outcomes
      .filter((outcome): outcome is Record<string, unknown> => isRecord(outcome))
      .map((outcome): ProviderToolResultOutcome => {
        const kind: "success" | "error" = outcome.kind === "success" ? "success" : "error";
        return {
          toolName: typeof outcome.toolName === "string" ? outcome.toolName : "",
          toolCallId: typeof outcome.toolCallId === "string" ? outcome.toolCallId : "",
          kind,
          isError: outcome.isError !== false,
          content: typeof outcome.content === "string" ? outcome.content : "",
        };
      })
      .filter((outcome) => outcome.toolName.length > 0 && outcome.toolCallId.length > 0),
  };
}

function startProviderTurnState<T>(
  provider: RuntimeProviderName,
  state: T[],
  prompt: string,
  attachments: readonly ProviderInputAttachment[],
): void {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "start-turn",
      provider,
      prompt,
    ],
    process.cwd(),
    process.env,
    `${JSON.stringify(state)}\0${JSON.stringify(attachments)}`,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.provider !== provider || !Array.isArray(parsed.state)) {
    throw new Error("Rust provider turn start returned an invalid payload.");
  }
  state.splice(0, state.length, ...(parsed.state as T[]));
}

function resetProviderTurnState<T>(
  provider: RuntimeProviderName,
  state: T[],
  systemPrompt: string,
): void {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "reset-state",
      provider,
    ],
    process.cwd(),
    process.env,
    systemPrompt,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.provider !== provider || !Array.isArray(parsed.state)) {
    throw new Error("Rust provider state reset returned an invalid payload.");
  }
  state.splice(0, state.length, ...(parsed.state as T[]));
}

function resolveProviderRuntimeSettings(
  provider: RuntimeProviderName,
  currentModel: string,
  currentReasoning: RuntimeReasoningConfig | undefined,
  settings: {
    reasoning?: RuntimeReasoningConfig | undefined;
    model?: string | undefined;
  },
): { readonly model: string; readonly reasoning?: RuntimeReasoningConfig } {
  const raw = runRustCommandSync(
    [
      "rust",
      "provider",
      "runtime-settings",
      provider,
      currentModel,
    ],
    process.cwd(),
    process.env,
    `${currentReasoning ? JSON.stringify(currentReasoning) : "-"}\0${JSON.stringify(settings)}`,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.provider !== provider || typeof parsed.model !== "string") {
    throw new Error("Rust provider runtime settings returned an invalid payload.");
  }
  return {
    model: parsed.model,
    ...(isRuntimeReasoningConfig(parsed.reasoning) ? { reasoning: parsed.reasoning } : {}),
  };
}

function parseProviderTraceEvent(raw: string): ProviderToolTraceEvent {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed)
    || (
      parsed.type !== "tool.started" &&
      parsed.type !== "tool.completed" &&
      parsed.type !== "reasoning.delta" &&
      parsed.type !== "assistant.delta"
    )
  ) {
    throw new Error("Rust provider trace returned an invalid payload.");
  }
  return parsed as ProviderToolTraceEvent;
}

function parseProviderActions(actions: readonly unknown[]): RustProviderAction[] {
  return actions
    .map((action) => {
      if (!isRecord(action)) {
        return null;
      }
      const callId = typeof action.callId === "string" ? action.callId : "";
      const tool = typeof action.tool === "string" ? action.tool : "";
      if (!callId || !tool) {
        return null;
      }
      return {
        callId,
        tool,
        input: isRecord(action.input) ? action.input : {},
      };
    })
    .filter((action): action is RustProviderAction => action !== null);
}

function isRuntimeReasoningConfig(value: unknown): value is RuntimeReasoningConfig {
  return isRecord(value)
    && typeof value.effort === "string"
    && typeof value.source === "string"
    && isRecord(value.support)
    && typeof value.support.status === "string";
}

function isRuntimeProviderKind(value: string): value is RuntimeProviderKind {
  return value === "anthropic"
    || value === "gemini"
    || value === "openai"
    || value === "deepseek"
    || value === "unsupported";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
