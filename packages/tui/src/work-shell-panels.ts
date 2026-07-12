import type { WorkShellPanel } from "./work-shell-view.js";
import { resolveWorkShellSlashArgHint, runRustCommandSync } from "@unclecode/orchestrator";
import {
  formatAuthLabelForDisplay,
  isAuthStatusInlineCommand,
  refineAuthBrowserFailureLines,
  refineAuthStatusPanelLines,
} from "./work-shell-auth-panels.js";

export { formatAuthLabelForDisplay } from "./work-shell-auth-panels.js";

const inlineCommandPanelCache = new Map<string, WorkShellPanel>();
const inlineCommandSummaryCache = new Map<string, string>();

function parseRustPanel(raw: string, expectedTitle?: string): WorkShellPanel {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (expectedTitle !== undefined && (parsed as { title?: unknown }).title !== expectedTitle) ||
    typeof (parsed as { title?: unknown }).title !== "string" ||
    !Array.isArray((parsed as { lines?: unknown }).lines)
  ) {
    throw new Error("Rust panel returned an invalid payload.");
  }
  return {
    title: (parsed as { title: string }).title,
    lines: (parsed as { lines: unknown[] }).lines.filter((line): line is string => typeof line === "string"),
  };
}

export function refineInlineCommandPanelLines(input: {
  readonly args: readonly string[];
  readonly lines: readonly string[];
  readonly failed: boolean;
  readonly authLabel: string;
  readonly browserOAuthAvailable?: boolean;
}): readonly string[] {
  const browserOAuthAvailable = input.browserOAuthAvailable ?? true;

  if (isAuthStatusInlineCommand(input.args)) {
    return refineAuthStatusPanelLines({
      lines: input.lines,
      browserOAuthAvailable,
    });
  }

  return refineAuthBrowserFailureLines(input);
}

export function buildInlineCommandPanel(args: readonly string[], lines: readonly string[]): WorkShellPanel {
  const key = JSON.stringify({ args, lines });
  const cached = inlineCommandPanelCache.get(key);
  if (cached) {
    return cached;
  }
  const panel = parseRustPanel(
    runRustCommandSync(
      ["rust", "ux", "panel", "inline-command"],
      process.cwd(),
      key,
    ),
  );
  inlineCommandPanelCache.set(key, panel);
  return panel;
}

export function formatInlineCommandResultSummary(args: readonly string[], lines: readonly string[]): string {
  const key = JSON.stringify({ args, lines });
  const cached = inlineCommandSummaryCache.get(key);
  if (cached) {
    return cached;
  }
  const summary = runRustCommandSync(
    ["rust", "ux", "text", "inline-command-summary"],
    process.cwd(),
    key,
  ).trimEnd();
  inlineCommandSummaryCache.set(key, summary);
  return summary;
}

export function buildContextPanel(
  contextSummaryLines: readonly string[],
  bridgeLines: readonly string[],
  memoryLines: readonly string[],
  lines: readonly string[],
  expanded = false,
): WorkShellPanel {
  return parseRustPanel(
    runRustCommandSync(
      ["rust", "ux", "panel", "context"],
      process.cwd(),
      JSON.stringify({
        contextSummaryLines,
        bridgeLines,
        memoryLines,
        traceLines: lines,
        expanded,
      }),
    ),
    expanded ? "Context expanded" : "Context",
  );
}

export function clampWorkShellSlashSelection(selectedIndex: number, suggestionCount: number): number {
  const count = Math.max(0, suggestionCount);
  if (count === 0) {
    return 0;
  }
  return Math.min(Math.max(0, selectedIndex), count - 1);
}

export function cycleWorkShellSlashSelection(
  selectedIndex: number,
  suggestionCount: number,
  direction: "next" | "previous",
): number {
  const count = Math.max(0, suggestionCount);
  if (count === 0) {
    return 0;
  }
  const clamped = clampWorkShellSlashSelection(selectedIndex, count);
  if (direction === "previous") {
    return clamped <= 0 ? count - 1 : clamped - 1;
  }
  return (clamped + 1) % count;
}

function isWorkShellSuggestion(value: unknown): value is {
  readonly command: string;
  readonly description: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly command?: unknown }).command === "string" &&
    typeof (value as { readonly description?: unknown }).description === "string"
  );
}

function visibleSlashSuggestions(
  suggestions: readonly { readonly command: string; readonly description: string }[],
): readonly { readonly command: string; readonly description: string }[] {
  return suggestions
    .filter(isWorkShellSuggestion)
    .map((suggestion) => ({
      command: suggestion.command.trim(),
      description: suggestion.description.trim(),
    }))
    .filter((suggestion) => suggestion.command.length > 0)
    .slice(0, 6);
}

function buildCommandsPanel(
  input: string,
  suggestions: readonly { readonly command: string; readonly description: string }[],
  selectedIndex: number,
): WorkShellPanel {
  const inputText = input.trim() || "/";
  const visible = visibleSlashSuggestions(suggestions);
  const selected = clampWorkShellSlashSelection(selectedIndex, visible.length);
  if (visible.length === 0) {
    return {
      title: "Commands",
      lines: [
        `No matches for ${inputText}.`,
        "",
        "Try /model <id>, /auth status, /queue, or /context.",
      ],
    };
  }
  const selectedCommand = visible[selected]?.command;
  const selectedArgHint = selectedCommand ? resolveWorkShellSlashArgHint(selectedCommand) : undefined;
  return {
    title: "Commands",
    lines: [
      `${inputText} matches`,
      "",
      ...visible.map((suggestion, index) => {
        const argHint = index === selected ? resolveWorkShellSlashArgHint(suggestion.command) : undefined;
        const suffix = argHint ? ` · args: ${argHint}` : "";
        return `${index === selected ? "›" : " "} ${suggestion.command}  ${suggestion.description}${suffix}`;
      }),
      "",
      selectedArgHint
        ? `↑↓ move · Enter run · args: ${selectedArgHint}`
        : "↑↓ move · Enter run",
    ],
  };
}

type ModelPickerCurrent = {
  readonly reasoning: string;
  readonly support?: string | undefined;
};

function stripCaseInsensitivePrefix(value: string, prefix: string): string | undefined {
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
    ? value.slice(prefix.length)
    : undefined;
}

function normalizeModelSuggestionDescription(description: string): string {
  const lower = description.toLowerCase();
  if (lower.includes("reasoning unsupported") || lower.includes("reasoning unavailable")) {
    return "Reasoning unavailable";
  }
  return description.trim();
}

function parseCurrentModelDescription(description: string): ModelPickerCurrent {
  const normalized = normalizeModelSuggestionDescription(description);
  if (normalized.toLowerCase() === "reasoning unavailable") {
    return { reasoning: "unavailable" };
  }
  const current = stripCaseInsensitivePrefix(normalized, "Current · ") ?? normalized;
  const [reasoningPart = "", support] = current.split(" · supports ", 2);
  const reasoning = (
    stripCaseInsensitivePrefix(reasoningPart, "reasoning default ") ??
    stripCaseInsensitivePrefix(reasoningPart, "default ")
  );
  return {
    reasoning: reasoning === undefined
      ? reasoningPart.trim()
      : `default ${reasoning.trim()}`,
    ...(support ? { support } : {}),
  };
}

function compactModelSuggestionDescription(description: string): string {
  const normalized = normalizeModelSuggestionDescription(description);
  if (normalized.toLowerCase() === "reasoning unavailable") {
    return "reasoning unavailable";
  }
  const stripped =
    stripCaseInsensitivePrefix(normalized, "Current · ") ??
    stripCaseInsensitivePrefix(normalized, "Default · ") ??
    stripCaseInsensitivePrefix(normalized, "Available · ") ??
    normalized;
  const active = stripCaseInsensitivePrefix(normalized, "Current · ") !== undefined;
  const [reasoningPart = ""] = stripped.split(" · supports ", 1);
  const effort = (
    stripCaseInsensitivePrefix(reasoningPart, "reasoning default ") ??
    stripCaseInsensitivePrefix(reasoningPart, "default ") ??
    stripCaseInsensitivePrefix(reasoningPart, "reasoning ") ??
    reasoningPart
  ).trim();
  return active ? `active · reasoning ${effort}` : `reasoning ${effort}`;
}

function modelPickerReasoningChoiceLine(currentMeta: ModelPickerCurrent): string {
  if (currentMeta.support && currentMeta.support.trim().length > 0) {
    return `Thinking choices · ${currentMeta.support.replace(/, /g, " / ")} / default`;
  }
  if (currentMeta.reasoning.toLowerCase() === "unavailable") {
    return "Thinking choices · unavailable for this model";
  }
  return "Thinking choices · low / medium / high / default";
}

const MODEL_PICKER_VISIBLE_ROWS = 6;

function normalizeWorkShellSuggestions(
  suggestions: readonly { readonly command: string; readonly description: string }[],
): readonly { readonly command: string; readonly description: string }[] {
  return suggestions
    .filter(isWorkShellSuggestion)
    .map((suggestion) => ({
      command: suggestion.command.trim(),
      description: suggestion.description.trim(),
    }))
    .filter((suggestion) => suggestion.command.length > 0);
}

function windowModelPickerRows<T>(
  entries: readonly T[],
  selectedIndex: number,
  maxRows = MODEL_PICKER_VISIBLE_ROWS,
): readonly T[] {
  if (entries.length <= maxRows) {
    return entries;
  }
  if (selectedIndex < 0) {
    return entries.slice(0, maxRows);
  }
  const halfWindow = Math.floor(maxRows / 2);
  const start = Math.min(
    Math.max(0, selectedIndex - halfWindow),
    Math.max(0, entries.length - maxRows),
  );
  return entries.slice(start, start + maxRows);
}

function buildModelPickerPanel(
  input: string,
  suggestions: readonly { readonly command: string; readonly description: string }[],
  selectedIndex: number,
  currentModel?: string,
): WorkShellPanel {
  const inputText = input.trim() || "/model";
  const modelFilter = inputText.startsWith("/model")
    ? inputText.slice("/model".length).trim() || undefined
    : undefined;
  const normalized = normalizeWorkShellSuggestions(suggestions);
  const selected = clampWorkShellSlashSelection(selectedIndex, normalized.length);
  const selectedCommand = normalized[selected]?.command ?? "";
  const allModelEntries = normalized.filter(
    (suggestion) =>
      suggestion.command.startsWith("/model ") && suggestion.command !== "/model list",
  );
  const selectedModelCommand =
    selectedCommand === "/model"
      ? allModelEntries[0]?.command ?? ""
      : selectedCommand === "/model list"
        ? ""
        : selectedCommand;
  const selectedModelIndex = allModelEntries.findIndex(
    (suggestion) => suggestion.command === selectedModelCommand,
  );
  const modelEntries = windowModelPickerRows(allModelEntries, selectedModelIndex);
  const currentEntry =
    allModelEntries.find((suggestion) => suggestion.description.toLowerCase().includes("current")) ??
    allModelEntries[0];
  const resolvedCurrentModel =
    currentModel?.trim() ||
    currentEntry?.command.trim().replace(/^\/model\s+/, "") ||
    "unknown";
  const currentMeta = currentEntry
    ? parseCurrentModelDescription(currentEntry.description)
    : { reasoning: "unknown" };

  if (modelEntries.length === 0) {
    return {
      title: "Model picker",
      lines: [
        ...(currentModel ? ["Current model", `Model · ${currentModel}`, ""] : []),
        "Filter",
        modelFilter ? `Query · ${modelFilter}` : "Query · /model",
        "",
        modelFilter
          ? `No model id matches ${modelFilter}. Current model unchanged.`
          : "No exact model match.",
        "/model list shows the catalog.",
        "",
        "Controls",
        "Backspace edit · Enter keeps current · Esc close",
      ],
    };
  }

  return {
    title: "Model picker",
    lines: [
      "Current model",
      `Model · ${resolvedCurrentModel}`,
      `Thinking · ${currentMeta.reasoning}`,
      modelPickerReasoningChoiceLine(currentMeta),
      ...(currentMeta.support ? [`Supports · ${currentMeta.support}`] : []),
      ...(modelFilter ? [`Filter · ${modelFilter}`] : []),
      "",
      "Pick model",
      ...modelEntries.map((suggestion) =>
        `${selectedModelCommand === suggestion.command ? "›" : " "} ${suggestion.command}  ${compactModelSuggestionDescription(suggestion.description)}`),
      "",
      "Controls",
      "↑↓ choose model · Enter switch · append low/medium/high/default · Esc close",
    ],
  };
}

export function buildSlashSuggestionPanel(
  input: string,
  suggestions: readonly { readonly command: string; readonly description: string }[],
  selectedIndex = 0,
  authLabel?: string,
  browserOAuthAvailable = true,
  authLauncherLines?: readonly string[],
  currentModel?: string,
): WorkShellPanel {
  if (input.trim().startsWith("/model")) {
    return buildModelPickerPanel(input, suggestions, selectedIndex, currentModel);
  }

  const visible = suggestions.slice(0, 6);
  const selected = clampWorkShellSlashSelection(selectedIndex, visible.length);

  if (input.trim().startsWith("/auth")) {
    return parseRustPanel(
      runRustCommandSync(
        ["rust", "ux", "panel", "auth-picker"],
        process.cwd(),
        JSON.stringify({
          suggestions: visible,
          selectedIndex: selected,
          authLabel,
          browserOAuthAvailable,
          authLauncherLines: authLauncherLines ?? [],
        }),
      ),
      "Auth",
    );
  }

  return buildCommandsPanel(input, visible, selected);
}

export function resolveWorkShellActivePanel(input: {
  readonly input: string;
  readonly suggestions: readonly { readonly command: string; readonly description: string }[];
  readonly selectedIndex: number;
  readonly authLabel?: string;
  readonly browserOAuthAvailable?: boolean;
  readonly authLauncherLines?: readonly string[];
  readonly currentModel?: string;
  readonly fallbackPanel: WorkShellPanel;
}): WorkShellPanel {
  if (!input.input.trim().startsWith("/")) {
    return input.fallbackPanel;
  }

  // Context expanded is an overlay panel from the engine. While the composer
  // still holds "/context" for a frame after submit, the slash picker must not
  // override it or the overlay never paints (runtime QA context contrast).
  if (input.fallbackPanel.title === "Context expanded") {
    return input.fallbackPanel;
  }

  return buildSlashSuggestionPanel(
    input.input,
    input.suggestions,
    input.selectedIndex,
    input.authLabel,
    input.browserOAuthAvailable,
    input.authLauncherLines,
    input.currentModel,
  );
}

export function buildWorkShellHelpPanel(): WorkShellPanel {
  return parseRustPanel(
    runRustCommandSync(["rust", "ux", "panel", "help"], process.cwd(), "{}"),
    "Work-first shell",
  );
}

export function buildWorkShellStatusPanel(input: {
  provider: string;
  model: string;
  mode: string;
  cwd: string;
  reasoningLabel: string;
  authLabel: string;
  contextSummaryLines?: readonly string[] | undefined;
  bridgeLines?: readonly string[] | undefined;
  memoryLines?: readonly string[] | undefined;
  traceLines?: readonly string[] | undefined;
}): WorkShellPanel {
  const route = resolveStatusRoute(input.provider, input.model);
  return parseRustPanel(
    runRustCommandSync(
      ["rust", "ux", "panel", "status"],
      process.cwd(),
      JSON.stringify({ ...input, ...route }),
    ),
    "Session status",
  );
}

function resolveStatusRoute(provider: string, model: string): { readonly route: unknown } | { readonly routeError: string } {
  try {
    return {
      route: JSON.parse(
        runRustCommandSync(["rust", "model", "provider-route-json", provider || "auto", model], process.cwd()),
      ) as unknown,
    };
  } catch (error) {
    return {
      routeError: error instanceof Error ? error.message : String(error),
    };
  }
}
