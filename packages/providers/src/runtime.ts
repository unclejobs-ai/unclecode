import type { ExecutionTraceEvent, ModeReasoningEffort } from "@unclecode/contracts";
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import { randomUUID } from "node:crypto";

import { estimateCostUsd } from "./model-pricing.js";
import { redactSecrets } from "./redaction.js";
import type { ReasoningSupport } from "./types.js";

export type AgentTurnResult = {
  text: string;
};

export type ProviderToolTraceEvent = Extract<
  ExecutionTraceEvent,
  { type: "tool.started" | "tool.completed" | "reasoning.delta" }
>;

export type ProviderInputAttachment = {
  type: "image";
  mimeType: string;
  dataUrl: string;
  path: string;
  displayName: string;
};

export type ProviderTraceListener = (event: ProviderToolTraceEvent) => void;

export type ProviderName = "anthropic" | "gemini" | "openai";

export type RuntimeReasoningConfig = {
  effort: ModeReasoningEffort | "unsupported";
  source: "mode-default" | "override" | "model-capability";
  support: ReasoningSupport;
};

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type ToolResult = {
  isError?: boolean;
  content: string;
};

export type ToolHandler = (
  input: Record<string, unknown>,
  cwd: string,
) => Promise<ToolResult>;

export type ToolRuntime = {
  readonly definitions: readonly ToolDefinition[];
  readonly handlers: Readonly<Record<string, ToolHandler>>;
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
};

export type ProviderQueryOptions = {
  readonly tools?: readonly ToolDefinition[];
  readonly model?: string;
  readonly reasoning?: RuntimeReasoningConfig;
};

export interface LlmProvider {
  runTurn(
    prompt: string,
    attachments?: readonly ProviderInputAttachment[],
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
};

const SYSTEM_PROMPT = `
You are MyClaudeCode, a clean-room terminal coding assistant.
Work step by step, prefer inspecting files before editing, and use tools when needed.
When you use tools, keep tool inputs minimal and precise.
Assume the workspace root is the allowed boundary and do not request paths outside it.
Prefer this philosophy unless the user explicitly overrides it: read first, search before guessing, edit precisely, write intentionally, use bash only when it adds evidence, and verify before claiming success.
`.trim();

const EMPTY_TOOL_RUNTIME: ToolRuntime = {
  definitions: [],
  handlers: {},
};

type OpenAIMessage =
  | { role: "system" | "assistant"; content: string; tool_calls?: unknown[] }
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
  private readonly fetchImpl: OpenAIFetch;
  private readonly systemPrompt: string;
  private readonly toolRuntime: ToolRuntime;
  private reasoning: RuntimeReasoningConfig;
  private traceListener: ProviderTraceListener | undefined;
  private readonly messages: OpenAIMessage[];
  private readonly runtime: "api" | "codex";
  private readonly openAIAccountId: string | null;

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
  }) {
    this.apiKey = args.apiKey;
    this.model = args.model;
    this.cwd = args.cwd;
    this.systemPrompt = args.systemPrompt?.trim()
      ? `${SYSTEM_PROMPT}\n\n${args.systemPrompt.trim()}`
      : SYSTEM_PROMPT;
    this.toolRuntime = args.toolRuntime ?? EMPTY_TOOL_RUNTIME;
    this.reasoning = args.reasoning;
    this.fetchImpl = args.fetchImpl ?? fetch;
    this.traceListener = args.traceListener;
    this.messages = [{ role: "system", content: this.systemPrompt }];
    this.runtime = args.runtime ?? "api";
    this.openAIAccountId = args.openAIAccountId ?? null;
  }

  updateRuntimeSettings(settings: {
    reasoning?: RuntimeReasoningConfig | undefined;
    model?: string | undefined;
  }): void {
    if (settings.reasoning) {
      this.reasoning = settings.reasoning;
    }
    if (settings.model?.trim()) {
      this.model = settings.model.trim();
    }
  }

  clear(): void {
    this.messages.splice(0, this.messages.length, {
      role: "system",
      content: this.systemPrompt,
    });
  }

  setTraceListener(listener?: ProviderTraceListener): void {
    this.traceListener = listener;
  }

  updateAuthToken(apiKey: string): void {
    this.apiKey = apiKey.trim();
  }

  private async requestOpenApiMessage(): Promise<{
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  }> {
    const response = await this.fetchImpl(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: this.messages,
          tools: this.toolRuntime.definitions.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
            },
          })),
          tool_choice: "auto",
          ...(this.reasoning.support.status === "supported"
            && this.reasoning.effort !== "unsupported"
            ? { reasoning: { effort: this.reasoning.effort } }
            : {}),
        }),
      },
    );

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        responseText.trim().length > 0
          ? `OpenAI request failed with status ${response.status}: ${responseText.trim()}`
          : `OpenAI request failed with status ${response.status}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };

    const message = payload.choices?.[0]?.message ?? {};
    const reasoningContent = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
    if (reasoningContent.length > 0) {
      emitProviderTrace(this.traceListener, {
        type: "reasoning.delta",
        level: "default",
        provider: "openai",
        model: this.model,
        kind: "text",
        itemId: `chat_${Date.now()}`,
        delta: redactSecrets(reasoningContent),
      });
    }
    return message;
  }

  private async requestCodexMessage(): Promise<{
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  }> {
    const input = sliceResponsesInputToLatestToolTurn(
      openAICompatibleMessagesToResponsesInput(this.messages),
    );
    const tools = this.toolRuntime.definitions.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      strict: false,
    }));

    const response = await this.fetchImpl(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(this.openAIAccountId ? { "ChatGPT-Account-Id": this.openAIAccountId } : {}),
          "User-Agent": "codex-cli/0.117.0",
          originator: "codex_cli_rs",
          "x-client-request-id": randomUUID(),
        },
        body: JSON.stringify({
          model: this.model,
          instructions: this.systemPrompt,
          input,
          tools,
          tool_choice: tools.length > 0 ? "auto" : "none",
          parallel_tool_calls: true,
          ...(this.reasoning.support.status === "supported" && this.reasoning.effort !== "unsupported"
            ? { reasoning: { effort: this.reasoning.effort, summary: "auto" } }
            : { reasoning: { effort: "none" } }),
          store: false,
          stream: true,
          include:
            this.reasoning.support.status === "supported" && this.reasoning.effort !== "unsupported"
              ? ["reasoning.encrypted_content"]
              : [],
          text: {
            format: { type: "text" },
            verbosity: "medium",
          },
        }),
      },
    );

    const responseText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(
        responseText.trim().length > 0
          ? `OpenAI request failed with status ${response.status}: ${responseText.trim()}`
          : `OpenAI request failed with status ${response.status}`,
      );
    }

    const parsed = parseResponsesSseToResult(responseText, {
      onReasoningDelta: ({ kind, itemId, delta }) => {
        emitProviderTrace(this.traceListener, {
          type: "reasoning.delta",
          level: "default",
          provider: "openai",
          model: this.model,
          kind,
          itemId,
          delta: redactSecrets(delta),
        });
      },
    });
    const toolCalls = parsed.content
      .filter((item): item is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        isRecord(item) && item.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string",
      )
      .map((item) => ({
        id: item.id,
        function: {
          name: item.name,
          arguments: JSON.stringify(item.input ?? {}),
        },
      }));
    const content = parsed.content
      .filter((item): item is { type: "text"; text: string } =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
      )
      .map((item) => item.text)
      .join("");

    return {
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  async runTurn(
    prompt: string,
    attachments: readonly ProviderInputAttachment[] = [],
  ): Promise<AgentTurnResult> {
    this.messages.push({
      role: "user",
      content:
        attachments.length > 0
          ? [
              { type: "text", text: prompt },
              ...attachments.map((attachment) => ({
                type: "image_url" as const,
                image_url: { url: attachment.dataUrl },
              })),
            ]
          : prompt,
    });

    let assistantText = "";

    for (let i = 0; i < 8; i += 1) {
      const message = this.runtime === "codex"
        ? await this.requestCodexMessage()
        : await this.requestOpenApiMessage();
      assistantText = typeof message?.content === "string" ? message.content : "";
      const toolCalls = message?.tool_calls ?? [];

      this.messages.push({
        role: "assistant",
        content: assistantText,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });

      if (toolCalls.length === 0) {
        return { text: assistantText };
      }

      for (const toolCall of toolCalls) {
        const name = toolCall.function?.name ?? "";
        const handler = this.toolRuntime.handlers[name];
        if (!handler) {
          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id ?? name,
            content: `Unknown tool: ${name}`,
          });
          continue;
        }

        try {
          const rawArgs = toolCall.function?.arguments ?? "{}";
          const parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
          const startedAt = Date.now();
          emitProviderTrace(this.traceListener, {
            type: "tool.started",
            level: "default",
            provider: "openai",
            toolName: name,
            toolCallId: toolCall.id ?? name,
            input: parsedArgs,
            startedAt,
          });
          const result = await handler(parsedArgs, this.cwd);
          const completedAt = Date.now();
          emitProviderTrace(this.traceListener, {
            type: "tool.completed",
            level: "default",
            provider: "openai",
            toolName: name,
            toolCallId: toolCall.id ?? name,
            isError: result.isError ?? false,
            output: result.content,
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
          });
          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id ?? name,
            content: result.content,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const completedAt = Date.now();
          emitProviderTrace(this.traceListener, {
            type: "tool.completed",
            level: "default",
            provider: "openai",
            toolName: name,
            toolCallId: toolCall.id ?? name,
            isError: true,
            output: message,
            startedAt: completedAt,
            completedAt,
            durationMs: 0,
          });
          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id ?? name,
            content: message,
          });
        }
      }
    }

    return { text: assistantText || "Stopped after reaching the tool iteration limit." };
  }

  async query(
    messages: ReadonlyArray<ProviderQueryMessage>,
    options: ProviderQueryOptions = {},
  ): Promise<ProviderQueryResult> {
    const tools = options.tools ?? this.toolRuntime.definitions;
    const model = options.model?.trim() ? options.model.trim() : this.model;
    const reasoning = options.reasoning ?? this.reasoning;
    const wireMessages = providerMessagesToOpenAI(messages, this.systemPrompt);

    const body: Record<string, unknown> = {
      model,
      messages: wireMessages,
      tool_choice: "auto",
    };
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }));
    }
    if (
      reasoning.support.status === "supported"
      && reasoning.effort !== "unsupported"
    ) {
      body.reasoning = { effort: reasoning.effort };
    }

    const response = await this.fetchImpl(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        responseText.trim().length > 0
          ? `OpenAI request failed with status ${response.status}: ${responseText.trim()}`
          : `OpenAI request failed with status ${response.status}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };

    const message = payload.choices?.[0]?.message ?? {};
    const content = typeof message.content === "string" ? message.content : "";
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    const actions: ProviderQueryAction[] = [];
    for (const call of rawCalls) {
      const name = call.function?.name?.trim();
      if (!name) {
        continue;
      }
      const callId = call.id?.trim() || name;
      let input: Record<string, unknown> = {};
      const rawArgs = call.function?.arguments;
      if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
        try {
          const parsed = JSON.parse(rawArgs) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // Leave input empty when args fail to parse — caller decides.
        }
      }
      actions.push({ callId, tool: name, input });
    }

    const promptTokens = typeof payload.usage?.prompt_tokens === "number"
      ? payload.usage.prompt_tokens
      : 0;
    const completionTokens = typeof payload.usage?.completion_tokens === "number"
      ? payload.usage.completion_tokens
      : 0;
    const costUsd = estimateCostUsd({
      modelId: model,
      promptTokens,
      completionTokens,
    });

    return { content, actions, costUsd };
  }
}

export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;
  private model: string;
  private readonly cwd: string;
  private readonly systemPrompt: string;
  private readonly toolRuntime: ToolRuntime;
  private traceListener: ProviderTraceListener | undefined;
  private readonly messages: MessageParam[] = [];

  constructor(args: {
    apiKey: string;
    model: string;
    cwd: string;
    toolRuntime?: ToolRuntime;
    traceListener?: ProviderTraceListener;
    systemPrompt?: string;
    client?: Anthropic;
  }) {
    this.client = args.client ?? new Anthropic({ apiKey: args.apiKey });
    this.model = args.model;
    this.cwd = args.cwd;
    this.systemPrompt = args.systemPrompt?.trim()
      ? `${SYSTEM_PROMPT}\n\n${args.systemPrompt.trim()}`
      : SYSTEM_PROMPT;
    this.toolRuntime = args.toolRuntime ?? EMPTY_TOOL_RUNTIME;
    this.traceListener = args.traceListener;
  }

  clear(): void {
    this.messages.length = 0;
  }

  setTraceListener(listener?: ProviderTraceListener): void {
    this.traceListener = listener;
  }

  updateRuntimeSettings(settings: {
    reasoning?: RuntimeReasoningConfig | undefined;
    model?: string | undefined;
  }): void {
    if (settings.model?.trim()) {
      this.model = settings.model.trim();
    }
  }

  async runTurn(
    prompt: string,
    attachments: readonly ProviderInputAttachment[] = [],
  ): Promise<AgentTurnResult> {
    if (attachments.length > 0) {
      const supportedMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
      const blocks: Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: {
              type: "base64";
              media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
              data: string;
            };
          }
      > = [{ type: "text", text: prompt }];
      for (const attachment of attachments) {
        if (!supportedMimes.has(attachment.mimeType)) {
          continue;
        }
        const commaIndex = attachment.dataUrl.indexOf(",");
        const base64Data = commaIndex >= 0 ? attachment.dataUrl.slice(commaIndex + 1) : "";
        if (base64Data.length === 0) {
          continue;
        }
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: attachment.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: base64Data,
          },
        });
      }
      this.messages.push({ role: "user", content: blocks });
    } else {
      this.messages.push({
        role: "user",
        content: prompt,
      });
    }

    let assistantText = "";

    for (let i = 0; i < 8; i += 1) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        system: this.systemPrompt,
        messages: this.messages,
        tools: [...this.toolRuntime.definitions],
      });

      this.messages.push({
        role: "assistant",
        content: response.content,
      });

      const textBlocks = response.content.filter((block) => block.type === "text");
      if (textBlocks.length > 0) {
        assistantText = textBlocks.map((block) => block.text).join("\n");
      }

      const toolUses = response.content.filter((block) => block.type === "tool_use");
      if (toolUses.length === 0) {
        return { text: assistantText };
      }

      const toolResults: ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const handler = this.toolRuntime.handlers[toolUse.name];
        if (!handler) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: `Unknown tool: ${toolUse.name}`,
          });
          continue;
        }

        try {
          const toolInput = toolUse.input as Record<string, unknown>;
          const startedAt = Date.now();
          emitProviderTrace(this.traceListener, {
            type: "tool.started",
            level: "default",
            provider: "anthropic",
            toolName: toolUse.name,
            toolCallId: toolUse.id,
            input: toolInput,
            startedAt,
          });
          const result = await handler(toolInput, this.cwd);
          const completedAt = Date.now();
          emitProviderTrace(this.traceListener, {
            type: "tool.completed",
            level: "default",
            provider: "anthropic",
            toolName: toolUse.name,
            toolCallId: toolUse.id,
            isError: result.isError ?? false,
            output: result.content,
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
          });
          const toolResult: ToolResultBlockParam = {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.content,
          };
          if (result.isError !== undefined) {
            toolResult.is_error = result.isError;
          }
          toolResults.push(toolResult);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const completedAt = Date.now();
          emitProviderTrace(this.traceListener, {
            type: "tool.completed",
            level: "default",
            provider: "anthropic",
            toolName: toolUse.name,
            toolCallId: toolUse.id,
            isError: true,
            output: message,
            startedAt: completedAt,
            completedAt,
            durationMs: 0,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: message,
          });
        }
      }

      this.messages.push({
        role: "user",
        content: toolResults,
      });
    }

    return {
      text: assistantText || "Stopped after reaching the tool iteration limit.",
    };
  }

  async query(
    messages: ReadonlyArray<ProviderQueryMessage>,
    options: ProviderQueryOptions = {},
  ): Promise<ProviderQueryResult> {
    const tools = options.tools ?? this.toolRuntime.definitions;
    const model = options.model?.trim() ? options.model.trim() : this.model;
    const { system, wireMessages } = providerMessagesToAnthropic(
      messages,
      this.systemPrompt,
    );

    const response = await this.client.messages.create({
      model,
      max_tokens: 2048,
      system,
      messages: wireMessages,
      tools: [...tools],
    });

    const textParts: string[] = [];
    for (const block of response.content) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
    }
    const content = textParts.join("\n");

    const actions: ProviderQueryAction[] = [];
    for (const block of response.content) {
      if (
        isRecord(block)
        && block.type === "tool_use"
        && typeof block.id === "string"
        && typeof block.name === "string"
      ) {
        const rawInput = (block as Record<string, unknown>).input;
        const input = isRecord(rawInput) ? (rawInput as Record<string, unknown>) : {};
        actions.push({ callId: block.id, tool: block.name, input });
      }
    }

    const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    const promptTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
    const completionTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
    const costUsd = estimateCostUsd({
      modelId: model,
      promptTokens,
      completionTokens,
    });

    return { content, actions, costUsd };
  }
}

type GeminiContent = {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
};

export class GeminiProvider implements LlmProvider {
  private readonly client: GoogleGenAI;
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
    client?: GoogleGenAI;
  }) {
    this.client = args.client ?? new GoogleGenAI({ apiKey: args.apiKey });
    this.model = args.model;
    this.cwd = args.cwd;
    this.systemPrompt = args.systemPrompt?.trim()
      ? `${SYSTEM_PROMPT}\n\n${args.systemPrompt.trim()}`
      : SYSTEM_PROMPT;
    this.toolRuntime = args.toolRuntime ?? EMPTY_TOOL_RUNTIME;
    this.traceListener = args.traceListener;
  }

  clear(): void {
    this.contents.length = 0;
  }

  setTraceListener(listener?: ProviderTraceListener): void {
    this.traceListener = listener;
  }

  updateRuntimeSettings(settings: {
    reasoning?: RuntimeReasoningConfig | undefined;
    model?: string | undefined;
  }): void {
    if (settings.model?.trim()) {
      this.model = settings.model.trim();
    }
  }

  async runTurn(
    prompt: string,
    attachments: readonly ProviderInputAttachment[] = [],
  ): Promise<AgentTurnResult> {
    const userParts: Array<
      | { text: string }
      | { inlineData: { mimeType: string; data: string } }
    > = [{ text: prompt }];
    for (const attachment of attachments) {
      const commaIndex = attachment.dataUrl.indexOf(",");
      const base64Data = commaIndex >= 0 ? attachment.dataUrl.slice(commaIndex + 1) : "";
      if (base64Data.length === 0) {
        continue;
      }
      userParts.push({ inlineData: { mimeType: attachment.mimeType, data: base64Data } });
    }
    this.contents.push({
      role: "user",
      parts: userParts,
    });

    let assistantText = "";

    for (let i = 0; i < 8; i += 1) {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: this.contents,
        config: {
          systemInstruction: this.systemPrompt,
          tools: [
            {
              functionDeclarations: this.toolRuntime.definitions.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.input_schema,
              })),
            },
          ],
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.AUTO,
            },
          },
        },
      });

      const candidate = response.candidates?.[0];
      const parts = (candidate?.content?.parts ?? []) as Array<
        Record<string, unknown>
      >;
      this.contents.push({
        role: "model",
        parts,
      });

      const textParts = parts
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .filter((text) => text.length > 0);
      if (textParts.length > 0) {
        assistantText = textParts.join("\n");
      }

      const functionCalls = parts
        .map((part) => part.functionCall)
        .filter(
          (
            call,
          ): call is { id?: string; name?: string; args?: unknown } =>
            typeof call === "object" && call !== null,
        );

      if (functionCalls.length === 0) {
        return { text: assistantText || response.text || "" };
      }

      const functionResponses: Array<Record<string, unknown>> = [];

      for (const functionCall of functionCalls) {
        const name = typeof functionCall.name === "string" ? functionCall.name : "";
        const callId =
          typeof functionCall.id === "string" ? functionCall.id : name;
        const handler = this.toolRuntime.handlers[name];

        if (!handler) {
          functionResponses.push({
            functionResponse: {
              name,
              id: callId,
              response: {
                error: `Unknown tool: ${name}`,
              },
            },
          });
          continue;
        }

        try {
          const input = isRecord(functionCall.args) ? functionCall.args : {};
          const startedAt = Date.now();
          emitProviderTrace(this.traceListener, {
            type: "tool.started",
            level: "default",
            provider: "gemini",
            toolName: name,
            toolCallId: callId,
            input,
            startedAt,
          });
          const result = await handler(input, this.cwd);
          const completedAt = Date.now();
          emitProviderTrace(this.traceListener, {
            type: "tool.completed",
            level: "default",
            provider: "gemini",
            toolName: name,
            toolCallId: callId,
            isError: result.isError ?? false,
            output: result.content,
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
          });
          functionResponses.push({
            functionResponse: {
              name,
              id: callId,
              response: {
                content: result.content,
                isError: result.isError ?? false,
              },
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const completedAt = Date.now();
          emitProviderTrace(this.traceListener, {
            type: "tool.completed",
            level: "default",
            provider: "gemini",
            toolName: name,
            toolCallId: callId,
            isError: true,
            output: message,
            startedAt: completedAt,
            completedAt,
            durationMs: 0,
          });
          functionResponses.push({
            functionResponse: {
              name,
              id: callId,
              response: {
                error: message,
              },
            },
          });
        }
      }

      this.contents.push({
        role: "user",
        parts: functionResponses,
      });
    }

    return {
      text: assistantText || "Stopped after reaching the tool iteration limit.",
    };
  }

  async query(
    messages: ReadonlyArray<ProviderQueryMessage>,
    options: ProviderQueryOptions = {},
  ): Promise<ProviderQueryResult> {
    const tools = options.tools ?? this.toolRuntime.definitions;
    const model = options.model?.trim() ? options.model.trim() : this.model;
    const { systemInstruction, contents } = providerMessagesToGemini(
      messages,
      this.systemPrompt,
    );

    const response = await this.client.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction,
        tools: tools.length > 0
          ? [
              {
                functionDeclarations: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.input_schema,
                })),
              },
            ]
          : [],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.AUTO,
          },
        },
      },
    });

    const candidate = response.candidates?.[0];
    const parts = (candidate?.content?.parts ?? []) as Array<Record<string, unknown>>;
    const textParts: string[] = [];
    for (const part of parts) {
      if (typeof part.text === "string" && part.text.length > 0) {
        textParts.push(part.text);
      }
    }
    const content = textParts.length > 0
      ? textParts.join("\n")
      : (typeof response.text === "string" ? response.text : "");

    const actions: ProviderQueryAction[] = [];
    for (const part of parts) {
      const call = part.functionCall;
      if (!isRecord(call)) {
        continue;
      }
      const name = typeof call.name === "string" ? call.name.trim() : "";
      if (name.length === 0) {
        continue;
      }
      const callId = typeof call.id === "string" && call.id.length > 0
        ? call.id
        : name;
      const input = isRecord(call.args) ? (call.args as Record<string, unknown>) : {};
      actions.push({ callId, tool: name, input });
    }

    const usage = (response as {
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    }).usageMetadata;
    const promptTokens = typeof usage?.promptTokenCount === "number"
      ? usage.promptTokenCount
      : 0;
    const completionTokens = typeof usage?.candidatesTokenCount === "number"
      ? usage.candidatesTokenCount
      : 0;
    const costUsd = estimateCostUsd({
      modelId: model,
      promptTokens,
      completionTokens,
    });

    return { content, actions, costUsd };
  }
}

export function createRuntimeProvider(args: CreateRuntimeProviderArgs): LlmProvider {
  if (args.providerOverride) {
    return args.providerOverride;
  }

  if (args.provider === "openai") {
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

  if (args.provider === "gemini") {
    return new GeminiProvider({
      apiKey: args.apiKey,
      model: args.model,
      cwd: args.cwd,
      ...(args.toolRuntime ? { toolRuntime: args.toolRuntime } : {}),
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    });
  }

  return new AnthropicProvider({
    apiKey: args.apiKey,
    model: args.model,
    cwd: args.cwd,
    ...(args.toolRuntime ? { toolRuntime: args.toolRuntime } : {}),
    ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
  });
}

function openAICompatibleMessagesToResponsesInput(messages: readonly OpenAIMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: [{ type: "input_text", text: message.content }],
      });
      continue;
    }

    if (message.role === "assistant" && message.content.length > 0) {
      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: message.content }],
      });
    } else if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n");
      if (text.length > 0) {
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        });
      }
    }

    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (!isRecord(toolCall)) {
          continue;
        }
        const fn = isRecord(toolCall.function) ? toolCall.function : {};
        input.push({
          type: "function_call",
          call_id: typeof toolCall.id === "string" ? toolCall.id : `call_${randomUUID()}`,
          name: typeof fn.name === "string" ? fn.name : "tool",
          arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
        });
      }
    }
  }

  return input;
}

function sliceResponsesInputToLatestToolTurn(input: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  let trailingOutputStart = -1;

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (isRecord(item) && item.type === "function_call_output" && typeof item.call_id === "string") {
      trailingOutputStart = index;
      continue;
    }
    if (trailingOutputStart !== -1) {
      break;
    }
  }

  if (trailingOutputStart === -1) {
    return removeUnpairedResponsesToolItems(input);
  }

  const trailingCallIds = new Set(
    input
      .slice(trailingOutputStart)
      .filter((item) => isRecord(item) && item.type === "function_call_output" && typeof item.call_id === "string")
      .map((item) => String(item.call_id)),
  );
  const remainingCallIds = new Set(trailingCallIds);

  let startIndex = trailingOutputStart;
  for (let index = trailingOutputStart - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === "function_call" && typeof item.call_id === "string" && trailingCallIds.has(item.call_id)) {
      startIndex = index;
      remainingCallIds.delete(item.call_id);
      continue;
    }
    if (item.type === "message" && remainingCallIds.size === 0) {
      startIndex = index;
      break;
    }
  }

  if (remainingCallIds.size > 0) {
    for (let index = trailingOutputStart - 1; index >= 0; index -= 1) {
      const item = input[index];
      if (isRecord(item) && item.type === "message") {
        startIndex = index;
        break;
      }
    }
  }

  return removeUnpairedResponsesToolItems(input.slice(startIndex));
}

function removeUnpairedResponsesToolItems(input: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const callIds = new Set(
    input
      .filter((item) => isRecord(item) && item.type === "function_call" && typeof item.call_id === "string")
      .map((item) => String(item.call_id)),
  );
  const outputIds = new Set(
    input
      .filter((item) => isRecord(item) && item.type === "function_call_output" && typeof item.call_id === "string")
      .map((item) => String(item.call_id)),
  );

  return input.filter((item) => {
    if (!isRecord(item)) {
      return true;
    }
    if (item.type === "function_call" && typeof item.call_id === "string") {
      return outputIds.has(item.call_id);
    }
    if (item.type === "function_call_output" && typeof item.call_id === "string") {
      return callIds.has(item.call_id);
    }
    return true;
  });
}

function parseResponsesSseToResult(
  sseText: string,
  options: {
    onReasoningDelta?: (event: { kind: "summary" | "text"; itemId: string; delta: string }) => void;
  } = {},
): {
  responseId: string | null;
  content: Array<Record<string, unknown>>;
} {
  const blocks: Array<Record<string, unknown>> = [];
  const textByMessageId = new Map<string, string>();
  const reasoningSummaryByItemId = new Map<string, string>();
  const reasoningTextByItemId = new Map<string, string>();
  const onReasoningDelta = options.onReasoningDelta;
  let responseId: string | null = null;

  for (const event of parseSseJsonEvents(sseText)) {
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "response.output_text.delta") {
      const itemId = typeof event.item_id === "string" ? event.item_id : `msg_${randomUUID()}`;
      const delta = typeof event.delta === "string" ? event.delta : "";
      textByMessageId.set(itemId, (textByMessageId.get(itemId) ?? "") + delta);
      continue;
    }

    if (type === "response.reasoning_summary_text.delta") {
      const itemId = typeof event.item_id === "string" ? event.item_id : `rsn_${randomUUID()}`;
      const delta = typeof event.delta === "string" ? event.delta : "";
      reasoningSummaryByItemId.set(itemId, (reasoningSummaryByItemId.get(itemId) ?? "") + delta);
      if (onReasoningDelta && delta.length > 0) {
        onReasoningDelta({ kind: "summary", itemId, delta });
      }
      continue;
    }

    if (type === "response.reasoning_text.delta") {
      const itemId = typeof event.item_id === "string" ? event.item_id : `rsn_${randomUUID()}`;
      const delta = typeof event.delta === "string" ? event.delta : "";
      reasoningTextByItemId.set(itemId, (reasoningTextByItemId.get(itemId) ?? "") + delta);
      if (onReasoningDelta && delta.length > 0) {
        onReasoningDelta({ kind: "text", itemId, delta });
      }
      continue;
    }

    if (type === "response.completed" && isRecord(event.response) && typeof event.response.id === "string") {
      responseId = event.response.id;
      continue;
    }

    if (type !== "response.output_item.done" || !isRecord(event.item)) {
      continue;
    }

    const item = event.item;
    const itemType = typeof item.type === "string" ? item.type : "";

    if (itemType === "message" && item.role === "assistant") {
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content
        .map((part) =>
          isRecord(part) && part.type === "output_text" && typeof part.text === "string" ? part.text : "",
        )
        .filter(Boolean)
        .join("");
      const fallbackText = text.length > 0 ? text : typeof item.id === "string" ? (textByMessageId.get(item.id) ?? "") : "";
      if (fallbackText.length > 0) {
        blocks.push({ type: "text", text: fallbackText });
      }
      continue;
    }

    if (itemType === "reasoning") {
      const itemId = typeof item.id === "string" ? item.id : `rsn_${randomUUID()}`;
      const summaryParts = Array.isArray(item.summary) ? item.summary : [];
      const summaryFromItem = summaryParts
        .map((part) =>
          isRecord(part) && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "",
        )
        .filter(Boolean)
        .join("\n");
      const contentParts = Array.isArray(item.content) ? item.content : [];
      const textFromItem = contentParts
        .map((part) =>
          isRecord(part)
            && (part.type === "reasoning_text" || part.type === "text")
            && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .filter(Boolean)
        .join("\n");
      const summary = summaryFromItem.length > 0 ? summaryFromItem : (reasoningSummaryByItemId.get(itemId) ?? "");
      const text = textFromItem.length > 0 ? textFromItem : (reasoningTextByItemId.get(itemId) ?? "");
      if (summary.length > 0 || text.length > 0) {
        blocks.push({ type: "reasoning", itemId, summary, text });
      }
      continue;
    }

    if (itemType === "function_call") {
      let input: Record<string, unknown> = {};
      if (typeof item.arguments === "string" && item.arguments.trim().length > 0) {
        try {
          const parsed = JSON.parse(item.arguments);
          input = isRecord(parsed) ? parsed : {};
        } catch {
          input = {};
        }
      }
      blocks.push({
        type: "tool_use",
        id: typeof item.call_id === "string" ? item.call_id : `toolu_${randomUUID()}`,
        name: typeof item.name === "string" ? item.name : "tool",
        input,
      });
    }
  }

  return {
    responseId,
    content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
  };
}

function parseSseJsonEvents(sseText: string): Array<Record<string, unknown>> {
  return (sseText ?? "")
    .split(/\n\n+/)
    .map((chunk) => {
      const dataLines = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
      if (dataLines.length === 0) {
        return null;
      }
      try {
        return JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((event): event is Record<string, unknown> => event !== null);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerMessagesToGemini(
  messages: ReadonlyArray<ProviderQueryMessage>,
  defaultSystemPrompt: string,
): { systemInstruction: string; contents: GeminiContent[] } {
  let systemInstruction = defaultSystemPrompt;
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemInstruction = message.content;
      continue;
    }
    if (message.role === "user") {
      contents.push({
        role: "user",
        parts: [{ text: message.content }],
      });
      continue;
    }
    if (message.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content.length > 0) {
        parts.push({ text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        let parsed: Record<string, unknown> = {};
        if (call.argumentsJson.trim().length > 0) {
          try {
            const candidate = JSON.parse(call.argumentsJson) as unknown;
            if (isRecord(candidate)) {
              parsed = candidate;
            }
          } catch {
            // Empty args on parse failure.
          }
        }
        parts.push({
          functionCall: {
            id: call.callId,
            name: call.name,
            args: parsed,
          },
        });
      }
      if (parts.length === 0) {
        parts.push({ text: "" });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              id: message.callId,
              name: message.callId,
              response: { output: message.content },
            },
          },
        ],
      });
    }
  }
  return { systemInstruction, contents };
}

function providerMessagesToAnthropic(
  messages: ReadonlyArray<ProviderQueryMessage>,
  defaultSystemPrompt: string,
): { system: string; wireMessages: MessageParam[] } {
  let system = defaultSystemPrompt;
  const wireMessages: MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      system = message.content;
      continue;
    }
    if (message.role === "user") {
      wireMessages.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      > = [];
      if (message.content.length > 0) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        let parsed: Record<string, unknown> = {};
        if (call.argumentsJson.trim().length > 0) {
          try {
            const candidate = JSON.parse(call.argumentsJson) as unknown;
            if (isRecord(candidate)) {
              parsed = candidate;
            }
          } catch {
            // Keep parsed empty when arguments fail to parse.
          }
        }
        blocks.push({
          type: "tool_use",
          id: call.callId,
          name: call.name,
          input: parsed,
        });
      }
      // Anthropic rejects empty content arrays — fall back to plain text.
      const content = blocks.length > 0 ? blocks : [{ type: "text" as const, text: "" }];
      wireMessages.push({ role: "assistant", content });
      continue;
    }
    if (message.role === "tool") {
      wireMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.callId,
            content: message.content,
          } satisfies ToolResultBlockParam,
        ],
      });
    }
  }
  return { system, wireMessages };
}

function providerMessagesToOpenAI(
  messages: ReadonlyArray<ProviderQueryMessage>,
  defaultSystemPrompt: string,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  let sawSystem = false;
  for (const message of messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
      sawSystem = true;
    } else if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      const toolCalls = message.toolCalls ?? [];
      const wireToolCalls = toolCalls.map((call) => ({
        id: call.callId,
        type: "function" as const,
        function: { name: call.name, arguments: call.argumentsJson },
      }));
      out.push({
        role: "assistant",
        content: message.content,
        ...(wireToolCalls.length > 0 ? { tool_calls: wireToolCalls } : {}),
      });
    } else if (message.role === "tool") {
      out.push({
        role: "tool",
        content: message.content,
        tool_call_id: message.callId,
      });
    }
  }
  if (!sawSystem && defaultSystemPrompt.trim().length > 0) {
    out.unshift({ role: "system", content: defaultSystemPrompt });
  }
  return out;
}
