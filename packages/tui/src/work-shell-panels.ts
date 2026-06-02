import type { WorkShellPanel } from "./work-shell-view.js";
import { runRustCommandSync } from "@unclecode/orchestrator";
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
  return resolveRustSlashSelection({ selectedIndex, suggestionCount });
}

export function cycleWorkShellSlashSelection(
  selectedIndex: number,
  suggestionCount: number,
  direction: "next" | "previous",
): number {
  return resolveRustSlashSelection({ selectedIndex, suggestionCount, direction });
}

function resolveRustSlashSelection(input: {
  readonly selectedIndex: number;
  readonly suggestionCount: number;
  readonly direction?: "next" | "previous";
}): number {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "slash-selection"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { selectedIndex?: unknown }).selectedIndex !== "number" ||
    !Number.isSafeInteger((parsed as { selectedIndex: number }).selectedIndex)
  ) {
    throw new Error("Rust slash selection returned an invalid payload.");
  }
  return (parsed as { selectedIndex: number }).selectedIndex;
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

  if (input.trim().startsWith("/model")) {
    return parseRustPanel(
      runRustCommandSync(
        ["rust", "ux", "panel", "model-picker"],
        process.cwd(),
        JSON.stringify({
          input: input.trim(),
          suggestions: visible,
          selectedIndex: selected,
          ...(currentModel ? { currentModel } : {}),
        }),
      ),
      "Model picker",
    );
  }

  return parseRustPanel(
    runRustCommandSync(
      ["rust", "ux", "panel", "commands"],
      process.cwd(),
      JSON.stringify({ input: input.trim(), suggestions: visible, selectedIndex: selected }),
    ),
    "Commands",
  );
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
