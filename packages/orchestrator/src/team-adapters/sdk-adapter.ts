/**
 * SDK adapter — drives the existing OpenAI / Anthropic / Gemini providers via
 * runTeamMiniLoop. One adapter instance per TeamLaneRuntime ("openai" |
 * "anthropic" | "gemini"). Constructor accepts injectable `providerFactory`
 * and `miniLoopRunner` so tests don't have to spin up real provider clients
 * or run the full mini-loop tool dispatch.
 */

import type { WorkerSpec } from "@unclecode/contracts";

import type { LlmProvider } from "@unclecode/providers";

import { runTeamMiniLoop, type RunTeamMiniLoopArgs, type RunTeamMiniLoopResult } from "../team-mini-loop.js";
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
} from "@unclecode/providers";
import { getPersonaConfig } from "../personas/index.js";

import type { LaneAdapter, LanePreflight, LaneRunContext, LaneRunResult } from "./lane-adapter.js";

export type SdkLaneRuntime = "openai" | "anthropic" | "gemini";

const ENV_BY_RUNTIME: Record<SdkLaneRuntime, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const DEFAULT_MODEL_BY_RUNTIME: Record<SdkLaneRuntime, string> = {
  openai: "gpt-5.6-sol",
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-2.5-pro",
};

export type SdkProviderFactoryArgs = {
  readonly runtime: SdkLaneRuntime;
  readonly apiKey: string;
  readonly model: string;
  readonly cwd: string;
  readonly systemPrompt: string;
};

export type SdkProviderFactory = (args: SdkProviderFactoryArgs) => LlmProvider;

export type CreateSdkAdapterArgs = {
  readonly id: SdkLaneRuntime;
  readonly providerFactory?: SdkProviderFactory;
  readonly miniLoopRunner?: (args: RunTeamMiniLoopArgs) => Promise<RunTeamMiniLoopResult>;
};

const defaultProviderFactory: SdkProviderFactory = ({
  runtime,
  apiKey,
  model,
  cwd,
  systemPrompt,
}) => {
  if (runtime === "anthropic") {
    return new AnthropicProvider({ apiKey, model, cwd, systemPrompt });
  }
  if (runtime === "gemini") {
    return new GeminiProvider({ apiKey, model, cwd, systemPrompt });
  }
  return new OpenAIProvider({
    apiKey,
    model,
    cwd,
    reasoning: {
      effort: "unsupported",
      source: "model-capability",
      support: { status: "unsupported", supportedEfforts: [] },
    },
    systemPrompt,
  });
};

export function createSdkAdapter(args: CreateSdkAdapterArgs): LaneAdapter {
  const { id } = args;
  const providerFactory = args.providerFactory ?? defaultProviderFactory;
  const miniLoopRunner = args.miniLoopRunner ?? runTeamMiniLoop;

  return {
    id,
    preflight(env): LanePreflight {
      const envName = ENV_BY_RUNTIME[id];
      const value = env[envName];
      if (value === undefined || value.trim().length === 0) {
        return {
          status: "missing",
          reason: `${id} lane requires ${envName} (currently unset)`,
        };
      }
      return { status: "ok" };
    },
    async run(spec: WorkerSpec, ctx: LaneRunContext): Promise<LaneRunResult> {
      const envName = ENV_BY_RUNTIME[id];
      const apiKey = ctx.env[envName]?.trim();
      if (!apiKey) {
        throw new Error(`${id} lane requires ${envName} — refusing to dispatch worker ${spec.workerId}`);
      }
      const model = spec.model?.trim() || DEFAULT_MODEL_BY_RUNTIME[id];
      const personaConfig = getPersonaConfig(spec.persona);
      const systemPrompt = ctx.systemPrompt ?? personaConfig.systemPrompt;
      const provider = providerFactory({
        runtime: id,
        apiKey,
        model,
        cwd: ctx.cwd,
        systemPrompt,
      });

      const result = await miniLoopRunner({
        workerId: spec.workerId,
        persona: spec.persona,
        task: spec.task,
        binding: ctx.binding,
        provider,
        cwd: ctx.cwd,
        ...(ctx.runtimeMode !== undefined ? { runtimeMode: ctx.runtimeMode } : {}),
        ...(ctx.executionPolicyProfile !== undefined
          ? { executionPolicyProfile: ctx.executionPolicyProfile }
          : {}),
      });

      return {
        ok: result.status === "submitted",
        submission: result.submission,
      };
    },
  };
}
