import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSessionStore } from "../../packages/session-store/src/index.ts";
import { readRestoredSessionRevision } from "../../apps/unclecode-cli/src/runtime-session-revision.ts";

test("runtime owner restores one durable session revision from the real session store", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-restored-revision-"));
  const projectPath = join(rootDir, "workspace");
  const ref = { projectPath, sessionId: "restored" };
  try {
    await mkdir(projectPath);
    const store = createSessionStore({ rootDir });
    await store.appendCheckpoint(ref, { type: "state", state: "running" });
    await store.appendCheckpoint(ref, { type: "metadata", metadata: { model: "test-model" } });
    await store.appendCheckpoint(ref, { type: "state", state: "paused" });

    assert.equal(await readRestoredSessionRevision({ rootDir, ...ref, resume: true }), 3);
    assert.equal(await readRestoredSessionRevision({ rootDir, ...ref, resume: false }), 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
