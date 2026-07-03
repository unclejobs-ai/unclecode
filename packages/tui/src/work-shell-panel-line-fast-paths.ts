export type WorkShellPanelLineClass =
  | { readonly kind: "blank"; readonly trimmed: string }
  | { readonly kind: "section"; readonly trimmed: string }
  | { readonly kind: "tree"; readonly branch: string; readonly label: string; readonly spacing: string; readonly value: string }
  | {
    readonly kind: "suggestion";
    readonly marker: string;
    readonly command: string;
    readonly spacing: string;
    readonly description: string;
    readonly isSelected: boolean;
    readonly isWarning: boolean;
  }
  | { readonly kind: "selected-command" | "command" | "signed-in" | "not-signed-in" | "warning" | "tip" | "hint-warning" | "match-summary"; readonly trimmed: string }
  | { readonly kind: "fact"; readonly label: string; readonly value: string; readonly isWarning: boolean }
  | { readonly kind: "indent"; readonly line: string; readonly trimmed: string }
  | { readonly kind: "text"; readonly line: string; readonly trimmed: string };

const SECTION_HEADERS = new Set([
  "Workspace",
  "Snapshot",
  "Issues",
  "Guidance",
  "Bridge",
  "Memory",
  "Live steps",
  "Current",
  "Current model",
  "Available",
  "Choose",
  "Pick model",
  "Filter",
  "Controls",
  "Routes",
  "Next",
  "Backlog",
  "Steer",
]);

export function classifyWorkShellPanelLineFast(line: string): WorkShellPanelLineClass {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { kind: "blank", trimmed };
  }
  if (SECTION_HEADERS.has(trimmed)) {
    return { kind: "section", trimmed };
  }
  const tree = parseTreeLine(line);
  if (tree) {
    return tree;
  }
  const suggestion = parseSuggestionLine(line);
  if (suggestion) {
    return suggestion;
  }
  if (trimmed.startsWith("› /")) {
    return { kind: "selected-command", trimmed };
  }
  if (trimmed.startsWith("/")) {
    return { kind: "command", trimmed };
  }
  const fact = parsePanelFactLine(trimmed);
  if (fact) {
    return fact;
  }
  if (trimmed.startsWith("Signed in · ")) {
    return { kind: "signed-in", trimmed };
  }
  if (trimmed === "Not signed in yet" || trimmed === "Not signed in") {
    return { kind: "not-signed-in", trimmed };
  }
  if (
    trimmed.startsWith("Browser OAuth needs refresh") ||
    trimmed.startsWith("Browser OAuth unavailable")
  ) {
    return { kind: "warning", trimmed };
  }
  if (trimmed.startsWith("Tip · ")) {
    return { kind: "tip", trimmed };
  }
  if (trimmed.startsWith("↑↓") || trimmed.startsWith("No slash")) {
    return { kind: "hint-warning", trimmed };
  }
  if (trimmed.startsWith("Matches for ") || trimmed.endsWith(" matches")) {
    return { kind: "match-summary", trimmed };
  }
  if (line.startsWith("  ")) {
    return { kind: "indent", line, trimmed };
  }
  return { kind: "text", line, trimmed };
}

function parseTreeLine(line: string): WorkShellPanelLineClass | undefined {
  const trimmed = line.trimStart();
  const branch = trimmed[0];
  if (branch !== "├" && branch !== "└") {
    return undefined;
  }
  const rest = trimmed.slice(branch.length);
  if (!rest.startsWith(" ")) {
    return undefined;
  }
  const split = splitLabelSpacingValue(rest.slice(1));
  if (!split) {
    return undefined;
  }
  return {
    kind: "tree",
    branch,
    label: split.label.trim(),
    spacing: split.spacing,
    value: split.value,
  };
}

function parseSuggestionLine(line: string): WorkShellPanelLineClass | undefined {
  const marker = line[0];
  if (marker !== "›" && marker !== " ") {
    return undefined;
  }
  const rest = line.slice(marker.length);
  if (!rest.startsWith(" ") || !rest.slice(1).startsWith("/")) {
    return undefined;
  }
  const split = splitLabelSpacingValue(rest.slice(1));
  if (!split) {
    return undefined;
  }
  return {
    kind: "suggestion",
    marker,
    command: split.label,
    spacing: split.spacing,
    description: split.value,
    isSelected: marker === "›",
    isWarning: isWorkShellWarningLineFast(split.value),
  };
}

function splitLabelSpacingValue(value: string): { readonly label: string; readonly spacing: string; readonly value: string } | undefined {
  const match = /^(.*?)( {2,})(.*)$/.exec(value);
  if (!match) {
    return undefined;
  }
  return {
    label: match[1] ?? "",
    spacing: match[2] ?? "",
    value: match[3] ?? "",
  };
}

function parsePanelFactLine(line: string): WorkShellPanelLineClass | undefined {
  if (line.startsWith("/")) {
    return undefined;
  }
  const separator = line.indexOf(" · ");
  if (separator === -1) {
    return undefined;
  }
  const label = line.slice(0, separator);
  const value = line.slice(separator + 3);
  if (label.length === 0 || !/^[A-Z][A-Za-z ]*$/.test(label)) {
    return undefined;
  }
  return {
    kind: "fact",
    label,
    value,
    isWarning: isWorkShellWarningLineFast(line),
  };
}

export function isWorkShellWarningLineFast(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return (
    normalized.includes("unsupported") ||
    normalized.includes("unavailable") ||
    normalized.includes("needs refresh") ||
    normalized.includes("lacks") ||
    normalized.startsWith("warning ·")
  );
}
