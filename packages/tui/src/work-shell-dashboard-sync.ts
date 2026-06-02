import { runRustCommandSync } from "@unclecode/orchestrator";

export type WorkShellDashboardHomeSyncState = {
  readonly isBusy: boolean;
  readonly authLabel: string;
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
};

export type WorkShellDashboardHomePatch = {
  readonly authLabel: string;
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
};

export function createWorkShellDashboardHomePatch(
  input: WorkShellDashboardHomePatch,
): WorkShellDashboardHomePatch {
  return parseDashboardHomePatch(
    runRustDashboardHomeCommand("dashboard-home-patch", input),
  );
}

export function createWorkShellDashboardHomeSyncState(
  input: WorkShellDashboardHomeSyncState,
): WorkShellDashboardHomeSyncState {
  return parseDashboardHomeSyncState(
    runRustDashboardHomeCommand("dashboard-home-sync-state", input),
  );
}

export function shouldRefreshDashboardHomeState(
  previous: WorkShellDashboardHomeSyncState | undefined,
  next: WorkShellDashboardHomeSyncState,
): boolean {
  const parsed = JSON.parse(
    runRustDashboardHomeCommand("dashboard-home-refresh", { previous, next }),
  ) as { shouldRefresh?: unknown };
  if (typeof parsed.shouldRefresh !== "boolean") {
    throw new Error("Rust dashboard home refresh returned an invalid payload.");
  }
  return parsed.shouldRefresh;
}

function runRustDashboardHomeCommand(operation: string, input: unknown): string {
  return runRustCommandSync(
    ["rust", "ux", operation],
    process.cwd(),
    JSON.stringify(input),
  );
}

function parseDashboardHomePatch(raw: string): WorkShellDashboardHomePatch {
  const parsed = JSON.parse(raw) as Partial<WorkShellDashboardHomePatch>;
  if (
    typeof parsed.authLabel !== "string" ||
    !isStringArray(parsed.bridgeLines) ||
    !isStringArray(parsed.memoryLines)
  ) {
    throw new Error("Rust dashboard home patch returned an invalid payload.");
  }
  return {
    authLabel: parsed.authLabel,
    bridgeLines: parsed.bridgeLines,
    memoryLines: parsed.memoryLines,
  };
}

function parseDashboardHomeSyncState(raw: string): WorkShellDashboardHomeSyncState {
  const parsed = JSON.parse(raw) as Partial<WorkShellDashboardHomeSyncState>;
  if (
    typeof parsed.isBusy !== "boolean" ||
    typeof parsed.authLabel !== "string" ||
    !isStringArray(parsed.bridgeLines) ||
    !isStringArray(parsed.memoryLines)
  ) {
    throw new Error("Rust dashboard home sync state returned an invalid payload.");
  }
  return {
    isBusy: parsed.isBusy,
    authLabel: parsed.authLabel,
    bridgeLines: parsed.bridgeLines,
    memoryLines: parsed.memoryLines,
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((line) => typeof line === "string");
}
