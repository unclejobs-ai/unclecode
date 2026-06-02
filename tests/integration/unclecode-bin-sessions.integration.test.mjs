import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const binEntrypoint = path.join(workspaceRoot, "bin/unclecode.cjs");

function seedSession(tempDir, sessionStoreRoot, sessionId) {
  const seedScript = `
    import { createSessionStore } from '@unclecode/session-store';
    const store = createSessionStore({ rootDir: ${JSON.stringify(sessionStoreRoot)} });
    const ref = { projectPath: ${JSON.stringify(tempDir)}, sessionId: ${JSON.stringify(sessionId)} };
    await store.appendCheckpoint(ref, { type: 'state', state: 'idle' });
    await store.appendCheckpoint(ref, { type: 'metadata', metadata: { model: 'gpt-5.4' } });
    await store.appendCheckpoint(ref, { type: 'task_summary', summary: 'Fork and share session', timestamp: '2026-04-02T00:00:00.000Z' });
  `;
  const result = spawnSync(
    "node",
    [
      "--conditions=source",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      seedScript,
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

function findSessionDir(sessionStoreRoot) {
  const projectsRoot = path.join(sessionStoreRoot, "projects");
  const project = readdirSync(projectsRoot)[0];
  assert.ok(project);
  return path.join(projectsRoot, project, "sessions");
}

test("root bin wrapper handles sessions fork on the Rust path", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-session-fork-"),
  );
  const sessionStoreRoot = path.join(tempDir, ".state");

  try {
    seedSession(tempDir, sessionStoreRoot, "session-fork-rust-bin");

    const result = spawnSync(
      "node",
      [binEntrypoint, "sessions", "fork", "session-fork-rust-bin"],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /forked session-fork-rust-bin -> /);
    assert.match(result.stdout, /session-dir /);

    const forkId = result.stdout.match(
      /forked session-fork-rust-bin -> (\S+)/,
    )?.[1];
    assert.ok(forkId);

    const sessionDir = findSessionDir(sessionStoreRoot);
    const files = readdirSync(sessionDir);
    assert.ok(
      files
        .filter((file) => file.endsWith(".checkpoint.json"))
        .some((file) =>
          readFileSync(path.join(sessionDir, file), "utf8").includes(
            `"sessionId":"${forkId}"`,
          ),
        ),
      "fork checkpoint was written with the new session id",
    );
    assert.ok(files.length >= 4, "fork created additional session files");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("root bin wrapper handles sessions share on the Rust path", () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "unclecode-bin-session-share-"),
  );
  const sessionStoreRoot = path.join(tempDir, ".state");
  const outDir = path.join(tempDir, "shares-out");

  try {
    seedSession(tempDir, sessionStoreRoot, "session-share-rust-bin");

    const result = spawnSync(
      "node",
      [
        binEntrypoint,
        "sessions",
        "share",
        "session-share-rust-bin",
        "--out",
        outDir,
      ],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SHARE_SLUG=share-/);
    assert.match(result.stdout, /SHARE_PATH=/);

    const sharePath = result.stdout.match(/SHARE_PATH=(.+)/)?.[1]?.trim();
    assert.ok(sharePath);
    assert.ok(existsSync(path.join(sharePath, "share.json")));
    const manifest = JSON.parse(
      readFileSync(path.join(sharePath, "share.json"), "utf8"),
    );
    assert.equal(manifest.sessionId, "session-share-rust-bin");
    assert.ok(Array.isArray(manifest.files));
    assert.ok(manifest.files.length >= 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
