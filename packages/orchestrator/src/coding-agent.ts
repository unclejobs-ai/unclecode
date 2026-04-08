import type { ExecutionTraceEvent } from "@unclecode/contracts";

type TraceProviderName = Extract<ExecutionTraceEvent, { type: "provider.calling" }>["provider"];

export type AgentTurnResult = {
  text: string;
};

export type CodingAgentTraceEvent<ToolTraceEvent extends { readonly type: string }> =
  | Extract<ExecutionTraceEvent, { type: "turn.started" | "provider.calling" | "turn.completed" }>
  | ToolTraceEvent;

export interface CodingAgentProvider<
  Attachment,
  Reasoning,
  ToolTraceEvent extends { readonly type: string },
> {
  clear(): void;
  setTraceListener(listener?: ((event: ToolTraceEvent) => void) | undefined): void;
  updateRuntimeSettings(settings: { reasoning?: Reasoning | undefined; model?: string | undefined }): void;
  runTurn(prompt: string, attachments?: readonly Attachment[]): Promise<AgentTurnResult>;
}

export interface TurnAgent<
  Attachment,
  Reasoning,
  TraceEvent extends { readonly type: string },
> {
  clear(): void;
  setTraceListener(listener?: ((event: TraceEvent) => void) | undefined): void;
  updateRuntimeSettings(settings: { reasoning?: Reasoning | undefined; model?: string | undefined }): void;
  runTurn(prompt: string, attachments?: readonly Attachment[]): Promise<AgentTurnResult>;
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

  async runTurn(prompt: string, attachments: readonly Attachment[] = []): Promise<AgentTurnResult> {
    const turnStartedAt = Date.now();
    this.emitTrace({
      type: "turn.started",
      level: "low-signal",
      provider: this.providerName,
      model: this.model,
      prompt,
      startedAt: turnStartedAt,
    });
    this.emitTrace({
      type: "provider.calling",
      level: "default",
      provider: this.providerName,
      model: this.model,
      startedAt: turnStartedAt,
    });

    const result = await this.provider.runTurn(prompt, attachments);
    const completedAt = Date.now();
    this.emitTrace({
      type: "turn.completed",
      level: "low-signal",
      provider: this.providerName,
      model: this.model,
      text: result.text,
      startedAt: turnStartedAt,
      completedAt,
      durationMs: completedAt - turnStartedAt,
    });
    return result;
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
