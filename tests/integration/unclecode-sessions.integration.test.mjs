import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const builtCliEntrypoint = path.join(
  workspaceRoot,
  "apps/unclecode-cli/dist/index.js",
);

function makeTempWorkspace() {
  return mkdtempSync(path.join(tmpdir(), "unclecode-sessions-"));
}

function seedSession({ cwd, sessionStoreRoot, sessionId }) {
  const script = `
    import { createSessionStore } from '@unclecode/session-store';
    const store = createSessionStore({ rootDir: ${JSON.stringify(sessionStoreRoot)} });
    const ref = { projectPath: ${JSON.stringify(cwd)}, sessionId: ${JSON.stringify(sessionId)} };
    await store.appendCheckpoint(ref, { type: 'state', state: 'idle' });
    await store.appendCheckpoint(ref, { type: 'metadata', metadata: { model: 'gpt-5.4' } });
    await store.appendCheckpoint(ref, { type: 'task_summary', summary: 'Review current repo health', timestamp: '2026-04-02T00:00:00.000Z' });
    await store.appendCheckpoint(ref, { type: 'mode', mode: 'coordinator' });
    await store.appendCheckpoint(ref, { type: 'approval', pendingAction: { toolName: 'mcp.list', actionDescription: 'List MCP servers', toolUseId: 'tool-1', requestId: 'req-1' } });
    await store.appendCheckpoint(ref, { type: 'worktree', worktree: { originalCwd: ${JSON.stringify(cwd)}, worktreePath: ${JSON.stringify(cwd)}, worktreeName: 'main-workspace', sessionId: ${JSON.stringify(sessionId)}, worktreeBranch: 'main' } });
  `;

  const result = spawnSync(
    "node",
    [
      "--conditions=source",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
}

test("built unclecode cli lists resumable sessions", () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    seedSession({ cwd, sessionStoreRoot, sessionId: "session-alpha" });

    const result = spawnSync("node", [builtCliEntrypoint, "sessions"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /session-alpha/);
    assert.match(result.stdout, /idle/);
    assert.match(result.stdout, /gpt-5\.4/);
    assert.match(result.stdout, /Review current repo health/);
    assert.match(result.stdout, /mode=coordinator/);
    assert.match(result.stdout, /pending=mcp\.list/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("built unclecode cli resumes a known session in no-TTY mode by printing its summary", () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    seedSession({ cwd, sessionStoreRoot, sessionId: "session-beta" });

    const result = spawnSync(
      "node",
      [builtCliEntrypoint, "resume", "session-beta"],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Resuming session: session-beta/);
    assert.match(result.stdout, /State: idle/);
    assert.match(result.stdout, /Model: gpt-5\.4/);
    assert.match(result.stdout, /Task summary: Review current repo health/);
    assert.match(result.stdout, /Mode: coordinator/);
    assert.match(result.stdout, /Pending action: List MCP servers/);
    assert.match(result.stdout, /Worktree branch: main/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("built unclecode cli sessions output includes update timestamp and summary metadata", () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    seedSession({ cwd, sessionStoreRoot, sessionId: "session-gamma" });

    const result = spawnSync("node", [builtCliEntrypoint, "sessions"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /updated=/);
    assert.match(result.stdout, /summary=Review current repo health/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("built unclecode cli sessions lists persisted work-shell chat sessions", () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    const seedWorkSession = spawnSync(
      "node",
      [
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { persistWorkShellSessionSnapshot } from ${JSON.stringify("@unclecode/orchestrator")};\nawait persistWorkShellSessionSnapshot({ cwd: ${JSON.stringify(cwd)}, env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: ${JSON.stringify(sessionStoreRoot)} }, sessionId: 'work-session-zeta', model: 'gpt-5.4', mode: 'analyze', state: 'idle', summary: 'Chat: summarize current changes' });`,
      ],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
      },
    );

    assert.equal(seedWorkSession.status, 0, seedWorkSession.stderr);

    const result = spawnSync("node", [builtCliEntrypoint, "sessions"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /work-session-zeta/);
    assert.match(result.stdout, /summary=Chat: summarize current changes/);
    assert.match(result.stdout, /gpt-5\.4/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
