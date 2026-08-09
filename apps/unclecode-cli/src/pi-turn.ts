import { isModeReasoningEffort } from "@unclecode/contracts";
import {
  createToolRuntime,
  resolveModeExecutionPolicyProfile,
  toolDefinitions,
} from "@unclecode/orchestrator";
import {
  createPiBridgeProvider,
  resolveCodexOAuthBridgeArgs,
  resolvePiProviderBaseUrl,
} from "@unclecode/pi-bridge";
import type { RuntimeReasoningConfig, ToolRuntime } from "@unclecode/providers";

type PiTurnRequest = {
  readonly provider: "anthropic" | "gemini" | "openai";
  readonly model: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly systemPrompt?: string;
  readonly reasoningEffort?: string;
  readonly allowedTools?: readonly string[];
  readonly allowRunShell?: boolean;
  readonly stepLimit?: number;
  readonly costLimitUsd?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePiTurnRequest(raw: string): PiTurnRequest {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("work-pi-turn: request must be a JSON object.");
  }
  const { provider, model, prompt, cwd } = parsed;
  if (provider !== "anthropic" && provider !== "gemini" && provider !== "openai") {
    throw new Error("work-pi-turn: provider must be anthropic, gemini, or openai.");
  }
  if (typeof model !== "string" || typeof prompt !== "string" || typeof cwd !== "string") {
    throw new Error("work-pi-turn: model, prompt, and cwd must be strings.");
  }
  const allowedTools = Array.isArray(parsed.allowedTools)
    ? parsed.allowedTools.filter((value): value is string => typeof value === "string")
    : undefined;
  if (
    parsed.stepLimit !== undefined
    && (
      typeof parsed.stepLimit !== "number"
      || !Number.isSafeInteger(parsed.stepLimit)
      || parsed.stepLimit <= 0
    )
  ) {
    throw new Error("work-pi-turn: stepLimit must be a positive integer.");
  }
  if (
    parsed.costLimitUsd !== undefined
    && (
      typeof parsed.costLimitUsd !== "number"
      || !Number.isFinite(parsed.costLimitUsd)
      || parsed.costLimitUsd <= 0
    )
  ) {
    throw new Error("work-pi-turn: costLimitUsd must be a positive finite number.");
  }
  return {
    provider,
    model,
    prompt,
    cwd,
    ...(typeof parsed.apiKey === "string" ? { apiKey: parsed.apiKey } : {}),
    ...(typeof parsed.baseUrl === "string" ? { baseUrl: parsed.baseUrl } : {}),
    ...(typeof parsed.systemPrompt === "string" ? { systemPrompt: parsed.systemPrompt } : {}),
    ...(typeof parsed.reasoningEffort === "string"
      ? { reasoningEffort: parsed.reasoningEffort }
      : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(typeof parsed.allowRunShell === "boolean" ? { allowRunShell: parsed.allowRunShell } : {}),
    ...(typeof parsed.stepLimit === "number" ? { stepLimit: parsed.stepLimit } : {}),
    ...(typeof parsed.costLimitUsd === "number" ? { costLimitUsd: parsed.costLimitUsd } : {}),
  };
}

function toReasoningConfig(effort: string | undefined): RuntimeReasoningConfig {
  if (effort && isModeReasoningEffort(effort)) {
    return {
      effort,
      source: "override",
      support: { status: "supported", defaultEffort: effort, supportedEfforts: [effort] },
    };
  }
  return {
    effort: "none",
    source: "mode-default",
    support: { status: "supported", defaultEffort: "none", supportedEfforts: ["none"] },
  };
}


export function buildPiTurnToolRuntime(input: {
  readonly allowedTools?: readonly string[] | undefined;
  readonly allowRunShell?: boolean | undefined;
}): ToolRuntime {
  const allowed = new Set(input.allowedTools ?? toolDefinitions.map((tool) => tool.name));
  if (!input.allowRunShell) {
    allowed.delete("run_shell");
  }
  // One-shot Pi turns are headless: no interaction bridge, so the executor has
  // no confirmation path and the shell grant is scoped to this request only.
  return createToolRuntime({
    allowedTools: [...allowed],
    policyProfile: resolveModeExecutionPolicyProfile({
      mode: "default",
      envShellOptIn: input.allowRunShell === true,
    }),
    runtimeMode: "local",
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.on("error", reject);
  });
}

export async function runWorkPiTurn(): Promise<number> {
  try {
    const request = parsePiTurnRequest(await readStdin());
    const codexOAuth = resolveCodexOAuthBridgeArgs({
      provider: request.provider,
      apiKey: request.apiKey,
    });
    if (!request.apiKey && !codexOAuth) {
      const providerName = request.provider === "openai"
        ? "OpenAI"
        : request.provider === "anthropic"
          ? "Anthropic"
          : "Gemini";
      const oauthSuffix = request.provider === "openai"
        ? " and no Codex OAuth credentials were available"
        : "";
      throw new Error(`work-pi-turn: no ${providerName} API key${oauthSuffix}.`);
    }
    const baseUrl = request.baseUrl?.trim() || resolvePiProviderBaseUrl(request.provider);
    const provider = createPiBridgeProvider({
      provider: request.provider,
      apiKey: request.apiKey ?? "",
      model: request.model,
      cwd: request.cwd,
      reasoning: toReasoningConfig(request.reasoningEffort),
      toolRuntime: buildPiTurnToolRuntime({
        allowedTools: request.allowedTools,
        allowRunShell: request.allowRunShell,
      }),
      ...(request.stepLimit !== undefined ? { toolLoopMax: request.stepLimit } : {}),
      ...(request.costLimitUsd !== undefined ? { costLimitUsd: request.costLimitUsd } : {}),
      ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(codexOAuth ?? {}),
    });
    const result = await provider.runTurn(request.prompt);
    process.stdout.write(`${JSON.stringify({
      status: "ok",
      text: result.text,
      steps: result.steps ?? 1,
      costUsd: result.costUsd ?? 0,
    })}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ status: "error", error: message })}\n`);
    return 0;
  }
}
