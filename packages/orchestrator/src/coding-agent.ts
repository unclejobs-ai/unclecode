import type { ExecutionTraceEvent } from "@unclecode/contracts";
import { runRustCommandSync } from "./rust-command.js";

type TraceProviderName = Extract<ExecutionTraceEvent, { type: "provider.calling" }>["provider"];
type ProviderRouteTraceEvent = Extract<ExecutionTraceEvent, { type: "provider.route" }>;
type TurnStartedTraceEvent = Extract<ExecutionTraceEvent, { type: "turn.started" }>;
type ProviderCallingTraceEvent = Extract<ExecutionTraceEvent, { type: "provider.calling" }>;
type TurnCompletedTraceEvent = Extract<ExecutionTraceEvent, { type: "turn.completed" }>;

export type AgentTurnResult = {
  text: string;
};

export type AgentTurnOptions = {
  readonly signal?: AbortSignal | undefined;
};

export type CodingAgentTraceEvent<ToolTraceEvent extends { readonly type: string }> =
  | Extract<ExecutionTraceEvent, { type: "turn.started" | "provider.route" | "provider.calling" | "turn.completed" }>
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
    this.emitTrace(this.buildTurnStartedTrace(prompt, turnStartedAt));
    this.emitTrace(this.buildProviderRouteTrace(turnStartedAt));
    this.emitTrace(this.buildProviderCallingTrace(turnStartedAt));

    const result = await this.provider.runTurn(prompt, attachments, options);
    const completedAt = Date.now();
    this.emitTrace(this.buildTurnCompletedTrace(result.text, turnStartedAt, completedAt));
    return result;
  }

  private buildTurnStartedTrace(prompt: string, startedAt: number): TurnStartedTraceEvent {
    try {
      return parseLifecycleTrace(runRustCommandSync([
        "rust",
        "provider",
        "turn-started-trace",
        this.providerName,
        this.model,
        String(startedAt),
      ], process.cwd(), prompt), "turn.started");
    } catch {
      return {
        type: "turn.started",
        level: "low-signal",
        provider: this.providerName,
        model: this.model,
        prompt,
        startedAt,
      };
    }
  }

  private buildProviderRouteTrace(startedAt: number): ProviderRouteTraceEvent {
    try {
      return parseProviderRouteTrace(runRustCommandSync([
        "rust",
        "provider",
        "route-trace",
        this.providerName,
        this.model,
        String(startedAt),
      ], process.cwd()));
    } catch (error) {
      return {
        type: "provider.route",
        level: "default",
        provider: this.providerName,
        model: this.model,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
      };
    }
  }

  private buildProviderCallingTrace(startedAt: number): ProviderCallingTraceEvent {
    try {
      return parseLifecycleTrace(runRustCommandSync([
        "rust",
        "provider",
        "calling-trace",
        this.providerName,
        this.model,
        String(startedAt),
      ], process.cwd()), "provider.calling");
    } catch {
      return {
        type: "provider.calling",
        level: "default",
        provider: this.providerName,
        model: this.model,
        startedAt,
      };
    }
  }

  private buildTurnCompletedTrace(text: string, startedAt: number, completedAt: number): TurnCompletedTraceEvent {
    try {
      return parseLifecycleTrace(runRustCommandSync([
        "rust",
        "provider",
        "turn-completed-trace",
        this.providerName,
        this.model,
        String(startedAt),
        String(completedAt),
      ], process.cwd(), text), "turn.completed");
    } catch {
      return {
        type: "turn.completed",
        level: "low-signal",
        provider: this.providerName,
        model: this.model,
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
