import {
  runFullTuiSmoke,
  runReasoningCleanupTuiSmoke,
  runYoloGreetingTuiSmoke,
} from "./tui-basic-smokes.mjs";
import { runContextContrastTuiSmoke } from "./tui-context-contrast-smoke.mjs";
import { runKoreanBusyTuiSmoke } from "./tui-korean-smoke.mjs";
import { runRealUseTuiStress } from "./tui-real-use-smoke.mjs";
import { runSlashLatencyTuiSmoke } from "./tui-slash-latency-smoke.mjs";

export async function runTuiSmokeSuite({ port, tmp, observations }) {
  const fullTuiSmoke = await runFullTuiSmoke({ port, tmp });
  const reasoningCleanupTuiSmoke = await runReasoningCleanupTuiSmoke({ tmp, observations });
  const yoloGreetingTuiSmoke = await runYoloGreetingTuiSmoke({ port, tmp, observations });
  const koreanBusyTuiSmoke = await runKoreanBusyTuiSmoke({ port, tmp, observations });
  const realUseTuiStress = await runRealUseTuiStress({ port, tmp, observations });
  const contextContrastTuiSmoke = await runContextContrastTuiSmoke({ tmp });
  const slashLatencyTuiSmoke = await runSlashLatencyTuiSmoke({ tmp });

  return {
    fullTuiSmoke,
    reasoningCleanupTuiSmoke,
    yoloGreetingTuiSmoke,
    koreanBusyTuiSmoke,
    realUseTuiStress,
    contextContrastTuiSmoke,
    slashLatencyTuiSmoke,
  };
}
