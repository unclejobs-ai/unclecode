import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message as PiMessage,
  Model,
  TextContent,
  Tool as PiTool,
  ToolCall,
  ToolResultMessage,
  TSchema,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ProviderInputAttachment,
  ProviderQueryMessage,
  ToolDefinition,
} from "@unclecode/providers";

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toPiToolParameters(schema: ToolDefinition["input_schema"]): TSchema {
  // ToolDefinition.input_schema is already JSON Schema in object form, which
  // is what pi-ai providers serialize for tool parameters.
  return schema as unknown as TSchema;
}
function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}


export function toPiTools(definitions: readonly ToolDefinition[]): PiTool[] {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: toPiToolParameters(definition.input_schema),
  }));
}

const DATA_URL_PATTERN = /^data:([^;]+);base64,(.+)$/s;

export function toPiImageContent(attachment: ProviderInputAttachment): ImageContent {
  const match = DATA_URL_PATTERN.exec(attachment.dataUrl);
  const mimeType = match?.[1];
  const data = match?.[2];
  if (!mimeType || !data) {
    throw new Error("pi-bridge: attachment dataUrl is not a base64 data URL.");
  }
  return { type: "image", data, mimeType };
}

export function isPiToolCall(
  content: AssistantMessage["content"][number],
): content is ToolCall {
  return content.type === "toolCall";
}

export function piAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function createToolResultMessage(
  call: ToolCall,
  resultText: string,
  isError: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: resultText }],
    isError,
    timestamp: Date.now(),
  };
}

export type MappedPiMessages = {
  readonly systemPrompt: string | undefined;
  readonly messages: PiMessage[];
};

export function mapQueryMessagesToPi(
  queryMessages: ReadonlyArray<ProviderQueryMessage>,
  model: Model<Api>,
): MappedPiMessages {
  const systemParts: string[] = [];
  const messages: PiMessage[] = [];
  const toolNamesByCallId = new Map<string, string>();

  for (const message of queryMessages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content, timestamp: Date.now() });
      continue;
    }
    if (message.role === "assistant") {
      const content: (TextContent | ToolCall)[] = [];
      if (message.content) {
        content.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        toolNamesByCallId.set(call.callId, call.name);
        content.push({
          type: "toolCall",
          id: call.callId,
          name: call.name,
          arguments: parseToolArguments(call.argumentsJson),
        });
      }
      messages.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: message.toolCalls?.length ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
      continue;
    }
    if (message.role !== "tool") continue;
    messages.push({
      role: "toolResult",
      toolCallId: message.callId,
      toolName: toolNamesByCallId.get(message.callId) ?? "unknown",
      content: [{ type: "text", text: message.content }],
      isError: false,
      timestamp: Date.now(),
    });
  }

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages,
  };
}
