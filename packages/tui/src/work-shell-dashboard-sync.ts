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
  return {
    authLabel: input.authLabel,
    bridgeLines: input.bridgeLines,
    memoryLines: input.memoryLines,
  };
}

export function createWorkShellDashboardHomeSyncState(
  input: WorkShellDashboardHomeSyncState,
): WorkShellDashboardHomeSyncState {
  return {
    isBusy: input.isBusy,
    authLabel: input.authLabel,
    bridgeLines: input.bridgeLines,
    memoryLines: input.memoryLines,
  };
}

export function shouldRefreshDashboardHomeState(
  previous: WorkShellDashboardHomeSyncState | undefined,
  next: WorkShellDashboardHomeSyncState,
): boolean {
  if (!previous) {
    return false;
  }

  return (
    (previous.isBusy && !next.isBusy) ||
    previous.authLabel !== next.authLabel ||
    previous.bridgeLines[0] !== next.bridgeLines[0] ||
    previous.memoryLines[0] !== next.memoryLines[0]
  );
}
