import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseQueueWriteResult,
  parseQueuedSubmit,
  parseQueuedSubmitList,
} from "../../packages/orchestrator/src/work-shell-engine-queue-parse.ts";
import {
  deleteQueuedAttachmentArtifacts,
  persistQueuedAttachments,
  restoreQueuedAttachments,
} from "../../packages/orchestrator/src/work-shell-queue-attachments.ts";

test("queue parser restores the durable envelope and accepts legacy id/line JSON", () => {
  assert.deepEqual(parseQueuedSubmit(JSON.stringify({ id: 1, line: "legacy" })), {
    id: 1,
    line: "legacy",
    createdAt: 0,
    status: "pending",
    attachmentRefs: [],
    attachmentCount: 0,
    attachments: [],
  });
  assert.deepEqual(parseQueuedSubmitList(JSON.stringify([{
    id: 2,
    line: "한글 후속 요청",
    createdAt: 123,
    status: "in-flight",
    attachmentRefs: [".unclecode/artifacts/run/queue/a.json"],
    attachmentCount: 1,
  }])), [{
    id: 2,
    line: "한글 후속 요청",
    createdAt: 123,
    status: "in-flight",
    attachmentRefs: [".unclecode/artifacts/run/queue/a.json"],
    attachmentCount: 1,
    attachments: [],
  }]);
});

test("queue write parser preserves typed Rust limit rejections", () => {
  assert.deepEqual(parseQueueWriteResult(JSON.stringify({
    accepted: false,
    error: { code: "queue_bytes", actual: 16_777_217, limit: 16_777_216 },
  })), {
    accepted: false,
    error: { code: "queue_bytes", actual: 16_777_217, limit: 16_777_216 },
  });
  assert.throws(
    () => parseQueueWriteResult(JSON.stringify({
      accepted: false,
      error: { code: "raw_path", actual: 2, limit: 1 },
    })),
    /Invalid Rust queue write response/,
  );
});

test("queued attachment payloads survive a fresh loader under UncleCode artifact ownership", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "unclecode-queue-artifacts-"));
  const attachment = {
    type: "image",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,QUJD",
    path: "(clipboard)",
    displayName: "스크린샷.png",
  };
  try {
    const artifacts = await persistQueuedAttachments(workspace, "session/unsafe", [attachment]);
    assert.equal(artifacts.length, 1);
    assert.match(artifacts[0].ref, /^\.unclecode\/artifacts\/session_unsafe\/queue-attachments\//);
    assert.equal(artifacts[0].schema, "unclecode.queue-attachment.v1");
    assert.match(artifacts[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(artifacts[0].size, Buffer.byteLength(`${JSON.stringify(attachment)}\n`));
    const stored = JSON.parse(await readFile(path.join(workspace, artifacts[0].ref), "utf8"));
    assert.equal(stored.dataUrl, attachment.dataUrl);

    assert.deepEqual(await restoreQueuedAttachments(workspace, artifacts), [attachment]);
    await deleteQueuedAttachmentArtifacts(workspace, artifacts.map((artifact) => artifact.ref));
    await assert.rejects(readFile(path.join(workspace, artifacts[0].ref), "utf8"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("queued attachment preflight runs against exact descriptors before any artifact write", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "unclecode-queue-preflight-"));
  const attachment = { type: "image", dataUrl: "data:image/png;base64,QUJD" };
  let inspected = false;
  try {
    await assert.rejects(
      persistQueuedAttachments(workspace, "session", [attachment], async (artifacts) => {
        inspected = true;
        assert.equal(artifacts.length, 1);
        assert.equal(artifacts[0].size, Buffer.byteLength(`${JSON.stringify(attachment)}\n`));
        assert.match(artifacts[0].sha256, /^[a-f0-9]{64}$/);
        throw new Error("preflight rejected");
      }),
      /preflight rejected/,
    );
    assert.equal(inspected, true);
    await assert.rejects(readFile(path.join(workspace, ".unclecode", "artifacts"), "utf8"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("queued attachment writes reject a symlinked artifact parent without touching its target", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "unclecode-queue-symlink-write-"));
  const outside = await mkdtemp(path.join(tmpdir(), "unclecode-queue-symlink-outside-"));
  try {
    await mkdir(path.join(workspace, ".unclecode"), { recursive: true });
    await symlink(outside, path.join(workspace, ".unclecode", "artifacts"));
    await assert.rejects(
      persistQueuedAttachments(workspace, "session", [{ secret: true }]),
      /symbolic-link|symlink|not a directory|Permission denied/i,
    );
    await assert.rejects(readFile(path.join(outside, "session", "queue-attachments"), "utf8"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("queued attachment reads reject a symlink leaf without exposing its target", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "unclecode-queue-symlink-read-"));
  const outside = path.join(workspace, "outside-secret.json");
  const reference = ".unclecode/artifacts/session/queue-attachments/escape.json";
  try {
    await mkdir(path.dirname(path.join(workspace, reference)), { recursive: true });
    await writeFile(outside, '{"secret":"must-not-be-read"}\n', { encoding: "utf8", mode: 0o600 });
    await symlink(outside, path.join(workspace, reference));
    await assert.rejects(
      restoreQueuedAttachments(workspace, [{
        ref: reference,
        schema: "unclecode.queue-attachment.v1",
        sha256: "0".repeat(64),
        size: 30,
      }]),
      /symbolic-link|symlink|Permission denied/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("queued attachment deletes reject a symlink leaf without deleting its target", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "unclecode-queue-symlink-delete-"));
  const outside = path.join(workspace, "outside-keep.json");
  const reference = ".unclecode/artifacts/session/queue-attachments/escape.json";
  try {
    await mkdir(path.dirname(path.join(workspace, reference)), { recursive: true });
    await writeFile(outside, '{"keep":true}\n', { encoding: "utf8", mode: 0o600 });
    await symlink(outside, path.join(workspace, reference));
    await assert.rejects(
      deleteQueuedAttachmentArtifacts(workspace, [reference]),
      /symbolic-link|symlink|Permission denied/i,
    );
    assert.equal(await readFile(outside, "utf8"), '{"keep":true}\n');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("queued attachment restoration rejects refs outside the owned artifact root", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "unclecode-queue-artifacts-"));
  try {
    await mkdir(path.join(workspace, ".unclecode", "artifacts"), { recursive: true });
    await writeFile(path.join(workspace, "outside.json"), "{}", "utf8");
    await assert.rejects(
      restoreQueuedAttachments(workspace, [{
        ref: "outside.json",
        schema: "unclecode.queue-attachment.v1",
        sha256: "0".repeat(64),
        size: 2,
      }]),
      /outside UncleCode artifact ownership/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
