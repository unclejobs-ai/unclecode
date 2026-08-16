import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createSessionStore } from "@unclecode/session-store";

import {
  augmentContextPacketViewInput,
  buildBootstrapContextPacketSupplement,
  clearCachedWorkspaceGuidance,
  discoverCursorRules,
  ingestWorkspaceBootstrapContext,
  loadBootstrapSnapshot,
} from "../../packages/context-broker/src/index.ts";

const SYMLINKS_REQUIRE_ELEVATION = process.platform === "win32";

function createFixtureWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-bootstrap-"));
  const home = path.join(root, "home");
  const nested = path.join(root, "apps", "demo");
  mkdirSync(path.join(home, ".unclecode"), { recursive: true });
  mkdirSync(path.join(nested, ".cursor", "rules"), { recursive: true });
  mkdirSync(path.join(nested, ".codex", "skills", "autopilot"), { recursive: true });

  writeFileSync(path.join(root, "AGENTS.md"), "# Agents\nPrefer read before edit.\n", "utf8");
  writeFileSync(path.join(nested, "CLAUDE.md"), "# Claude\nUse slash commands for operator surfaces.\n", "utf8");
  writeFileSync(
    path.join(nested, ".cursor", "rules", "testing.mdc"),
    "# Testing\nAlways verify before claiming completion.\n",
    "utf8",
  );
  writeFileSync(
    path.join(nested, ".codex", "skills", "autopilot", "SKILL.md"),
    "# Autopilot\nKeep moving without waiting for approval.\n",
    "utf8",
  );
  writeFileSync(
    path.join(nested, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        context7: { type: "stdio", command: "context7" },
      },
    }),
    "utf8",
  );
  writeFileSync(
    path.join(home, ".unclecode", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "claude-mem": { type: "stdio", command: "claude-mem" },
      },
    }),
    "utf8",
  );

  return { root, home, nested };
}

describe("context bootstrap", () => {
  it("discovers cursor rules without failing when the rules directory is absent", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-bootstrap-no-rules-"));
    const rules = await discoverCursorRules(cwd);
    assert.deepEqual(rules, []);
  });

  it("writes bootstrap.json and persists project memory facts on ingest", async () => {
    const { home, nested } = createFixtureWorkspace();
    const rootDir = path.join(nested, ".state");
    const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir, HOME: home };

    const result = await ingestWorkspaceBootstrapContext({
      cwd: nested,
      env,
      userHomeDir: home,
      sessionId: "bootstrap-session-1",
    });

    assert.ok(existsSync(result.snapshotPath));
    assert.equal(result.snapshotPath, path.join(nested, ".unclecode", "context", "bootstrap.json"));
    assert.ok(result.snapshot.sources.some((source) => source.kind === "guidance"));
    assert.ok(result.snapshot.sources.some((source) => source.kind === "cursor-rule"));
    assert.ok(result.snapshot.sources.some((source) => source.kind === "skill"));
    assert.ok(result.snapshot.sources.some((source) => source.kind === "mcp" && source.summary.includes("context7")));
    assert.ok(result.snapshot.sources.some((source) => source.kind === "mcp" && source.summary.includes("claude-mem")));
    assert.ok(result.summaryLines.some((line) => /Bootstrap context ·/.test(line)));

    const reloaded = await loadBootstrapSnapshot(nested);
    assert.equal(reloaded?.sources.length, result.snapshot.sources.length);

    assert.deepEqual(
      readdirSync(path.dirname(result.snapshotPath)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );

    const projectMemories = await createSessionStore({ rootDir }).listProjectMemories(nested);
    const bootstrapRecord = projectMemories.find((record) => record.memoryId === "bootstrap:context");
    assert.ok(bootstrapRecord);
    assert.match(bootstrapRecord.content, /^Bootstrap context:/);
  });

  it("classifies bootstrap sources into packet included, excluded, and warnings", async () => {
    const { home, nested } = createFixtureWorkspace();
    const env = { ...process.env, HOME: home };

    const result = await ingestWorkspaceBootstrapContext({
      cwd: nested,
      env,
      userHomeDir: home,
      persistMemoryFacts: false,
    });

    const supplement = buildBootstrapContextPacketSupplement({
      ...result.snapshot,
      memoryPrefetch: {
        status: "degraded",
        reason: "memory prefetch timed out after 5ms",
      },
    });

    const packet = augmentContextPacketViewInput({
      base: {
        id: "packet-test",
        generatedAt: result.snapshot.generatedAt,
        included: [...result.packetItems],
        excluded: supplement.excluded,
        warnings: [...result.packetWarnings, ...supplement.warnings],
        preview: ["Bootstrap packet preview"],
      },
    });

    assert.ok(packet.included.some((item) => item.id === "bootstrap-context-stamp"));
    assert.ok(packet.included.some((item) => item.id === "bootstrap-mcp-registry"));
    assert.ok(packet.excluded.length > 0);
    assert.ok(packet.warnings.some((warning) => warning.code === "bootstrap.memory-prefetch.degraded"));
    assert.ok(packet.sourceCounts.included >= 3);
  });

  it("stores bootstrap manifest with source paths matching fixtures", async () => {
    const { home, nested } = createFixtureWorkspace();
    const env = { ...process.env, HOME: home };

    await ingestWorkspaceBootstrapContext({
      cwd: nested,
      env,
      userHomeDir: home,
      persistMemoryFacts: false,
    });

    const manifest = JSON.parse(
      readFileSync(path.join(nested, ".unclecode", "context", "bootstrap.json"), "utf8"),
    );

    assert.equal(manifest.version, 1);
    assert.ok(
      manifest.sources.some(
        (source) =>
          source.kind === "cursor-rule" &&
          source.path.endsWith(path.join(".cursor", "rules", "testing.mdc")),
      ),
    );
    assert.ok(manifest.sources.some((source) => source.kind === "guidance" && /AGENTS\.md$/.test(source.path)));
    const autopilot = manifest.sources.find((source) => source.kind === "skill" && source.id.includes("autopilot"));
    assert.ok(autopilot);
    assert.equal(autopilot.includedInModel, false);
  });

  it("discovers .cursor/skills and marks pinned skills for model injection", async () => {
    const { home, nested } = createFixtureWorkspace();
    mkdirSync(path.join(nested, ".cursor", "skills", "cursor-demo"), { recursive: true });
    writeFileSync(
      path.join(nested, ".cursor", "skills", "cursor-demo", "SKILL.md"),
      "---\nname: cursor-demo\ndescription: Cursor workspace skill\n---\n# Cursor demo\n",
      "utf8",
    );
    mkdirSync(path.join(nested, ".unclecode", "context"), { recursive: true });
    writeFileSync(
      path.join(nested, ".unclecode", "context", "pinned-skills.json"),
      JSON.stringify({ skills: ["cursor-demo"] }),
      "utf8",
    );

    const result = await ingestWorkspaceBootstrapContext({
      cwd: nested,
      env: { ...process.env, HOME: home },
      userHomeDir: home,
      persistMemoryFacts: false,
    });

    const cursorSkill = result.snapshot.sources.find((source) => source.id.includes("cursor-demo"));
    assert.ok(cursorSkill);
    assert.equal(cursorSkill.includedInModel, true);
  });

  it("regenerates bootstrap.json when guidance changes on reload ingest", async () => {
    const { home, nested } = createFixtureWorkspace();
    const env = { ...process.env, HOME: home };

    const first = await ingestWorkspaceBootstrapContext({
      cwd: nested,
      env,
      userHomeDir: home,
      persistMemoryFacts: false,
    });

    writeFileSync(path.join(nested, "AGENTS.md"), "# Agents\nUpdated guidance after reload.\n", "utf8");
    clearCachedWorkspaceGuidance(nested, home);

    const second = await ingestWorkspaceBootstrapContext({
      cwd: nested,
      env,
      userHomeDir: home,
      persistMemoryFacts: false,
    });

    assert.notEqual(second.snapshot.generatedAt, first.snapshot.generatedAt);
    assert.ok(
      second.snapshot.sources.some(
        (source) => source.kind === "guidance" && source.summary.includes("Updated guidance after reload"),
      ),
    );
  });

  it("skips bootstrap.json write when the workspace context dir is read-only", async () => {
    const { home, nested } = createFixtureWorkspace();
    const bootstrapDir = path.join(nested, ".unclecode", "context");
    mkdirSync(bootstrapDir, { recursive: true });
    chmodSync(bootstrapDir, 0o555);

    try {
      const result = await ingestWorkspaceBootstrapContext({
        cwd: nested,
        env: { ...process.env, HOME: home },
        userHomeDir: home,
        persistMemoryFacts: false,
      });

      assert.equal(result.snapshotWritten, false);
      assert.ok(result.summaryLines.some((line) => /read-only/.test(line)));
      assert.equal(existsSync(path.join(bootstrapDir, "bootstrap.json")), false);
      assert.ok(result.snapshot.sources.length > 0);
    } finally {
      chmodSync(bootstrapDir, 0o755);
    }
  });

  it(
    "refuses to persist bootstrap.json through a symlinked .unclecode directory",
    { skip: SYMLINKS_REQUIRE_ELEVATION },
    async () => {
      const { root, home, nested } = createFixtureWorkspace();
      const escapeTarget = path.join(root, "escaped-unclecode");
      mkdirSync(escapeTarget, { recursive: true });
      const unclecodeLink = path.join(nested, ".unclecode");
      symlinkSync(escapeTarget, unclecodeLink);

      const result = await ingestWorkspaceBootstrapContext({
        cwd: nested,
        env: { ...process.env, HOME: home },
        userHomeDir: home,
        persistMemoryFacts: false,
      });

      assert.equal(result.snapshotWritten, false);
      assert.equal(existsSync(path.join(escapeTarget, "context", "bootstrap.json")), false);
      assert.equal(existsSync(path.join(escapeTarget, "context")), false);
      assert.equal(lstatSync(unclecodeLink).isSymbolicLink(), true);
      assert.ok(result.snapshot.sources.length > 0);
    },
  );

  it(
    "refuses to write through a symlinked bootstrap.json and leaves its target intact",
    { skip: SYMLINKS_REQUIRE_ELEVATION },
    async () => {
      const { root, home, nested } = createFixtureWorkspace();
      const escapeTarget = path.join(root, "escaped-bootstrap.json");
      const untouched = "sentinel payload the bootstrap writer must never replace\n";
      writeFileSync(escapeTarget, untouched, "utf8");

      const snapshotLink = path.join(nested, ".unclecode", "context", "bootstrap.json");
      mkdirSync(path.dirname(snapshotLink), { recursive: true });
      symlinkSync(escapeTarget, snapshotLink);

      const result = await ingestWorkspaceBootstrapContext({
        cwd: nested,
        env: { ...process.env, HOME: home },
        userHomeDir: home,
        persistMemoryFacts: false,
      });

      assert.equal(result.snapshotWritten, false);
      assert.equal(readFileSync(escapeTarget, "utf8"), untouched);
      assert.equal(lstatSync(snapshotLink).isSymbolicLink(), true);
      assert.ok(result.snapshot.sources.length > 0);
    },
  );

  it(
    "refuses to load bootstrap.json through a symbolic link",
    { skip: SYMLINKS_REQUIRE_ELEVATION },
    async () => {
      const { root, nested } = createFixtureWorkspace();
      const escapeTarget = path.join(root, "escaped-bootstrap.json");
      writeFileSync(
        escapeTarget,
        `${JSON.stringify({
          version: 1,
          workspaceRoot: nested,
          generatedAt: new Date().toISOString(),
          sources: [],
          warnings: [],
          conflicts: [],
          memoryPrefetch: { status: "empty" },
        })}\n`,
        "utf8",
      );
      const snapshotLink = path.join(nested, ".unclecode", "context", "bootstrap.json");
      mkdirSync(path.dirname(snapshotLink), { recursive: true });
      symlinkSync(escapeTarget, snapshotLink);

      await assert.rejects(loadBootstrapSnapshot(nested), /symbolic-link/i);
      assert.equal(lstatSync(snapshotLink).isSymbolicLink(), true);
    },
  );

  it("keeps exactly one stable bootstrap memory record across repeated ingests", async () => {
    const { home, nested } = createFixtureWorkspace();
    const rootDir = path.join(nested, ".state");
    const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir, HOME: home };

    await ingestWorkspaceBootstrapContext({
      cwd: nested,
      env,
      userHomeDir: home,
      sessionId: "bootstrap-stable-1",
    });
    await ingestWorkspaceBootstrapContext({
      cwd: nested,
      env,
      userHomeDir: home,
      sessionId: "bootstrap-stable-2",
    });

    const records = await createSessionStore({ rootDir }).listProjectMemories(nested);
    const bootstrapRecords = records.filter((record) => record.content.startsWith("Bootstrap context:"));

    assert.deepEqual(
      bootstrapRecords.map((record) => record.memoryId),
      ["bootstrap:context"],
    );
  });

  it("deletes legacy synthetic bootstrap memory records when writing the stable record", async () => {
    const { home, nested } = createFixtureWorkspace();
    const rootDir = path.join(nested, ".state");
    const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir, HOME: home };
    const store = createSessionStore({ rootDir });

    await store.writeProjectMemory({
      projectPath: nested,
      memoryId: "memory:project:2024-01-01T00:00:00.000Z:11111111",
      content: "Bootstrap context: 1 guidance, 0 cursor rules, 0 skills, 0 MCP servers.",
    });
    await store.writeProjectMemory({
      projectPath: nested,
      memoryId: "memory:project:2024-01-02T00:00:00.000Z:22222222",
      content: "Bootstrap context: 2 guidance, 1 cursor rules, 1 skills, 2 MCP servers.",
    });
    await store.writeProjectMemory({
      projectPath: nested,
      memoryId: "memory:project:2024-01-03T00:00:00.000Z:33333333",
      content: "Operator prefers read before edit.",
    });

    await ingestWorkspaceBootstrapContext({
      cwd: nested,
      env,
      userHomeDir: home,
      sessionId: "bootstrap-legacy-sweep",
    });

    const records = await store.listProjectMemories(nested);

    assert.deepEqual(
      records
        .filter((record) => record.content.startsWith("Bootstrap context:"))
        .map((record) => record.memoryId),
      ["bootstrap:context"],
    );
    assert.ok(records.some((record) => record.content === "Operator prefers read before edit."));
  });
});
