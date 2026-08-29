/**
 * `/auth` provider catalog — the OMP-style credential selector.
 *
 * Chrome follows the work shell's existing overlay language (single-line
 * border, section header, dim subtitle, footer hints) and paints entirely
 * through the active palette: the accent tier for the header and key glyphs,
 * the soft border tone as the selected row's full-width ground, and the dim
 * tier for provenance and scroll state. No hex, no per-component pigment.
 */

import { Box, Text } from "ink";
import React from "react";

import type { ContextInspectorPalette } from "./work-shell-context-inspector-model.js";
import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";
import {
  layoutOmpAuthPickerKeyHints,
  clampOmpAuthPickerCursor,
  describeOmpAuthCatalogError,
  describeOmpAuthProviderRow,
  filterOmpAuthProviders,
  formatOmpAuthPickerScrollSummary,
  resolveOmpAuthPickerViewport,
  type OmpAuthPickerCatalog,
  type OmpAuthProviderRowView,
} from "./work-shell-auth-provider-picker-model.js";

export type OmpAuthProviderPickerInput = {
  readonly catalog: OmpAuthPickerCatalog;
  readonly query: string;
  readonly cursor: number;
  readonly width: number;
  readonly borderColor: string;
  readonly palette: ContextInspectorPalette;
  readonly signInReceipt?: string;
  readonly maxRows?: number;
  readonly uiLocale?: "en" | "ko";
};

/** Rows shown at once. Narrow terminals give up rows before they give up chrome. */
const DEFAULT_MAX_ROWS = 8;
const NARROW_COLUMNS = 60;
const NARROW_MAX_ROWS = 5;

function toneColor(tone: OmpAuthProviderRowView["tone"], palette: ContextInspectorPalette): string {
  if (tone === "signed-in") {
    return palette.success;
  }
  return tone === "unavailable" ? palette.textDim : palette.textMuted;
}

/**
 * One provider line: `› ● Name            provenance`.
 *
 * The selected row takes a full-width slate ground, so the name is padded to
 * the content width rather than trailing off after the text — a background
 * that stops mid-row reads as a highlight artefact, not a selection.
 */
function renderProviderRow(input: {
  readonly view: OmpAuthProviderRowView;
  readonly selected: boolean;
  readonly contentWidth: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const { palette, view } = input;
  const marker = input.selected ? "› " : "  ";
  const prefix = `${marker}${view.glyph} `;
  const provenance = ` ${view.provenance}`;
  const nameWidth = Math.max(
    4,
    input.contentWidth - getDisplayWidth(prefix) - getDisplayWidth(provenance),
  );
  const name = truncateForDisplayWidth(view.name, nameWidth);
  const padding = " ".repeat(Math.max(0, nameWidth - getDisplayWidth(name)));
  const rowProps = input.selected ? { backgroundColor: palette.borderSoft } : {};

  return (
    <Text key={view.id} {...rowProps} wrap="truncate">
      <Text color={input.selected ? palette.assistant : palette.textDim}>{marker}</Text>
      <Text color={toneColor(view.tone, palette)}>{`${view.glyph} `}</Text>
      <Text color={input.selected ? palette.text : palette.textMuted} bold={input.selected}>
        {name}
      </Text>
      <Text>{padding}</Text>
      <Text color={palette.textDim}>{provenance}</Text>
    </Text>
  );
}

function renderKeyHints(palette: ContextInspectorPalette, contentWidth: number, uiLocale: "en" | "ko"): React.ReactNode {
  return layoutOmpAuthPickerKeyHints(contentWidth).map((row) => (
    <Text key={row.map((hint) => hint.key).join("|")} wrap="truncate">
      {row.map((hint, index) => (
        <Text key={hint.key}>
          {index === 0 ? "" : <Text color={palette.borderSoft}>{"  "}</Text>}
          <Text color={palette.assistant}>{hint.key}</Text>
          <Text color={palette.textDim}>{` ${uiLocale === "ko" ? ({ provider: "제공자", filter: "필터", edit: "편집", "sign in": "로그인", "back to work": "작업으로" } as Record<string, string>)[hint.label] ?? hint.label : hint.label}`}</Text>
        </Text>
      ))}
    </Text>
  ));
}

function renderCatalogBody(input: OmpAuthProviderPickerInput, contentWidth: number): React.ReactNode {
  const { catalog, palette } = input;
  const ko = input.uiLocale === "ko";

  if (catalog.status === "loading") {
    return <Text color={palette.textMuted} wrap="truncate">{ko ? "OMP 자격 증명 목록 읽는 중…" : "Reading OMP credential catalog…"}</Text>;
  }

  if (catalog.status === "error") {
    return (
      <Box flexDirection="column">
        <Text color={palette.warning} wrap="truncate">{describeOmpAuthCatalogError(catalog.code)}</Text>
        <Text color={palette.textDim} wrap="truncate">{catalog.message}</Text>
        <Text color={palette.textDim} wrap="truncate">
          {ko ? "로그인은 OMP가 담당하며 여기서는 아무것도 변경하지 않았습니다." : "Sign-in is owned by OMP; nothing was changed here."}
        </Text>
      </Box>
    );
  }

  const matches = filterOmpAuthProviders(catalog.providers, input.query);
  const maxRows = input.maxRows ?? (input.width < NARROW_COLUMNS ? NARROW_MAX_ROWS : DEFAULT_MAX_ROWS);
  const viewport = resolveOmpAuthPickerViewport({
    rowCount: matches.length,
    cursor: input.cursor,
    maxRows,
  });
  const cursor = clampOmpAuthPickerCursor(input.cursor, matches.length);

  return (
    <Box flexDirection="column">
      {matches.slice(viewport.start, viewport.end).map((row, index) =>
        renderProviderRow({
          view: localizeProviderRow(describeOmpAuthProviderRow(row), input.uiLocale ?? "en"),
          selected: viewport.start + index === cursor,
          contentWidth,
          palette,
        }))}
      <Text color={palette.textDim} wrap="truncate">
        {localizeAuthSummary(formatOmpAuthPickerScrollSummary({
          hiddenBefore: viewport.hiddenBefore,
          hiddenAfter: viewport.hiddenAfter,
          matched: matches.length,
          total: catalog.providers.length,
        }), input.uiLocale ?? "en")}
      </Text>
    </Box>
  );
}

export function renderOmpAuthProviderPicker(input: OmpAuthProviderPickerInput): React.ReactNode {
  const { palette } = input;
  const width = Math.max(28, input.width);
  const contentWidth = Math.max(20, width - 4);

  return (
    <Box
      marginTop={1}
      borderStyle="single"
      borderColor={input.borderColor}
      paddingX={1}
      flexDirection="column"
      width={width}
    >
      <Text wrap="truncate">
        <Text color={palette.warning} bold>{input.uiLocale === "ko" ? "OMP 제공자" : "OMP providers"}</Text>
        <Text color={palette.textDim}>{input.uiLocale === "ko" ? " · OMP가 자격 증명 관리" : " · credentials owned by OMP"}</Text>
      </Text>
      <Text wrap="truncate">
        <Text color={palette.assistant}>{"⌕ "}</Text>
        {input.query.length > 0
          ? <Text color={palette.text}>{truncateForDisplayWidth(input.query, contentWidth - 2)}</Text>
          : <Text color={palette.textDim}>{input.uiLocale === "ko" ? "입력하여 필터" : "type to filter"}</Text>}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {renderCatalogBody(input, contentWidth)}
      </Box>
      {input.signInReceipt ? (
        <Box marginTop={1}>
          <Text color={palette.warning} wrap="truncate">{input.signInReceipt}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">{renderKeyHints(palette, contentWidth, input.uiLocale ?? "en")}</Box>
    </Box>
  );
}

function localizeProviderRow(view: OmpAuthProviderRowView, uiLocale: "en" | "ko"): OmpAuthProviderRowView {
  if (uiLocale === "en") return view;
  return {
    ...view,
    provenance: view.provenance
      .replace(/^unavailable$/u, "사용 불가")
      .replace(/^not signed in$/u, "로그인 안 됨")
      .replace(/^signed in$/u, "로그인됨")
      .replace(/^runtime key$/u, "런타임 키")
      .replace(/^config key$/u, "설정 키")
      .replace(/^api key$/u, "API 키")
      .replace(/^fallback key$/u, "대체 키"),
  };
}

function localizeAuthSummary(value: string, uiLocale: "en" | "ko"): string {
  if (uiLocale === "en") return value;
  return value
    .replace(/no provider matches/gu, "일치하는 제공자 없음")
    .replace(/in catalog/gu, "목록에 있음")
    .replace(/providers/gu, "개 제공자")
    .replace(/ of /gu, "/")
    .replace(/ more/gu, " 더 있음");
}
