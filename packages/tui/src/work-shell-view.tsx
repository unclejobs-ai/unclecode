import { Box, Newline, Text } from "ink";
import React from "react";

export type WorkShellEntryRole = "user" | "assistant" | "tool" | "system";

export type WorkShellEntry = {
  readonly role: WorkShellEntryRole;
  readonly text: string;
};

export type WorkShellPanel = {
  readonly title: string;
  readonly lines: readonly string[];
};

export type WorkShellEntryPresentation = {
  readonly label: string;
  readonly badge: string;
  readonly labelColor: string;
  readonly borderColor?: string;
  readonly bodyColor: string;
};

export function formatWorkShellProviderTitle(provider: string): string {
  if (provider === "openai" || provider === "openai-api") return "UncleCode · OpenAI API";
  if (provider === "openai-codex") return "UncleCode · OpenAI Codex";
  if (provider === "gemini") return "UncleCode · Gemini";
  if (provider === "anthropic") return "UncleCode · Anthropic";
  return `UncleCode · ${provider}`;
}

export function getWorkShellEntryPresentation(role: WorkShellEntryRole): WorkShellEntryPresentation {
  if (role === "user") {
    return { label: "Request", badge: "◉", labelColor: "cyan", borderColor: "cyan", bodyColor: "white" };
  }
  if (role === "assistant") {
    return { label: "Answer", badge: "✦", labelColor: "green", borderColor: "green", bodyColor: "white" };
  }
  if (role === "tool") {
    return { label: "Step", badge: "→", labelColor: "magenta", borderColor: "magenta", bodyColor: "white" };
  }
  return { label: "Status", badge: "·", labelColor: "gray", borderColor: "gray", bodyColor: "gray" };
}

export function getWorkShellConversationLayout(role: WorkShellEntryRole): {
  readonly marginBottom: number;
  readonly paddingLeft: number;
  readonly hasBorder: boolean;
} {
  if (role === "system") {
    return { marginBottom: 1, paddingLeft: 1, hasBorder: true };
  }
  if (role === "assistant") {
    return { marginBottom: 1, paddingLeft: 2, hasBorder: true };
  }

  return { marginBottom: 1, paddingLeft: 1, hasBorder: true };
}

export function getWorkShellEntryBorderStyle(role: WorkShellEntryRole): "round" | "single" {
  return role === "tool" || role === "system" ? "single" : "round";
}

export function getWorkShellEmptyConversationHint(): string {
  return "Start typing. /auth shows sign-in routes.";
}

export function getWorkShellPanelBorderColor(inputValue: string, panelTitle: string): string {
  if (inputValue.trim().startsWith("/")) {
    return "cyan";
  }
  if (panelTitle === "Auth") {
    return "green";
  }
  if (panelTitle === "Commands" || panelTitle === "Models") {
    return "cyan";
  }
  return "gray";
}

export function getWorkShellPanelDisplayMode(input: {
  readonly panelTitle: string;
  readonly inputValue: string;
  readonly terminalColumns?: number;
}): "hidden" | "overlay" | "side" | "bottom" {
  const terminalColumns = input.terminalColumns ?? process.stdout.columns ?? 120;
  const slashActive = input.inputValue.trim().startsWith("/");
  const interactivePanel = input.panelTitle === "Auth" || input.panelTitle === "Commands" || input.panelTitle === "Models";

  if (input.panelTitle === "Context") {
    return "hidden";
  }
  if (input.panelTitle === "Context expanded") {
    return "overlay";
  }
  if (slashActive && interactivePanel && terminalColumns >= 160) {
    return "side";
  }

  return "bottom";
}

export function getWorkShellPanelPlacement(input: {
  readonly panelTitle: string;
  readonly inputValue: string;
  readonly terminalColumns?: number;
}): "side" | "bottom" {
  return getWorkShellPanelDisplayMode(input) === "side" ? "side" : "bottom";
}

export function getWorkShellPanelAnchor(displayMode: "hidden" | "overlay" | "side" | "bottom"): "with-conversation" | "after-composer" {
  return displayMode === "side" ? "with-conversation" : "after-composer";
}

export function getWorkShellBottomDrawerMinHeight(
  displayMode: "hidden" | "overlay" | "side" | "bottom",
  panelTitle: string,
  inputValue: string,
): number {
  if (displayMode !== "bottom") {
    return 0;
  }
  if (inputValue.trim().startsWith("/")) {
    return 8;
  }
  if (
    panelTitle === "Commands" ||
    panelTitle === "Auth" ||
    panelTitle === "Models" ||
    panelTitle === "Session status" ||
    panelTitle === "Doctor" ||
    panelTitle === "Mode" ||
    panelTitle === "MCP"
  ) {
    return 8;
  }
  return 0;
}

export function getWorkShellComposerHintMinHeight(): 1 {
  return 1;
}

export function getWorkShellAttachmentPlacement(): "after-composer" {
  return "after-composer";
}

export function getWorkShellAttachmentMinHeight(): 4 {
  return 4;
}

export function getWorkShellAttachmentLineColor(index: number): string {
  if (index === 0) {
    return "cyan";
  }
  if (index === 1) {
    return "white";
  }
  return "gray";
}

export function getWorkShellComposerHint(inputValue: string, slashSuggestionCount: number): string | undefined {
  if (!inputValue.trim().startsWith("/")) {
    return undefined;
  }
  return slashSuggestionCount > 0 ? "↑↓ · Tab · Enter" : "No slash yet.";
}

function compactWorkShellReasoningLabel(reasoningLabel: string): string {
  return reasoningLabel.replace(/\s*\([^)]*\)$/, "").trim();
}

function compactWorkShellAuthLabel(authLabel: string): string {
  if (authLabel === "Browser OAuth · file") return "OAuth file";
  if (authLabel === "Browser OAuth · env") return "OAuth env";
  if (authLabel === "API key · file") return "Key file";
  if (authLabel === "API key · env") return "Key env";
  if (authLabel === "Not signed in") return "No auth";
  return authLabel;
}

export function formatWorkShellStatusLine(input: {
  readonly model: string;
  readonly reasoningLabel: string;
  readonly mode: string;
  readonly authLabel: string;
}): string {
  return [
    input.model,
    compactWorkShellReasoningLabel(input.reasoningLabel),
    input.mode,
    compactWorkShellAuthLabel(input.authLabel),
  ].join(" · ");
}

export function parseWorkShellPanelFactLine(line: string): { readonly label: string; readonly value: string } | undefined {
  const match = /^(?!\/)([A-Z][A-Za-z ]+)\s·\s(.+)$/.exec(line.trim());
  if (!match) {
    return undefined;
  }
  return {
    label: match[1] ?? "",
    value: match[2] ?? "",
  };
}

export function isWorkShellWarningLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return normalized.includes("unsupported") ||
    normalized.includes("unavailable") ||
    normalized.includes("needs refresh") ||
    normalized.includes("lacks") ||
    normalized.startsWith("warning ·");
}

function renderWorkShellPanelLine(line: string, index: number): React.ReactNode {
  const trimmed = line.trim();
  const sectionHeaders = new Set(["Workspace", "Guidance", "Bridge", "Memory", "Live steps", "Current", "Available", "Routes", "Next"]);
  if (trimmed.length === 0) {
    return <Text key={`${index}-blank`}> </Text>;
  }
  if (sectionHeaders.has(trimmed)) {
    return (
      <Box key={`${index}-${line}`} marginTop={index === 0 ? 0 : 1}>
        <Text bold color="white">{trimmed}</Text>
      </Box>
    );
  }
  const treeMatch = /^(├|└)\s+([^\s].*?)(\s{2,})(.+)$/.exec(line);
  if (treeMatch) {
    const branch = treeMatch[1] ?? "";
    const label = treeMatch[2] ?? "";
    const spacing = treeMatch[3] ?? " ";
    const value = treeMatch[4] ?? "";
    return (
      <Text key={`${index}-${line}`} color="gray">
        {branch} <Text color="cyan">{label.trim()}</Text>
        {spacing}
        <Text color="white">{value}</Text>
      </Text>
    );
  }
  const suggestionMatch = /^(›| )\s+(\/\S(?:.*?))(\s{2,})(.+)$/.exec(line);
  if (suggestionMatch) {
    const marker = suggestionMatch[1] ?? " ";
    const command = suggestionMatch[2] ?? "";
    const spacing = suggestionMatch[3] ?? "  ";
    const description = suggestionMatch[4] ?? "";
    const isSelected = marker === "›";
    return (
      <Text key={`${index}-${line}`}>
        <Text color={isSelected ? "cyanBright" : "gray"}>{marker}</Text>
        <Text color={isSelected ? "cyanBright" : "cyan"}> {command}</Text>
        <Text color={isWorkShellWarningLine(description) ? "yellow" : isSelected ? "white" : "gray"}>{spacing}{description}</Text>
      </Text>
    );
  }
  if (trimmed.startsWith("› /")) {
    return <Text key={`${index}-${line}`} color="cyanBright">{trimmed}</Text>;
  }
  if (trimmed.startsWith("/")) {
    return <Text key={`${index}-${line}`} color="cyan">{trimmed}</Text>;
  }
  const factLine = parseWorkShellPanelFactLine(trimmed);
  if (factLine) {
    const labelColor = factLine.label === "Warning" ? "yellow" : "cyan";
    const valueColor = isWorkShellWarningLine(trimmed) ? "yellow" : "white";
    return (
      <Text key={`${index}-${line}`}>
        <Text color={labelColor}>{factLine.label}</Text>
        <Text color="gray"> · </Text>
        <Text color={valueColor}>{factLine.value}</Text>
      </Text>
    );
  }
  if (trimmed.startsWith("Signed in · ")) {
    return <Text key={`${index}-${line}`} color="green">{trimmed}</Text>;
  }
  if (trimmed === "Not signed in yet" || trimmed === "Not signed in") {
    return <Text key={`${index}-${line}`} color="yellow">{trimmed}</Text>;
  }
  if (trimmed === "Current" || trimmed === "Routes" || trimmed === "Next") {
    return <Text key={`${index}-${line}`} color="white" bold>{trimmed}</Text>;
  }
  if (trimmed.startsWith("Browser OAuth needs refresh") || trimmed.startsWith("Browser OAuth unavailable")) {
    return <Text key={`${index}-${line}`} color="yellow">{trimmed}</Text>;
  }
  if (trimmed.startsWith("Tip · ")) {
    return <Text key={`${index}-${line}`} color="gray">{trimmed}</Text>;
  }
  if (trimmed.startsWith("↑↓") || trimmed.startsWith("No slash")) {
    return <Text key={`${index}-${line}`} color="yellow">{trimmed}</Text>;
  }
  if (trimmed.startsWith("Matches for ") || trimmed.endsWith(" matches")) {
    return <Text key={`${index}-${line}`} color="gray">{trimmed}</Text>;
  }
  if (line.startsWith("  ")) {
    return <Text key={`${index}-${line}`} color="gray">{line}</Text>;
  }
  return <Text key={`${index}-${line}`} color="white">{line}</Text>;
}

export function WorkShellView(props: {
  readonly provider: string;
  readonly model: string;
  readonly reasoningLabel: string;
  readonly reasoningSupported: boolean;
  readonly mode: string;
  readonly authLabel: string;
  readonly entries: readonly WorkShellEntry[];
  readonly isBusy: boolean;
  readonly activePanel: WorkShellPanel;
  readonly attachmentLines?: readonly string[];
  readonly composer: React.ReactNode;
  readonly inputValue: string;
  readonly slashSuggestionCount: number;
  readonly headerHint?: string;
  readonly composerHintOverride?: string;
  readonly terminalColumns?: number;
}) {
  const composerHint = props.composerHintOverride ?? getWorkShellComposerHint(props.inputValue, props.slashSuggestionCount);

  const panelBorderColor = getWorkShellPanelBorderColor(props.inputValue, props.activePanel.title);
  const panelDisplayMode = getWorkShellPanelDisplayMode({
    panelTitle: props.activePanel.title,
    inputValue: props.inputValue,
    ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
  });
  const panelPlacement = panelDisplayMode === "side" ? "side" : "bottom";

  const conversation = (
    <Box flexDirection="column" width={panelPlacement === "side" ? "68%" : undefined} paddingRight={panelPlacement === "side" ? 1 : 0}>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text bold color="white">Conversation</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {props.entries.length === 0 ? (
          <Text color="gray">{getWorkShellEmptyConversationHint()}</Text>
        ) : props.entries.slice(-12).map((entry, index) => {
          const presentation = getWorkShellEntryPresentation(entry.role);
          const layout = getWorkShellConversationLayout(entry.role);
          return (
            <Box
              key={`${entry.role}-${index}`}
              marginBottom={layout.marginBottom}
              {...(layout.hasBorder && presentation.borderColor
                ? {
                    borderStyle: getWorkShellEntryBorderStyle(entry.role),
                    borderColor: presentation.borderColor,
                    paddingX: 1,
                    paddingY: 0,
                  }
                : {})}
              paddingLeft={layout.paddingLeft}
              flexDirection="column"
            >
              <Text bold color={presentation.labelColor}>{`${presentation.badge} ${presentation.label}`}</Text>
              <Text color={presentation.bodyColor}>{entry.text}</Text>
            </Box>
          );
        })}
        {props.isBusy ? (
          <Text color="gray">
            thinking…
            <Newline />
          </Text>
        ) : null}
      </Box>
    </Box>
  );

  const panel = (
    <Box flexDirection="column" width={panelPlacement === "side" ? "32%" : undefined} paddingLeft={panelPlacement === "side" ? 1 : 0} marginTop={panelPlacement === "bottom" ? 1 : 0}>
      <Box borderStyle="round" borderColor={panelBorderColor} paddingX={1}>
        <Text bold color="white">{props.activePanel.title}</Text>
      </Box>
      <Box
        marginTop={1}
        flexDirection="column"
        paddingLeft={1}
        minHeight={getWorkShellBottomDrawerMinHeight(panelDisplayMode, props.activePanel.title, props.inputValue)}
      >
        {props.activePanel.lines.map((line, index) => renderWorkShellPanelLine(line, index))}
      </Box>
    </Box>
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>{formatWorkShellProviderTitle(props.provider)}</Text>
        <Text color="gray">{props.headerHint ?? "Esc · /auth · /context"}</Text>
      </Box>
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text>
          <Text color="cyan">{props.model}</Text>
          <Text color="gray">  ·  </Text>
          <Text color={props.reasoningSupported ? "green" : "yellow"}>
            {compactWorkShellReasoningLabel(props.reasoningLabel)}
          </Text>
          <Text color="gray">  ·  </Text>
          <Text color="magenta">{props.mode}</Text>
          <Text color="gray">  ·  </Text>
          <Text color="yellow">{compactWorkShellAuthLabel(props.authLabel)}</Text>
        </Text>
      </Box>
      {getWorkShellPanelAnchor(panelDisplayMode) === "with-conversation" ? (
        <Box marginTop={1}>
          {conversation}
          {panel}
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {conversation}
        </Box>
      )}
      <Box marginTop={1} borderStyle="single" borderColor={props.inputValue.trim().startsWith("/") ? "cyan" : "gray"} paddingX={1}>
        <Text color="gray">{"> "}</Text>
        {props.composer}
      </Box>
      <Box minHeight={getWorkShellComposerHintMinHeight()}>
        <Text color="gray">{composerHint ?? " "}</Text>
      </Box>
      {props.attachmentLines && props.attachmentLines.length > 0 && getWorkShellAttachmentPlacement() === "after-composer" ? (
        <Box marginTop={1} flexDirection="column">
          <Box borderStyle="round" borderColor="cyan" paddingX={1}>
            <Text bold color="cyan">Attachments</Text>
          </Box>
          <Box marginTop={1} flexDirection="column" paddingLeft={1} minHeight={getWorkShellAttachmentMinHeight()}>
            {props.attachmentLines.map((line, index) => (
              <Text key={`${index}-${line}`} color={getWorkShellAttachmentLineColor(index)}>{line}</Text>
            ))}
          </Box>
        </Box>
      ) : null}
      {panelDisplayMode === "overlay" ? (
        <Box marginTop={1} borderStyle="round" borderColor={panelBorderColor} paddingX={1} flexDirection="column">
          <Text bold color="white">{props.activePanel.title}</Text>
          <Text color="gray">Esc closes · /context refreshes</Text>
          <Box marginTop={1} flexDirection="column">
            {props.activePanel.lines.map((line, index) => renderWorkShellPanelLine(line, index))}
          </Box>
        </Box>
      ) : panelDisplayMode === "bottom" ? (
        panel
      ) : null}
    </Box>
  );
}
