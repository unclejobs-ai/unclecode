import type { DatabaseSync } from "node:sqlite";

import { type ContextSourceRecord, type SelectContextSourcesInput } from "@unclecode/contracts";

import { contextSourceRowToRecord, mapContextSourceRow } from "./store-mappers.js";
import type { SelectedContextSources } from "./store-types.js";
import { sqlRow, sqlRows } from "./sql-row.js";

/**
 * Select context sources for a turn under a token budget.
 *
 * Sources are ranked by salience (desc) then recency (updated_at desc).
 * The selector greedily adds sources until the cumulative token estimate
 * exceeds the budget. The top-ranked source is always included even if it
 * alone exceeds the budget (never silently drop the most relevant source).
 *
 * Sources with included_in_model = 0 are returned as "heldBack" so the
 * Runbook can show them in the "Held back locally" section without a
 * separate query.
 */
export function selectContextSources(
  db: DatabaseSync,
  input: SelectContextSourcesInput,
): SelectedContextSources {
  const nowIso = new Date().toISOString();
  const params: readonly (string | number)[] = [
    input.projectId,
    nowIso,
    input.minSalience ?? 0,
  ];

  // Build category filter with placeholders if provided.
  let categoryClause = "";
  if (input.categoryFilter !== undefined && input.categoryFilter.length > 0) {
    const placeholders = input.categoryFilter.map(() => "?").join(",");
    categoryClause = ` AND category IN (${placeholders})`;
  }

  const rows = db
    .prepare(
      `SELECT * FROM context_sources
       WHERE project_id = ?
         AND (expires_at IS NULL OR expires_at > ?)
         AND salience >= ?${categoryClause}
       ORDER BY salience DESC, updated_at DESC`,
    )
    .all(...params, ...(input.categoryFilter ?? []));

  const sqlRowsAll = sqlRows(rows, "context_sources select");
  const allRecords = sqlRowsAll.map((row) => contextSourceRowToRecord(mapContextSourceRow(row)));

  const selected: ContextSourceRecord[] = [];
  const heldBack: ContextSourceRecord[] = [];
  let totalTokens = 0;

  for (const record of allRecords) {
    if (!record.includedInModel) {
      heldBack.push(record);
      continue;
    }
    // Greedy budget fit — always include the top source even if over budget.
    if (selected.length > 0 && totalTokens + record.tokenEstimate > input.tokenBudget) {
      heldBack.push(record);
      continue;
    }
    selected.push(record);
    totalTokens += record.tokenEstimate;
  }

  return {
    selected,
    heldBack,
    totalTokens,
    budget: input.tokenBudget,
  };
}

export function countContextSourcesByCategory(
  db: DatabaseSync,
  projectId: string,
): ReadonlyMap<string, number> {
  const rows = db
    .prepare(
      `SELECT category, COUNT(*) as count
       FROM context_sources
       WHERE project_id = ?
       GROUP BY category`,
    )
    .all(projectId);

  const result = new Map<string, number>();
  for (const row of rows) {
    const typed = sqlRow(row, "context_sources count");
    result.set(typed.category as string, Number(typed.count));
  }
  return result;
}

export function getContextSourceById(
  db: DatabaseSync,
  projectId: string,
  id: string,
): ContextSourceRecord | undefined {
  const row = db.prepare("SELECT * FROM context_sources WHERE project_id = ? AND id = ?").get(projectId, id);
  if (row === undefined) return undefined;
  return contextSourceRowToRecord(mapContextSourceRow(sqlRow(row, `context source ${projectId}/${id}`)));
}
