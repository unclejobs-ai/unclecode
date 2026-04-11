import type { WorkShellPanel } from "./work-shell-view.js";
import {
  buildDefaultAuthLauncherLines,
  compactContextValue,
  dedupeVisibleLines,
  formatAuthLabelForDisplay,
  isAuthStatusInlineCommand,
  isBrowserAuthInlineCommand,
  isMissingOAuthClientId,
  normalizeAuthLauncherLines,
  refineAuthStatusPanelLines,
} from "./work-shell-auth-panels.js";

export { formatAuthLabelForDisplay } from "./work-shell-auth-panels.js";

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

  if (!input.failed || !isBrowserAuthInlineCommand(input.args)) {
    return input.lines;
  }

  const missingClientId = input.lines.some((line) => isMissingOAuthClientId(line));
  if (!missingClientId) {
    return input.lines;
  }

  const authDisplay = formatAuthLabelForDisplay(input.authLabel);
  if (input.authLabel.startsWith("api-key-")) {
    return [
      "Current",
      `Auth · ${authDisplay}`,
      "Browser OAuth here needs OPENAI_OAUTH_CLIENT_ID.",
      "",
      "Next",
      "/auth status inspects auth or /auth logout switches.",
      "/auth key opens secure API key entry.",
    ];
  }
  if (input.authLabel.startsWith("oauth-")) {
    return [
      "Current",
      `Auth · ${authDisplay}`,
      "Saved browser OAuth found.",
      "",
      "Next",
      "/auth status inspects auth or /auth logout switches auth.",
    ];
  }

  return [
    "Current",
    "Auth · Not signed in",
    "Browser OAuth unavailable here.",
    "",
    "Next",
    "Set OPENAI_OAUTH_CLIENT_ID for browser login.",
    "Or use /auth key.",
  ];
}

export function buildInlineCommandPanel(args: readonly string[], lines: readonly string[]): WorkShellPanel {
  const key = args.join(" ");
  const title = key === "doctor"
    ? "Doctor"
    : key === "auth status" || key === "auth login" || key === "auth login --browser" || key === "auth key" || key.startsWith("auth login --api-key ")
      ? "Auth"
      : key === "mcp list"
        ? "MCP"
        : key === "mode status"
          ? "Mode"
          : key;

  return {
    title,
    lines: lines.length > 0 ? lines : ["No output."],
  };
}

export function formatInlineCommandResultSummary(args: readonly string[], lines: readonly string[]): string {
  const panel = buildInlineCommandPanel(args, lines);
  return [panel.title, ...panel.lines.slice(0, 2)].join(" · ");
}

export function buildContextPanel(
  contextSummaryLines: readonly string[],
  bridgeLines: readonly string[],
  memoryLines: readonly string[],
  lines: readonly string[],
  expanded = false,
): WorkShellPanel {
  const dedupedContextLines = dedupeVisibleLines(contextSummaryLines);
  const issueLines = dedupedContextLines.filter((line) => /^Auth issue:/i.test(line));
  const guidanceLines = dedupedContextLines.filter((line) => !/^Auth issue:/i.test(line));
  const bridge = dedupeVisibleLines(bridgeLines);
  const memory = dedupeVisibleLines(memoryLines);
  const live = dedupeVisibleLines(lines);

  if (!expanded) {
    const compactSections = [
      ...(issueLines.length > 0
        ? [{ label: "Issue", value: issueLines[0] ?? "" }]
        : []),
      ...(guidanceLines.length > 0
        ? [{ label: "Guidance", value: guidanceLines[0] ?? "" }]
        : []),
      ...(bridge.length > 0 ? [{ label: "Bridge", value: bridge[0] ?? "" }] : []),
      ...(memory.length > 0 ? [{ label: "Memory", value: memory[0] ?? "" }] : []),
      ...(live.length > 0 ? [{ label: "Live", value: live[0] ?? "" }] : []),
    ];

    return {
      title: "Context",
      lines: compactSections.length === 0
        ? ["Focus", "□ Empty   No workspace context yet."]
        : [
            "Focus",
            ...compactSections.map((section) => {
              const prefix =
                section.label === "Live"
                  ? "→"
                  : section.label === "Issue"
                    ? "!"
                    : "□";
              const label = section.label === "Guidance" ? "Guide" : section.label;
              return `${prefix} ${label.padEnd(7, " ")} ${compactContextValue(section.label, section.value)}`;
            }),
          ],
    };
  }

  return {
    title: "Context",
    lines: [
      ...(issueLines.length > 0 ? ["Issues", ...issueLines] : []),
      ...(guidanceLines.length > 0
        ? [...(issueLines.length > 0 ? [""] : []), "Guidance", ...guidanceLines]
        : []),
      ...(bridge.length > 0 ? ["", "Bridge", ...bridge] : []),
      ...(memory.length > 0 ? ["", "Memory", ...memory] : []),
      ...(live.length > 0 ? ["", "Live steps", ...live] : []),
    ],
  };
}

export function clampWorkShellSlashSelection(selectedIndex: number, suggestionCount: number): number {
  if (suggestionCount <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(selectedIndex, suggestionCount - 1));
}

export function cycleWorkShellSlashSelection(
  selectedIndex: number,
  suggestionCount: number,
  direction: "next" | "previous",
): number {
  if (suggestionCount <= 0) {
    return 0;
  }

  return direction === "previous"
    ? (selectedIndex <= 0 ? suggestionCount - 1 : selectedIndex - 1)
    : (selectedIndex + 1) % suggestionCount;
}

function formatModelSuggestionDescription(description: string): string {
  return /reasoning unsupported/i.test(description)
    ? "Warning · reasoning unsupported"
    : description;
}

function parseCurrentModelDescription(description: string): {
  readonly reasoning: string;
  readonly support?: string;
} {
  const normalized = formatModelSuggestionDescription(description);
  if (/Warning · reasoning unsupported/i.test(normalized)) {
    return { reasoning: "no reasoning" };
  }
  const match = /^Current\s·\sdefault\s([^·]+)\s·\ssupports\s(.+)$/i.exec(normalized);
  if (match) {
    const support = match[2]?.trim();
    return {
      reasoning: `default ${match[1]?.trim() ?? "unknown"}`,
      ...(support ? { support } : {}),
    };
  }
  return {
    reasoning: normalized.replace(/^Current\s*·\s*/i, "").trim(),
  };
}

function compactModelSuggestionDescription(description: string): string {
  const normalized = formatModelSuggestionDescription(description);
  if (/Warning · reasoning unsupported/i.test(normalized)) {
    return "no reasoning";
  }
  const currentMatch = /^Current\s·\sdefault\s([^·]+)\s·\ssupports\s(.+)$/i.exec(normalized);
  if (currentMatch) {
    return `active · ${currentMatch[1]?.trim() ?? "unknown"}`;
  }
  const defaultMatch = /^Default\s·\s([^·]+)\s·\ssupports\s(.+)$/i.exec(normalized);
  if (defaultMatch) {
    return defaultMatch[1]?.trim() ?? normalized;
  }
  return normalized;
}

function buildModelSlashSuggestionPanel(
  suggestions: readonly { readonly command: string; readonly description: string }[],
  selectedIndex: number,
): WorkShellPanel {
  const visible = suggestions.slice(0, 6);
  const selected = clampWorkShellSlashSelection(selectedIndex, visible.length);
  const modelEntries = visible.filter(
    (entry) => entry.command.startsWith("/model ") && entry.command !== "/model list",
  );
  const currentEntry = modelEntries.find((entry) => /current/i.test(entry.description)) ?? modelEntries[0];
  const currentModel = currentEntry?.command.replace(/^\/model\s+/, "") ?? "unknown";
  const currentMeta = parseCurrentModelDescription(currentEntry?.description ?? "unknown");

  return {
    title: "Models",
    lines: [
      "Current",
      `Model · ${currentModel}`,
      `Thinking · ${currentMeta.reasoning}`,
      "",
      "Available",
      ...modelEntries.map((entry) => `${visible.indexOf(entry) === selected ? "›" : " "} ${entry.command}  ${compactModelSuggestionDescription(entry.description)}`),
      "",
      "Enter switch · Esc close",
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
): WorkShellPanel {
  const visible = suggestions.slice(0, 6);
  const selected = clampWorkShellSlashSelection(selectedIndex, visible.length);

  if (input.trim().startsWith("/auth")) {
    const signedIn = authLabel && authLabel !== "none";
    const rememberedLines = normalizeAuthLauncherLines({
      ...(authLauncherLines ? { lines: authLauncherLines } : {}),
      ...(authLabel ? { authLabel } : {}),
      browserOAuthAvailable,
    });
    return {
      title: "Auth",
      lines: [
        ...(rememberedLines ?? buildDefaultAuthLauncherLines(authLabel, browserOAuthAvailable)),
        "",
        "Routes",
        ...visible.map((entry, index) => `${index === selected ? "›" : " "} ${entry.command}  ${entry.description}`),
        "",
        signedIn ? "Tip · /auth logout" : "Tip · /auth login",
      ],
    };
  }

  if (input.trim().startsWith("/model")) {
    return buildModelSlashSuggestionPanel(visible, selected);
  }

  return {
    title: "Commands",
    lines: [
      `${input.trim()} matches`,
      "",
      ...visible.map((entry, index) => `${index === selected ? "›" : " "} ${entry.command}  ${entry.description}`),
      "",
      "↑↓ move · Enter run",
    ],
  };
}

export function resolveWorkShellActivePanel(input: {
  readonly input: string;
  readonly suggestions: readonly { readonly command: string; readonly description: string }[];
  readonly selectedIndex: number;
  readonly authLabel?: string;
  readonly browserOAuthAvailable?: boolean;
  readonly authLauncherLines?: readonly string[];
  readonly fallbackPanel: WorkShellPanel;
}): WorkShellPanel {
  if (!input.input.trim().startsWith("/")) {
    return input.fallbackPanel;
  }

  if (input.suggestions.length === 0) {
    return {
      title: "Commands",
      lines: [
        "No slash yet.",
        "",
        "Try /model, /auth, /doctor, /context.",
      ],
    };
  }

  return buildSlashSuggestionPanel(
    input.input,
    input.suggestions,
    input.selectedIndex,
    input.authLabel,
    input.browserOAuthAvailable,
    input.authLauncherLines,
  );
}

export function buildWorkShellHelpPanel(): WorkShellPanel {
  return {
    title: "Work-first shell",
    lines: [
      "Composer is live.",
      "Esc opens sessions.",
      "Shift+Tab cycles mode.",
      "/ starts commands. Tab completes.",
      "/context, /reasoning, /model, /sessions, /reload",
      "/doctor, /auth status, /auth login, /auth key, /mcp list, /mode status",
      "/research <topic>, /research status, /review, /commit",
      "/queue, /skills, /skill <name>, /memories, /harness, /clear, /help, /exit",
      "/remember [session|project|user|agent] <text>",
      "AGENTS.md / CLAUDE.md load automatically.",
    ],
  };
}

export function buildWorkShellStatusPanel(input: {
  provider: string;
  model: string;
  mode: string;
  cwd: string;
  reasoningLabel: string;
  authLabel: string;
}): WorkShellPanel {
  return {
    title: "Session status",
    lines: [
      "Current",
      `Provider · ${input.provider}`,
      `Model · ${input.model}`,
      `Reasoning · ${input.reasoningLabel}`,
      `Mode · ${input.mode}`,
      `Auth · ${formatAuthLabelForDisplay(input.authLabel)}`,
      "",
      "Workspace",
      `Cwd · ${input.cwd}`,
    ],
  };
}
