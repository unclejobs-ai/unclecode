import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from "@unclecode/contracts";

export interface WorkShellInteractionHost {
  ask(
    request: AskUserQuestionRequest,
    signal?: AbortSignal | undefined,
  ): Promise<AskUserQuestionResult>;
}

export interface WorkShellInteractionBridge {
  ask(
    request: AskUserQuestionRequest,
    signal?: AbortSignal | undefined,
  ): Promise<AskUserQuestionResult>;
  bind(host: WorkShellInteractionHost): void;
  unbind(reason: string): void;
}

type PendingInteraction = {
  abort(): void;
  settle(result: AskUserQuestionResult): void;
};

const UNAVAILABLE_REASON = "Work Shell interaction is unavailable.";

export function createWorkShellInteractionBridge(): WorkShellInteractionBridge {
  let host: WorkShellInteractionHost | undefined;
  const pending = new Set<PendingInteraction>();

  return {
    async ask(request, signal) {
      if (host === undefined) {
        return { status: "unavailable", reason: UNAVAILABLE_REASON };
      }
      if (signal?.aborted) {
        return { status: "cancelled" };
      }
      const currentHost = host;

      return await new Promise<AskUserQuestionResult>((resolve) => {
        const controller = new AbortController();
        let settled = false;
        const interaction: PendingInteraction = {
          abort() {
            controller.abort();
          },
          settle(result) {
            if (settled) {
              return;
            }
            settled = true;
            pending.delete(interaction);
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
          },
        };
        const onAbort = () => {
          interaction.abort();
          interaction.settle({ status: "cancelled" });
        };
        pending.add(interaction);
        signal?.addEventListener("abort", onAbort, { once: true });

        void new Promise<AskUserQuestionResult>((resolveHost) => {
          if (controller.signal.aborted) {
            resolveHost({ status: "cancelled" });
            return;
          }
          resolveHost(currentHost.ask(request, controller.signal));
        })
          .then((result) => interaction.settle(result))
          .catch(() => interaction.settle({
            status: "unavailable",
            reason: UNAVAILABLE_REASON,
          }));
      });
    },
    bind(nextHost) {
      for (const interaction of [...pending]) {
        interaction.abort();
        interaction.settle({ status: "unavailable", reason: UNAVAILABLE_REASON });
      }
      host = nextHost;
    },
    unbind(reason) {
      host = undefined;
      for (const interaction of [...pending]) {
        interaction.abort();
        interaction.settle({ status: "unavailable", reason });
      }
    },
  };
}
