import path from "node:path";

export const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
export const binEntrypoint = path.join(repoRoot, "bin", "unclecode.cjs");
export const reportPath = path.join(repoRoot, ".unclecode", "qa", "runtime-qa-latest.json");
export const tmpPrefix = "unclecode-runtime-qa-";

export const responseText = "UNCLECODE_RUNTIME_QA_OK";
export const scrollbackResponseText = (prompt) => `${responseText} · ${prompt}`;
export const ttyResponseText = "UNCLECODE_TTY_QA_OK";
export const fullTuiResponseText = "UNCLECODE_FULL_TUI_QA_OK";
export const yoloGreetingResponseText = "UNCLECODE_YOLO_GREETING_QA_OK";
export const koreanBusyPromptText = "한글 스피너 QA";
export const koreanBusyResponseText = "하이요! 편하게 말씀 주세요.";
// Keep this above Composer's large single-chunk threshold. tmux sends the
// complete prompt followed immediately by CR, matching terminal paste/input
// bursts that must submit on the first Enter.
export const realUseFirstPromptText = `실사용 긴 프롬프트 즉시 제출 검증: ${"가".repeat(48)}`;
export const realUseFirstResponseText = "REAL_USE_FIRST_OK";
export const realUseQueuedPromptText = "큐 후속 질문";
export const realUseQueuedResponseText = "REAL_USE_QUEUE_OK";
export const toolCallPromptText = "Run the local tool-call smoke.";
export const toolCallId = "fc_runtime_tool_1";
export const toolCallShellOutput = "TOOL_CALL_SMOKE_OK";
export const toolCallFinalResponseText = "TOOL_CALL_FINAL_OK";
export const openAIToolCallPromptText = "Run the OpenAI local tool-call smoke.";
export const openAIToolCallId = "call_runtime_openai_1";
export const openAIToolCallShellOutput = "OPENAI_TOOL_CALL_SMOKE_OK";
export const openAIToolCallFinalResponseText = "OPENAI_TOOL_CALL_FINAL_OK";
export const openAIStreamPromptText = "Stream the OpenAI runtime QA reply.";
export const openAIStreamChunkTexts = [
  "OPENAI_STREAM_FIRST_TOKEN keeps painting while ",
  "the turn is still running and ",
  "closes with OPENAI_STREAM_FINAL_OK",
];
export const openAIStreamPartialMarkerText = "OPENAI_STREAM_FIRST_TOKEN";
export const openAIStreamFinalMarkerText = "OPENAI_STREAM_FINAL_OK";
export const anthropicToolCallPromptText = "Run the Anthropic local tool-use smoke.";
export const anthropicToolCallId = "tu_runtime_anthropic_1";
export const anthropicToolCallShellOutput = "ANTHROPIC_TOOL_CALL_SMOKE_OK";
export const anthropicToolCallFinalResponseText = "ANTHROPIC_TOOL_CALL_FINAL_OK";
export const parallelModeKoreanPromptText = "패러랠 모드가 뭐냐";
export const parallelModeKoreanCleanResponseText =
  "병렬 모드(Parallel)는 큰 작업을 나눠 동시에 처리하는 ultrawork 모드예요.";
export const parallelModeKoreanLeakyResponseText = `[{"id":"subtask-1","summary":"Locate parallel mode","prompt":"read packages/orchestrator"}]
I'll trace the repo for parallel mode.

Parallel mode runs subtasks concurrently.

${parallelModeKoreanCleanResponseText}`;
