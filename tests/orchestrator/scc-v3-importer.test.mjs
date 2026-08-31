import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planSccV3Import } from "@unclecode/orchestrator";

const fixtureParents = [];

test.after(async () => {
  await Promise.all(
    fixtureParents.map((parent) =>
      rm(parent, { recursive: true, force: true }),
    ),
  );
});

async function snapshotTree(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        const content = await readFile(absolute);
        files.push({
          path: relative,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      } else {
        files.push({
          path: relative,
          sha256: entry.isSymbolicLink() ? "symlink" : "other",
        });
      }
    }
  }
  await visit(root);
  return files;
}

async function makeFixture() {
  const parent = await mkdtemp(join(tmpdir(), "unclecode-scc-v3-"));
  fixtureParents.push(parent);
  const sourceRoot = join(parent, ".data");
  const workspaceRoot = join(parent, "workspace");
  await mkdir(join(sourceRoot, "state"), { recursive: true });
  await mkdir(join(sourceRoot, "events"), { recursive: true });
  await mkdir(join(sourceRoot, "cycles", "cycle-001"), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  await writeFile(
    join(sourceRoot, "state", "pdca-active.json"),
    JSON.stringify({
      run_id: "pdca-20260828-example",
      topic: "Improve runtime token=must-not-leak",
      domain: "code",
      current_phase: "check",
      completed: ["plan", "do"],
      cycle_count: 1,
      max_cycles: 3,
      artifacts: { do: ".data/cycles/cycle-001/do.md" },
      check_verdict: "NEEDS_IMPROVEMENT",
      reviewer_count: 2,
      refine_count: 1,
      pivot_count: 0,
      critical_count: 0,
    }),
  );
  await writeFile(
    join(sourceRoot, "events", "pdca-pdca-20260828-example.jsonl"),
    [
      JSON.stringify({
        ts: "2026-08-28T01:00:00.000Z",
        run_id: "pdca-20260828-example",
        type: "phase_start",
        phase: "check",
      }),
      JSON.stringify({
        ts: "2026-08-28T01:01:00.000Z",
        run_id: "pdca-20260828-example",
        type: "review_completed",
        data: { output: "token=also-secret" },
      }),
    ].join("\n"),
  );
  await writeFile(
    join(sourceRoot, "cycles", "cycle-001", "do.md"),
    "raw artifact token=artifact-secret\n",
  );
  await writeFile(
    join(sourceRoot, "cycles", "cycle-001", "metrics.json"),
    JSON.stringify({
      run_id: "pdca-20260828-example",
      cycle_count: 1,
      refine_count: 1,
      pivot_count: 0,
      check_verdict: "NEEDS_IMPROVEMENT",
    }),
  );
  return { parent, sourceRoot, workspaceRoot };
}

test("SCC v3 importer produces an immutable dry-run plan for UncleCode-owned stores", async () => {
  const { sourceRoot, workspaceRoot } = await makeFixture();
  const before = await snapshotTree(sourceRoot);

  const report = await planSccV3Import({ sourceRoot, workspaceRoot });

  assert.equal(report.mode, "dry-run");
  assert.equal(report.receipt.schema, "unclecode.scc-v3-import-receipt/v1");
  assert.match(report.receipt.idempotencyKey, /^scc-v3:[a-f0-9]{64}$/);
  assert.equal(report.receipt.onExisting, "skip-identical");
  assert.equal(report.receipt.onCollision, "reject");
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].runId, "pdca-20260828-example");
  assert.equal(report.runs[0].quality.currentStage, "critic");
  assert.equal(report.runs[0].quality.gateStatus, "refine");
  assert.equal(report.runs[0].quality.independentVerification, true);
  assert.equal(report.runs[0].eventCounts.review_completed, 1);
  assert.ok(
    report.runs[0].plannedRecords.some(
      (entry) => entry.store === "session-store",
    ),
  );
  assert.ok(
    report.runs[0].plannedRecords.some(
      (entry) => entry.store === "agentops-db",
    ),
  );
  assert.equal(report.runs[0].artifacts.length, 2);
  assert.match(
    report.runs[0].artifacts[0].target,
    /^\.unclecode\/artifacts\/pdca-20260828-example\//,
  );
  assert.deepEqual(await snapshotTree(sourceRoot), before);
  await assert.rejects(
    readFile(
      join(
        workspaceRoot,
        ".unclecode",
        "artifacts",
        "pdca-20260828-example",
        "do.md",
      ),
    ),
  );

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /must-not-leak|also-secret|artifact-secret/);
});

test("SCC v3 importer returns the same receipt and plan for an unchanged source", async () => {
  const { sourceRoot, workspaceRoot } = await makeFixture();

  const first = await planSccV3Import({ sourceRoot, workspaceRoot });
  const second = await planSccV3Import({ sourceRoot, workspaceRoot });

  assert.deepEqual(second, first);
  assert.equal(
    first.receipt.target,
    `migration:scc-v3:${first.receipt.idempotencyKey.slice("scc-v3:".length)}`,
  );
});

test("SCC v3 importer marks reviewer-free checks unproven", async () => {
  const { sourceRoot, workspaceRoot } = await makeFixture();
  const path = join(sourceRoot, "state", "pdca-active.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.reviewer_count = 0;
  state.check_verdict = "PASS";
  await writeFile(path, JSON.stringify(state));

  const report = await planSccV3Import({ sourceRoot, workspaceRoot });
  assert.equal(report.runs[0].quality.gateStatus, "unproven");
  assert.equal(report.runs[0].quality.independentVerification, false);
});

test("SCC v3 importer rejects symlinks instead of following them", async () => {
  const { parent, sourceRoot, workspaceRoot } = await makeFixture();
  const outside = join(parent, "outside.json");
  await writeFile(outside, JSON.stringify({ run_id: "outside" }));
  await symlink(outside, join(sourceRoot, "state", "escape.json"));

  await assert.rejects(
    planSccV3Import({ sourceRoot, workspaceRoot }),
    /symbolic link/i,
  );
});

test("SCC v3 importer rejects a symbolic-link source root", async () => {
  const { parent, sourceRoot, workspaceRoot } = await makeFixture();
  const sourceLink = join(parent, "data-link");
  await symlink(sourceRoot, sourceLink);

  await assert.rejects(
    planSccV3Import({ sourceRoot: sourceLink, workspaceRoot }),
    /symbolic link source root/i,
  );
});

test("SCC v3 importer fails closed on artifact path traversal", async () => {
  const { sourceRoot, workspaceRoot } = await makeFixture();
  const path = join(sourceRoot, "state", "pdca-active.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.artifacts.act_final = "../../outside-secret.md";
  await writeFile(path, JSON.stringify(state));
  const before = await snapshotTree(sourceRoot);

  await assert.rejects(
    planSccV3Import({ sourceRoot, workspaceRoot }),
    /artifact reference escapes/i,
  );
  assert.deepEqual(await snapshotTree(sourceRoot), before);
});

test("SCC v3 importer fails closed on malformed JSON and record fields", async () => {
  const malformedJson = await makeFixture();
  await writeFile(
    join(malformedJson.sourceRoot, "events", "broken.jsonl"),
    "{not-json}\n",
  );
  await assert.rejects(
    planSccV3Import(malformedJson),
    /malformed SCC v3 JSONL record/i,
  );

  const malformedField = await makeFixture();
  const statePath = join(
    malformedField.sourceRoot,
    "state",
    "pdca-active.json",
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.reviewer_count = "2";
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(
    planSccV3Import(malformedField),
    /reviewer_count.*non-negative integer/i,
  );
});

test("SCC v3 importer rejects oversize files before parsing", async () => {
  const { sourceRoot, workspaceRoot } = await makeFixture();
  await writeFile(
    join(sourceRoot, "oversize.bin"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  );

  await assert.rejects(
    planSccV3Import({ sourceRoot, workspaceRoot }),
    /file larger than 2097152 bytes/i,
  );
});

test("SCC v3 importer rejects conflicting records that map to the same run", async () => {
  const { sourceRoot, workspaceRoot } = await makeFixture();
  const activePath = join(sourceRoot, "state", "pdca-active.json");
  const completedPath = join(sourceRoot, "state", "pdca-last-completed.json");
  const completed = JSON.parse(await readFile(activePath, "utf8"));
  completed.current_phase = "act";
  completed.ended_at = "2026-08-28T02:00:00.000Z";
  await writeFile(completedPath, JSON.stringify(completed));

  await assert.rejects(
    planSccV3Import({ sourceRoot, workspaceRoot }),
    /conflicting state records.*pdca-20260828-example/i,
  );
});

test("SCC v3 importer rejects portable target collisions", async () => {
  const { sourceRoot, workspaceRoot } = await makeFixture();
  await writeFile(
    join(sourceRoot, "events", "case-collision.jsonl"),
    `${JSON.stringify({ run_id: "PDCA-20260828-example", type: "tick" })}\n`,
  );

  await assert.rejects(
    planSccV3Import({ sourceRoot, workspaceRoot }),
    /import target collision/i,
  );
});

test("SCC v3 importer bounds the number of parsed records", async () => {
  const { sourceRoot, workspaceRoot } = await makeFixture();
  const event = JSON.stringify({ run_id: "b", type: "t" });
  await writeFile(
    join(sourceRoot, "events", "bounded.jsonl"),
    `${Array.from({ length: 65_537 }, () => event).join("\n")}\n`,
  );

  await assert.rejects(
    planSccV3Import({ sourceRoot, workspaceRoot }),
    /exceeds the 65536 record dry-run limit/i,
  );
});
