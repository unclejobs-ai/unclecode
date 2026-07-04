import {
  runFullTuiSmoke,
  runReasoningCleanupTuiSmoke,
  runYoloGreetingTuiSmoke,
} from "./tui-basic-smokes.mjs";
import { runContextContrastTuiSmoke } from "./tui-context-contrast-smoke.mjs";
import { runKoreanBusyTuiSmoke } from "./tui-korean-smoke.mjs";
import { runOpenAIStreamTuiSmoke } from "./tui-openai-stream-smoke.mjs";
import { runRealUseTuiStress } from "./tui-real-use-smoke.mjs";
import { runSlashLatencyTuiSmoke } from "./tui-slash-latency-smoke.mjs";

export async function runTuiSmokeSuite({ port, tmp, observations }) {
  const fullTuiSmoke = await runFullTuiSmoke({ port, tmp });
  const reasoningCleanupTuiSmoke = await runReasoningCleanupTuiSmoke({ tmp, observations });
  const yoloGreetingTuiSmoke = await runYoloGreetingTuiSmoke({ port, tmp, observations });
  const koreanBusyTuiSmoke = await runKoreanBusyTuiSmoke({ port, tmp, observations });
  const realUseTuiStress = await runRealUseTuiStress({ port, tmp, observations });
  const openAIStreamTuiSmoke = await runOpenAIStreamTuiSmoke({ tmp });
  const contextContrastTuiSmoke = await runContextContrastTuiSmoke({ tmp });
  const slashLatencyTuiSmoke = await runSlashLatencyTuiSmoke({ tmp });

  return {
    fullTuiSmoke,
    reasoningCleanupTuiSmoke,
    yoloGreetingTuiSmoke,
    koreanBusyTuiSmoke,
    // The streaming smoke rides on the real-use stress report entry so the
    // persisted runtime report surfaces its evidence without changing the
    // top-level runner contract.
    realUseTuiStress: { ...realUseTuiStress, openAIStreaming: openAIStreamTuiSmoke },
    contextContrastTuiSmoke,
    slashLatencyTuiSmoke,
  };
}
