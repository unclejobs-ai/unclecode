import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runRustCommandSync } from "@unclecode/orchestrator";

test("Rust queue preflight returns typed payload-free limit rejections", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-queue-limits-"));
  const session = "task4-limits";
  try {
    const accepted = JSON.parse(runRustCommandSync(
      ["rust", "queue", "validate-envelope-json", session],
      cwd,
      JSON.stringify({ line: "가".repeat(21_845) + "a", createdAt: 123, attachments: [] }),
    ));
    assert.deepEqual(accepted, { accepted: true });

    const rejected = JSON.parse(runRustCommandSync(
      ["rust", "queue", "validate-envelope-json", session],
      cwd,
      JSON.stringify({ line: "가".repeat(21_846), createdAt: 124, attachments: [] }),
    ));
    assert.deepEqual(rejected, {
      accepted: false,
      error: { actual: 65_538, code: "message_bytes", limit: 65_536 },
    });
    assert.equal(JSON.stringify(rejected).includes("가"), false, "rejections never echo raw input");
    assert.deepEqual(
      JSON.parse(runRustCommandSync(["rust", "queue", "list", session], cwd)),
      [],
      "preflight never mutates the durable queue",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Rust queue backend atomically removes and reorders stable ids", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-queue-mutation-"));
  const session = "task4-queue";
  try {
    runRustCommandSync(["rust", "queue", "push-json", session, "first"], cwd);
    runRustCommandSync(["rust", "queue", "push-json", session, "second"], cwd);
    runRustCommandSync(["rust", "queue", "push-json", session, "third"], cwd);

    const moved = JSON.parse(runRustCommandSync(["rust", "queue", "move-json", session, "3", "up"], cwd));
    assert.equal(moved.id, 3);
    let items = JSON.parse(runRustCommandSync(["rust", "queue", "list", session], cwd));
    assert.deepEqual(items.map((item) => item.id), [1, 3, 2]);

    const removed = JSON.parse(runRustCommandSync(["rust", "queue", "remove-json", session, "3"], cwd));
    assert.equal(removed.id, 3);
    items = JSON.parse(runRustCommandSync(["rust", "queue", "list", session], cwd));
    assert.deepEqual(items.map((item) => item.id), [1, 2]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Rust queue acknowledgement durably tracks bounded attachment cleanup", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-queue-cleanup-"));
  const session = "task4-cleanup";
  const attachment = {
    ref: ".unclecode/artifacts/session/queue-attachments/cleanup.json",
    schema: "unclecode.queue-attachment.v1",
    sha256: "c".repeat(64),
    size: 17,
  };
  try {
    const pushed = JSON.parse(runRustCommandSync(
      ["rust", "queue", "push-envelope-json", session],
      cwd,
      JSON.stringify({ line: "cleanup", createdAt: 123, attachments: [attachment] }),
    ));
    runRustCommandSync(["rust", "queue", "claim-json", session], cwd);
    assert.equal(JSON.parse(runRustCommandSync(
      ["rust", "queue", "ack-json", session, String(pushed.id)], cwd,
    )).id, pushed.id);
    assert.equal(JSON.parse(runRustCommandSync(
      ["rust", "queue", "nack-json", session, String(pushed.id)], cwd,
    )), null, "a post-ack cleanup failure must never requeue completed work");
    assert.deepEqual(JSON.parse(runRustCommandSync(
      ["rust", "queue", "cleanup-list-json", session, "64"], cwd,
    )), [{ ref: attachment.ref, size: 17 }]);

    assert.deepEqual(JSON.parse(runRustCommandSync(
      ["rust", "queue", "cleanup-complete-json", session],
      cwd,
      JSON.stringify([attachment.ref]),
    )), { completed: 1, remaining: 0 });
    assert.deepEqual(JSON.parse(runRustCommandSync(
      ["rust", "queue", "cleanup-list-json", session, "64"], cwd,
    )), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Rust queue backend quarantines crash-stale claims until explicit retry or discard", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-queue-recovery-"));
  const session = "task4-recovery";
  const attachment = {
    ref: ".unclecode/artifacts/session/queue-attachments/a.json",
    schema: "unclecode.queue-attachment.v1",
    sha256: "a".repeat(64),
    size: 42,
  };
  try {
    const pushed = JSON.parse(runRustCommandSync(
      ["rust", "queue", "push-envelope-json", session],
      cwd,
      JSON.stringify({ line: "restore me", createdAt: 123, attachments: [attachment] }),
    ));
    assert.deepEqual(pushed.attachments, [attachment]);
    assert.equal(pushed.status, "pending");

    assert.equal(JSON.parse(runRustCommandSync(
      ["rust", "queue", "claim-json", session], cwd,
    )).status, "in-flight");
    assert.equal(
      JSON.parse(runRustCommandSync(["rust", "queue", "claim-json", session], cwd)),
      null,
      "a persisted in-flight item is not executed twice",
    );

    const quarantined = JSON.parse(runRustCommandSync(
      ["rust", "queue", "quarantine-json", session, String(pushed.id)],
      cwd,
      "attachment hash mismatch",
    ));
    assert.equal(quarantined.status, "requires-action");
    assert.equal(quarantined.recoveryReason, "attachment hash mismatch");
    assert.equal(JSON.parse(runRustCommandSync(
      ["rust", "queue", "claim-json", session], cwd,
    )), null);

    const retried = JSON.parse(runRustCommandSync(
      ["rust", "queue", "retry-json", session, String(pushed.id)], cwd,
    ));
    assert.equal(retried.status, "pending");
    runRustCommandSync(["rust", "queue", "claim-json", session], cwd);
    const discarded = JSON.parse(runRustCommandSync(
      ["rust", "queue", "discard-json", session, String(pushed.id)], cwd,
    ));
    assert.equal(discarded.id, pushed.id);
    assert.deepEqual(JSON.parse(runRustCommandSync(
      ["rust", "queue", "list", session], cwd,
    )), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Rust queue startup recovery separates pending count from the full durable snapshot", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-queue-startup-recovery-"));
  const session = "task4-startup-recovery";
  const attachment = {
    ref: ".unclecode/artifacts/session/queue-attachments/restart.json",
    schema: "unclecode.queue-attachment.v1",
    sha256: "b".repeat(64),
    size: 17,
  };
  try {
    const first = JSON.parse(runRustCommandSync(
      ["rust", "queue", "push-envelope-json", session],
      cwd,
      JSON.stringify({ line: "claimed before restart", createdAt: 456, attachments: [attachment] }),
    ));
    const second = JSON.parse(runRustCommandSync(
      ["rust", "queue", "push-json", session, "still pending"], cwd,
    ));
    assert.equal(JSON.parse(runRustCommandSync(
      ["rust", "queue", "claim-json", session], cwd,
    )).id, first.id);

    const recovered = JSON.parse(runRustCommandSync(
      ["rust", "queue", "recover-json", session], cwd,
    ));
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, first.id);
    assert.equal(recovered[0].status, "requires-action");
    assert.match(recovered[0].recoveryReason, /restarted.*Retry or discard/u);
    assert.deepEqual(recovered[0].attachments, [attachment]);

    assert.deepEqual(
      JSON.parse(runRustCommandSync(["rust", "queue", "len-json", session], cwd)),
      { length: 1 },
      "len is the pending follow-up count, not the durable snapshot size",
    );
    const snapshot = JSON.parse(runRustCommandSync(["rust", "queue", "list", session], cwd));
    assert.deepEqual(snapshot.map(({ id, status }) => ({ id, status })), [
      { id: first.id, status: "requires-action" },
      { id: second.id, status: "pending" },
    ]);
    assert.deepEqual(
      JSON.parse(runRustCommandSync(["rust", "queue", "recover-json", session], cwd)),
      [],
      "startup recovery is idempotent",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
