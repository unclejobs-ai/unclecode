import {
  formatSessionCenterDraftValue,
  type SessionCenterResearchRun,
} from "./dashboard-actions.js";

type InspectorTone = "muted" | "text" | "success" | "warning";

export type DashboardInspectorLine = {
  readonly text: string;
  readonly tone: InspectorTone;
};

export function formatWorkContextDisplayText(value: string): string {
  const text = value.trim();
  if (text.length === 0) {
    return text;
  }
  if (/^Context brief completed$/i.test(text)) {
    return "Work context refreshed";
  }
  if (/^Context brief failed$/i.test(text)) {
    return "Work context refresh failed";
  }
  if (/^Artifact:/i.test(text)) {
    return "Saved local context snapshot";
  }
  if (/^Session: research-/i.test(text)) {
    return "Saved in Work history";
  }
  if (/^No active context brief$/i.test(text)) {
    return "No saved Work context refresh";
  }
  if (/^Summary:/i.test(text)) {
    return formatWorkContextDisplayText(text.replace(/^Summary:\s*/i, ""));
  }

  return text
    .replace(/Prepared a local research bundle for/gi, "Refreshed Work context for")
    .replace(/Prepared a context brief for/gi, "Refreshed Work context for")
    .replace(/Prepared a context brief/gi, "Refreshed Work context")
    .replace(/Context brief status/gi, "Work context status")
    .replace(/context briefs/gi, "Work context")
    .replace(/context brief/gi, "Work context")
    .replace(/research bundle/gi, "Work context")
    .replace(/\bbriefs\b/gi, "context")
    .replace(/\bbrief\b/gi, "context");
}

function runStatusLabel(status: SessionCenterResearchRun["status"]): string {
  switch (status) {
    case "completed":
      return "refreshed";
    case "failed":
      return "failed";
    case "unknown":
      return "unknown";
  }
}

export function buildResearchInspectorLines(input: {
  readonly latestResearchSessionId: string | null;
  readonly latestResearchSummary: string | null;
  readonly latestResearchTimestamp: string | null;
  readonly researchRunCount: number;
  readonly recentResearchRuns?: readonly SessionCenterResearchRun[];
  readonly selectedRunIndex?: number;
  readonly researchDraft: string;
  readonly isDraftOpen: boolean;
}): readonly DashboardInspectorLine[] {
  const lines: DashboardInspectorLine[] = [
    { text: "Workspace context for Work", tone: "text" },
    { text: "Work already uses live repo state.", tone: "muted" },
    { text: "N refreshes a focused scan when a task needs sharper context.", tone: "muted" },
    { text: `Refreshes · ${String(input.researchRunCount)}`, tone: "muted" },
  ];

  if (input.isDraftOpen) {
    lines.push(
      { text: "Focus", tone: "muted" },
      {
        text: input.researchDraft.length > 0
          ? formatSessionCenterDraftValue("new-research", input.researchDraft)
          : "Example: inspect auth flow risks",
        tone: "warning",
      },
      { text: "Enter/Ctrl+R refreshes · Esc cancels", tone: "success" },
    );
  } else {
    lines.push(
      { text: "Press N to refresh focused context", tone: "warning" },
      { text: "Skip it when the normal Work prompt is enough.", tone: "muted" },
    );
  }

  if (input.latestResearchSessionId || input.latestResearchSummary) {
    lines.push(
      { text: "Latest context", tone: "muted" },
      {
        text: input.latestResearchSummary
          ? formatWorkContextDisplayText(input.latestResearchSummary)
          : "No summary recorded.",
        tone: "text",
      },
      { text: input.latestResearchTimestamp ?? "saved in Work history", tone: "muted" },
    );
  }

  if (input.recentResearchRuns && input.recentResearchRuns.length > 0) {
    const selectedRun = input.selectedRunIndex !== undefined
      ? input.recentResearchRuns[input.selectedRunIndex]
      : undefined;
    if (selectedRun) {
      lines.push(
        { text: "Selected context", tone: "muted" },
        {
          text: `${runStatusLabel(selectedRun.status)} · ${selectedRun.prompt}`,
          tone: selectedRun.status === "failed" ? "warning" : "text",
        },
        { text: selectedRun.timestamp ?? "saved in Work history", tone: "muted" },
      );
    }
    lines.push({ text: "Recent context", tone: "muted" });
    for (const run of input.recentResearchRuns.slice(0, 2)) {
      lines.push({
        text: `${runStatusLabel(run.status)} · ${run.prompt || run.sessionId}`,
        tone: run.status === "failed" ? "warning" : "muted",
      });
      if (run.summary.trim().length > 0 && run.summary !== input.latestResearchSummary) {
        lines.push({ text: formatWorkContextDisplayText(run.summary), tone: "text" });
      }
    }
  }

  return lines;
}
