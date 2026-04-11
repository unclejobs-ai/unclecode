import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");

function readWorkspaceFile(relativePath) {
  return readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

test("work-shell engine imports helper ownership seams instead of regrowing local orchestration helpers", () => {
  const engineSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine.ts",
  );

  assert.match(
    engineSource,
    /from "\.\/work-shell-engine-builtin-runtime\.js"/,
  );
  assert.match(
    engineSource,
    /from "\.\/work-shell-engine-command-runtime\.js"/,
  );
  assert.match(engineSource, /from "\.\/work-shell-engine-context\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-prompt-runtime\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-lifecycle\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-persistence\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-submit\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-trace\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-state\.js"/);

  assert.doesNotMatch(engineSource, /private async executePromptCommand\(/);
  assert.doesNotMatch(engineSource, /private async handleChatSubmit\(/);
  assert.doesNotMatch(engineSource, /private async executePromptTurn\(/);
  assert.doesNotMatch(engineSource, /private async handleTraceEvent\(/);
  assert.doesNotMatch(engineSource, /private async finalizeAssistantReply\(/);
  assert.doesNotMatch(
    engineSource,
    /function redactSensitiveInlineCommandArgs\(/,
  );
  assert.doesNotMatch(
    engineSource,
    /function redactSensitiveInlineCommandLine\(/,
  );
});

test("work-shell helper owner files expose the builtin, execution, operational, trace, persistence, and turn seams", () => {
  const builtinsSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-builtins.ts",
  );
  const builtinRuntimeSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-builtin-runtime.ts",
  );
  const contextSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-context.ts",
  );
  const executionSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-execution.ts",
  );
  const promptRuntimeSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-prompt-runtime.ts",
  );
  const lifecycleSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-lifecycle.ts",
  );
  const operationsSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-operations.ts",
  );
  const panelsSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-panels.ts",
  );
  const persistenceSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-persistence.ts",
  );
  const submitSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-submit.ts",
  );
  const turnsSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-turns.ts",
  );
  const traceSource = readWorkspaceFile(
    "packages/orchestrator/src/work-shell-engine-trace.ts",
  );

  assert.match(builtinsSource, /export function createHelpBuiltinResult/);
  assert.match(builtinsSource, /export function createContextBuiltinResult/);
  assert.match(builtinsSource, /export function createTraceModeBuiltinResult/);
  assert.match(builtinsSource, /export function resolveReasoningBuiltinResult/);
  assert.match(builtinsSource, /export function resolveModelBuiltinResult/);
  assert.match(
    builtinsSource,
    /export function createLoadedSkillBuiltinResult/,
  );
  assert.match(
    builtinRuntimeSource,
    /export async function executeWorkShellBuiltinSubmit/,
  );

  assert.match(
    contextSource,
    /export function applyAuthIssueLinesToContextSummaryLines/,
  );
  assert.match(
    contextSource,
    /export async function loadInitialWorkShellContextState/,
  );
  assert.match(
    contextSource,
    /export async function loadWorkShellContextState/,
  );
  assert.match(
    contextSource,
    /export async function reloadWorkShellContextState/,
  );

  assert.match(
    executionSource,
    /export async function runPromptTurnSuccessSequence/,
  );
  assert.match(
    executionSource,
    /export async function resolvePromptTurnFailureResult/,
  );
  assert.match(
    executionSource,
    /export async function executeWorkShellPromptTurn/,
  );
  assert.match(executionSource, /export function createPromptTurnStartPatch/);
  assert.match(executionSource, /export function createPromptTurnSuccessPatch/);
  assert.match(executionSource, /export function createPromptTurnFailurePatch/);
  assert.match(
    executionSource,
    /export function createPromptTurnFinalizePatch/,
  );

  assert.match(
    promptRuntimeSource,
    /export async function executeWorkShellChatSubmit/,
  );
  assert.match(
    promptRuntimeSource,
    /export async function executeWorkShellPromptCommandSubmit/,
  );

  assert.match(
    lifecycleSource,
    /export async function loadInitialWorkShellLifecycleState/,
  );
  assert.match(
    lifecycleSource,
    /export async function loadOpenSessionsPanelState/,
  );
  assert.match(
    lifecycleSource,
    /export function resolveSensitiveInputCancelState/,
  );
  assert.match(lifecycleSource, /export function resolveCloseOverlayState/);

  assert.match(panelsSource, /export function createCollapsedContextPanel/);
  assert.match(
    panelsSource,
    /export function createRecentSessionsLoadingPanel/,
  );
  assert.match(panelsSource, /export function createRecentSessionsPanel/);
  assert.match(panelsSource, /export async function loadRecentSessionsPanel/);
  assert.match(panelsSource, /export function createWorkspaceReloadEntries/);
  assert.match(
    panelsSource,
    /export function createWorkspaceReloadCompleteEntry/,
  );
  assert.match(panelsSource, /export function createWorkShellStatusPanel/);
  assert.match(
    panelsSource,
    /export function createSensitiveInputCancelResult/,
  );

  assert.match(
    operationsSource,
    /export async function resolveSecureApiKeyEntrySubmission/,
  );
  assert.match(
    operationsSource,
    /export async function loadWorkShellMemoriesPanel/,
  );
  assert.match(
    operationsSource,
    /export async function writeWorkShellRememberCommand/,
  );
  assert.match(
    operationsSource,
    /export async function resolveInlineOperationalCommandResult/,
  );

  assert.match(
    persistenceSource,
    /export function createWorkShellSessionSnapshotInput/,
  );
  assert.doesNotMatch(
    persistenceSource,
    /export async function loadWorkShellContextState/,
  );

  assert.match(submitSource, /export function resolveWorkShellSubmitRoute/);

  assert.match(
    turnsSource,
    /export async function finalizeWorkShellAssistantReply/,
  );
  assert.match(traceSource, /export function resolveBusyStatusFromTraceEvent/);
  assert.match(traceSource, /export function createTraceEventBusyPatch/);
  assert.match(traceSource, /export function resolveVerboseTraceEntry/);
  assert.match(traceSource, /export function applyWorkShellTraceEvent/);
  assert.match(traceSource, /export function applyWorkShellTraceEvent/);
});

test("work-agent exports agent-driven planning helpers", () => {
  const agentSource = readFileSync(
    path.join(workspaceRoot, "packages/orchestrator/src/work-agent.ts"),
    "utf8",
  );
  assert.match(agentSource, /export function parseAgentPlanResponse\(/);
  assert.match(agentSource, /export function resolveWorkerBudget\(/);
  assert.match(agentSource, /export class WorkAgent</);
});
