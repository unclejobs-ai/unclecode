import { estimateCacheSavingsUsd } from "@unclecode/providers";
import type { ExecutionTraceEvent } from "@unclecode/contracts";
import { runRustCommandSync } from "./rust-command.js";

type TraceProviderName = Extract<ExecutionTraceEvent, { type: "provider.calling" }>["provider"];
type ProviderRouteTraceEvent = Extract<ExecutionTraceEvent, { type: "provider.route" }>;
type TurnStartedTraceEvent = Extract<ExecutionTraceEvent, { type: "turn.started" }>;
type ProviderCallingTraceEvent = Extract<ExecutionTraceEvent, { type: "provider.calling" }>;
type TurnCompletedTraceEvent = Extract<ExecutionTraceEvent, { type: "turn.completed" }>;
type UsageRecordedTraceEvent = Extract<ExecutionTraceEvent, { type: "usage.recorded" }>;

let usageEventSequence = 0;

export type AgentTurnResult = {
  readonly text: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
  readonly steps?: number;
  readonly costUsd?: number;
};

export type AgentTurnOptions = {
  readonly signal?: AbortSignal | undefined;
};

export type CodingAgentTraceEvent<ToolTraceEvent extends { readonly type: string }> =
  | Extract<ExecutionTraceEvent, {
      type: "turn.started" | "provider.route" | "provider.calling" | "turn.completed" | "usage.recorded";
    }>
  | ToolTraceEvent;

export interface CodingAgentProvider<
  Attachment,
  Reasoning,
  ToolTraceEvent extends { readonly type: string },
> {
  clear(): void;
  setTraceListener(listener?: ((event: ToolTraceEvent) => void) | undefined): void;
  updateRuntimeSettings(settings: { reasoning?: Reasoning | undefined; model?: string | undefined }): void;
  runTurn(prompt: string, attachments?: readonly Attachment[], options?: AgentTurnOptions): Promise<AgentTurnResult>;
}

export interface TurnAgent<
  Attachment,
  Reasoning,
  TraceEvent extends { readonly type: string },
> {
  clear(): void;
  setTraceListener(listener?: ((event: TraceEvent) => void) | undefined): void;
  updateRuntimeSettings(settings: { reasoning?: Reasoning | undefined; model?: string | undefined }): void;
  runTurn(prompt: string, attachments?: readonly Attachment[], options?: AgentTurnOptions): Promise<AgentTurnResult>;
}

export class CodingAgent<
  Attachment,
  Reasoning,
  ToolTraceEvent extends { readonly type: string },
> implements TurnAgent<Attachment, Reasoning, CodingAgentTraceEvent<ToolTraceEvent>> {
  private readonly provider: CodingAgentProvider<Attachment, Reasoning, ToolTraceEvent>;
  private readonly providerName: TraceProviderName;
  private model: string;
  private traceListener: ((event: CodingAgentTraceEvent<ToolTraceEvent>) => void) | undefined;
  private activeTurnFirstTokenAt: number | undefined = undefined;

  constructor(args: {
    providerName: TraceProviderName;
    model: string;
    provider: CodingAgentProvider<Attachment, Reasoning, ToolTraceEvent>;
  }) {
    this.provider = args.provider;
    this.providerName = args.providerName;
    this.model = args.model;
  }

  clear(): void {
    this.provider.clear();
  }

  setTraceListener(listener?: ((event: CodingAgentTraceEvent<ToolTraceEvent>) => void) | undefined): void {
    this.traceListener = listener;
    this.provider.setTraceListener(listener ? (event) => this.emitTrace(event) : undefined);
  }

  updateRuntimeSettings(settings: { reasoning?: Reasoning | undefined; model?: string | undefined }): void {
    this.provider.updateRuntimeSettings(settings);
    if (settings.model?.trim()) {
      this.model = settings.model.trim();
    }
  }

  async runTurn(prompt: string, attachments: readonly Attachment[] = [], options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
    const turnStartedAt = Date.now();
    const model = this.model;
    this.activeTurnFirstTokenAt = undefined;
    this.emitTrace(this.buildTurnStartedTrace(prompt, turnStartedAt, model));
    this.emitTrace(this.buildProviderRouteTrace(turnStartedAt, model));
    this.emitTrace(this.buildProviderCallingTrace(turnStartedAt, model));

    const result = await this.provider.runTurn(prompt, attachments, options);
    const completedAt = Date.now();
    this.emitTrace(this.buildTurnCompletedTrace(result.text, turnStartedAt, completedAt, model));
    const usageTrace = this.buildUsageRecordedTrace(result, turnStartedAt, completedAt, model);
    if (usageTrace) {
      this.emitTrace(usageTrace);
    }
    return result;
  }

  private buildUsageRecordedTrace(
    result: AgentTurnResult,
    startedAt: number,
    completedAt: number,
    model: string,
  ): UsageRecordedTraceEvent | undefined {
    const usage = result.usage;
    if (!usage && result.costUsd === undefined) {
      return undefined;
    }
    const cacheSavingsUsd = usage
      ? estimateCacheSavingsUsd({
          provider: this.providerName,
          modelId: model,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        })
      : 0;
    return {
      type: "usage.recorded",
      level: "low-signal",
      eventId: `usage:${this.providerName}:${startedAt}:${++usageEventSequence}`,
      provider: this.providerName,
      model,
      ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
      ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
      ...(usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
      ...(usage?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
      ...(cacheSavingsUsd > 0 ? { cacheSavingsUsd } : {}),
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      startedAt,
      ...(this.activeTurnFirstTokenAt === undefined ? {} : { firstTokenAt: this.activeTurnFirstTokenAt }),
      completedAt,
    };
  }

  private buildTurnStartedTrace(prompt: string, startedAt: number, model: string): TurnStartedTraceEvent {
    try {
      return parseLifecycleTrace(runRustCommandSync([
        "rust",
        "provider",
        "turn-started-trace",
        this.providerName,
        model,
        String(startedAt),
      ], process.cwd(), prompt), "turn.started");
    } catch {
      return {
        type: "turn.started",
        level: "low-signal",
        provider: this.providerName,
        model,
        prompt,
        startedAt,
      };
    }
  }

  private buildProviderRouteTrace(startedAt: number, model: string): ProviderRouteTraceEvent {
    try {
      return parseProviderRouteTrace(runRustCommandSync([
        "rust",
        "provider",
        "route-trace",
        this.providerName,
        model,
        String(startedAt),
      ], process.cwd()));
    } catch (error) {
      return {
        type: "provider.route",
        level: "default",
        provider: this.providerName,
        model,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
      };
    }
  }

  private buildProviderCallingTrace(startedAt: number, model: string): ProviderCallingTraceEvent {
    try {
      return parseLifecycleTrace(runRustCommandSync([
        "rust",
        "provider",
        "calling-trace",
        this.providerName,
        model,
        String(startedAt),
      ], process.cwd()), "provider.calling");
    } catch {
      return {
        type: "provider.calling",
        level: "default",
        provider: this.providerName,
        model,
        startedAt,
      };
    }
  }

  private buildTurnCompletedTrace(text: string, startedAt: number, completedAt: number, model: string): TurnCompletedTraceEvent {
    try {
      return parseLifecycleTrace(runRustCommandSync([
        "rust",
        "provider",
        "turn-completed-trace",
        this.providerName,
        model,
        String(startedAt),
        String(completedAt),
      ], process.cwd(), text), "turn.completed");
    } catch {
      return {
        type: "turn.completed",
        level: "low-signal",
        provider: this.providerName,
        model,
        text,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
      };
    }
  }

  private emitTrace(event: CodingAgentTraceEvent<ToolTraceEvent>): void {
    if (!this.traceListener) {
      return;
    }

    const delta = (event as { readonly delta?: unknown }).delta;
    if (
      event.type === "assistant.delta"
      && typeof delta === "string"
      && delta.length > 0
      && this.activeTurnFirstTokenAt === undefined
    ) {
      this.activeTurnFirstTokenAt = Date.now();
    }

    try {
      this.traceListener(event);
    } catch {
      // Trace visibility must not break the work loop.
    }
  }
}

function parseProviderRouteTrace(raw: string): ProviderRouteTraceEvent {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { type?: unknown }).type !== "provider.route" ||
    (parsed as { level?: unknown }).level !== "default" ||
    typeof (parsed as { provider?: unknown }).provider !== "string" ||
    typeof (parsed as { model?: unknown }).model !== "string" ||
    typeof (parsed as { startedAt?: unknown }).startedAt !== "number"
  ) {
    throw new Error("Rust provider route trace returned an invalid payload.");
  }
  return parsed as ProviderRouteTraceEvent;
}

function parseLifecycleTrace<Type extends "turn.started" | "provider.calling" | "turn.completed">(
  raw: string,
  type: Type,
): Extract<ExecutionTraceEvent, { type: Type }> {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { type?: unknown }).type !== type ||
    typeof (parsed as { provider?: unknown }).provider !== "string" ||
    typeof (parsed as { model?: unknown }).model !== "string" ||
    typeof (parsed as { startedAt?: unknown }).startedAt !== "number"
  ) {
    throw new Error(`Rust ${type} trace returned an invalid payload.`);
  }
  return parsed as Extract<ExecutionTraceEvent, { type: Type }>;
}
