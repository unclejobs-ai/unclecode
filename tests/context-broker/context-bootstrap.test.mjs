import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  augmentContextPacketViewInput,
  buildBootstrapContextPacketSupplement,
  clearCachedWorkspaceGuidance,
  discoverCursorRules,
  ingestWorkspaceBootstrapContext,
  listScopedMemoryEntries,
  loadBootstrapSnapshot,
} from "../../packages/context-broker/src/index.ts";

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

    const memoryEntries = await listScopedMemoryEntries({
      scope: "project",
      cwd: nested,
      env,
    });
    assert.ok(memoryEntries.some((entry) => /Bootstrap context:/.test(entry.summary)));
    assert.match(memoryEntries[0]?.memoryId ?? "", /^memory:project:/);
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
});
