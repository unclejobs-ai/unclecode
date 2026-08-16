import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkExecutorAgent } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";
import { loadWorkCliBootstrap } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";

const REASONING = {
  effort: "medium",
  source: "mode-default",
  support: { status: "supported" },
};

/**
 * Point both OMP lookups at paths that cannot exist so the executor fails at
 * the boundary instead of reaching a real install and a real model. The turn
 * still emits its full trace identity before it fails, which is what these
 * tests read.
 */
function unreachableOmpEnv(extra = {}) {
  return {
    UNCLECODE_OMP_BIN: path.join(tmpdir(), "unclecode-omp-absent-bin"),
    UNCLECODE_OMP_BUN_BIN: path.join(tmpdir(), "unclecode-omp-absent-bun"),
    ...extra,
  };
}

function preserveRustToolchainEnv(env) {
  const preserved = {};
  for (const key of ["PATH", "HOME", "CARGO_HOME", "RUSTUP_HOME", "TMPDIR", "SHELL", "USER"]) {
    if (env[key] !== undefined) preserved[key] = env[key];
  }
  return preserved;
}

test("work executors run under the omp provider identity on the Kimi default selector", async () => {
  const executor = createWorkExecutorAgent({
    cwd: tmpdir(),
    env: unreachableOmpEnv(),
    reasoning: REASONING,
  });

  const traces = [];
  executor.setTraceListener((event) => traces.push(event));

  await assert.rejects(
    () => executor.runTurn("implement the slice"),
    (error) => error.code === "OMP_UNAVAILABLE",
  );

  const identities = traces
    .filter((event) => event.type === "turn.started" || event.type === "provider.calling")
    .map((event) => `${event.type}:${event.provider}:${event.model}`);
  assert.deepEqual(identities, [
    "turn.started:omp:kimi-code/k3",
    "provider.calling:omp:kimi-code/k3",
  ]);
});

test("the work executor stays on Kimi K3 even when the retired override is set", async () => {
  const executor = createWorkExecutorAgent({
    cwd: tmpdir(),
    // `UNCLECODE_OMP_WORKER_MODEL` used to retarget the executor. Work turns are
    // now pinned to one selector, so a stale value left in an operator's shell
    // must be inert: a delegated turn that silently ran on another upstream
    // model would make its trace, cost, and guardian verdict unattributable.
    env: unreachableOmpEnv({ UNCLECODE_OMP_WORKER_MODEL: " zai/glm-5 " }),
    reasoning: REASONING,
  });

  const routes = new Set();
  executor.setTraceListener((event) => {
    if ("model" in event) routes.add(`${event.provider}:${event.model}`);
  });

  await assert.rejects(
    () => executor.runTurn("implement the slice"),
    (error) => error.code === "OMP_UNAVAILABLE",
  );
  assert.deepEqual([...routes], ["omp:kimi-code/k3"]);
});

test("the work executor factory accepts no model input, so no caller can retarget it", async () => {
  const executor = createWorkExecutorAgent({
    cwd: tmpdir(),
    env: unreachableOmpEnv({ UNCLECODE_OMP_WORKER_MODEL: "zai/glm-5" }),
    // Not part of the factory's input shape any more. Passing it must change
    // nothing rather than quietly reopening the override that was removed.
    model: "groq/openai/gpt-oss-20b",
    reasoning: REASONING,
  });

  const models = new Set();
  executor.setTraceListener((event) => {
    if ("model" in event) models.add(event.model);
  });

  await assert.rejects(() => executor.runTurn("go"), (error) => error.code === "OMP_UNAVAILABLE");
  assert.deepEqual([...models], ["kimi-code/k3"]);
});

test("loadWorkCliBootstrap keeps the direct conversation agent on the configured runtime", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-omp-bootstrap-"));
  const fakeHome = path.join(workspaceRoot, "home");

  try {
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");
    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      HOME: fakeHome,
      ...preserveRustToolchainEnv(originalEnv),
      UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, ".state"),
      OPENAI_OAUTH_CLIENT_ID: "",
      ...unreachableOmpEnv(),
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_AUTH_TOKEN;

    const result = await loadWorkCliBootstrap({ argv: ["--cwd", workspaceRoot] });

    // The direct agent is still a RuntimeCodingAgent: only it exposes the work
    // shell interaction bridge, which the OMP executor deliberately lacks.
    assert.equal(result.options.provider, "openai");
    assert.equal(result.options.model, "gpt-5.4");
    assert.notEqual(result.options.interactionBridge, undefined);
    assert.equal(typeof result.options.ompAuthCatalog?.list, "function");
    assert.equal(typeof result.options.ompAuthCatalog?.signIn, "function");
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
