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
  const engineSource = readWorkspaceFile("packages/orchestrator/src/work-shell-engine.ts");

  assert.match(engineSource, /from "\.\/work-shell-engine-builtins\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-execution\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-operations\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-panels\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-persistence\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-trace\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-turns\.js"/);
  assert.match(engineSource, /from "\.\/work-shell-engine-state\.js"/);

  assert.doesNotMatch(engineSource, /private async finalizeAssistantReply\(/);
  assert.doesNotMatch(engineSource, /function redactSensitiveInlineCommandArgs\(/);
  assert.doesNotMatch(engineSource, /function redactSensitiveInlineCommandLine\(/);
});

test("work-shell helper owner files expose the builtin, execution, operational, trace, persistence, and turn seams", () => {
  const builtinsSource = readWorkspaceFile("packages/orchestrator/src/work-shell-engine-builtins.ts");
  const executionSource = readWorkspaceFile("packages/orchestrator/src/work-shell-engine-execution.ts");
  const operationsSource = readWorkspaceFile("packages/orchestrator/src/work-shell-engine-operations.ts");
  const panelsSource = readWorkspaceFile("packages/orchestrator/src/work-shell-engine-panels.ts");
  const persistenceSource = readWorkspaceFile("packages/orchestrator/src/work-shell-engine-persistence.ts");
  const turnsSource = readWorkspaceFile("packages/orchestrator/src/work-shell-engine-turns.ts");
  const traceSource = readWorkspaceFile("packages/orchestrator/src/work-shell-engine-trace.ts");

  assert.match(builtinsSource, /export function createHelpBuiltinResult/);
  assert.match(builtinsSource, /export function createContextBuiltinResult/);
  assert.match(builtinsSource, /export function createTraceModeBuiltinResult/);
  assert.match(builtinsSource, /export function resolveReasoningBuiltinResult/);
  assert.match(builtinsSource, /export function resolveModelBuiltinResult/);
  assert.match(builtinsSource, /export function createLoadedSkillBuiltinResult/);

  assert.match(executionSource, /export async function runPromptTurnSuccessSequence/);
  assert.match(executionSource, /export async function resolvePromptTurnFailureResult/);
  assert.match(executionSource, /export function createPromptTurnStartPatch/);
  assert.match(executionSource, /export function createPromptTurnSuccessPatch/);
  assert.match(executionSource, /export function createPromptTurnFailurePatch/);
  assert.match(executionSource, /export function createPromptTurnFinalizePatch/);

  assert.match(panelsSource, /export function createCollapsedContextPanel/);
  assert.match(panelsSource, /export function createRecentSessionsLoadingPanel/);
  assert.match(panelsSource, /export function createRecentSessionsPanel/);
  assert.match(panelsSource, /export function createWorkShellStatusPanel/);
  assert.match(panelsSource, /export function createSensitiveInputCancelResult/);

  assert.match(operationsSource, /export async function resolveSecureApiKeyEntrySubmission/);
  assert.match(operationsSource, /export async function loadWorkShellMemoriesPanel/);
  assert.match(operationsSource, /export async function writeWorkShellRememberCommand/);
  assert.match(operationsSource, /export async function resolveInlineOperationalCommandResult/);

  assert.match(persistenceSource, /export function createWorkShellSessionSnapshotInput/);
  assert.match(persistenceSource, /export async function loadWorkShellContextState/);

  assert.match(turnsSource, /export async function finalizeWorkShellAssistantReply/);
  assert.match(traceSource, /export function resolveBusyStatusFromTraceEvent/);
});
