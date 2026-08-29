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
import { runTmux } from "./tmux-helpers.mjs";

export async function runTuiSmokeSuite({ port, tmp, observations }) {
  const isolated = (label, run) => runWithRuntimeHome(tmp, label, run);
  const fullTuiSmoke = await isolated("full", () => runFullTuiSmoke({ port, tmp }));
  const reasoningCleanupTuiSmoke = await isolated("reasoning", () => runReasoningCleanupTuiSmoke({ tmp, observations }));
  const yoloGreetingTuiSmoke = await isolated("yolo", () => runYoloGreetingTuiSmoke({ port, tmp, observations }));
  const koreanBusyTuiSmoke = await isolated("korean", () => runKoreanBusyTuiSmoke({ port, tmp, observations }));
  const parallelModeKoreanTuiSmoke = await isolated("parallel-ko", () => runParallelModeKoreanTuiSmoke({ port, tmp, observations }));
  const promptInputTuiSmoke = await isolated("prompt-input", () => runPromptInputTuiSmoke({ port, tmp, observations }));
  const realUseTuiStress = await isolated("real-use", () => runRealUseTuiStress({ port, tmp, observations }));
  const scrollbackTuiSmoke = await isolated("scrollback", () => runScrollbackTuiSmoke({ port, tmp, observations }));
  const openAIStreamTuiSmoke = await isolated("openai-stream", () => runOpenAIStreamTuiSmoke({ tmp }));
  const contextContrastTuiSmoke = await isolated("context", () => runContextContrastTuiSmoke({ tmp }));
  const slashLatencyTuiSmoke = await isolated("slash", () => runSlashLatencyTuiSmoke({ tmp }));

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

export async function runWithRuntimeHome(tmp, label, run) {
  const home = path.join(tmp, "runtime-homes", label);
  await runTmux(["set-environment", "-g", "HOME", home]);
  await runTmux(["set-environment", "-g", "USERPROFILE", home]);
  await runTmux(["set-environment", "-g", "UNCLECODE_SESSION_STORE_ROOT", path.join(home, ".unclecode", "state")]);
  return run();
}
import path from "node:path";
