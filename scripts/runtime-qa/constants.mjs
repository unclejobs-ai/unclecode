import path from "node:path";

export const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
export const binEntrypoint = path.join(repoRoot, "bin", "unclecode.cjs");
export const reportPath = path.join(repoRoot, ".unclecode", "qa", "runtime-qa-latest.json");
export const tmpPrefix = "unclecode-runtime-qa-";

export const responseText = "UNCLECODE_RUNTIME_QA_OK";
export const ttyResponseText = "UNCLECODE_TTY_QA_OK";
export const fullTuiResponseText = "UNCLECODE_FULL_TUI_QA_OK";
export const yoloGreetingResponseText = "UNCLECODE_YOLO_GREETING_QA_OK";
export const koreanBusyPromptText = "한글 스피너 QA";
export const koreanBusyResponseText = "하이요! 편하게 말씀 주세요.";
export const realUseFirstPromptText = "실사용 스트레스 첫 번째";
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
export const anthropicToolCallPromptText = "Run the Anthropic local tool-use smoke.";
export const anthropicToolCallId = "tu_runtime_anthropic_1";
export const anthropicToolCallShellOutput = "ANTHROPIC_TOOL_CALL_SMOKE_OK";
export const anthropicToolCallFinalResponseText = "ANTHROPIC_TOOL_CALL_FINAL_OK";
