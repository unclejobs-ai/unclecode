import {
  runFullTuiSmoke,
  runReasoningCleanupTuiSmoke,
  runYoloGreetingTuiSmoke,
} from "./tui-basic-smokes.mjs";
import { runContextContrastTuiSmoke } from "./tui-context-contrast-smoke.mjs";
import { runKoreanBusyTuiSmoke } from "./tui-korean-smoke.mjs";
import { runOpenAIStreamTuiSmoke } from "./tui-openai-stream-smoke.mjs";
import { runParallelModeKoreanTuiSmoke } from "./tui-parallel-mode-korean-smoke.mjs";
import { runPromptInputTuiSmoke } from "./tui-prompt-input-smoke.mjs";
import { runRealUseTuiStress } from "./tui-real-use-smoke.mjs";
import { runScrollbackTuiSmoke } from "./tui-scrollback-smoke.mjs";
import { runSlashLatencyTuiSmoke } from "./tui-slash-latency-smoke.mjs";

export async function runTuiSmokeSuite({ port, tmp, observations }) {
  const fullTuiSmoke = await runFullTuiSmoke({ port, tmp });
  const reasoningCleanupTuiSmoke = await runReasoningCleanupTuiSmoke({ tmp, observations });
  const yoloGreetingTuiSmoke = await runYoloGreetingTuiSmoke({ port, tmp, observations });
  const koreanBusyTuiSmoke = await runKoreanBusyTuiSmoke({ port, tmp, observations });
  const parallelModeKoreanTuiSmoke = await runParallelModeKoreanTuiSmoke({ port, tmp, observations });
  const promptInputTuiSmoke = await runPromptInputTuiSmoke({ port, tmp, observations });
  const realUseTuiStress = await runRealUseTuiStress({ port, tmp, observations });
  const scrollbackTuiSmoke = await runScrollbackTuiSmoke({ port, tmp, observations });
  const openAIStreamTuiSmoke = await runOpenAIStreamTuiSmoke({ tmp });
  const contextContrastTuiSmoke = await runContextContrastTuiSmoke({ tmp });
  const slashLatencyTuiSmoke = await runSlashLatencyTuiSmoke({ tmp });

  return {
    fullTuiSmoke,
    reasoningCleanupTuiSmoke,
    yoloGreetingTuiSmoke,
    koreanBusyTuiSmoke,
    parallelModeKoreanTuiSmoke,
    promptInputTuiSmoke,
    // The streaming smoke rides on the real-use stress report entry so the
    // persisted runtime report surfaces its evidence without changing the
    // top-level runner contract.
    realUseTuiStress: { ...realUseTuiStress, openAIStreaming: openAIStreamTuiSmoke },
    scrollbackTuiSmoke,
    contextContrastTuiSmoke,
    slashLatencyTuiSmoke,
  };
}
