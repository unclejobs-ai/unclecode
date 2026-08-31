import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "unclecode-slash-cache-"));
const fakeRust = path.join(fixtureRoot, "fake-rust.sh");
const callLog = path.join(fixtureRoot, "calls.log");
writeFileSync(fakeRust, `#!/bin/sh
payload=$(cat)
printf '%s\\t%s\\n' "$*" "$payload" >> "$UNCLECODE_CACHE_TEST_LOG"
case "$*" in
  "rust command extension-slash-commands "*) printf '%s\\n' '[]' ;;
  "rust ux model-suggestions "*) printf '[{"command":"/model %s","description":"Current model"}]\\n' "$5" ;;
  *) printf '%s\\n' 'unsupported fake Rust command' >&2; exit 2 ;;
esac
`, "utf8");
chmodSync(fakeRust, 0o700);

const previousRustBin = process.env.UNCLECODE_RUST_BIN;
const previousCallLog = process.env.UNCLECODE_CACHE_TEST_LOG;
process.env.UNCLECODE_RUST_BIN = fakeRust;
process.env.UNCLECODE_CACHE_TEST_LOG = callLog;

const {
  clearExtensionRegistryCache,
  getWorkShellSlashSuggestions,
  listWorkShellSlashSuggestionEntries,
} = await import("@unclecode/orchestrator");

test.after(() => {
  if (previousRustBin === undefined) delete process.env.UNCLECODE_RUST_BIN;
  else process.env.UNCLECODE_RUST_BIN = previousRustBin;
  if (previousCallLog === undefined) delete process.env.UNCLECODE_CACHE_TEST_LOG;
  else process.env.UNCLECODE_CACHE_TEST_LOG = previousCallLog;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function loggedCalls(commandPrefix) {
  try {
    return readFileSync(callLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith(commandPrefix));
  } catch {
    return [];
  }
}

test("slash entry cache hits, follows extension generation invalidation, and evicts after 32 entries", () => {
  const workspaces = Array.from({ length: 33 }, (_, index) => path.join(fixtureRoot, `workspace-${index}`));
  for (const workspace of workspaces) mkdirSync(workspace, { recursive: true });

  const first = listWorkShellSlashSuggestionEntries({ workspaceRoot: workspaces[0], userHomeDir: fixtureRoot });
  assert.strictEqual(
    listWorkShellSlashSuggestionEntries({ workspaceRoot: workspaces[0], userHomeDir: fixtureRoot }),
    first,
  );
  assert.equal(loggedCalls("rust command extension-slash-commands ").length, 1);

  clearExtensionRegistryCache({ workspaceRoot: workspaces[0], userHomeDir: fixtureRoot });
  const invalidated = listWorkShellSlashSuggestionEntries({ workspaceRoot: workspaces[0], userHomeDir: fixtureRoot });
  assert.notStrictEqual(invalidated, first, "extension cache generation changes must invalidate slash entries");
  assert.deepEqual(invalidated, first, "cache invalidation must not change visible built-in suggestions");
  assert.equal(loggedCalls("rust command extension-slash-commands ").length, 2);

  for (const workspace of workspaces.slice(1)) {
    listWorkShellSlashSuggestionEntries({ workspaceRoot: workspace, userHomeDir: fixtureRoot });
  }
  assert.equal(loggedCalls("rust command extension-slash-commands ").length, 34);

  const reloaded = listWorkShellSlashSuggestionEntries({ workspaceRoot: workspaces[0], userHomeDir: fixtureRoot });
  assert.notStrictEqual(reloaded, invalidated, "workspace churn must evict the oldest current-generation entry");
  assert.deepEqual(reloaded, invalidated);
  assert.equal(loggedCalls("rust command extension-slash-commands ").length, 35);
});

test("model suggestion cache hits and evicts after 32 model keys", () => {
  const workspaceRoot = path.join(fixtureRoot, "model-workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const options = (currentModel) => ({
    workspaceRoot,
    userHomeDir: fixtureRoot,
    provider: "openai",
    currentModel,
  });

  const first = getWorkShellSlashSuggestions("/model", options("model-0"));
  assert.strictEqual(getWorkShellSlashSuggestions("/model", options("model-0")), first);
  assert.deepEqual(first, [{ command: "/model model-0", description: "Current model" }]);
  assert.equal(loggedCalls("rust ux model-suggestions ").length, 1);

  for (let index = 1; index <= 32; index += 1) {
    getWorkShellSlashSuggestions("/model", options(`model-${index}`));
  }
  assert.equal(loggedCalls("rust ux model-suggestions ").length, 33);

  getWorkShellSlashSuggestions("/model", options("model-32"));
  assert.equal(loggedCalls("rust ux model-suggestions ").length, 33, "the newest model must remain a hit");
  const reloaded = getWorkShellSlashSuggestions("/model", options("model-0"));
  assert.notStrictEqual(reloaded, first);
  assert.deepEqual(reloaded, first);
  assert.equal(loggedCalls("rust ux model-suggestions ").length, 34, "model retention must stay within 32 keys");
});
