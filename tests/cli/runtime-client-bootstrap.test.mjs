import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recordWorkspaceTrust } from "@unclecode/plugin-host";
import { loadWorkCliBootstrap } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";

function isolatedEnv(root, home, overrides = {}) {
  return {
    HOME: home,
    PATH: process.env.PATH,
    ...(process.env.CARGO_HOME ? { CARGO_HOME: process.env.CARGO_HOME } : {}),
    ...(process.env.RUSTUP_HOME ? { RUSTUP_HOME: process.env.RUSTUP_HOME } : {}),
    DEEPSEEK_API_KEY: "test-only-key",
    UNCLECODE_SESSION_STORE_ROOT: join(root, "sessions"),
    ...overrides,
  };
}

async function listExistingPaths(entries) {
  const existing = [];
  for (const [label, path] of entries) {
    try {
      await access(path);
      existing.push(label);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return existing;
}

test("interactive client bootstrap does not read or restore a local session", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-client-resume-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(workspace);
  await mkdir(home);
  try {
    const loaded = await loadWorkCliBootstrap({
      argv: [
        "--cwd", workspace,
        "--provider", "deepseek",
        "--model", "deepseek-chat",
        "--session-id", "owner-only-session",
      ],
      role: "client",
      userHomeDir: home,
      env: isolatedEnv(root, home),
    });

    assert.equal(loaded.options.sessionId, "owner-only-session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive client bootstrap ignores owner-only review routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-client-review-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(workspace);
  await mkdir(home);
  try {
    const loaded = await loadWorkCliBootstrap({
      argv: ["--cwd", workspace, "--provider", "deepseek", "--model", "deepseek-chat"],
      role: "client",
      userHomeDir: home,
      env: isolatedEnv(root, home, {
        UNCLECODE_REVIEW_PROVIDER: "owner-only-invalid-route",
      }),
    });

    assert.equal(loaded.options.provider, "deepseek");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive client bootstrap is serializable and creates no owner lifecycle state", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-client-bootstrap-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const pluginDir = join(workspace, ".unclecode", "plugins");
  const pluginMarker = join(root, "workspace-plugin-loaded");
  const previousHome = process.env.HOME;
  await mkdir(pluginDir, { recursive: true });
  await mkdir(home);
  await writeFile(
    join(pluginDir, "client-side-effect-trap.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      `export default () => { writeFileSync(${JSON.stringify(pluginMarker)}, "loaded"); return {}; };`,
      "",
    ].join("\n"),
  );
  recordWorkspaceTrust(workspace, home);
  process.env.HOME = home;
  try {
    const loaded = await loadWorkCliBootstrap({
      argv: ["--cwd", workspace, "--provider", "deepseek", "--model", "deepseek-chat"],
      role: "client",
      userHomeDir: home,
      env: isolatedEnv(root, home),
    });
    assert.equal(loaded.prompt, "");
    await assert.rejects(
      loaded.agent.runTurn("must stay owner-only"),
      /runtime owner attachment/,
    );
    assert.deepEqual(
      await listExistingPaths([
        ["workspace plugin marker", pluginMarker],
        ["AgentOps database home", join(home, ".unclecode", "agentops")],
        [
          "workspace bootstrap context snapshot",
          join(workspace, ".unclecode", "context", "bootstrap.json"),
        ],
        ["session/project-memory store", join(root, "sessions")],
      ]),
      [],
      "attached clients must not create owner lifecycle state",
    );
    assert.deepEqual(structuredClone(loaded.options), loaded.options);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});
