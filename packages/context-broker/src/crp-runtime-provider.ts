import {
  type ContextPacketViewBadge,
  type UpsertContextSourceInput,
} from "@unclecode/contracts";

import {
  deriveSalience,
  estimateTokens,
  type ContextProvider,
} from "./crp-provider-utils.js";

type RuntimeTraceToolProfile = {
  readonly risk: "low" | "medium" | "high" | "unknown";
  readonly resourceLabel: string;
};

export type RuntimeContextProvider = ContextProvider & {
  readonly pushTraceLine: (line: string) => void;
  readonly clearTrace: () => void;
};

function runtimeTraceToolProfile(line: string): RuntimeTraceToolProfile | undefined {
  const match = /^(?:[→✓✖]\s+)(read|write|search|bash|apply_patch|read_file|write_file|list_files|search_text|run_shell)\b/i.exec(line);
  const tool = match?.[1]?.toLowerCase();
  switch (tool) {
    case "read":
    case "read_file":
    case "list_files":
    case "search":
    case "search_text":
      return { risk: "low", resourceLabel: "resource read" };
    case "write":
    case "write_file":
    case "apply_patch":
      return { risk: "high", resourceLabel: "resource write" };
    case "bash":
    case "run_shell":
      return { risk: "unknown", resourceLabel: "resource shell" };
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function riskBadgeTone(risk: RuntimeTraceToolProfile["risk"]): ContextPacketViewBadge["tone"] {
  switch (risk) {
    case "low":
      return "success";
    case "medium":
      return "warning";
    case "high":
      return "danger";
    case "unknown":
      return "muted";
  }
}

function runtimeTraceRisk(line: string): RuntimeTraceToolProfile["risk"] | undefined {
  const match = /\brisk\s+(low|medium|high|unknown)\b/i.exec(line);
  const risk = match?.[1]?.toLowerCase();
  if (risk === "low" || risk === "medium" || risk === "high" || risk === "unknown") {
    return risk;
  }
  return undefined;
}

function runtimeTraceResourceLabel(line: string): string | undefined {
  const match = /\bresources?\s+(read|write|delete|execute|unknown)\b/i.exec(line);
  const mode = match?.[1]?.toLowerCase();
  if (mode !== undefined) return `resource ${mode}`;
  return /\bresources?\b/i.test(line) ? "resources" : undefined;
}

function deriveRuntimeTraceBadges(line: string): readonly ContextPacketViewBadge[] {
  const badges: ContextPacketViewBadge[] = [];
  const profile = runtimeTraceToolProfile(line);
  if (profile !== undefined || /\btool\.(?:started|completed)\b/i.test(line)) {
    badges.push({ label: "tool", tone: "info" });
  }
  const risk = runtimeTraceRisk(line) ?? profile?.risk;
  if (risk !== undefined) {
    badges.push({ label: `risk ${risk}`, tone: riskBadgeTone(risk) });
  }
  const resourceLabel = runtimeTraceResourceLabel(line) ?? profile?.resourceLabel;
  if (resourceLabel !== undefined) {
    badges.push({ label: resourceLabel, tone: "info" });
  }
  return dedupeContextPacketBadges(badges);
}

function dedupeContextPacketBadges(
  badges: readonly ContextPacketViewBadge[],
): readonly ContextPacketViewBadge[] {
  const seen = new Set<string>();
  const deduped: ContextPacketViewBadge[] = [];
  for (const badge of badges) {
    const key = `${badge.tone}\0${badge.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(badge);
  }
  return deduped;
}

export function createRuntimeProvider(): RuntimeContextProvider {
  let traceBuffer: string[] = [];
  const MAX_TRACE = 12;
  return {
    providerId: "runtime",
    categories: ["runtime"],
    refresh: "on-turn",
    trustTier: "builtin",
    pushTraceLine(line: string) {
      traceBuffer.push(line);
      if (traceBuffer.length > MAX_TRACE) traceBuffer = traceBuffer.slice(-MAX_TRACE);
    },
    clearTrace() {
      traceBuffer = [];
    },
    async sync(input) {
      const touched: string[] = [];
      const lines = traceBuffer;
      const total = lines.length;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line === undefined) continue;
        const id = `runtime-trace-${i + 1}`;
        const ageFromEnd = total - 1 - i;
        const badges = deriveRuntimeTraceBadges(line);
        const upsert: UpsertContextSourceInput = {
          id,
          projectId: input.projectId,
          category: "runtime",
          label: line.slice(0, 120),
          content: line,
          reason: "live work-shell trace",
          salience: deriveSalience({ base: 0.55, ageTurns: ageFromEnd, length: line.length }),
          tokenEstimate: estimateTokens(line),
          ...(badges.length > 0 ? { badges } : {}),
        };
        input.store.upsertContextSource(upsert);
        touched.push(id);
      }
      input.store.deleteContextSourcesByIdPrefix({
        projectId: input.projectId,
        idPrefix: "runtime-trace-",
        keepIds: touched,
      });
      return touched;
    },
  };
}
