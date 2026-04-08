export function resolveBusyStatusFromTraceEvent(
  event: { readonly type: string; readonly status?: string },
  line: string,
): string | null | undefined {
  if (event.type === "turn.completed") {
    return undefined;
  }

  if (
    event.type === "turn.started"
    || event.type === "provider.calling"
    || event.type === "tool.started"
    || (event.type === "orchestrator.step" && event.status === "running")
  ) {
    return line || "thinking";
  }

  return null;
}

export function resolveTraceEntryRole(event: { readonly type: string }): "system" | "tool" {
  return event.type === "turn.started" || event.type === "turn.completed"
    ? "system"
    : "tool";
}

export function extractCurrentTurnStartedAt(event: { readonly type: string; readonly startedAt?: unknown }): number | undefined {
  return event.type === "turn.started" && typeof event.startedAt === "number"
    ? event.startedAt
    : undefined;
}
