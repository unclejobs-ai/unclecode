import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveFastCliPath } from "../../apps/unclecode-cli/src/fast-cli.ts";
import { createUncleCodeProgram } from "../../apps/unclecode-cli/src/program.ts";
import { launchSessionCenter } from "../../apps/unclecode-cli/src/session-center-launcher.ts";
import { shouldLaunchDefaultWorkSession } from "../../apps/unclecode-cli/src/startup-paths.ts";
import { launchWorkEntrypoint } from "../../apps/unclecode-cli/src/work-bootstrap.ts";

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
  const interactiveShellPath = path.join(
    workspaceRoot,
    "apps/unclecode-cli/src/interactive-shell.ts",
  );
  const sessionCenterBootstrapSource = readFileSync(
    path.join(
      workspaceRoot,
      "apps/unclecode-cli/src/session-center-bootstrap.ts",
    ),
    "utf8",
  );
  const sessionCenterLauncherSource = readFileSync(
    path.join(
      workspaceRoot,
      "apps/unclecode-cli/src/session-center-launcher.ts",
    ),
    "utf8",
  );
  const workBootstrapSource = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/work-bootstrap.ts"),
    "utf8",
  );
  const interactiveLaunchInputsSource = readFileSync(
    path.join(
      workspaceRoot,
      "apps/unclecode-cli/src/interactive-launch-inputs.ts",
    ),
    "utf8",
  );
  const startupPathsSource = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/startup-paths.ts"),
    "utf8",
  );
  const workRuntimeArgsSource = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/work-runtime-args.ts"),
    "utf8",
  );
  const workRuntimeSessionSource = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/work-runtime-session.ts"),
    "utf8",
  );
  const workRuntimeDashboardSource = readFileSync(
    path.join(
      workspaceRoot,
      "apps/unclecode-cli/src/work-runtime-dashboard.ts",
    ),
    "utf8",
  );
  const workRuntimeBootstrapSource = readFileSync(
    path.join(
      workspaceRoot,
      "apps/unclecode-cli/src/work-runtime-bootstrap.ts",
    ),
    "utf8",
  );
  const workRuntimeSource = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/work-runtime.ts"),
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
    /await\s*\(await import\("\.\/work-bootstrap\.js"\)\)\.launchWorkEntrypoint\(\[\]\)/,
  );
  assert.match(
    indexSource,
    /slashInput[\s\S]*await import\("\.\/command-router\.js"\)/,
  );
  assert.equal(existsSync(interactiveShellPath), false);
  assert.match(
    sessionCenterBootstrapSource,
    /await import\("@unclecode\/tui"\)/,
  );
  assert.match(
    workBootstrapSource,
    /import\s+type\s+\{[\s\S]*EmbeddedWorkDashboardSnapshot[\s\S]*EmbeddedWorkPaneRenderOptions[\s\S]*\}\s+from\s+"@unclecode\/tui"/,
  );
  assert.match(workRuntimeSource, /from\s+"\.\/work-runtime-args\.js"/);
  assert.match(workRuntimeSource, /from\s+"\.\/work-runtime-bootstrap\.js"/);
  assert.match(workRuntimeSource, /from\s+"\.\/work-runtime-dashboard\.js"/);
  assert.doesNotMatch(workRuntimeSource, /function\s+printHelp\(/);
  assert.doesNotMatch(workRuntimeSource, /function\s+deriveAuthIssueLines\(/);
  assert.doesNotMatch(
    workRuntimeSource,
    /async\s+function\s+loadResumedWorkSession\(/,
  );
  assert.doesNotMatch(
    workRuntimeSource,
    /function\s+createManagedDashboardInput\(/,
  );
  assert.doesNotMatch(
    workRuntimeSource,
    /async\s+function\s+loadWorkCliSession\(/,
  );
  assert.doesNotMatch(workRuntimeSource, /function\s+printTools\(/);
  assert.doesNotMatch(workRuntimeSource, /function\s+resolveRuntimeProvider\(/);
  assert.doesNotMatch(workRuntimeSource, /function\s+parseArgs\(/);
  assert.match(workRuntimeArgsSource, /export\s+type\s+ParsedArgs\s*=\s*\{/);
  assert.match(
    workRuntimeArgsSource,
    /export\s+function\s+printHelp\(\):\s*void/,
  );
  assert.match(
    workRuntimeArgsSource,
    /export\s+function\s+printTools\(\):\s*void/,
  );
  assert.match(
    workRuntimeArgsSource,
    /export\s+function\s+resolveRuntimeProvider\(/,
  );
  assert.match(
    workRuntimeArgsSource,
    /export\s+function\s+parseArgs\(argv:\s*string\[]\):\s*ParsedArgs/,
  );
  assert.match(
    workRuntimeSessionSource,
    /export\s+type\s+WorkRuntimeAuthIssueInput\s*=\s*\{/,
  );
  assert.match(
    workRuntimeSessionSource,
    /export\s+function\s+deriveAuthIssueLines\(input:\s*WorkRuntimeAuthIssueInput\):\s*readonly string\[]/,
  );
  assert.match(
    workRuntimeSessionSource,
    /export\s+async\s+function\s+loadResumedWorkSession\(/,
  );
  assert.match(
    workRuntimeDashboardSource,
    /export\s+type\s+StartReplOptions\s*=\s*\{/,
  );
  assert.match(
    workRuntimeDashboardSource,
    /export\s+type\s+StartReplAgent\s*=\s*\{/,
  );
  assert.match(
    workRuntimeDashboardSource,
    /export\s+type\s+ManagedDashboardSession\s*=\s*\{/,
  );
  assert.match(
    workRuntimeDashboardSource,
    /export\s+function\s+createManagedDashboardInput\(/,
  );
  assert.match(
    workRuntimeBootstrapSource,
    /export\s+type\s+WorkCliBootstrapInput\s*=\s*\{/,
  );
  assert.match(
    workRuntimeBootstrapSource,
    /export\s+type\s+WorkCliBootstrapResult\s*=\s*\{/,
  );
  assert.match(
    workRuntimeBootstrapSource,
    /export\s+async\s+function\s+loadWorkCliBootstrap\(/,
  );
  assert.doesNotMatch(programSource, /from\s+"\.\/interactive-shell\.js"/);
  assert.match(
    programSource,
    /import\s+\{\s*buildWorkCommandArgs,\s*launchWorkEntrypoint,\s*withWorkCwd\s*\}\s+from\s+"\.\/work-bootstrap\.js"/,
  );
  assert.match(programSource, /from\s+"\.\/session-center-launcher\.js"/);
  assert.match(programSource, /type\s+BrowserOAuthCallbackInput\s*=\s*\{/);
  assert.match(
    programSource,
    /type\s+ResolvedOpenAIAuthStatus\s*=\s*Awaited<\s*ReturnType<typeof\s+resolveOpenAIAuthStatus>\s*>/,
  );
  assert.match(
    programSource,
    /waitForBrowserOAuthCallback\(input:\s*BrowserOAuthCallbackInput\)/,
  );
  assert.match(
    programSource,
    /formatLogoutResult\(status:\s*ResolvedOpenAIAuthStatus\)/,
  );
  assert.match(programSource, /type\s+WorkCommandOptions\s*=\s*\{/);
  assert.match(programSource, /type\s+ConfigExplainCommandOptions\s*=\s*\{/);
  assert.match(programSource, /type\s+ConfigExplainCliFlags\s*=\s*\{/);
  assert.match(programSource, /type\s+AuthLoginCommandOptions\s*=\s*\{/);
  assert.match(programSource, /type\s+DoctorCommandOptions\s*=\s*\{/);
  assert.match(programSource, /type\s+ResumeCommandOptions\s*=\s*\{/);
  assert.match(programSource, /type\s+ResearchRunCommandOptions\s*=\s*\{/);
  assert.match(programSource, /type\s+AuthLoginRuntimeContext\s*=\s*\{/);
  assert.match(programSource, /type\s+ApiKeyStdinLoginInput\s*=\s*\{/);
  assert.match(programSource, /type\s+DeviceAuthLoginInput\s*=\s*\{/);
  assert.match(programSource, /type\s+BrowserAuthLoginInput\s*=\s*\{/);
  assert.match(
    programSource,
    /function\s+resolveOpenAICredentialsPath\(\):\s*string/,
  );
  assert.match(
    programSource,
    /async\s+function\s+resolveAuthLoginRuntimeContext\(\s*options:\s*AuthLoginCommandOptions\s*\):\s*Promise<AuthLoginRuntimeContext>/,
  );
  assert.match(
    programSource,
    /type\s+AuthLoginMethod\s*=\s*"api-key-stdin"\s*\|\s*"device"\s*\|\s*"browser"\s*\|\s*"saved-auth"/,
  );
  assert.match(programSource, /type\s+AuthLoginMethodSelection\s*=\s*\{/);
  assert.match(
    programSource,
    /async\s+function\s+handleApiKeyStdinLogin\(\s*input:\s*ApiKeyStdinLoginInput\s*\):\s*Promise<boolean>/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleSavedAuthLogin\(\):\s*Promise<boolean>/,
  );
  assert.match(
    programSource,
    /function\s+selectAuthLoginMethod\(\s*options:\s*AuthLoginCommandOptions,\s*runtimeContext:\s*AuthLoginRuntimeContext\s*\):\s*AuthLoginMethodSelection/,
  );
  assert.match(
    programSource,
    /async\s+function\s+runDeviceAuthLogin\(\s*input:\s*DeviceAuthLoginInput\s*\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /async\s+function\s+runBrowserAuthLogin\(\s*input:\s*BrowserAuthLoginInput\s*\):\s*Promise<void>/,
  );
  assert.doesNotMatch(programSource, /function\s+buildWorkCommandArgs\(/);
  assert.match(
    workBootstrapSource,
    /export\s+function\s+buildWorkCommandArgs\(/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleRootCommand\(program:\s*Command\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleTuiCommand\(options:\s*WorkCommandOptions\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleCenterCommand\(\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleWorkCommand\(promptParts:\s*string\[],\s*options:\s*WorkCommandOptions\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /function\s+registerRootCommands\(program:\s*Command\):\s*void/,
  );
  assert.match(
    programSource,
    /function\s+registerWorkCommands\(program:\s*Command\):\s*void/,
  );
  assert.match(
    programSource,
    /function\s+registerConfigCommands\(program:\s*Command\):\s*void/,
  );
  assert.match(
    programSource,
    /function\s+registerAuthCommands\(program:\s*Command\):\s*void/,
  );
  assert.match(
    programSource,
    /function\s+registerModeCommands\(program:\s*Command\):\s*void/,
  );
  assert.match(
    programSource,
    /function\s+registerResearchCommands\(program:\s*Command\):\s*void/,
  );
  assert.match(
    programSource,
    /function\s+registerMcpCommands\(program:\s*Command\):\s*void/,
  );
  assert.match(
    programSource,
    /createUncleCodeProgram\([\s\S]*registerRootCommands\(program\)/,
  );
  assert.match(
    programSource,
    /createUncleCodeProgram\([\s\S]*registerWorkCommands\(program\)/,
  );
  assert.match(
    programSource,
    /createUncleCodeProgram\([\s\S]*registerConfigCommands\(program\)/,
  );
  assert.match(
    programSource,
    /createUncleCodeProgram\([\s\S]*registerAuthCommands\(program\)/,
  );
  assert.match(
    programSource,
    /createUncleCodeProgram\([\s\S]*registerModeCommands\(program\)/,
  );
  assert.match(
    programSource,
    /createUncleCodeProgram\([\s\S]*registerResearchCommands\(program\)/,
  );
  assert.match(
    programSource,
    /createUncleCodeProgram\([\s\S]*registerMcpCommands\(program\)/,
  );
  assert.match(
    programSource,
    /program\.action\(async \(\) => \{[\s\S]*await\s+handleRootCommand\(program\)/,
  );
  assert.match(
    programSource,
    /\.command\("tui"\)[\s\S]*\.action\(async \(_promptParts: string\[], options: WorkCommandOptions\) => \{[\s\S]*await\s+handleTuiCommand\(options\)/,
  );
  assert.match(
    programSource,
    /\.command\("center"\)[\s\S]*\.action\(async \(\) => \{[\s\S]*await\s+handleCenterCommand\(\)/,
  );
  assert.match(
    programSource,
    /\.action\(async \(promptParts: string\[], options: WorkCommandOptions, _command\) => \{[\s\S]*await\s+handleWorkCommand\(promptParts, options\)/,
  );
  assert.match(
    programSource,
    /\.action\(\(options: ConfigExplainCommandOptions\)[\s\S]*handleConfigExplainCommand\(options\)/,
  );
  assert.match(
    programSource,
    /const\s+cliFlags:\s*ConfigExplainCliFlags\s*=\s*\{/,
  );
  assert.match(
    programSource,
    /\.action\(async \(options: AuthLoginCommandOptions\)[\s\S]*const\s+credentialsPath\s*=\s*resolveOpenAICredentialsPath\(\)/,
  );
  assert.match(
    programSource,
    /\.action\(async \(options: AuthLoginCommandOptions\)[\s\S]*await\s+handleApiKeyStdinLogin\(/,
  );
  assert.match(
    programSource,
    /\.action\(async \(options: AuthLoginCommandOptions\)[\s\S]*const\s+runtimeContext\s*=\s*await\s+resolveAuthLoginRuntimeContext\(options\)/,
  );
  assert.match(
    programSource,
    /\.action\(async \(options: AuthLoginCommandOptions\)[\s\S]*if\s*\(await\s+handleSavedAuthLogin\(\)\)\s*\{/,
  );
  assert.match(
    programSource,
    /\.action\(async \(options: AuthLoginCommandOptions\)[\s\S]*const\s+methodSelection\s*=\s*selectAuthLoginMethod\(options, runtimeContext\)/,
  );
  assert.match(
    programSource,
    /\.action\(async \(options: AuthLoginCommandOptions\)[\s\S]*if\s*\(methodSelection\.method === "device"\)\s*\{/,
  );
  assert.match(
    programSource,
    /\.action\(async \(options: AuthLoginCommandOptions\)[\s\S]*await\s+runDeviceAuthLogin\(/,
  );
  assert.match(
    programSource,
    /\.action\(async \(options: AuthLoginCommandOptions\)[\s\S]*await\s+runBrowserAuthLogin\(/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleDoctorCommand\(options:\s*DoctorCommandOptions\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleResumeCommand\(sessionId:\s*string,\s*options:\s*ResumeCommandOptions\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleResearchStatusCommand\(\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleResearchRunCommand\(promptParts:\s*string\[],\s*options:\s*ResearchRunCommandOptions\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /function\s+handleConfigExplainCommand\(options:\s*ConfigExplainCommandOptions\):\s*void/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleAuthStatusCommand\(\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleAuthLogoutCommand\(\):\s*Promise<void>/,
  );
  assert.match(programSource, /function\s+handleModeStatusCommand\(\):\s*void/);
  assert.match(
    programSource,
    /async\s+function\s+handleModeSetCommand\(mode:\s*string\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleSetupCommand\(\):\s*Promise<void>/,
  );
  assert.match(
    programSource,
    /async\s+function\s+handleSessionsCommand\(\):\s*Promise<void>/,
  );
  assert.match(programSource, /function\s+handleMcpListCommand\(\):\s*void/);
  assert.match(
    programSource,
    /auth[\s\S]*\.command\("status"\)[\s\S]*\.action\(async \(\) => \{[\s\S]*await\s+handleAuthStatusCommand\(\)/,
  );
  assert.match(
    programSource,
    /auth[\s\S]*\.command\("logout"\)[\s\S]*\.action\(async \(\) => \{[\s\S]*await\s+handleAuthLogoutCommand\(\)/,
  );
  assert.match(
    programSource,
    /mode[\s\S]*\.command\("status"\)[\s\S]*\.action\(\(\) => \{[\s\S]*handleModeStatusCommand\(\)/,
  );
  assert.match(
    programSource,
    /mode[\s\S]*\.command\("set <mode>"\)[\s\S]*\.action\(async \(mode: string\) => \{[\s\S]*await\s+handleModeSetCommand\(mode\)/,
  );
  assert.match(
    programSource,
    /setup[\s\S]*\.action\(async \(\) => \{[\s\S]*await\s+handleSetupCommand\(\)/,
  );
  assert.match(
    programSource,
    /sessions[\s\S]*\.action\(async \(\) => \{[\s\S]*await\s+handleSessionsCommand\(\)/,
  );
  assert.match(
    programSource,
    /mcp[\s\S]*\.command\("list"\)[\s\S]*\.action\(\(\) => \{[\s\S]*handleMcpListCommand\(\)/,
  );
  assert.match(
    programSource,
    /\.action\(async \(options: DoctorCommandOptions\)[\s\S]*await\s+handleDoctorCommand\(options\)/,
  );
  assert.match(
    programSource,
    /\.action\(async \(sessionId: string, options: ResumeCommandOptions\)[\s\S]*await\s+handleResumeCommand\(sessionId, options\)/,
  );
  assert.match(
    programSource,
    /research[\s\S]*\.command\("status"\)[\s\S]*\.action\(async \(\) => \{[\s\S]*await\s+handleResearchStatusCommand\(\)/,
  );
  assert.match(
    programSource,
    /\.action\(async \(promptParts: string\[], options: ResearchRunCommandOptions\)[\s\S]*await\s+handleResearchRunCommand\(promptParts, options\)/,
  );
  assert.doesNotMatch(
    programSource,
    /export\s*\{\s*launchWorkEntrypoint,\s*shouldLaunchDefaultWorkSession,\s*withWorkCwd\s*\}/,
  );
  assert.match(
    sessionCenterLauncherSource,
    /import\s+\{\s*createSessionCenterDashboardRenderOptions\s*\}\s+from\s+"@unclecode\/tui"/,
  );
  assert.match(
    workBootstrapSource,
    /import\s+\{\s*createEmbeddedWorkPaneController\s*\}\s+from\s+"@unclecode\/tui"/,
  );
  assert.match(workBootstrapSource, /function\s+withWorkCwd\(/);
  assert.match(
    workBootstrapSource,
    /async\s+function\s+loadWorkEntrypointModule\(/,
  );
  assert.match(workBootstrapSource, /function\s+resolveWorkModuleLoader\(/);
  assert.match(
    workBootstrapSource,
    /async\s+function\s+loadEmbeddedWorkPane\(input:\s*EmbeddedWorkPaneLoadInput<WorkModule>\)/,
  );
  assert.match(
    sessionCenterLauncherSource,
    /export\s+async\s+function\s+launchSessionCenter\(/,
  );
  assert.match(
    sessionCenterLauncherSource,
    /const\s+\{\s*workspaceRoot,\s*env,\s*userHomeDir\s*\}\s*=\s*createSessionCenterEnvironment\(input\)/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /createEmbeddedWorkPaneLoadInput<\s*WorkModule\s*>\(input:\s*EmbeddedWorkPaneLoadInput<WorkModule>\)/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /createSessionCenterEnvironment\(input:\s*SessionCenterEnvironmentInput\):\s*SessionCenterEnvironment/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /resolveSessionCenterDependencies\([\s\S]*\):\s*Promise<SessionCenterResolvedDependencies>/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /createSessionCenterHomeStateLoader\(input:\s*SessionCenterHomeStateLoaderInput\)/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /createSessionCenterRuntimeCallbackInput\(input:\s*SessionCenterRuntimeCallbackInput\)/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /createSessionCenterRuntimeCallbacks\(input:\s*SessionCenterRuntimeCallbackInput\)/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /createSessionCenterRenderInput\(input:\s*SessionCenterRenderInput\):\s*SessionCenterDashboardRenderInput/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /loadSessionCenterRenderInput\(input:\s*SessionCenterRenderLoadInput\):\s*Promise<SessionCenterDashboardRenderInput>/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /const\s+createHomeState\s*=\s*createSessionCenterHomeStateLoader\(/,
  );
  assert.match(
    sessionCenterLauncherSource,
    /const\s+renderInput\s*=\s*await\s+loadSessionCenterRenderInput\(/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /async\s+function\s+resolveSessionCenterDependencies\(/,
  );
  assert.match(
    sessionCenterLauncherSource,
    /const\s+\{\s*buildHomeState,\s*renderShell,\s*runAction,\s*runSession\s*\}\s*=\s*await\s+resolveSessionCenterDependencies\(/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /function\s+createWorkLaunchInput\(/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /function\s+createSessionCenterLaunchInput\(/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /function\s+createSessionCenterRuntimeCallbacks\(/,
  );
  assert.match(
    sessionCenterLauncherSource,
    /const\s+renderInput\s*=\s*await\s+loadSessionCenterRenderInput\(/,
  );
  assert.match(
    sessionCenterLauncherSource,
    /await\s+renderShell\([\s\S]*createSessionCenterDashboardRenderOptions(?:<[\s\S]*?>)?\(\s*renderInput\s*\)[\s\S]*\)/,
  );
  assert.match(sessionCenterBootstrapSource, /import\("\.\/operational\.js"\)/);
  assert.match(
    sessionCenterBootstrapSource,
    /resolveSessionCenterDependencies[\s\S]*const\s+operational\s*=\s*deps\?\.buildHomeState/,
  );
  assert.match(
    workBootstrapSource,
    /launchWorkEntrypoint[\s\S]*const\s+loadModule\s*=\s*resolveWorkModuleLoader\(input\?\.loadModule\)/,
  );
  assert.match(
    workBootstrapSource,
    /loadEmbeddedWorkPane[\s\S]*const\s+loadModule\s*=\s*resolveWorkModuleLoader\(input\.loadWorkModule\)/,
  );
  assert.match(
    sessionCenterLauncherSource,
    /launchWorkSession:\s*\(forwardedArgs\s*=\s*\[\]\)\s*=>[\s\S]*launchWorkEntrypoint\(forwardedArgs/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /type\s+SharedBootstrapDependencies\s*=\s*SessionCenterBootstrapDependencies\s*&/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /export\s+type\s+SessionCenterEnvironmentInput\s*=\s*\{/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /export\s+type\s+SessionCenterEnvironment\s*=\s*\{/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /type\s+SessionCenterResolvedDependencies\s*=\s*\{/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /export\s+type\s+EmbeddedWorkPaneLoadInput<WorkModule>\s*=\s*\{/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /type\s+SessionCenterHomeStateLoaderInput\s*=\s*\{/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /type\s+SessionCenterRuntimeCallbackInput\s*=\s*\{/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /type\s+SessionCenterRenderInput\s*=\s*\{/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /type\s+SessionCenterDashboardRenderInput\s*=\s*\{/,
  );
  assert.match(
    sessionCenterBootstrapSource,
    /export\s+type\s+SessionCenterRenderLoadInput\s*=\s*\{/,
  );
  assert.match(workBootstrapSource, /export\s+type\s+WorkLaunchInput\s*=\s*\{/);
  assert.match(
    workBootstrapSource,
    /import\s+type\s+\{[\s\S]*EmbeddedWorkPaneLoadInput[\s\S]*TuiHomeState[\s\S]*\}\s+from\s+"\.\/session-center-bootstrap\.js"/,
  );
  assert.match(
    startupPathsSource,
    /export\s+type\s+DefaultWorkSessionStartupInput\s*=\s*\{/,
  );
  assert.match(
    startupPathsSource,
    /shouldLaunchDefaultWorkSession\(input:\s*DefaultWorkSessionStartupInput\)/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /import\s+type\s+\{[\s\S]*SessionCenterEnvironmentInput[\s\S]*SessionCenterBootstrapDependencies[\s\S]*\}\s+from\s+"\.\/session-center-bootstrap\.js"/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /import\s+type\s+\{[\s\S]*WorkLaunchInput[\s\S]*WorkModule[\s\S]*\}\s+from\s+"\.\/work-bootstrap\.js"/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /type\s+SessionCenterLaunchInput\s*=\s*SessionCenterEnvironmentInput\s*&\s*\{/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /export\s+type\s+WorkInteractiveSurfaceInput\s*=\s*\{/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /export\s+type\s+CenterInteractiveSurfaceInput\s*=\s*\{\s*readonly\s+kind:\s*"center"\s*\}\s*&\s*SessionCenterLaunchInput/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /export\s+type\s+InteractiveSurfaceInput\s*=\s*WorkInteractiveSurfaceInput\s*\|\s*CenterInteractiveSurfaceInput/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /createWorkLaunchInput\(\s*input:\s*WorkInteractiveSurfaceInput/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /createSessionCenterLaunchInput\(\s*input:\s*CenterInteractiveSurfaceInput/,
  );
  assert.doesNotMatch(
    interactiveLaunchInputsSource,
    /Extract<InteractiveSurfaceInput,\s*\{\s*kind:\s*"(?:work|center)"\s*\}>/,
  );
  assert.match(
    interactiveLaunchInputsSource,
    /createWorkLaunchInput[\s\S]*\):\s*WorkLaunchInput\s*\{/,
  );
  assert.doesNotMatch(
    workBootstrapSource,
    /launchWorkEntrypoint[\s\S]*\(input\?\.loadModule\s*\?\?\s*\(\)\s*=>\s*loadWorkEntrypointModule\(\)\)\(\)/,
  );
  assert.doesNotMatch(
    workBootstrapSource,
    /loadEmbeddedWorkPane[\s\S]*\(loadWorkModule\s*\?\?\s*\(\)\s*=>\s*loadWorkEntrypointModule\(\)\)\(\)/,
  );
  assert.equal(existsSync(interactiveShellPath), false);
  assert.match(
    workBootstrapSource,
    /dist-work[\s\S]*apps[\s\S]*unclecode-cli[\s\S]*src[\s\S]*work-entry\.js/,
  );
  assert.doesNotMatch(
    workBootstrapSource,
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

test("launchSessionCenter opens work view immediately for embedded work-session resumes", async () => {
  let receivedRenderWorkPane = undefined;
  let receivedOpenEmbeddedWorkSession = undefined;
  let receivedInitialView = undefined;
  let receivedAuthLabel = undefined;
  let receivedSessionCount = undefined;
  let receivedSessions = undefined;
  let receivedContextLines = undefined;
  let receivedUpdatedContextLines = undefined;
  let receivedUpdatedHomeState = undefined;
  let receivedUpdatedSelectedSessionId = undefined;
  const embeddedArgsCalls = [];

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
        receivedOpenEmbeddedWorkSession = options.openEmbeddedWorkSession;
        receivedInitialView = options.initialView;
        receivedAuthLabel = options.authLabel;
        receivedSessionCount = options.sessionCount;
        receivedSessions = options.sessions;
        receivedContextLines = options.contextLines;
        const embeddedUpdate = await options.openEmbeddedWorkSession?.([
          "--session-id",
          "work-session-10",
        ]);
        receivedUpdatedContextLines = embeddedUpdate?.contextLines;
        receivedUpdatedHomeState = embeddedUpdate?.homeState;
        receivedUpdatedSelectedSessionId = embeddedUpdate?.selectedSessionId;
      },
      loadWorkModule: async () => ({
        loadWorkShellDashboardProps: async (args) => {
          embeddedArgsCalls.push([...args]);
          return {
            workspaceRoot: "/tmp/project-c",
            initialView: "work",
            authLabel: args.includes("work-session-10")
              ? "api-key-file"
              : "oauth-file",
            sessionCount: 2,
            sessions: args.includes("work-session-10")
              ? [
                  {
                    sessionId: "work-session-10",
                    state: "idle",
                    updatedAt: "2026-04-05T12:05:00.000Z",
                    model: "gpt-5.4",
                    taskSummary: "Resume newer work",
                  },
                  {
                    sessionId: "work-session-9",
                    state: "idle",
                    updatedAt: "2026-04-05T12:00:00.000Z",
                    model: "gpt-5.4",
                    taskSummary: "Resume work",
                  },
                ]
              : [
                  {
                    sessionId: "work-session-9",
                    state: "idle",
                    updatedAt: "2026-04-05T12:00:00.000Z",
                    model: "gpt-5.4",
                    taskSummary: "Resume work",
                  },
                  {
                    sessionId: "work-session-8",
                    state: "idle",
                    updatedAt: "2026-04-05T11:50:00.000Z",
                    model: "gpt-5.4-mini",
                    taskSummary: "Older work",
                  },
                ],
            contextLines: args.includes("work-session-10")
              ? ["Resumed session: work-session-10"]
              : ["Loaded guidance: AGENTS.md"],
            renderWorkPane: () => null,
          };
        },
      }),
    },
  );

  assert.equal(typeof receivedRenderWorkPane, "function");
  assert.equal(typeof receivedOpenEmbeddedWorkSession, "function");
  assert.equal(receivedInitialView, "work");
  assert.equal(receivedAuthLabel, "oauth-file");
  assert.equal(receivedSessionCount, 2);
  assert.deepEqual(receivedSessions, [
    {
      sessionId: "work-session-9",
      state: "idle",
      updatedAt: "2026-04-05T12:00:00.000Z",
      model: "gpt-5.4",
      taskSummary: "Resume work",
    },
    {
      sessionId: "work-session-8",
      state: "idle",
      updatedAt: "2026-04-05T11:50:00.000Z",
      model: "gpt-5.4-mini",
      taskSummary: "Older work",
    },
  ]);
  assert.deepEqual(receivedContextLines, ["Loaded guidance: AGENTS.md"]);
  assert.deepEqual(receivedUpdatedContextLines, [
    "Resumed session: work-session-10",
  ]);
  assert.equal(receivedUpdatedSelectedSessionId, "work-session-10");
  assert.deepEqual(receivedUpdatedHomeState, {
    authLabel: "api-key-file",
    sessionCount: 2,
    sessions: [
      {
        sessionId: "work-session-10",
        state: "idle",
        updatedAt: "2026-04-05T12:05:00.000Z",
        model: "gpt-5.4",
        taskSummary: "Resume newer work",
      },
      {
        sessionId: "work-session-9",
        state: "idle",
        updatedAt: "2026-04-05T12:00:00.000Z",
        model: "gpt-5.4",
        taskSummary: "Resume work",
      },
    ],
  });
  assert.deepEqual(embeddedArgsCalls, [
    ["--cwd", "/tmp/project-c", "--session-id", "work-session-9"],
    ["--cwd", "/tmp/project-c", "--session-id", "work-session-10"],
  ]);
});

test("obsolete root cli compatibility surfaces are removed after app/package seams take over", () => {
  assert.equal(existsSync(path.join(workspaceRoot, "src/cli.tsx")), false);
  assert.equal(existsSync(path.join(workspaceRoot, "src/cli.d.ts")), false);

  const runtimeSource = readFileSync(
    path.join(workspaceRoot, "apps/unclecode-cli/src/work-runtime.ts"),
    "utf8",
  );
  assert.equal(existsSync(path.join(workspaceRoot, "src/composer.tsx")), false);
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/session-store-paths.ts")),
    false,
  );
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/context-memory.ts")),
    false,
  );
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/workspace-skills.ts")),
    false,
  );

  assert.match(
    runtimeSource,
    /export function createWorkShellDashboardProps\(/,
  );
  assert.match(runtimeSource, /export async function startRepl\(/);
  assert.match(
    runtimeSource,
    /export\s+const\s+resolveWorkShellInlineCommand\s*=|export\s+async\s+function\s+resolveWorkShellInlineCommand\(/,
  );
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
    /import\s*\{[^}]*runWorkShellInlineCommand[^}]*\}\s*from\s*"@unclecode\/orchestrator"/s,
  );
  assert.match(
    source,
    /import\s*\{[^}]*loadWorkCliBootstrap[^}]*\}\s*from\s*"\.\/work-runtime-bootstrap\.js"/s,
  );
  assert.match(
    source,
    /import\s*\{[^}]*createManagedDashboardInput[^}]*StartReplAgent[^}]*StartReplOptions[^}]*\}\s*from\s*"\.\/work-runtime-dashboard\.js"/s,
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

test("obsolete root utility compatibility surfaces are removed", () => {
  for (const relativePath of [
    "src/composer.tsx",
    "src/composer.d.ts",
    "src/config.ts",
    "src/config.d.ts",
    "src/context-memory.ts",
    "src/context-memory.d.ts",
    "src/session-store-paths.ts",
    "src/session-store-paths.d.ts",
    "src/tools.ts",
    "src/tools.d.ts",
    "src/work-agent.ts",
    "src/work-agent.d.ts",
    "src/workspace-skills.ts",
    "src/workspace-skills.d.ts",
    "src/workspace-guidance.ts",
    "src/workspace-guidance.d.ts",
  ]) {
    assert.equal(
      existsSync(path.join(workspaceRoot, relativePath)),
      false,
      relativePath,
    );
  }
});

test("remaining root src residue is either removed or relocated out of the runtime root", () => {
  const readmeSource = readFileSync(
    path.join(workspaceRoot, "README.md"),
    "utf8",
  );

  assert.equal(existsSync(path.join(workspaceRoot, "src")), false);
  assert.equal(existsSync(path.join(workspaceRoot, "src/types.ts")), false);
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/anthropicCompatProxy.ts")),
    false,
  );
  assert.equal(
    existsSync(path.join(workspaceRoot, "scripts/anthropic-compat-proxy.ts")),
    true,
  );
  assert.match(readmeSource, /scripts\/anthropic-compat-proxy\.ts/);
  assert.doesNotMatch(readmeSource, /src\/anthropicCompatProxy\.ts/);
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
  assert.equal(existsSync(path.join(workspaceRoot, "src/cli.d.ts")), false);
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/composer.d.ts")),
    false,
  );
  assert.equal(existsSync(path.join(workspaceRoot, "src/config.d.ts")), false);
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/context-memory.d.ts")),
    false,
  );
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/session-store-paths.d.ts")),
    false,
  );
  assert.equal(existsSync(path.join(workspaceRoot, "src/tools.d.ts")), false);
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/work-agent.d.ts")),
    false,
  );
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/workspace-skills.d.ts")),
    false,
  );
  assert.equal(
    existsSync(path.join(workspaceRoot, "src/workspace-guidance.d.ts")),
    false,
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
