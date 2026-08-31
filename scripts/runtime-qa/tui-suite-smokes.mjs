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
import { stopRuntimeOwnersUnder } from "./runtime-owner-cleanup.mjs";
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

export async function runWithRuntimeHome(tmp, label, run, dependencies = {}) {
  const runTmuxCommand = dependencies.runTmuxCommand ?? runTmux;
  const stopOwners = dependencies.stopOwners ?? stopRuntimeOwnersUnder;
  const extraOwnerRoots = dependencies.extraOwnerRoots ?? [];
  const home = path.join(tmp, "runtime-homes", label);
  try {
    await runTmuxCommand(["set-environment", "-g", "HOME", home]);
    await runTmuxCommand(["set-environment", "-g", "USERPROFILE", home]);
    await runTmuxCommand(["set-environment", "-g", "UNCLECODE_SESSION_STORE_ROOT", path.join(home, ".unclecode", "state")]);
    return await run();
  } finally {
    // Every smoke owns an isolated runtime HOME. Reap its persistent owner as
    // soon as that smoke settles so later panes do not inherit a fleet of idle
    // pollers and sockets that distort responsiveness and memory evidence.
    await stopOwners(home);
    for (const extraRoot of extraOwnerRoots) {
      if (path.resolve(extraRoot) === path.resolve(home)) continue;
      await stopOwners(extraRoot);
    }
  }
}
import path from "node:path";
