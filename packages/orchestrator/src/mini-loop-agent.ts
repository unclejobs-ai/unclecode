/**
 * MiniLoopAgent — append-only message log, stateless action execution per step,
 * output-marker exit. Wraps a pluggable ToolExecutor (Environment) and
 * ModelClient (Model). MMBridge / SSOT hooks attach at boundaries.
 *
 * High-level loop philosophy from mini-SWE-agent (SWE-bench, 2024).
 * Tool layer (file viewer/editor/linter/search) lives in src/aci/* (Phase B.2).
 */

import type {
  MiniLoopAction,
  MiniLoopConfig,
  MiniLoopHooks,
  MiniLoopHookContext,
  MiniLoopHookDecision,
  MiniLoopMessage,
  MiniLoopObservation,
  MiniLoopResult,
} from "@unclecode/contracts";

import { collapseOlderObservations } from "./aci/observation-collapser.js";

export interface MiniLoopToolExecutor {
  execute(action: MiniLoopAction, cwd: string): Promise<MiniLoopObservation>;
}

export type MiniLoopModelResponse = {
  readonly content: string;
  readonly actions: ReadonlyArray<MiniLoopAction>;
  readonly costUsd: number;
};

export interface MiniLoopModelClient {
  query(messages: ReadonlyArray<MiniLoopMessage>): Promise<MiniLoopModelResponse>;
}

export type MiniLoopAgentArgs = {
  readonly config: MiniLoopConfig;
  readonly executor: MiniLoopToolExecutor;
  readonly model: MiniLoopModelClient;
  readonly cwd: string;
  readonly hooks?: MiniLoopHooks;
  readonly initialUserMessage?: string;
};

export class MiniLoopAgent {
  private readonly config: MiniLoopConfig;
  private readonly executor: MiniLoopToolExecutor;
  private readonly model: MiniLoopModelClient;
  private readonly cwd: string;
  private readonly hooks: MiniLoopHooks;
  private messages: MiniLoopMessage[] = [];
  private steps = 0;
  private costUsd = 0;

  constructor(args: MiniLoopAgentArgs) {
    this.config = args.config;
    this.executor = args.executor;
    this.model = args.model;
    this.cwd = args.cwd;
    this.hooks = args.hooks ?? {};
  }

  async run(task: string): Promise<MiniLoopResult> {
    this.messages = [
      { role: "system", content: this.config.systemPrompt },
      { role: "user", content: task },
    ];

    while (true) {
      if (this.steps >= this.config.stepLimit) {
        return this.exit("limits_exceeded", "step limit reached");
      }
      if (this.costUsd >= this.config.costLimitUsd) {
        return this.exit("limits_exceeded", "cost limit reached");
      }

      const ctx: MiniLoopHookContext = {
        persona: this.config.persona,
        stepIndex: this.steps,
        messages: this.messages,
      };

      const beforeDecision = this.hooks.onBeforeStep
        ? await this.hooks.onBeforeStep(ctx)
        : ({ kind: "continue" } as MiniLoopHookDecision);
      if (beforeDecision.kind === "halt") {
        return this.exit("halted", beforeDecision.reason);
      }
      if (beforeDecision.kind === "inject") {
        this.messages.push(beforeDecision.message);
        continue;
      }

      let response: MiniLoopModelResponse;
      try {
        response = await this.model.query(this.messages);
      } catch (error) {
        return this.exit("errored", error instanceof Error ? error.message : String(error));
      }

      this.steps += 1;
      this.costUsd += response.costUsd;
      this.messages.push({
        role: "assistant",
        content: response.content,
        stepIndex: this.steps,
      });

      if (response.actions.length === 0) {
        return this.exit("submitted", response.content);
      }

      for (const action of response.actions) {
        if (this.config.allowedTools.length > 0 && !this.config.allowedTools.includes(action.tool)) {
          this.messages.push({
            role: "tool",
            content: `Tool "${action.tool}" not allowed for persona "${this.config.persona}"`,
            stepIndex: this.steps,
            action,
            observation: { stdout: "", stderr: "tool not allowed", exitCode: -1, truncated: false },
          });
          continue;
        }

        let observation: MiniLoopObservation;
        try {
          observation = await this.executor.execute(action, this.cwd);
        } catch (error) {
          observation = {
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: -1,
            truncated: false,
          };
        }

        this.messages.push({
          role: "tool",
          content: observation.stdout || observation.stderr,
          stepIndex: this.steps,
          action,
          observation,
        });

        const submitted = this.detectSubmit(observation);
        if (submitted !== null) {
          if (this.hooks.onSubmit) {
            const decision = await this.hooks.onSubmit(
              { persona: this.config.persona, stepIndex: this.steps, messages: this.messages },
              submitted,
            );
            if (decision.kind === "halt") {
              return this.exit("halted", decision.reason);
            }
            if (decision.kind === "inject") {
              this.messages.push(decision.message);
              continue;
            }
          }
          return this.exit("submitted", submitted);
        }

        if (this.hooks.onAfterStep) {
          const decision = await this.hooks.onAfterStep(
            { persona: this.config.persona, stepIndex: this.steps, messages: this.messages },
            action,
            observation,
          );
          if (decision.kind === "halt") {
            return this.exit("halted", decision.reason);
          }
          if (decision.kind === "inject") {
            this.messages.push(decision.message);
          }
        }
      }

      this.messages = [...collapseOlderObservations(this.messages, 5)];
    }
  }

  private detectSubmit(observation: MiniLoopObservation): string | null {
    if (observation.exitCode !== 0) {
      return null;
    }
    const lines = observation.stdout.split(/\r?\n/);
    const firstNonEmpty = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
    if (firstNonEmpty !== this.config.submitMarker) {
      return null;
    }
    const markerIndex = lines.findIndex((line) => line.trim() === this.config.submitMarker);
    return lines
      .slice(markerIndex + 1)
      .join("\n")
      .trim();
  }

  private exit(status: MiniLoopResult["status"], submission: string): MiniLoopResult {
    this.messages.push({ role: "exit", content: status, stepIndex: this.steps });
    return {
      status,
      submission,
      steps: this.steps,
      costUsd: this.costUsd,
      messages: this.messages,
    };
  }
}
