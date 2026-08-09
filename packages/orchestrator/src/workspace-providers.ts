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

import { createToolRuntime } from "./tools.js";

// Workspace providers are the ambient, non-interactive entry points, so there
// is no interaction bridge to confirm prompts with: the executor fails closed.
const toolRuntime = createToolRuntime({});

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
