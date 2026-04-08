import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveFastCliPath } from "../../apps/unclecode-cli/src/fast-cli.ts";
import { launchSessionCenter } from "../../apps/unclecode-cli/src/interactive-shell.ts";
import {
  createUncleCodeProgram,
  launchWorkEntrypoint,
  shouldLaunchDefaultWorkSession,
} from "../../apps/unclecode-cli/src/program.ts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");

test("resolveFastCliPath recognizes lightweight operator startup", () => {
  assert.equal(resolveFastCliPath(["auth", "status"]), "auth-status");
  assert.equal(resolveFastCliPath(["doctor"]), "doctor");
  assert.equal(resolveFastCliPath(["doctor", "--json"]), "doctor-json");
  assert.equal(resolveFastCliPath(["setup"]), "setup");
  assert.equal(resolveFastCliPath(["mode", "status"]), "mode-status");
  assert.equal(resolveFastCliPath(["sessions"]), "sessions");
  assert.equal(resolveFastCliPath(["config", "explain"]), "config-explain");
});

test("createUncleCodeProgram exposes the unclecode root command and tui boundary", () => {
  const program = createUncleCodeProgram();
  const configCommand = program.commands.find(
    (command) => command.name() === "config",
  );
  const authCommand = program.commands.find(
    (command) => command.name() === "auth",
  );
  const doctorCommand = program.commands.find(
    (command) => command.name() === "doctor",
  );

  assert.equal(program.name(), "unclecode");
  assert.ok(program.commands.some((command) => command.name() === "tui"));
  assert.ok(program.commands.some((command) => command.name() === "setup"));
  assert.ok(configCommand);
  assert.ok(
    configCommand.commands.some((command) => command.name() === "explain"),
  );
  assert.ok(authCommand);
  assert.ok(authCommand.commands.some((command) => command.name() === "login"));
  assert.ok(
    authCommand.commands.some((command) => command.name() === "status"),
  );
  assert.ok(doctorCommand);
  assert.ok(
    doctorCommand.options.some((option) => option.long === "--verbose"),
  );
});

test("fast sessions path avoids the full session-store runtime barrel", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/fast-sessions.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /from\s+"@unclecode\/session-store"/);
  assert.match(source, /function\s+getSessionPaths\(/);
});

test("workspace build script cleans stale dist-work outputs before rebuilding the app-owned work entrypoint", () => {
  const packageJsonSource = readFileSync(
    path.join(workspaceRoot, "package.json"),
    "utf8",
  );

  assert.match(
    packageJsonSource,
    /"build"\s*:\s*"node .*dist-work.*tsc -b tsconfig\.json && tsc -p tsconfig\.work\.json"/,
  );
});

test("startup router keeps interactive boot behind dynamic imports without a work-launcher shim", () => {
  const indexSource = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/index.ts"),
    "utf8",
  );
  const interactiveShellSource = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/interactive-shell.ts"),
    "utf8",
  );
  const programSource = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/program.ts"),
    "utf8",
  );
  const binSource = readFileSync(
    path.join(workspaceRoot, "bin/unclecode.cjs"),
    "utf8",
  );
  const workTsconfig = readFileSync(
    path.join(workspaceRoot, "tsconfig.work.json"),
    "utf8",
  );

  assert.doesNotMatch(indexSource, /\.\/work-launcher\.js/);
  assert.match(
    indexSource,
    /import\s+\{\s*shouldLaunchDefaultWorkSession\s*\}\s+from\s+"\.\/startup-paths\.js"/,
  );
  assert.match(indexSource, /await import\("\.\/fast-cli\.js"\)/);
  assert.match(indexSource, /await maybeRunFastCliPath\(args\)/);
  assert.match(
    indexSource,
    /await\s*\(await import\("\.\/interactive-shell\.js"\)\)\.launchWorkEntrypoint\(\[\]\)/,
  );
  assert.match(
    indexSource,
    /slashInput[\s\S]*await import\("\.\/command-router\.js"\)/,
  );
  assert.doesNotMatch(
    interactiveShellSource,
    /import\s+\{\s*renderTui\s*\}\s+from\s+"@unclecode\/tui"/,
  );
  assert.match(interactiveShellSource, /await import\("@unclecode\/tui"\)/);
  assert.match(interactiveShellSource, /import\("\.\/operational\.js"\)/);
  assert.match(
    interactiveShellSource,
    /dist-work[\s\S]*apps[\s\S]*unclecode-cli[\s\S]*src[\s\S]*work-entry\.js/,
  );
  assert.doesNotMatch(
    interactiveShellSource,
    /dist-work[\/",\s]+src[\/",\s]+index\.js/,
  );
  assert.doesNotMatch(programSource, /\.\/work-launcher\.js/);
  assert.match(
    binSource,
    /dist-work[\/",\s]+apps[\/",\s]+unclecode-cli[\/",\s]+src[\/",\s]+work-entry\.js/,
  );
  assert.doesNotMatch(binSource, /dist-work[\/",\s]+src[\/",\s]+index\.js/);
  assert.match(
    workTsconfig,
    /"include"\s*:\s*\[\s*"apps\/unclecode-cli\/src\/work-entry\.ts"\s*\]/,
  );
  assert.doesNotMatch(workTsconfig, /"src\/\*\*\/*.ts"/);
  assert.equal(
    existsSync(
      path.join(workspaceRoot, "apps/unclecode-cli/src/work-launcher.ts"),
    ),
    false,
  );
});

test("launchWorkEntrypoint dispatches to the work module in-process", async () => {
  let capturedArgs = undefined;

  await launchWorkEntrypoint(["--tools"], {
    callerCwd: "/tmp/project-a",
    loadModule: async () => ({
      runWorkCli: async (args) => {
        capturedArgs = args;
      },
    }),
  });

  assert.deepEqual(capturedArgs, ["--cwd", "/tmp/project-a", "--tools"]);
});

test("launchSessionCenter reuses the interactive bootstrap for work handoff", async () => {
  let capturedArgs = undefined;
  let receivedWorkspaceRoot = undefined;
  let receivedInitialView = undefined;

  await launchSessionCenter(
    {
      workspaceRoot: "/tmp/project-b",
      env: { HOME: "/tmp/home-b" },
    },
    {
      buildHomeState: async () => ({
        modeLabel: "default",
        authLabel: "none",
        sessionCount: 0,
        mcpServerCount: 0,
        mcpServers: [],
        latestResearchSessionId: null,
        latestResearchSummary: null,
        latestResearchTimestamp: null,
        researchRunCount: 0,
        sessions: [],
        bridgeLines: [],
        memoryLines: [],
      }),
      renderShell: async (options) => {
        receivedWorkspaceRoot = options.workspaceRoot;
        receivedInitialView = options.initialView;
        await options.launchWorkSession?.(["--session-id", "work-session-1"]);
      },
      loadWorkModule: async () => ({
        runWorkCli: async (args) => {
          capturedArgs = args;
        },
      }),
    },
  );

  assert.equal(receivedWorkspaceRoot, "/tmp/project-b");
  assert.equal(receivedInitialView, "sessions");
  assert.deepEqual(capturedArgs, [
    "--cwd",
    "/tmp/project-b",
    "--session-id",
    "work-session-1",
  ]);
});

test("launchSessionCenter wires an embedded work pane when the work module exposes dashboard props", async () => {
  let receivedRenderWorkPane = undefined;
  let embeddedArgs = undefined;

  await launchSessionCenter(
    {
      workspaceRoot: "/tmp/project-c",
      env: { HOME: "/tmp/home-c" },
      initialSelectedSessionId: "work-session-9",
    },
    {
      buildHomeState: async () => ({
        modeLabel: "default",
        authLabel: "none",
        sessionCount: 1,
        mcpServerCount: 0,
        mcpServers: [],
        latestResearchSessionId: null,
        latestResearchSummary: null,
        latestResearchTimestamp: null,
        researchRunCount: 0,
        sessions: [
          {
            sessionId: "work-session-9",
            state: "idle",
            updatedAt: "2026-04-05T12:00:00.000Z",
            model: "gpt-5.4",
            taskSummary: "Resume work",
          },
        ],
        bridgeLines: [],
        memoryLines: [],
      }),
      renderShell: async (options) => {
        receivedRenderWorkPane = options.renderWorkPane;
      },
      loadWorkModule: async () => ({
        loadWorkShellDashboardProps: async (args) => {
          embeddedArgs = args;
          return {
            workspaceRoot: "/tmp/project-c",
            initialView: "work",
            contextLines: ["Loaded guidance: AGENTS.md"],
            renderWorkPane: () => null,
          };
        },
      }),
    },
  );

  assert.equal(typeof receivedRenderWorkPane, "function");
  assert.deepEqual(embeddedArgs, [
    "--cwd",
    "/tmp/project-c",
    "--session-id",
    "work-session-9",
  ]);
});

test("startRepl is wired through app-owned managed dashboard helpers instead of local root assembly", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );
  const runtimeSource = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/work-runtime.ts"),
    "utf8",
  );

  assert.match(
    cliSource,
    /export\s*\{[^}]*resolveWorkShellInlineCommand[^}]*createWorkShellDashboardProps[^}]*startRepl[^}]*\}\s*from\s*"\.\.\/apps\/unclecode-cli\/src\/work-runtime\.js"/,
  );
  assert.match(
    cliSource,
    /export\s+type\s*\{[^}]*StartReplOptions[^}]*\}\s*from\s*"\.\.\/apps\/unclecode-cli\/src\/work-runtime\.js"/,
  );
  assert.doesNotMatch(
    cliSource,
    /export function createWorkShellDashboardProps\(/,
  );
  assert.doesNotMatch(cliSource, /export async function startRepl\(/);
  assert.doesNotMatch(cliSource, /type StartReplOptions = \{/);
  assert.doesNotMatch(cliSource, /function\s+App\s*\(/);
  assert.doesNotMatch(
    cliSource,
    /render\s*\(\s*<Dashboard\s*\{\.\.\.createWorkShellDashboardProps\(agent, options\)\}/,
  );
  assert.match(
    runtimeSource,
    /export function createWorkShellDashboardProps\(/,
  );
  assert.match(runtimeSource, /export async function startRepl\(/);
});

test("src/cli.tsx delegates work-shell dashboard assembly to app-owned helpers instead of building pane runtime inline", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );

  assert.match(
    cliSource,
    /from\s*"\.\.\/apps\/unclecode-cli\/src\/work-runtime\.js"/,
  );
  assert.doesNotMatch(cliSource, /createManagedDashboardInput/);
  assert.doesNotMatch(cliSource, /createManagedDashboardProps/);
  assert.doesNotMatch(cliSource, /createWorkShellPaneRuntime/);
  assert.doesNotMatch(cliSource, /createWorkShellEngine\(/);
  assert.doesNotMatch(cliSource, /getWorkShellSlashSuggestions\(/);
  assert.doesNotMatch(cliSource, /shouldBlockSlashSubmit\(/);
  assert.doesNotMatch(cliSource, /new\s+WorkShellEngine\s*</);
  assert.doesNotMatch(cliSource, /new\s+WorkShellEngine\s*\(/);
});

test("src/cli.tsx imports composer-input loading from @unclecode/orchestrator", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );

  assert.match(
    cliSource,
    /import\s*\{[^}]*resolveComposerInput[^}]*\}\s*from\s*"@unclecode\/orchestrator"/,
  );
  assert.doesNotMatch(cliSource, /async function toImageAttachment\(/);
  assert.doesNotMatch(
    cliSource,
    /export async function resolveComposerInput\(/,
  );
});

test("src/cli.tsx re-exports managed work-shell dashboard helpers from app runtime while src/composer.tsx stays a thin shim", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );
  const composerSource = readFileSync(
    path.join(workspaceRoot, "src/composer.tsx"),
    "utf8",
  );

  assert.match(
    cliSource,
    /export\s*\{[^}]*createWorkShellDashboardProps[^}]*startRepl[^}]*\}\s*from\s*"\.\.\/apps\/unclecode-cli\/src\/work-runtime\.js"/,
  );
  assert.doesNotMatch(
    cliSource,
    /import\s*\{[^}]*Composer[^}]*\}\s*from\s*"@unclecode\/tui"/,
  );
  assert.doesNotMatch(cliSource, /from\s+"\.\/composer\.js"/);
  assert.match(composerSource, /from\s*"@unclecode\/tui"/);
  assert.match(composerSource, /Composer/);
  assert.match(composerSource, /sanitizeComposerInput/);
  assert.match(composerSource, /shouldTreatComposerChangeAsPaste/);
  assert.doesNotMatch(
    composerSource,
    /function\s+shouldTreatComposerChangeAsPaste\(/,
  );
  assert.doesNotMatch(composerSource, /function\s+Composer\(/);
});

test("src/cli.tsx keeps slash helper logic behind @unclecode/orchestrator", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );

  assert.match(
    cliSource,
    /import\s*\{[^}]*resolveWorkShellSlashCommand[^}]*\}\s*from\s*"@unclecode\/orchestrator"/,
  );
  assert.doesNotMatch(cliSource, /function\s+getWorkShellCommandRegistry\(/);
  assert.doesNotMatch(
    cliSource,
    /export function resolveWorkShellSlashCommand\(/,
  );
  assert.doesNotMatch(
    cliSource,
    /export function getWorkShellSlashSuggestions\(/,
  );
  assert.doesNotMatch(cliSource, /export function shouldBlockSlashSubmit\(/);
  assert.doesNotMatch(cliSource, /getWorkShellSlashSuggestions\(/);
  assert.doesNotMatch(cliSource, /shouldBlockSlashSubmit\(/);
});

test("src/cli.tsx imports reasoning helpers from @unclecode/orchestrator", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );

  assert.match(
    cliSource,
    /import\s*\{[^}]*describeReasoning[^}]*resolveReasoningCommand[^}]*\}\s*from\s*"@unclecode\/orchestrator"/,
  );
  assert.doesNotMatch(cliSource, /export function describeReasoning\(/);
  assert.doesNotMatch(cliSource, /export function resolveReasoningCommand\(/);
});

test("src/cli.tsx lets the shared managed dashboard helper absorb work-shell input controller wiring", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );

  assert.match(
    cliSource,
    /export\s*\{[^}]*createWorkShellDashboardProps[^}]*startRepl[^}]*\}\s*from\s*"\.\.\/apps\/unclecode-cli\/src\/work-runtime\.js"/,
  );
  assert.doesNotMatch(cliSource, /useWorkShellPaneState/);
  assert.doesNotMatch(
    cliSource,
    /import\s*\{[^}]*useWorkShellInputController[^}]*\}\s*from\s*"@unclecode\/tui"/,
  );
  assert.doesNotMatch(cliSource, /useWorkShellInputController\(\{/);
  assert.doesNotMatch(cliSource, /useInput\(\(value, key\) =>/);
});

test("src/cli.tsx delegates direct WorkShellPane and lifecycle hook ownership to the shared TUI helper", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );

  assert.match(
    cliSource,
    /export\s*\{[^}]*createWorkShellDashboardProps[^}]*startRepl[^}]*\}\s*from\s*"\.\.\/apps\/unclecode-cli\/src\/work-runtime\.js"/,
  );
  assert.doesNotMatch(
    cliSource,
    /import\s*\{[^}]*WorkShellPane[^}]*\}\s*from\s*"@unclecode\/tui"/,
  );
  assert.doesNotMatch(
    cliSource,
    /import\s*\{[^}]*useWorkShellPaneState[^}]*\}\s*from\s*"@unclecode\/tui"/,
  );
  assert.doesNotMatch(cliSource, /useWorkShellPaneState/);
  assert.doesNotMatch(cliSource, /useWorkShellEngineState\(engine\)/);
  assert.doesNotMatch(cliSource, /useWorkShellComposerPreview\(\{/);
  assert.doesNotMatch(
    cliSource,
    /useWorkShellDashboardHomeSync(?:<[^>]+>)?\(\{/,
  );
  assert.doesNotMatch(cliSource, /useWorkShellSlashState\(\{/);
});

test("src/cli.tsx lets the shared managed dashboard helper absorb dashboard home sync wiring", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );

  assert.match(
    cliSource,
    /export\s*\{[^}]*createWorkShellDashboardProps[^}]*startRepl[^}]*\}\s*from\s*"\.\.\/apps\/unclecode-cli\/src\/work-runtime\.js"/,
  );
  assert.doesNotMatch(cliSource, /useWorkShellPaneState/);
  assert.doesNotMatch(
    cliSource,
    /import\s*\{[^}]*useWorkShellDashboardHomeSync[^}]*\}\s*from\s*"@unclecode\/tui"/,
  );
  assert.doesNotMatch(
    cliSource,
    /useWorkShellDashboardHomeSync(?:<[^>]+>)?\(\{/,
  );
  assert.doesNotMatch(cliSource, /createWorkShellDashboardHomePatch\(\{/);
  assert.doesNotMatch(cliSource, /createWorkShellDashboardHomeSyncState\(\{/);
  assert.doesNotMatch(cliSource, /shouldRefreshDashboardHomeState\(/);
});

test("src/cli.tsx imports work-shell session helpers from @unclecode/orchestrator", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );

  assert.match(
    cliSource,
    /import\s*\{[^}]*listSessionLines[^}]*persistWorkShellSessionSnapshot[^}]*\}\s*from\s*"@unclecode\/orchestrator"/,
  );
  assert.doesNotMatch(
    cliSource,
    /export\s+async\s+function\s+listSessionLines\(/,
  );
  assert.doesNotMatch(
    cliSource,
    /export\s+async\s+function\s+persistWorkShellSessionSnapshot\(/,
  );
});

test("src/cli.tsx imports session-store root resolution from @unclecode/session-store and src/session-store-paths.ts is a thin shim", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );
  const shimSource = readFileSync(
    path.join(workspaceRoot, "src/session-store-paths.ts"),
    "utf8",
  );

  assert.match(
    cliSource,
    /import\s*\{[^}]*getSessionStoreRoot[^}]*\}\s*from\s*"@unclecode\/session-store"/,
  );
  assert.doesNotMatch(cliSource, /from\s+"\.\/session-store-paths\.js"/);
  assert.match(shimSource, /from\s*"@unclecode\/session-store"/);
  assert.doesNotMatch(shimSource, /function\s+getSessionStoreRoot\(/);
});

test("src/cli.tsx imports context-memory helpers from @unclecode/context-broker and src/context-memory.ts is a thin shim", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );
  const shimSource = readFileSync(
    path.join(workspaceRoot, "src/context-memory.ts"),
    "utf8",
  );

  assert.match(
    cliSource,
    /import\s*\{[^}]*listProjectBridgeLines[^}]*listScopedMemoryLines[^}]*publishContextBridge[^}]*writeScopedMemory[^}]*\}\s*from\s*"@unclecode\/context-broker"/,
  );
  assert.doesNotMatch(cliSource, /from\s+"\.\/context-memory\.js"/);
  assert.match(shimSource, /from\s*"@unclecode\/context-broker"/);
  assert.doesNotMatch(
    shimSource,
    /export\s+async\s+function\s+publishContextBridge\(/,
  );
  assert.doesNotMatch(
    shimSource,
    /export\s+async\s+function\s+listProjectBridgeLines\(/,
  );
  assert.doesNotMatch(
    shimSource,
    /export\s+async\s+function\s+writeScopedMemory\(/,
  );
  assert.doesNotMatch(
    shimSource,
    /export\s+async\s+function\s+listScopedMemoryLines\(/,
  );
});

test("src/cli.tsx imports workspace-skill helpers from @unclecode/context-broker and src/workspace-skills.ts is a thin shim", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );
  const shimSource = readFileSync(
    path.join(workspaceRoot, "src/workspace-skills.ts"),
    "utf8",
  );

  assert.match(
    cliSource,
    /import\s*\{[^}]*listAvailableSkills[^}]*loadNamedSkill[^}]*\}\s*from\s*"@unclecode\/context-broker"/,
  );
  assert.doesNotMatch(cliSource, /from\s+"\.\/workspace-skills\.js"/);
  assert.match(shimSource, /from\s*"@unclecode\/context-broker"/);
  assert.doesNotMatch(
    shimSource,
    /export\s+async\s+function\s+discoverSkillMetadata\(/,
  );
  assert.doesNotMatch(
    shimSource,
    /export\s+async\s+function\s+listAvailableSkills\(/,
  );
  assert.doesNotMatch(
    shimSource,
    /export\s+async\s+function\s+loadNamedSkill\(/,
  );
  assert.doesNotMatch(
    shimSource,
    /export\s+function\s+clearWorkspaceSkillCache\(/,
  );
});

test("src/cli.tsx re-exports inline-command resolution from app runtime instead of keeping a local wrapper", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );
  const runtimeSource = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/work-runtime.ts"),
    "utf8",
  );

  assert.match(
    cliSource,
    /export\s*\{[^}]*resolveWorkShellInlineCommand[^}]*\}\s*from\s*"\.\.\/apps\/unclecode-cli\/src\/work-runtime\.js"/,
  );
  assert.doesNotMatch(
    cliSource,
    /export\s+const\s+resolveWorkShellInlineCommand\s*=|export\s+async\s+function\s+resolveWorkShellInlineCommand\(/,
  );
  assert.match(
    runtimeSource,
    /export\s+const\s+resolveWorkShellInlineCommand\s*=|export\s+async\s+function\s+resolveWorkShellInlineCommand\(/,
  );
  assert.doesNotMatch(cliSource, /stdout\?: unknown/);
  assert.doesNotMatch(cliSource, /stderr\?: unknown/);
});

test("src/cli.tsx imports auth-label parsing from @unclecode/tui", () => {
  const cliSource = readFileSync(
    path.join(workspaceRoot, "src/cli.tsx"),
    "utf8",
  );

  assert.match(
    cliSource,
    /import\s*\{[^}]*extractAuthLabel[^}]*\}\s*from\s*"@unclecode\/tui"/,
  );
  assert.doesNotMatch(cliSource, /function extractAuthLabel\(/);
});

test("obsolete root runtime wrappers are removed once app-owned work entrypoint owns the packaged work bootstrap", () => {
  assert.equal(existsSync(path.join(workspaceRoot, "src/index.ts")), false);
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/work-shell-runtime.ts")),
    false,
  );
});

test("apps/unclecode-cli/src/work-runtime.ts imports config/tools/guidance from package seams instead of root src modules", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/work-runtime.ts"),
    "utf8",
  );

  assert.match(
    source,
    /import\s*\{[^}]*loadConfig[^}]*toolDefinitions[^}]*WorkAgent[^}]*\}\s*from\s*"@unclecode\/orchestrator"/s,
  );
  assert.match(
    source,
    /import\s*\{[^}]*clearCachedWorkspaceGuidance[^}]*loadCachedWorkspaceGuidance[^}]*\}\s*from\s*"@unclecode\/context-broker"/s,
  );
  assert.match(
    source,
    /import\s*\{[^}]*createRuntimeCodingAgent[^}]*\}\s*from\s*"\.\/runtime-coding-agent\.js"/s,
  );
  assert.doesNotMatch(source, /\.\.\.\/\.\.\.\/src\/agent\.js/);
  assert.doesNotMatch(source, /\.\.\.\/\.\.\.\/src\/cli\.js/);
  assert.doesNotMatch(source, /\.\.\.\/\.\.\.\/src\/config\.js/);
  assert.doesNotMatch(source, /\.\.\.\/\.\.\.\/src\/tools\.js/);
  assert.doesNotMatch(source, /\.\.\.\/\.\.\.\/src\/workspace-guidance\.js/);
  assert.doesNotMatch(source, /\.\.\.\/\.\.\.\/src\/work-agent\.js/);
  assert.doesNotMatch(source, /function\s+loadRootRuntimeDeps\s*\(/);
});

test("apps/unclecode-cli/src/runtime-coding-agent.ts is a thin compatibility shim over @unclecode/orchestrator", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/runtime-coding-agent.ts"),
    "utf8",
  );

  assert.match(source, /from\s+"@unclecode\/orchestrator"/);
  assert.doesNotMatch(source, /from\s+"@unclecode\/providers"/);
  assert.doesNotMatch(source, /createRuntimeProvider/);
  assert.doesNotMatch(source, /\.\.\/\.\.\/\.\.\/src\/providers\.js/);
  assert.doesNotMatch(source, /function\s+importRootModule\s*\(/);
  assert.doesNotMatch(source, /function\s+createRuntimeProvider\s*\(/);
  assert.match(source, /export\s*\{[^}]*createRuntimeCodingAgent[^}]*\}/s);
});

test("obsolete root agent/provider compatibility surfaces are removed", () => {
  assert.equal(existsSync(path.join(workspaceRoot, "src/agent.ts")), false);
  assert.equal(existsSync(path.join(workspaceRoot, "src/providers.ts")), false);
  assert.equal(existsSync(path.join(workspaceRoot, "src/agent.d.ts")), false);
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/providers.d.ts")),
    false,
  );
});

test("src/config.ts is now a thin shim over @unclecode/orchestrator", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "src/config.ts"),
    "utf8",
  );

  assert.match(source, /from\s+"@unclecode\/orchestrator"/);
  assert.match(
    source,
    /export\s+type\s*\{[^}]*AppConfig[^}]*AppReasoningConfig[^}]*\}/s,
  );
  assert.match(source, /export\s*\{\s*loadConfig\s*\}/);
  assert.doesNotMatch(source, /const\s+envSchema\s*=/);
  assert.doesNotMatch(source, /async\s+function\s+loadConfig\s*\(/);
});

test("src/tools.ts is now a thin shim over @unclecode/orchestrator", () => {
  const source = readFileSync(path.join(workspaceRoot, "src/tools.ts"), "utf8");

  assert.match(source, /from\s+"@unclecode\/orchestrator"/);
  assert.match(
    source,
    /export\s+type\s*\{[^}]*ToolDefinition[^}]*ToolHandler[^}]*ToolResult[^}]*\}/s,
  );
  assert.match(
    source,
    /export\s*\{[^}]*toolDefinitions[^}]*toolHandlers[^}]*\}/s,
  );
  assert.doesNotMatch(source, /async\s+function\s+listFiles\s*\(/);
  assert.doesNotMatch(source, /async\s+function\s+runShell\s*\(/);
});

test("src/work-agent.ts is now a thin shim over @unclecode/orchestrator", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "src/work-agent.ts"),
    "utf8",
  );

  assert.match(source, /from\s+"@unclecode\/orchestrator"/);
  assert.match(source, /export\s*\{\s*WorkAgent\s*\}/);
  assert.doesNotMatch(source, /function\s+buildComplexTasks\s*\(/);
  assert.doesNotMatch(source, /function\s+resolveWorkerBudget\s*\(/);
});

test("root compat sources no longer keep stale checked-in generated runtime/map artifacts", () => {
  for (const relativePath of [
    "src/agent.js",
    "src/agent.js.map",
    "src/agent.d.ts.map",
    "src/providers.js",
    "src/providers.js.map",
    "src/providers.d.ts.map",
    "src/cli.js",
    "src/cli.js.map",
    "src/cli.d.ts.map",
    "src/composer.js",
    "src/composer.js.map",
    "src/composer.d.ts.map",
    "src/config.js",
    "src/config.js.map",
    "src/config.d.ts.map",
    "src/context-memory.js",
    "src/context-memory.js.map",
    "src/context-memory.d.ts.map",
    "src/session-store-paths.js",
    "src/session-store-paths.js.map",
    "src/session-store-paths.d.ts.map",
    "src/tools.js",
    "src/tools.js.map",
    "src/tools.d.ts.map",
    "src/work-agent.js",
    "src/work-agent.js.map",
    "src/work-agent.d.ts.map",
    "src/workspace-guidance.js",
    "src/workspace-guidance.js.map",
    "src/workspace-guidance.d.ts.map",
    "src/workspace-skills.js",
    "src/workspace-skills.js.map",
    "src/workspace-skills.d.ts.map",
  ]) {
    assert.equal(
      existsSync(path.join(workspaceRoot, relativePath)),
      false,
      relativePath,
    );
  }
});

test("repo behavioral tests import owning package and app seams instead of root compatibility shims", () => {
  const agentTest = readFileSync(
    path.join(workspaceRoot, "tests/work/agent.test.mjs"),
    "utf8",
  );
  const openAiProviderTest = readFileSync(
    path.join(workspaceRoot, "tests/work/openai-provider.test.mjs"),
    "utf8",
  );
  const replTest = readFileSync(
    path.join(workspaceRoot, "tests/work/repl.test.mjs"),
    "utf8",
  );
  const workCliResumeTest = readFileSync(
    path.join(workspaceRoot, "tests/work/work-cli-resume.test.mjs"),
    "utf8",
  );
  const sessionsIntegrationTest = readFileSync(
    path.join(
      workspaceRoot,
      "tests/integration/unclecode-sessions.integration.test.mjs",
    ),
    "utf8",
  );

  assert.match(agentTest, /from\s+"@unclecode\/orchestrator"/);
  assert.doesNotMatch(agentTest, /\.\.\/\.\.\/src\/agent\.ts/);

  assert.match(openAiProviderTest, /from\s+"@unclecode\/orchestrator"/);
  assert.doesNotMatch(openAiProviderTest, /\.\.\/\.\.\/src\/providers\.ts/);

  assert.match(replTest, /from\s+"@unclecode\/orchestrator"/);
  assert.match(replTest, /from\s+"@unclecode\/tui"/);
  assert.match(replTest, /from\s+"@unclecode\/context-broker"/);
  assert.match(
    replTest,
    /from\s+"\.\.\/\.\.\/apps\/unclecode-cli\/src\/work-runtime\.ts"/,
  );
  assert.doesNotMatch(replTest, /\.\.\/\.\.\/src\/cli\.tsx/);

  assert.match(
    workCliResumeTest,
    /from\s+"\.\.\/\.\.\/apps\/unclecode-cli\/src\/work-runtime\.ts"/,
  );
  assert.doesNotMatch(workCliResumeTest, /\.\.\/\.\.\/src\/index\.ts/);

  assert.match(
    sessionsIntegrationTest,
    /from \$\{JSON\.stringify\("@unclecode\/orchestrator"\)\}/,
  );
  assert.doesNotMatch(sessionsIntegrationTest, /src\/cli\.tsx/);
});

test("root declaration shims re-export owner seams instead of preserving stale local declarations", () => {
  const cliDeclaration = readFileSync(
    path.join(workspaceRoot, "src/cli.d.ts"),
    "utf8",
  );
  const composerDeclaration = readFileSync(
    path.join(workspaceRoot, "src/composer.d.ts"),
    "utf8",
  );
  const configDeclaration = readFileSync(
    path.join(workspaceRoot, "src/config.d.ts"),
    "utf8",
  );
  const contextMemoryDeclaration = readFileSync(
    path.join(workspaceRoot, "src/context-memory.d.ts"),
    "utf8",
  );
  const sessionStorePathsDeclaration = readFileSync(
    path.join(workspaceRoot, "src/session-store-paths.d.ts"),
    "utf8",
  );
  const toolsDeclaration = readFileSync(
    path.join(workspaceRoot, "src/tools.d.ts"),
    "utf8",
  );
  const workAgentDeclaration = readFileSync(
    path.join(workspaceRoot, "src/work-agent.d.ts"),
    "utf8",
  );
  const workspaceGuidanceDeclaration = readFileSync(
    path.join(workspaceRoot, "src/workspace-guidance.d.ts"),
    "utf8",
  );
  const workspaceSkillsDeclaration = readFileSync(
    path.join(workspaceRoot, "src/workspace-skills.d.ts"),
    "utf8",
  );

  assert.match(
    cliDeclaration,
    /export\s+type\s*\{[^}]*StartReplOptions[^}]*\}\s*from\s*"\.\.\/apps\/unclecode-cli\/src\/work-runtime\.js"/s,
  );
  assert.match(cliDeclaration, /from\s+"@unclecode\/orchestrator"/);
  assert.match(cliDeclaration, /from\s+"@unclecode\/tui"/);
  assert.match(cliDeclaration, /from\s+"@unclecode\/context-broker"/);
  assert.match(cliDeclaration, /from\s+"@unclecode\/session-store"/);
  assert.doesNotMatch(cliDeclaration, /declare\s+function\s+startRepl/);
  assert.doesNotMatch(cliDeclaration, /type\s+StartReplOptions\s*=\s*\{/);

  assert.match(composerDeclaration, /from\s+"@unclecode\/tui"/);
  assert.doesNotMatch(composerDeclaration, /declare\s+function\s+Composer/);

  assert.match(configDeclaration, /from\s+"@unclecode\/orchestrator"/);
  assert.doesNotMatch(configDeclaration, /declare\s+function\s+loadConfig/);
  assert.doesNotMatch(configDeclaration, /from\s+"\.\/providers\.js"/);

  assert.match(contextMemoryDeclaration, /from\s+"@unclecode\/context-broker"/);
  assert.doesNotMatch(
    contextMemoryDeclaration,
    /declare\s+function\s+publishContextBridge/,
  );

  assert.match(
    sessionStorePathsDeclaration,
    /from\s+"@unclecode\/session-store"/,
  );
  assert.doesNotMatch(
    sessionStorePathsDeclaration,
    /declare\s+function\s+getSessionStoreRoot/,
  );

  assert.match(toolsDeclaration, /from\s+"@unclecode\/orchestrator"/);
  assert.doesNotMatch(toolsDeclaration, /declare\s+const\s+toolDefinitions/);

  assert.match(workAgentDeclaration, /from\s+"@unclecode\/orchestrator"/);
  assert.doesNotMatch(workAgentDeclaration, /declare\s+class\s+WorkAgent/);

  assert.match(
    workspaceGuidanceDeclaration,
    /from\s+"@unclecode\/context-broker"/,
  );
  assert.match(
    workspaceGuidanceDeclaration,
    /export\s+function\s+clearWorkspaceGuidanceCache/,
  );
  assert.match(
    workspaceGuidanceDeclaration,
    /export\s+function\s+loadWorkspaceGuidance/,
  );
  assert.doesNotMatch(workspaceGuidanceDeclaration, /sourceMappingURL/);

  assert.match(
    workspaceSkillsDeclaration,
    /from\s+"@unclecode\/context-broker"/,
  );
  assert.doesNotMatch(
    workspaceSkillsDeclaration,
    /declare\s+function\s+discoverSkillMetadata/,
  );
});

test("shouldLaunchDefaultWorkSession enables no-arg interactive startup", () => {
  assert.equal(
    shouldLaunchDefaultWorkSession({
      args: [],
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    true,
  );
  assert.equal(
    shouldLaunchDefaultWorkSession({
      args: [],
      stdinIsTTY: false,
      stdoutIsTTY: true,
    }),
    false,
  );
  assert.equal(
    shouldLaunchDefaultWorkSession({
      args: ["auth", "status"],
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    false,
  );
});
