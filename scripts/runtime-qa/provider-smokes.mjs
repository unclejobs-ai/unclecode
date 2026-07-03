import assert from "node:assert/strict";

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
  const beforeRequests = observations.length;
  const result = await run(process.execPath, [
    binEntrypoint,
    "work",
    "--provider",
    "gemini",
    "--model",
    "gemini-2.5-flash",
    toolCallPromptText,
  ], {
    ...providerEnv(port),
    UNCLECODE_ALLOW_RUN_SHELL: "1",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(toolCallFinalResponseText));
  assert.doesNotMatch(result.stderr, /Unknown tool|tool call|panic|TypeError|ReferenceError/i);

  const requests = observations.slice(beforeRequests);
  assert.equal(requests.length, 2, `tool-call smoke should make two provider calls, got ${requests.length}`);
  assert.equal(requests[0]?.hasTools, true, "first tool-call request should expose local tools");
  assert.equal(requests[0]?.hasToolConfig, true, "first tool-call request should enable Gemini AUTO tool mode");
  assert.equal(extractRuntimeQaUserRequest(requests[0]?.text ?? ""), toolCallPromptText);
  assert.equal(
    requests[1]?.contentCount,
    3,
    "second tool-call request should include user, model tool call, and tool result turns",
  );
  assert.equal(requests[1]?.hasFunctionResponse, true, "second tool-call request should carry a functionResponse");
  assert.equal(requests[1]?.functionResponseId, toolCallId);
  assert.equal(requests[1]?.functionResponseIdMatched, true);
  assert.equal(requests[1]?.functionResponseName, "run_shell");
  assert.equal(requests[1]?.functionResponseNameMatched, true);
  assert.match(requests[1]?.functionResponseText ?? "", new RegExp(toolCallShellOutput));
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

export async function runOpenAIToolCallSmoke(port, openAIObservations) {
  const beforeRequests = openAIObservations.length;
  const result = await run(process.execPath, [
    binEntrypoint,
    "work",
    "--provider",
    "openai",
    "--model",
    "gpt-4.1-mini",
    openAIToolCallPromptText,
  ], {
    ...openAIProviderEnv(port),
    UNCLECODE_ALLOW_RUN_SHELL: "1",
  });

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
    "--provider",
    "anthropic",
    "--model",
    "claude-sonnet-4-6",
    anthropicToolCallPromptText,
  ], {
    ...anthropicProviderEnv(port),
    UNCLECODE_ALLOW_RUN_SHELL: "1",
  });

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
