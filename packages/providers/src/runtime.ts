import { randomUUID } from "node:crypto";

import type { ExecutionTraceEvent, ModeReasoningEffort } from "@unclecode/contracts";
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";

import {
  openAICompatibleMessagesToResponsesInput,
  openAICompatibleToolsToResponsesTools,
  parseResponsesSseToResult,
  sliceResponsesInputToLatestToolTurn,
} from "../../../shared/openaiResponsesCompat.js";
import type { ReasoningSupport } from "./types.js";

export type AgentTurnResult = {
  text: string;
};

export type ProviderToolTraceEvent = Extract<
  ExecutionTraceEvent,
  { type: "tool.started" | "tool.completed" }
>;

export type ProviderInputAttachment = {
  type: "image";
  mimeType: string;
  dataUrl: string;
  path: string;
  displayName: string;
};

export type ProviderTraceListener = (event: ProviderToolTraceEvent) => void;

export type ProviderName = "anthropic" | "gemini" | "openai" | "openai-api" | "openai-codex";

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

export interface LlmProvider {
  runTurn(
    prompt: string,
    attachments?: readonly ProviderInputAttachment[],
  ): Promise<AgentTurnResult>;
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

  constructor(args: {
    apiKey: string;
    model: string;
    cwd: string;
    reasoning: RuntimeReasoningConfig;
    toolRuntime?: ToolRuntime;
    fetchImpl?: OpenAIFetch;
    traceListener?: ProviderTraceListener;
    systemPrompt?: string;
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
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };

      const message = payload.choices?.[0]?.message;
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
            provider: "openai-api",
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
            provider: "openai-api",
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
            provider: "openai-api",
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
}

export class OpenAICodexProvider implements LlmProvider {
  private apiKey: string;
  private model: string;
  private readonly cwd: string;
  private readonly fetchImpl: OpenAIFetch;
  private readonly systemPrompt: string;
  private readonly toolRuntime: ToolRuntime;
  private reasoning: RuntimeReasoningConfig;
  private traceListener: ProviderTraceListener | undefined;
  private readonly messages: OpenAIMessage[];

  constructor(args: {
    apiKey: string;
    model: string;
    cwd: string;
    reasoning: RuntimeReasoningConfig;
    toolRuntime?: ToolRuntime;
    fetchImpl?: OpenAIFetch;
    traceListener?: ProviderTraceListener;
    systemPrompt?: string;
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

  async runTurn(
    prompt: string,
    attachments: readonly ProviderInputAttachment[] = [],
  ): Promise<AgentTurnResult> {
    const attachmentSuffix = attachments.length > 0
      ? `\n\n[Attached images omitted from Codex runtime payload: ${attachments.map((attachment) => attachment.displayName).join(", ")}]`
      : "";

    this.messages.push({
      role: "user",
      content: `${prompt}${attachmentSuffix}`,
    });

    let assistantText = "";

    for (let i = 0; i < 8; i += 1) {
      const response = await this.fetchImpl(
        "https://chatgpt.com/backend-api/codex/responses",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "User-Agent": "unclecode/0.1.0",
            originator: "unclecode_cli_ts",
            "x-client-request-id": randomUUID(),
          },
          body: JSON.stringify({
            model: this.model,
            instructions: this.systemPrompt,
            input: sliceResponsesInputToLatestToolTurn(openAICompatibleMessagesToResponsesInput(this.messages)),
            tools: openAICompatibleToolsToResponsesTools(
              this.toolRuntime.definitions.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.input_schema,
                },
              })),
            ),
            tool_choice: "auto",
            parallel_tool_calls: true,
            reasoning: { effort: "none" },
            store: false,
            stream: true,
            include: [],
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
            ? `OpenAI Codex request failed with status ${response.status}: ${responseText.trim()}`
            : `OpenAI Codex request failed with status ${response.status}`,
        );
      }

      const payload = parseResponsesSseToResult(responseText);
      const toolCalls = payload.content
        .filter((item): item is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => item.type === "tool_use")
        .map((item) => ({
          id: item.id,
          function: {
            name: item.name,
            arguments: JSON.stringify(item.input ?? {}),
          },
        }));
      assistantText = payload.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("");

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
            provider: "openai-codex",
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
            provider: "openai-codex",
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
            provider: "openai-codex",
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
  }) {
    this.client = new Anthropic({ apiKey: args.apiKey });
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
      throw new Error(
        "Image attachments are currently supported only in the OpenAI work shell.",
      );
    }

    this.messages.push({
      role: "user",
      content: prompt,
    });

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
  }) {
    this.client = new GoogleGenAI({ apiKey: args.apiKey });
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
    if (attachments.length > 0) {
      throw new Error(
        "Image attachments are currently supported only in the OpenAI work shell.",
      );
    }

    this.contents.push({
      role: "user",
      parts: [{ text: prompt }],
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
}

export function createRuntimeProvider(args: CreateRuntimeProviderArgs): LlmProvider {
  if (args.providerOverride) {
    return args.providerOverride;
  }

  if (args.provider === "openai-codex") {
    return new OpenAICodexProvider({
      apiKey: args.apiKey,
      model: args.model,
      cwd: args.cwd,
      reasoning: args.reasoning,
      ...(args.toolRuntime ? { toolRuntime: args.toolRuntime } : {}),
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    });
  }

  if (args.provider === "openai" || args.provider === "openai-api") {
    return new OpenAIProvider({
      apiKey: args.apiKey,
      model: args.model,
      cwd: args.cwd,
      reasoning: args.reasoning,
      ...(args.toolRuntime ? { toolRuntime: args.toolRuntime } : {}),
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
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
