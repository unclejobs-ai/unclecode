import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type OmoContextIncludedItem =
  | {
      readonly kind: "omo-goal";
      readonly sessionId: string;
      readonly goalId: string;
      readonly status: string;
      readonly summary: string;
    }
  | {
      readonly kind: "omo-criterion";
      readonly sessionId: string;
      readonly goalId: string;
      readonly criterionId: string;
      readonly status: string;
      readonly summary: string;
    };

export type OmoContextExcludedItem = {
  readonly path: string;
  readonly reason: string;
};

export type OmoContextSnapshot = {
  readonly sourceLabel: ".omo/ulw-loop";
  readonly included: readonly OmoContextIncludedItem[];
  readonly excluded: readonly OmoContextExcludedItem[];
  readonly warnings: readonly string[];
};

type OmoGoalPlan = {
  readonly activeGoalId?: unknown;
  readonly goals?: unknown;
};

const ACTIVE_GOAL_STATUSES = new Set(["pending", "in_progress", "review_blocked", "needs_user_decision"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, fallback = ""): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function summarizeText(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listDirectories(rootDir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function listEvidencePaths(sessionDir: string, sessionId: string): Promise<readonly string[]> {
  const evidenceDir = path.join(sessionDir, "evidence");
  try {
    const entries = await readdir(evidenceDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.posix.join(".omo", "ulw-loop", sessionId, "evidence", entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function excludedArtifactPaths(sessionDir: string, sessionId: string): Promise<readonly OmoContextExcludedItem[]> {
  const excluded: OmoContextExcludedItem[] = [];
  const ledgerPath = path.join(sessionDir, "ledger.jsonl");
  if (await exists(ledgerPath)) {
    excluded.push({
      path: path.posix.join(".omo", "ulw-loop", sessionId, "ledger.jsonl"),
      reason: "raw OMO ledger is excluded from provider context",
    });
  }
  for (const evidencePath of await listEvidencePaths(sessionDir, sessionId)) {
    excluded.push({
      path: evidencePath,
      reason: "raw OMO evidence transcript is excluded from provider context",
    });
  }
  return excluded;
}

function findGoalById(plan: OmoGoalPlan, goalId: string): Record<string, unknown> | undefined {
  if (!Array.isArray(plan.goals)) {
    return undefined;
  }
  for (const goal of plan.goals) {
    if (!isRecord(goal)) {
      continue;
    }
    if (stringField(goal, "id") === goalId) {
      return goal;
    }
  }
  return undefined;
}

function isActiveGoal(goal: Record<string, unknown> | undefined): goal is Record<string, unknown> {
  return goal !== undefined && ACTIVE_GOAL_STATUSES.has(stringField(goal, "status", "unknown"));
}

function includedItemsFromGoal(sessionId: string, goal: Record<string, unknown>): readonly OmoContextIncludedItem[] {
  const goalId = stringField(goal, "id");
  if (!goalId) {
    return [];
  }
  const status = stringField(goal, "status", "unknown");
  const title = stringField(goal, "title");
  const objective = stringField(goal, "objective");
  const included: OmoContextIncludedItem[] = [{
    kind: "omo-goal",
    sessionId,
    goalId,
    status,
    summary: summarizeText(title || objective || goalId),
  }];

  const criteria = goal.successCriteria;
  if (!Array.isArray(criteria)) {
    return included;
  }
  for (const criterion of criteria) {
    if (!isRecord(criterion)) {
      continue;
    }
    const criterionId = stringField(criterion, "id");
    if (!criterionId) {
      continue;
    }
    included.push({
      kind: "omo-criterion",
      sessionId,
      goalId,
      criterionId,
      status: stringField(criterion, "status", "unknown"),
      summary: summarizeText(stringField(criterion, "scenario") || criterionId),
    });
  }
  return included;
}

export async function loadOmoContextSnapshot(rootDir: string): Promise<OmoContextSnapshot> {
  const ulwRoot = path.join(rootDir, ".omo", "ulw-loop");
  const sessionIds = await listDirectories(ulwRoot);
  const included: OmoContextIncludedItem[] = [];
  const excluded: OmoContextExcludedItem[] = [];
  const warnings: string[] = [];
  const activeSessionIds: string[] = [];
  const activeSessionGoals: Array<{ readonly sessionId: string; readonly goal: Record<string, unknown> }> = [];

  for (const sessionId of sessionIds) {
    const sessionDir = path.join(ulwRoot, sessionId);
    excluded.push(...await excludedArtifactPaths(sessionDir, sessionId));

    try {
      const raw = await readFile(path.join(sessionDir, "goals.json"), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        warnings.push(`Malformed OMO goals JSON in ${sessionId}: expected object.`);
        continue;
      }
      const plan = parsed as OmoGoalPlan;
      if (typeof plan.activeGoalId === "string" && plan.activeGoalId.length > 0) {
        const activeGoal = findGoalById(plan, plan.activeGoalId);
        if (isActiveGoal(activeGoal)) {
          activeSessionIds.push(sessionId);
          activeSessionGoals.push({ sessionId, goal: activeGoal });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Malformed OMO goals JSON in ${sessionId}: ${message}`);
    }
  }

  if (activeSessionIds.length > 1) {
    warnings.push(`Multiple active OMO sessions detected: ${activeSessionIds.join(", ")}. OMO goal summaries omitted to avoid selecting stale context.`);
  } else if (activeSessionGoals[0]) {
    included.push(...includedItemsFromGoal(activeSessionGoals[0].sessionId, activeSessionGoals[0].goal));
  }

  return {
    sourceLabel: ".omo/ulw-loop",
    included,
    excluded,
    warnings,
  };
}
