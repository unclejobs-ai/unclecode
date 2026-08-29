import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadWorkCliBootstrap } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";

test("interactive client bootstrap is config-only and cannot construct or execute a local agent turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-client-bootstrap-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(workspace);
  await mkdir(home);
  try {
    const loaded = await loadWorkCliBootstrap({
      argv: ["--cwd", workspace, "--provider", "deepseek", "--model", "deepseek-chat"],
      role: "client",
      userHomeDir: home,
      env: {
        HOME: home,
        PATH: process.env.PATH,
        DEEPSEEK_API_KEY: "test-only-key",
        UNCLECODE_SESSION_STORE_ROOT: join(root, "sessions"),
      },
    });
    assert.equal(loaded.prompt, "");
    await assert.rejects(
      loaded.agent.runTurn("must stay owner-only"),
      /runtime owner attachment/,
    );
    assert.equal(loaded.options.interactionBridge, undefined);
    assert.equal(loaded.options.recordTurn, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
