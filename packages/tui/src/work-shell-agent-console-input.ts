import { AGENT_CONSOLE_TABS, type AgentConsoleTab } from "@unclecode/contracts";
import type { AgentConsoleControlState, WorkShellComposerMode } from "@unclecode/orchestrator";

/**
 * Agent Console (Sprint 3) — keyboard resolver for the `Alt+A` console.
 *
 * Pure TS, following `resolveWorkShellContextInspectorAction` rather than the
 * Rust `ux input-action` state machine: the decision is a precedence ladder
 * over a handful of key comparisons, and the console's view state never
 * crosses the Rust boundary.
 *
 * One function answers one question per keystroke, and its four outcomes are
 * what the controller and the Composer both read — there is no second map:
 *
 * - `dispatch` — the console acts. The controller stops; the Composer drops
 *   the keystroke.
 * - `consume`  — the console swallows the key without acting (an armed cancel
 *   confirmation is modal). The controller stops; the Composer drops it.
 * - `compose`  — the console reserves the key for its own composer. The
 *   controller stops, so no telemetry hotkey, Context Inspector action or
 *   Rust action can see it, but the Composer turns it into text.
 * - `pass`     — the console has no claim; the shell behaves exactly as it
 *   did before the console existed.
 *
 * The ladder, in order:
 *
 * 1. secure API-key entry owns every keystroke — nothing leaks to the console;
 * 2. the slash command picker owns its keys next;
 * 3. ctrl chords stay global (Ctrl+C, Ctrl+O tool history, Ctrl+V);
 * 4. `Alt+A` toggles the console from any other composer state, draft or not;
 * 5. a closed console has no further claim;
 * 6. `agent-steer` gives every non-`Esc` key to the Composer and nothing to
 *    the handlers behind it; `Esc` cancels the mode;
 * 7. an armed cancel confirmation answers `y`, `n` and `Esc` and swallows the
 *    rest — resolved *before* the empty-composer gate, because a stray
 *    character in the draft would otherwise make the question unanswerable;
 * 8. every remaining key needs an empty composer, so typing is never stolen;
 * 9. browsing owns `j`/`k`, the arrows, `Tab`, `Enter`, `s`, `x`, `r`, `Esc`.
 */
export type AgentConsoleInputDecision =
  | { readonly kind: "dispatch"; readonly action: AgentConsoleInputAction }
  | { readonly kind: "consume" }
  | { readonly kind: "compose" }
  | { readonly kind: "pass" };

export type AgentConsoleInputAction =
  | { readonly kind: "open" }
  | { readonly kind: "close" }
  | { readonly kind: "move"; readonly delta: -1 | 1 }
  | { readonly kind: "tab"; readonly tab: AgentConsoleTab }
  | { readonly kind: "toggle-inspector" }
  | { readonly kind: "begin-steer" }
  | { readonly kind: "cancel-steer" }
  | { readonly kind: "request-cancel" }
  | { readonly kind: "confirm-cancel"; readonly confirmed: boolean }
  | { readonly kind: "continue" };

/** The subset of ink's key flags the console reads. */
export type AgentConsoleKeyState = {
  readonly meta?: boolean | undefined;
  readonly ctrl?: boolean | undefined;
  readonly shift?: boolean | undefined;
  readonly tab?: boolean | undefined;
  readonly return?: boolean | undefined;
  readonly escape?: boolean | undefined;
  readonly upArrow?: boolean | undefined;
  readonly downArrow?: boolean | undefined;
};

export type AgentConsoleInputContext = {
  /** ink's normalized input string — already stripped of a leading `ESC`. */
  readonly value: string;
  readonly key: AgentConsoleKeyState;
  readonly open: boolean;
  readonly tab: AgentConsoleTab;
  readonly control: AgentConsoleControlState["kind"];
  readonly composerMode: WorkShellComposerMode;
  readonly composerEmpty: boolean;
  readonly slashPickerActive: boolean;
};

function stepTab(tab: AgentConsoleTab, delta: 1 | -1): AgentConsoleTab {
  const index = AGENT_CONSOLE_TABS.indexOf(tab);
  const next = (index + delta + AGENT_CONSOLE_TABS.length) % AGENT_CONSOLE_TABS.length;
  return AGENT_CONSOLE_TABS[next] as AgentConsoleTab;
}

const PASS: AgentConsoleInputDecision = { kind: "pass" };
const CONSUME: AgentConsoleInputDecision = { kind: "consume" };
const COMPOSE: AgentConsoleInputDecision = { kind: "compose" };

function act(action: AgentConsoleInputAction): AgentConsoleInputDecision {
  return { kind: "dispatch", action };
}

export function resolveAgentConsoleInputDecision(
  input: AgentConsoleInputContext,
): AgentConsoleInputDecision {
  // Secure entry is absolute: an API key must never be readable as console
  // navigation, and no console state may change while one is being typed.
  if (input.composerMode === "api-key-entry") {
    return PASS;
  }
  if (input.slashPickerActive) {
    return PASS;
  }
  // Ctrl chords are the shell's global escape hatches (Ctrl+C exit, Ctrl+O
  // tool history, Ctrl+V paste) and stay reachable from every console state.
  if (input.key.ctrl === true) {
    return PASS;
  }
  // `Alt+A` reaches ink as one keypress: the terminal writes `ESC` then `a`,
  // and `parse-keypress` reports `meta` with the escape byte stripped off the
  // input. Some terminal/Ink combinations retain `escape` on that same chord;
  // the non-empty `a` value distinguishes it from a bare Escape reliably.
  if (input.key.meta === true && input.value.toLowerCase() === "a") {
    return act(input.open ? { kind: "close" } : { kind: "open" });
  }
  if (!input.open) {
    return PASS;
  }
  if (input.composerMode === "agent-steer") {
    // The steer composer is the operator's message box. Everything but the
    // escape hatch is reserved for it: letting a key fall through would let a
    // hidden Cache Telemetry / Agent History hotkey or a Context Inspector
    // action consume the first character of a steer — or submit its own slash
    // command as the steer message.
    return input.key.escape === true ? act({ kind: "cancel-steer" }) : COMPOSE;
  }
  // Resolved before the empty-composer gate: the confirmation is modal, so a
  // stray character must never reach the draft, because a non-empty composer
  // would then stop `y`/`n`/`Esc` from answering the question at all.
  if (input.control === "confirm-cancel") {
    if (input.key.escape === true) {
      return act({ kind: "confirm-cancel", confirmed: false });
    }
    switch (input.value.toLowerCase()) {
      case "y":
        return act({ kind: "confirm-cancel", confirmed: true });
      case "n":
        return act({ kind: "confirm-cancel", confirmed: false });
      default:
        // Navigation stays frozen too: moving the cursor would leave the
        // operator answering about a row they can no longer see.
        return CONSUME;
    }
  }
  if (!input.composerEmpty) {
    return PASS;
  }
  if (input.key.escape === true) {
    return act({ kind: "close" });
  }
  if (input.key.tab === true) {
    return act({ kind: "tab", tab: stepTab(input.tab, input.key.shift === true ? -1 : 1) });
  }
  if (input.key.upArrow === true) {
    return act({ kind: "move", delta: -1 });
  }
  if (input.key.downArrow === true) {
    return act({ kind: "move", delta: 1 });
  }
  if (input.key.return === true) {
    return act({ kind: "toggle-inspector" });
  }
  switch (input.value.toLowerCase()) {
    case "j":
      return act({ kind: "move", delta: 1 });
    case "k":
      return act({ kind: "move", delta: -1 });
    case "s":
      return act({ kind: "begin-steer" });
    case "x":
      return act({ kind: "request-cancel" });
    case "r":
      return act({ kind: "continue" });
    default:
      return PASS;
  }
}

/** Engine-backed operations the resolved actions are delivered to. */
export type AgentConsoleControls = {
  readonly open: () => void;
  readonly close: () => void;
  readonly selectTab: (tab: AgentConsoleTab) => void;
  readonly moveCursor: (delta: -1 | 1) => void;
  readonly toggleInspector: () => void;
  readonly beginSteer: () => void;
  readonly cancelSteer: () => void;
  readonly requestCancel: () => void;
  readonly confirmCancel: (confirmed: boolean) => void;
  readonly continueRun: () => void;
};

export function dispatchAgentConsoleAction(
  action: AgentConsoleInputAction,
  controls: AgentConsoleControls,
): void {
  switch (action.kind) {
    case "open":
      controls.open();
      return;
    case "close":
      controls.close();
      return;
    case "move":
      controls.moveCursor(action.delta);
      return;
    case "tab":
      controls.selectTab(action.tab);
      return;
    case "toggle-inspector":
      controls.toggleInspector();
      return;
    case "begin-steer":
      controls.beginSteer();
      return;
    case "cancel-steer":
      controls.cancelSteer();
      return;
    case "request-cancel":
      controls.requestCancel();
      return;
    case "confirm-cancel":
      controls.confirmCancel(action.confirmed);
      return;
    case "continue":
      controls.continueRun();
      return;
  }
}
