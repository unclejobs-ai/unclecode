import {
  AnthropicProvider as BaseAnthropicProvider,
  GeminiProvider as BaseGeminiProvider,
  OpenAIProvider as BaseOpenAIProvider,
  type LlmProvider,
  type ProviderInputAttachment,
  type ProviderName,
  type ProviderToolTraceEvent,
  type ProviderTraceListener,
  type RuntimeReasoningConfig,
} from "@unclecode/providers";

import { toolDefinitions, toolHandlers } from "./tools.js";

const toolRuntime = {
  definitions: toolDefinitions,
  handlers: toolHandlers,
} as const;

export type {
  LlmProvider,
  ProviderInputAttachment,
  ProviderName,
  ProviderToolTraceEvent,
  ProviderTraceListener,
  RuntimeReasoningConfig,
};

export class OpenAIProvider extends BaseOpenAIProvider {
  constructor(args: ConstructorParameters<typeof BaseOpenAIProvider>[0]) {
    super({
      ...args,
      toolRuntime,
    });
  }
}

export class AnthropicProvider extends BaseAnthropicProvider {
  constructor(args: ConstructorParameters<typeof BaseAnthropicProvider>[0]) {
    super({
      ...args,
      toolRuntime,
    });
  }
}

export class GeminiProvider extends BaseGeminiProvider {
  constructor(args: ConstructorParameters<typeof BaseGeminiProvider>[0]) {
    super({
      ...args,
      toolRuntime,
    });
  }
}
