import type { WorkShellPanel } from "./work-shell-view.js";

function formatAuthRouteLabel(route: string): string {
  if (route === "device-oauth") {
    return "Device OAuth";
  }
  if (route === "browser-oauth") {
    return "Browser OAuth";
  }
  return route;
}

function getPreferredAuthRoute(authLabel: string | undefined, browserOAuthAvailable: boolean): string | undefined {
  if (
    !authLabel ||
    authLabel === "none" ||
    authLabel.startsWith("api-key-") ||
    authLabel.startsWith("oauth-")
  ) {
    return browserOAuthAvailable ? "browser-oauth" : "device-oauth";
  }
  return undefined;
}

function formatAuthStatusBlurb(authLabel?: string, browserOAuthAvailable = true): string {
  if (!authLabel || authLabel === "none") {
    return browserOAuthAvailable
      ? "Use /auth login or /auth key."
      : "Use /auth login (device when available) or /auth key.";
  }
  if (authLabel.startsWith("oauth-")) {
    return browserOAuthAvailable
      ? "Saved browser OAuth found."
      : "Saved browser OAuth found. New browser login needs OPENAI_OAUTH_CLIENT_ID.";
  }
  if (authLabel.startsWith("api-key-")) {
    return browserOAuthAvailable ? "API key ready. Browser OAuth is also available." : "API key ready. /auth login may use device OAuth.";
  }
  return "OpenAI auth loaded.";
}

function buildAuthLauncherNextLines(authLabel?: string, browserOAuthAvailable = true): readonly string[] {
  if (!authLabel || authLabel === "none") {
    return browserOAuthAvailable
      ? ["/auth login starts OAuth.", "/auth key opens secure API key entry."]
      : ["/auth login may use device OAuth.", "/auth key opens secure API key entry."];
  }

  if (authLabel.startsWith("oauth-")) {
    return ["/auth status inspects auth.", "/auth logout switches auth."];
  }

  if (authLabel.startsWith("api-key-")) {
    return browserOAuthAvailable
      ? ["/auth status inspects auth.", "/auth login starts OAuth or /auth logout switches auth."]
      : ["/auth status inspects auth.", "/auth login may use device OAuth."];
  }

  return ["/auth status inspects auth."];
}

function buildDefaultAuthLauncherLines(
  authLabel?: string,
  browserOAuthAvailable = true,
  oauthRoute?: string,
): readonly string[] {
  const signedIn = authLabel && authLabel !== "none";
  const route = oauthRoute ?? getPreferredAuthRoute(authLabel, browserOAuthAvailable);
  return [
    "Current",
    signedIn ? `Auth · ${formatAuthLabelForDisplay(authLabel)}` : "Auth · Not signed in",
    ...(route ? [`Route · ${formatAuthRouteLabel(route)}`] : []),
    formatAuthStatusBlurb(authLabel, browserOAuthAvailable),
    ...(!browserOAuthAvailable ? ["Browser OAuth unavailable in this shell."] : []),
    "",
    "Next",
    ...buildAuthLauncherNextLines(authLabel, browserOAuthAvailable),
  ];
}

export function extractAuthLabel(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = /^(?:Auth|Source|Auth source):\s*(.+)$/i.exec(line.trim());
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function extractAuthRoute(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = /^Route:\s*(.+)$/i.exec(line.trim());
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function ensureAuthLauncherRoute(
  lines: readonly string[],
  authLabel: string | undefined,
  browserOAuthAvailable: boolean,
): readonly string[] {
  if (!lines.includes("Current") || lines.some((line) => /^Route\s·\s/i.test(line.trim()))) {
    return lines;
  }
  const route = getPreferredAuthRoute(authLabel, browserOAuthAvailable);
  if (!route) {
    return lines;
  }
  const authIndex = lines.findIndex((line) => /^Auth\s·\s/i.test(line.trim()));
  if (authIndex < 0) {
    return lines;
  }
  return [...lines.slice(0, authIndex + 1), `Route · ${formatAuthRouteLabel(route)}`, ...lines.slice(authIndex + 1)];
}

function normalizeAuthLauncherLines(input: {
  readonly lines?: readonly string[];
  readonly authLabel?: string;
  readonly browserOAuthAvailable: boolean;
}): readonly string[] | undefined {
  const rawLines = input.lines ?? [];
  if (rawLines.length === 0) {
    return undefined;
  }
  if (rawLines.includes("Current")) {
    return ensureAuthLauncherRoute(rawLines, input.authLabel, input.browserOAuthAvailable);
  }
  const lines = rawLines.filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  const rememberedAuthLabel = extractAuthLabel(lines) ?? input.authLabel;
  const rememberedRoute = extractAuthRoute(lines);
  if (lines.some((line) => /(?:browser|oauth) login complete\./i.test(line))) {
    return buildDefaultAuthLauncherLines(rememberedAuthLabel ?? "oauth-file", input.browserOAuthAvailable, rememberedRoute);
  }
  if (lines.some((line) => /saved auth found\./i.test(line))) {
    return buildDefaultAuthLauncherLines(rememberedAuthLabel ?? "oauth-file", input.browserOAuthAvailable, rememberedRoute);
  }
  if (lines.some((line) => /api key login saved\./i.test(line))) {
    return buildDefaultAuthLauncherLines(rememberedAuthLabel ?? "api-key-file", input.browserOAuthAvailable, rememberedRoute);
  }
  if (lines.some((line) => /signed out\./i.test(line))) {
    return buildDefaultAuthLauncherLines("none", input.browserOAuthAvailable, rememberedRoute);
  }
  if (lines.some((line) => /^auth:\s*/i.test(line)) && rememberedAuthLabel) {
    return buildDefaultAuthLauncherLines(rememberedAuthLabel, input.browserOAuthAvailable, rememberedRoute);
  }
  return undefined;
}

function isMissingOAuthClientId(message: string): boolean {
  return /OPENAI_OAUTH_CLIENT_ID is required for (?:OAuth|browser) login|Browser OAuth unavailable/i.test(message);
}

function isBrowserAuthInlineCommand(args: readonly string[]): boolean {
  return args[0] === "auth" && args[1] === "login" && args.includes("--browser");
}

function isAuthStatusInlineCommand(args: readonly string[]): boolean {
  return args[0] === "auth" && args[1] === "status";
}

function parseAuthStatusLine(lines: readonly string[], key: string): string | undefined {
  const match = lines
    .map((line) => line.trim())
    .map((line) => new RegExp(`^${key}:\\s*(.+)$`, "i").exec(line)?.[1]?.trim())
    .find((value) => typeof value === "string" && value.length > 0);
  return typeof match === "string" ? match : undefined;
}

function refineAuthStatusPanelLines(input: {
  readonly lines: readonly string[];
  readonly browserOAuthAvailable: boolean;
}): readonly string[] {
  const source = parseAuthStatusLine(input.lines, "source") ?? "none";
  const auth = parseAuthStatusLine(input.lines, "auth") ?? "none";
  const expiresAt = parseAuthStatusLine(input.lines, "expiresAt") ?? "none";
  const expired = (parseAuthStatusLine(input.lines, "expired") ?? "no").toLowerCase() === "yes";
  const authDisplay = formatAuthLabelForDisplay(source);

  if (source === "none") {
    return [
      "Current",
      "Auth · Not signed in",
      ...(input.browserOAuthAvailable ? ["Route · Browser OAuth"] : ["Route · Device OAuth"]),
      input.browserOAuthAvailable
        ? "Use /auth login or /auth key."
        : "Use /auth login (device when available) or /auth key.",
      "",
      "Next",
      ...(input.browserOAuthAvailable
        ? ["/auth login starts OAuth.", "/auth key opens secure API key entry."]
        : ["/auth login may use device OAuth.", "/auth key opens secure API key entry."]),
    ];
  }

  if (auth === "api-key") {
    return [
      "Current",
      `Auth · ${authDisplay}`,
      ...(input.browserOAuthAvailable ? ["Route · Browser OAuth"] : ["Route · Device OAuth"]),
      "API key active.",
      "",
      "Next",
      ...(input.browserOAuthAvailable
        ? ["/auth status inspects auth.", "/auth login starts OAuth or /auth logout switches auth."]
        : ["/auth status inspects auth.", "/auth login may use device OAuth."]),
    ];
  }

  if (expiresAt === "insufficient-scope") {
    return [
      "Current",
      `Auth · ${authDisplay}`,
      ...(input.browserOAuthAvailable ? ["Route · Browser OAuth"] : ["Route · Device OAuth"]),
      "OAuth token lacks model.request scope.",
      "",
      "Next",
      ...(input.browserOAuthAvailable
        ? ["Use /auth login for proper browser OAuth.", "/auth key opens secure API key entry."]
        : [
            "Browser OAuth here needs OPENAI_OAUTH_CLIENT_ID.",
            "/auth key opens secure API key entry.",
          ]),
    ];
  }

  if (expired || expiresAt === "refresh-required") {
    return [
      "Current",
      `Auth · ${authDisplay}`,
      ...(input.browserOAuthAvailable ? ["Route · Browser OAuth"] : ["Route · Device OAuth"]),
      "Browser OAuth needs refresh.",
      "",
      "Next",
      ...(input.browserOAuthAvailable
        ? ["/auth login refreshes this shell.", "/auth logout clears stale auth if needed."]
        : [
            "OAuth refresh needs OPENAI_OAUTH_CLIENT_ID here.",
            "/auth logout clears stale auth if needed.",
          ]),
    ];
  }

  return [
    "Current",
    `Auth · ${authDisplay}`,
    ...(input.browserOAuthAvailable ? ["Route · Browser OAuth"] : ["Route · Device OAuth"]),
    "Saved browser OAuth found.",
    "",
    "Next",
    "/auth status inspects auth or /auth logout switches auth.",
  ];
}

function normalizeVisibleLine(line: string): string {
  const trimmed = line.trim();
  const dedupeCommaList = (prefix: string): string => {
    if (!trimmed.startsWith(prefix)) {
      return trimmed;
    }
    const items = trimmed.slice(prefix.length).split(",").map((value) => value.trim()).filter((value) => value.length > 0);
    const unique = items.filter((value, index) => items.indexOf(value) === index);
    return `${prefix}${unique.join(", ")}`;
  };

  return dedupeCommaList("Loaded guidance: ");
}

function dedupeVisibleLines(lines: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.map((value) => normalizeVisibleLine(value)).filter((value) => value.length > 0)) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    result.push(line);
  }
  return result;
}

function compactContextValue(label: string, value: string): string {
  const normalized = value
    .replace(/^Auth issue:\s*/i, "")
    .replace(/^Loaded guidance:\s*/i, "")
    .replace(/^Loaded extension:\s*/i, "ext ")
    .replace(/^Loaded skills:\s*/i, "skills ")
    .replace(/^AGENTS\.md:\s*/i, "AGENTS: ")
    .replace(/^CLAUDE\.md:\s*/i, "CLAUDE: ");
  const limit = label === "Issue" ? 35 : 36;
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

export function formatAuthLabelForDisplay(authLabel: string): string {
  if (authLabel === "oauth-file") return "Browser OAuth · file";
  if (authLabel === "oauth-env") return "Browser OAuth · env";
  if (authLabel === "api-key-file") return "API key · file";
  if (authLabel === "api-key-env") return "API key · env";
  if (authLabel === "none") return "Not signed in";
  return authLabel;
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
    return { reasoning: "unsupported" };
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

function buildModelSlashSuggestionPanel(
  suggestions: readonly { readonly command: string; readonly description: string }[],
  selectedIndex: number,
): WorkShellPanel {
  const visible = suggestions.slice(0, 8);
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
      `Selected · /model ${currentModel}`,
      `Reasoning · ${currentMeta.reasoning}`,
      ...(currentMeta.support ? [`Support · ${currentMeta.support}`] : []),
      "",
      "Available",
      ...modelEntries.map((entry) => `${visible.indexOf(entry) === selected ? "›" : " "} ${entry.command}  ${formatModelSuggestionDescription(entry.description)}`),
      "",
      "Routes",
      "/model shows this picker.",
      "/model <id> switches now.",
      "/model list shows all model picks.",
      "↑↓ · Tab · Enter",
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
  const visible = suggestions.slice(0, 8);
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
        "↑↓ · Tab · Enter",
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
      ...visible.flatMap((entry, index) => [`${index === selected ? "›" : " "} ${entry.command}`, `  ${entry.description}`]),
      "",
      "↑↓ · Tab · Enter",
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
      "/ starts commands. Tab completes.",
      "/context, /reasoning, /model, /sessions, /reload",
      "/doctor, /auth status, /auth login, /auth key, /mcp list, /mode status",
      "/research <topic>, /research status, /review, /commit",
      "/skills, /skill <name>, /memories, /clear, /help, /exit",
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
