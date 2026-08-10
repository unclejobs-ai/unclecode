import type {
  AgentConsoleSnapshot,
  AgentConsoleTab,
  AgentControlReceipt,
  AgentRun,
  AsyncJob,
  WorkNode,
} from "@unclecode/contracts";

/**
 * What the operator is doing with the selected record. Cancelling is the only
 * destructive control, so it is the only one that parks the console in a
 * confirmation state instead of firing straight at the runtime.
 */
export type AgentConsoleControlState =
  | { readonly kind: "browse" }
  | { readonly kind: "confirm-cancel"; readonly agentRunId: string };

/**
 * Engine-owned navigation state for the Agent Console. It deliberately holds
 * no lifecycle data: every row it addresses is resolved against the current
 * `AgentConsoleSnapshot`, so a console view can never render a record the
 * snapshot has already dropped.
 */
export type AgentConsoleViewState = {
  readonly open: boolean;
  readonly tab: AgentConsoleTab;
  readonly cursor: number;
  readonly inspectorVisible: boolean;
  readonly control: AgentConsoleControlState;
  readonly receipt?: AgentControlReceipt;
};

/** The record the cursor addresses, discriminated by the tab that owns it. */
export type AgentConsoleSelection =
  | { readonly tab: "agents"; readonly run: AgentRun }
  | { readonly tab: "jobs"; readonly job: AsyncJob }
  | { readonly tab: "plan"; readonly node: WorkNode };

const BROWSE: AgentConsoleControlState = { kind: "browse" };

const CANCEL_UNAVAILABLE_MESSAGE = "Select a running agent to cancel.";

/** A run that has settled can no longer be steered or cancelled. */
export function isSettledAgentRun(run: AgentRun): boolean {
  return run.status === "completed"
    || run.status === "failed"
    || run.status === "cancelled"
    || run.status === "interrupted";
}

/** A job that has settled no longer counts as active console work. */
export function isSettledAsyncJob(job: AsyncJob): boolean {
  return job.status === "completed"
    || job.status === "failed"
    || job.status === "cancelled"
    || job.status === "interrupted";
}

export function countAgentConsoleRows(
  snapshot: AgentConsoleSnapshot,
  tab: AgentConsoleTab,
): number {
  switch (tab) {
    case "agents":
      return snapshot.agents.length;
    case "jobs":
      return snapshot.jobs.length;
    case "plan":
      return snapshot.workGraph?.nodes.length ?? 0;
  }
}

export function createAgentConsoleViewState(): AgentConsoleViewState {
  return {
    open: false,
    tab: "agents",
    cursor: 0,
    inspectorVisible: true,
    control: BROWSE,
  };
}

/**
 * Single immutable revision point. A receipt describes the outcome of the
 * control that produced it, so it is retired by every revision that does not
 * explicitly carry a new one — a stale "accepted" must never outlive the row
 * it belonged to.
 */
function reviseAgentConsoleView(
  view: AgentConsoleViewState,
  patch: {
    readonly open?: boolean;
    readonly tab?: AgentConsoleTab;
    readonly cursor?: number;
    readonly inspectorVisible?: boolean;
    readonly control?: AgentConsoleControlState;
    readonly receipt?: AgentControlReceipt;
  },
): AgentConsoleViewState {
  return {
    open: patch.open ?? view.open,
    tab: patch.tab ?? view.tab,
    cursor: patch.cursor ?? view.cursor,
    inspectorVisible: patch.inspectorVisible ?? view.inspectorVisible,
    control: patch.control ?? view.control,
    ...(patch.receipt === undefined ? {} : { receipt: patch.receipt }),
  };
}

function clampCursor(cursor: number, rows: number): number {
  if (rows <= 0) {
    return 0;
  }
  return Math.min(Math.max(0, Math.trunc(cursor)), rows - 1);
}

export function openAgentConsoleView(
  view: AgentConsoleViewState,
  snapshot: AgentConsoleSnapshot,
  tab?: AgentConsoleTab,
): AgentConsoleViewState {
  const nextTab = tab ?? view.tab;
  const cursor = nextTab === view.tab ? view.cursor : 0;
  return reviseAgentConsoleView(view, {
    open: true,
    tab: nextTab,
    cursor: clampCursor(cursor, countAgentConsoleRows(snapshot, nextTab)),
    control: BROWSE,
  });
}

export function closeAgentConsoleView(view: AgentConsoleViewState): AgentConsoleViewState {
  return reviseAgentConsoleView(view, { open: false, control: BROWSE });
}

export function selectAgentConsoleTab(
  view: AgentConsoleViewState,
  snapshot: AgentConsoleSnapshot,
  tab: AgentConsoleTab,
): AgentConsoleViewState {
  const cursor = tab === view.tab ? view.cursor : 0;
  return reviseAgentConsoleView(view, {
    tab,
    cursor: clampCursor(cursor, countAgentConsoleRows(snapshot, tab)),
    control: BROWSE,
  });
}

export function moveAgentConsoleCursor(
  view: AgentConsoleViewState,
  snapshot: AgentConsoleSnapshot,
  delta: number,
): AgentConsoleViewState {
  return reviseAgentConsoleView(view, {
    cursor: clampCursor(view.cursor + delta, countAgentConsoleRows(snapshot, view.tab)),
  });
}

export function toggleAgentConsoleInspector(view: AgentConsoleViewState): AgentConsoleViewState {
  return reviseAgentConsoleView(view, { inspectorVisible: !view.inspectorVisible });
}

/**
 * Arm the cancel confirmation for the selected run. A row that is not a live
 * agent run cannot be cancelled, so the request settles as a rejection instead
 * of parking the console in a confirmation nothing can answer.
 */
export function requestAgentConsoleCancel(
  view: AgentConsoleViewState,
  snapshot: AgentConsoleSnapshot,
): AgentConsoleViewState {
  const selection = resolveAgentConsoleSelection(view, snapshot);
  if (selection?.tab !== "agents" || isSettledAgentRun(selection.run)) {
    return reviseAgentConsoleView(view, {
      control: BROWSE,
      receipt: { status: "rejected", message: CANCEL_UNAVAILABLE_MESSAGE },
    });
  }
  return reviseAgentConsoleView(view, {
    control: { kind: "confirm-cancel", agentRunId: selection.run.id },
  });
}

/**
 * Return the console to browsing. Passing a receipt records the outcome of the
 * control that just ran; omitting it abandons the control silently.
 */
export function settleAgentConsoleControl(
  view: AgentConsoleViewState,
  receipt?: AgentControlReceipt,
): AgentConsoleViewState {
  return reviseAgentConsoleView(view, {
    control: BROWSE,
    ...(receipt === undefined ? {} : { receipt }),
  });
}

/**
 * Re-anchor the view against a newly reduced snapshot: the cursor stays inside
 * the rows that still exist, and a confirmation whose target settled (or left
 * the snapshot) is abandoned rather than cancelling a finished run.
 */
export function clampAgentConsoleView(
  view: AgentConsoleViewState,
  snapshot: AgentConsoleSnapshot,
): AgentConsoleViewState {
  const cursor = clampCursor(view.cursor, countAgentConsoleRows(snapshot, view.tab));
  // Snapshot re-anchoring is not operator navigation, so it must not retire a
  // receipt the operator has not seen yet.
  const keptReceipt = view.receipt === undefined ? {} : { receipt: view.receipt };
  const control = view.control;
  if (control.kind === "confirm-cancel") {
    const target = snapshot.agents.find((agent) => agent.id === control.agentRunId);
    if (!target || isSettledAgentRun(target)) {
      return reviseAgentConsoleView(view, { cursor, control: BROWSE, ...keptReceipt });
    }
  }
  return reviseAgentConsoleView(view, { cursor, ...keptReceipt });
}

/**
 * The one merge invariant between the two writers of an `AgentConsoleSnapshot`.
 *
 * Lifecycle-owned fields (`workGraph`, `activity`, `agents`, `jobs`,
 * `mainUsage`) come from the pending reduction, so a burst stays in arrival
 * order. Shell-owned fields (`profileId`, `manifest`, `pendingDecision`) are
 * re-read from the live snapshot, so a decision or manifest that changed inside
 * the coalescing window is neither overwritten by the next reduction nor
 * resurrected after it settled. Both inputs are already normalised snapshots,
 * so the merge re-picks references instead of deep-copying.
 */
export function mergeAgentConsoleLifecycle(
  pending: AgentConsoleSnapshot,
  current: AgentConsoleSnapshot,
): AgentConsoleSnapshot {
  if (
    pending.profileId === current.profileId
    && pending.manifest === current.manifest
    && pending.pendingDecision === current.pendingDecision
  ) {
    return pending;
  }
  return {
    profileId: current.profileId,
    ...(current.manifest === undefined ? {} : { manifest: current.manifest }),
    ...(current.pendingDecision === undefined ? {} : { pendingDecision: current.pendingDecision }),
    ...(pending.workGraph === undefined ? {} : { workGraph: pending.workGraph }),
    activity: pending.activity,
    agents: pending.agents,
    jobs: pending.jobs,
    ...(pending.mainUsage === undefined ? {} : { mainUsage: pending.mainUsage }),
  };
}

export function resolveAgentConsoleSelection(
  view: AgentConsoleViewState,
  snapshot: AgentConsoleSnapshot,
): AgentConsoleSelection | undefined {
  switch (view.tab) {
    case "agents": {
      const run = snapshot.agents[view.cursor];
      return run ? { tab: "agents", run } : undefined;
    }
    case "jobs": {
      const job = snapshot.jobs[view.cursor];
      return job ? { tab: "jobs", job } : undefined;
    }
    case "plan": {
      const node = snapshot.workGraph?.nodes[view.cursor];
      return node ? { tab: "plan", node } : undefined;
    }
  }
}
