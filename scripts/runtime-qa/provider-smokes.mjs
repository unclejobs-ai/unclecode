import assert from "node:assert/strict";
import path from "node:path";

import {
  anthropicToolCallFinalResponseText,
  anthropicToolCallId,
  anthropicToolCallPromptText,
  anthropicToolCallShellOutput,
  binEntrypoint,
  openAIToolCallFinalResponseText,
  openAIToolCallId,
  openAIToolCallPromptText,
  openAIToolCallShellOutput,
  responseText,
  toolCallFinalResponseText,
  toolCallId,
  toolCallPromptText,
  toolCallShellOutput,
} from "./constants.mjs";
import { anthropicProviderEnv, openAIProviderEnv, providerEnv, run } from "./cli-helpers.mjs";
import { extractRuntimeQaUserRequest } from "./fake-gemini-server.mjs";

export async function runPromptSmoke(port, observations) {
  const result = await run(process.execPath, [
    binEntrypoint,
    "work",
    "--engine",
    "pi",
    "--provider",
    "gemini",
    "--model",
    "gemini-2.5-flash",
    "Respond from the runtime QA prompt smoke.",
  ], providerEnv(port));

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(responseText));
  const request = observations.at(-1);
  assert.ok(request, "prompt smoke did not reach the local provider");
  assert.equal(request.hasConfig, false);
  assert.equal(request.hasModel, false);
  assert.match(request.text ?? "", /runtime QA prompt smoke/);
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    request,
  };
}

export async function runToolCallSmoke(port, observations) {
  const deniedEnv = isolatedRuntimeEnv(providerEnv(port), "gemini-policy-denied");
  delete deniedEnv.UNCLECODE_ALLOW_RUN_SHELL;
  const deniedBeforeRequests = observations.length;
  const denied = await run(process.execPath, [
    binEntrypoint,
    "work",
    "--engine",
    "pi",
    "--provider",
    "gemini",
    "--model",
    "gemini-2.5-flash",
    toolCallPromptText,
  ], deniedEnv);

  assert.equal(denied.code, 0, denied.stderr);
  assert.match(denied.stdout, /run_shell blocked by execution policy/);
  assert.doesNotMatch(denied.stdout, new RegExp(toolCallFinalResponseText));
  const deniedRequests = observations.slice(deniedBeforeRequests);
  assert.equal(deniedRequests.length, 2, `denied tool-call smoke should make two provider calls, got ${deniedRequests.length}`);
  assert.equal(deniedRequests[0]?.hasTools, true, "denied smoke should still expose the declared tool");
  assert.equal(deniedRequests[1]?.hasFunctionResponse, true, "denied smoke should return the policy refusal to the provider");
  assert.equal(deniedRequests[1]?.finalAnswerGatedByToolResult, false, "a denied shell call must not fabricate the harmless command output");

  const beforeRequests = observations.length;
  const result = await run(process.execPath, [
    binEntrypoint,
    "work",
    "--engine",
    "pi",
    "--provider",
    "gemini",
    "--model",
    "gemini-2.5-flash",
    toolCallPromptText,
  ], isolatedRuntimeEnv({
    ...providerEnv(port),
    UNCLECODE_ALLOW_RUN_SHELL: "1",
  }, "gemini-policy-approved"));

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(toolCallFinalResponseText));
  assert.doesNotMatch(result.stderr, /Unknown tool|tool call|panic|TypeError|ReferenceError/i);

  const requests = observations.slice(beforeRequests);
  assert.equal(requests.length, 2, `tool-call smoke should make two provider calls, got ${requests.length}`);
  assert.equal(requests[0]?.hasTools, true, "first tool-call request should expose local tools");
  assert.equal(extractRuntimeQaUserRequest(requests[0]?.text ?? ""), toolCallPromptText);
  assert.equal(
    requests[1]?.contentCount,
    3,
    "second tool-call request should include user, model tool call, and tool result turns",
  );
  assert.equal(requests[1]?.hasFunctionResponse, true, "second tool-call request should carry a functionResponse");
  assert.equal(requests[1]?.functionResponseName, "run_shell");
  assert.equal(requests[1]?.functionResponseNameMatched, true);
  assert.match(requests[1]?.functionResponseText ?? "", new RegExp(toolCallShellOutput));
  assert.equal(requests[1]?.finalAnswerGatedByToolResult, true);

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    requestDelta: requests.length,
    defaultPolicyBlockVerified: true,
    firstRequest: requests[0],
    secondRequest: requests[1],
    toolRoundTripVerified: true,
    finalAnswerGatedByToolResult: true,
  };
}

export async function runOpenAIToolCallSmoke(port, openAIObservations) {
  const beforeRequests = openAIObservations.length;
  const result = await run(process.execPath, [
    binEntrypoint,
    "work",
    "--engine",
    "pi",
    "--provider",
    "openai",
    "--model",
    "gpt-4.1-mini",
    openAIToolCallPromptText,
  ], isolatedRuntimeEnv({
    ...openAIProviderEnv(port),
    UNCLECODE_ALLOW_RUN_SHELL: "1",
  }, "openai-policy-approved"));

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(openAIToolCallFinalResponseText));
  assert.doesNotMatch(result.stderr, /Unknown tool|tool call|panic|TypeError|ReferenceError/i);

  const requests = openAIObservations.slice(beforeRequests);
  assert.equal(requests.length, 2, `OpenAI tool-call smoke should make two provider calls, got ${requests.length}`);
  assert.equal(requests[0]?.hasTools, true, "first OpenAI request should expose local tools");
  assert.equal(requests[0]?.lastMessageRole, "user");
  assert.match(requests[0]?.lastMessageContent ?? "", new RegExp(openAIToolCallPromptText));
  assert.equal(requests[1]?.lastMessageRole, "tool", "second OpenAI request should end with a tool result");
  assert.equal(requests[1]?.hasToolResult, true, "second OpenAI request should carry tool output");
  assert.equal(requests[1]?.toolCallId, openAIToolCallId);
  assert.equal(requests[1]?.toolCallIdMatched, true);
  assert.match(requests[1]?.lastMessageContent ?? "", new RegExp(openAIToolCallShellOutput));
  assert.equal(requests[1]?.finalAnswerGatedByToolResult, true);

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    requestDelta: requests.length,
    firstRequest: requests[0],
    secondRequest: requests[1],
    toolRoundTripVerified: true,
    finalAnswerGatedByToolResult: true,
  };
}

export async function runAnthropicToolCallSmoke(port, anthropicObservations) {
  const beforeRequests = anthropicObservations.length;
  const result = await run(process.execPath, [
    binEntrypoint,
    "work",
    "--engine",
    "pi",
    "--provider",
    "anthropic",
    "--model",
    "claude-sonnet-4-6",
    anthropicToolCallPromptText,
  ], isolatedRuntimeEnv({
    ...anthropicProviderEnv(port),
    UNCLECODE_ALLOW_RUN_SHELL: "1",
  }, "anthropic-policy-approved"));

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(anthropicToolCallFinalResponseText));
  assert.doesNotMatch(result.stderr, /Unknown tool|tool call|panic|TypeError|ReferenceError/i);

  const requests = anthropicObservations.slice(beforeRequests);
  assert.equal(requests.length, 2, `Anthropic tool-use smoke should make two provider calls, got ${requests.length}`);
  assert.equal(requests[0]?.hasTools, true, "first Anthropic request should expose local tools");
  assert.equal(requests[0]?.lastMessageRole, "user");
  assert.match(requests[0]?.lastMessageText ?? "", new RegExp(anthropicToolCallPromptText));
  assert.equal(requests[1]?.lastMessageRole, "user", "second Anthropic request should end with a user tool_result");
  assert.equal(requests[1]?.hasToolResult, true, "second Anthropic request should carry tool output");
  assert.equal(requests[1]?.toolUseId, anthropicToolCallId);
  assert.equal(requests[1]?.toolUseIdMatched, true);
  assert.match(requests[1]?.toolResultContent ?? "", new RegExp(anthropicToolCallShellOutput));
  assert.equal(requests[1]?.finalAnswerGatedByToolResult, true);

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    requestDelta: requests.length,
    firstRequest: requests[0],
    secondRequest: requests[1],
    toolRoundTripVerified: true,
    finalAnswerGatedByToolResult: true,
  };
}

function isolatedRuntimeEnv(env, label) {
  const root = process.env.UNCLECODE_RUNTIME_QA_HOME_ROOT ?? process.env.HOME;
  assert.ok(root, "runtime QA requires an isolated HOME root");
  const home = path.join(root, label);
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    UNCLECODE_SESSION_STORE_ROOT: path.join(home, ".unclecode", "state"),
  };
}
