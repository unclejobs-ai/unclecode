/**
 * Pure model behind the `/auth` provider catalog.
 *
 * The port types below are declared here: the TUI is the UI layer and must
 * not depend on infrastructure. The app implements a structurally compatible
 * port over UncleCode's credential store (`apps/unclecode-cli/src/provider-auth.ts`)
 * and wires it in at the pane boundary — assignability is the whole contract.
 *
 * Nothing here holds a credential. A row carries whether the app has auth for a
 * provider, which cascade leg supplied it, and — for the env leg — the
 * variable's NAME. Never a value.
 */

import { getDisplayWidth } from "./text-width.js";

/** Where a provider's active credential comes from. */
export type ProviderCredentialOriginKind = "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";

export type ProviderAuthRow = {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly storeCredentialsAs?: string;
  readonly credentialKey: string;
  readonly signedIn: boolean;
  readonly originKind?: ProviderCredentialOriginKind;
  readonly originEnvVar?: string;
};

export type ProviderAuthCatalogErrorCode =
  | "AUTH_UNAVAILABLE"
  | "AUTH_CATALOG_UNAVAILABLE"
  | "AUTH_PROTOCOL_ERROR";

export type ProviderAuthCatalogResult =
  | { readonly ok: true; readonly dbPath: string; readonly providers: readonly ProviderAuthRow[] }
  | { readonly ok: false; readonly error: { readonly code: ProviderAuthCatalogErrorCode; readonly message: string } };

export type ProviderAuthSignInHandoff =
  | { readonly ok: true; readonly binPath: string; readonly argv: readonly string[]; readonly command: string }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "AUTH_UNAVAILABLE" | "SIGN_IN_UNAVAILABLE";
        readonly message: string;
      };
    };

/** Injected at the pane boundary by the app. The TUI never constructs one. */
export type ProviderAuthCatalogPort = {
  list(): Promise<ProviderAuthCatalogResult>;
  signIn(providerId: string): Promise<ProviderAuthSignInHandoff>;
};

/** What the picker knows right now. "loading" is a real state, not an empty list. */
export type ProviderAuthPickerCatalog =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly providers: readonly ProviderAuthRow[] }
  | { readonly status: "error"; readonly code: ProviderAuthCatalogErrorCode; readonly message: string };

export type ProviderAuthRowView = {
  readonly id: string;
  readonly name: string;
  readonly glyph: string;
  readonly tone: "signed-in" | "available" | "unavailable";
  readonly provenance: string;
};

/**
 * `/auth <word>` forms that are existing shell actions rather than a provider
 * filter. They keep routing to the engine so the OpenAI-specific auth surface
 * stays reachable behind the catalog.
 */
const RESERVED_AUTH_SUBCOMMANDS: Readonly<Record<string, true>> = {
  status: true,
  login: true,
  key: true,
  logout: true,
  browser: true,
};

const PROVENANCE_BY_ORIGIN: Readonly<Record<ProviderCredentialOriginKind, string>> = {
  runtime: "runtime key",
  config: "config key",
  oauth: "oauth",
  api_key: "api key",
  env: "env",
  fallback: "fallback key",
};

export type ProviderAuthPickerKeyHint = { readonly key: string; readonly label: string };

export const PROVIDER_AUTH_PICKER_KEY_HINTS: readonly ProviderAuthPickerKeyHint[] = [
  { key: "↑↓", label: "provider" },
  { key: "type", label: "filter" },
  { key: "⌫", label: "edit" },
  { key: "Enter", label: "sign in" },
  { key: "Esc", label: "back to work" },
];

/** Gap between two hints on the same footer row. */
const KEY_HINT_GAP = 2;

/**
 * Wrap the footer onto as many rows as the width needs.
 *
 * A narrow terminal must not silently lose `Enter sign in` off the right edge:
 * truncating the hint strip hides the only affordance that does anything.
 */
export function layoutProviderAuthPickerKeyHints(
  contentWidth: number,
): readonly (readonly ProviderAuthPickerKeyHint[])[] {
  const limit = Math.max(8, Math.trunc(contentWidth));
  const rows: ProviderAuthPickerKeyHint[][] = [];
  let current: ProviderAuthPickerKeyHint[] = [];
  let used = 0;
  for (const hint of PROVIDER_AUTH_PICKER_KEY_HINTS) {
    const hintWidth = getDisplayWidth(hint.key) + 1 + getDisplayWidth(hint.label);
    const nextWidth = current.length === 0 ? hintWidth : used + KEY_HINT_GAP + hintWidth;
    if (current.length > 0 && nextWidth > limit) {
      rows.push(current);
      current = [hint];
      used = hintWidth;
      continue;
    }
    current.push(hint);
    used = nextWidth;
  }
  if (current.length > 0) {
    rows.push(current);
  }
  return rows;
}

/** Text typed after `/auth`, which doubles as the catalog filter. */
export function resolveProviderAuthPickerQuery(inputValue: string): string {
  const trimmed = inputValue.trim();
  if (trimmed !== "/auth" && !trimmed.startsWith("/auth ")) {
    return "";
  }
  return trimmed.slice("/auth".length).trim().replace(/\s+/g, " ");
}

export function filterProviderAuths(
  providers: readonly ProviderAuthRow[],
  query: string,
): readonly ProviderAuthRow[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return providers;
  }
  return providers.filter(
    (row) => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle),
  );
}

export function clampProviderAuthPickerCursor(cursor: number, rowCount: number): number {
  if (rowCount <= 0) {
    return 0;
  }
  return Math.min(rowCount - 1, Math.max(0, Math.trunc(cursor)));
}

export function moveProviderAuthPickerCursor(cursor: number, direction: -1 | 1, rowCount: number): number {
  return clampProviderAuthPickerCursor(clampProviderAuthPickerCursor(cursor, rowCount) + direction, rowCount);
}

export function describeProviderAuthRow(row: ProviderAuthRow): ProviderAuthRowView {
  const base = { id: row.id, name: row.name } as const;
  if (!row.available) {
    return { ...base, glyph: "×", tone: "unavailable", provenance: "unavailable" };
  }
  if (!row.signedIn) {
    return { ...base, glyph: "○", tone: "available", provenance: "not signed in" };
  }
  const origin = row.originKind ? PROVENANCE_BY_ORIGIN[row.originKind] : undefined;
  const named = row.originKind === "env" && row.originEnvVar
    ? `env ${row.originEnvVar}`
    : origin ?? "signed in";
  // Credential aliasing is load-bearing: `zai-coding-plan` signs you in as
  // `zai`, so hiding the alias would make two rows look independently signed in.
  const aliased = row.storeCredentialsAs && row.storeCredentialsAs !== row.id
    ? `${named} · stored as ${row.storeCredentialsAs}`
    : named;
  return { ...base, glyph: "●", tone: "signed-in", provenance: aliased };
}

export type ProviderAuthPickerViewport = {
  readonly start: number;
  readonly end: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
};

/** Window of rows to paint, scrolled so the cursor stays inside it. */
export function resolveProviderAuthPickerViewport(input: {
  readonly rowCount: number;
  readonly cursor: number;
  readonly maxRows: number;
}): ProviderAuthPickerViewport {
  const maxRows = Math.max(1, Math.trunc(input.maxRows));
  const rowCount = Math.max(0, Math.trunc(input.rowCount));
  if (rowCount <= maxRows) {
    return { start: 0, end: rowCount, hiddenBefore: 0, hiddenAfter: 0 };
  }
  const cursor = clampProviderAuthPickerCursor(input.cursor, rowCount);
  // Centre the cursor, then push the window back inside both ends.
  const start = Math.min(
    Math.max(0, cursor - Math.floor((maxRows - 1) / 2)),
    rowCount - maxRows,
  );
  const end = start + maxRows;
  return { start, end, hiddenBefore: start, hiddenAfter: rowCount - end };
}

export function formatProviderAuthPickerScrollSummary(input: {
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
  readonly matched: number;
  readonly total: number;
}): string {
  if (input.matched === 0) {
    return `no provider matches · ${input.total} in catalog`;
  }
  const count = input.matched === input.total
    ? `${input.total} providers`
    : `${input.matched} of ${input.total} providers`;
  const scroll = [
    input.hiddenBefore > 0 ? `↑ ${input.hiddenBefore} more` : undefined,
    input.hiddenAfter > 0 ? `↓ ${input.hiddenAfter} more` : undefined,
  ].filter((part): part is string => part !== undefined);
  return [count, ...scroll].join(" · ");
}

export function describeProviderAuthCatalogError(code: ProviderAuthCatalogErrorCode): string {
  return code === "AUTH_UNAVAILABLE" ? "sign-in unavailable" : "catalog unavailable";
}

export function formatProviderAuthSignInReceipt(handoff: ProviderAuthSignInHandoff): string {
  return handoff.ok
    ? `Sign-in handoff · run: ${handoff.command}`
    : `Sign-in handoff failed · ${handoff.error.message}`;
}

/**
 * Enter on a row the catalog reports as unavailable. There is no credential path to
 * hand off, so the picker states that instead of calling sign-in and echoing
 * whatever generic failure comes back.
 */
export function formatProviderAuthUnavailableReceipt(row: ProviderAuthRow): string {
  return `Sign-in unavailable · ${row.name} is unavailable`;
}


/** Whether the current composer value belongs to the provider picker. */
export function shouldShowProviderAuthPicker(inputValue: string): boolean {
  const trimmed = inputValue.trim();
  if (trimmed !== "/auth" && !trimmed.startsWith("/auth ")) {
    return false;
  }
  const rest = trimmed.slice("/auth".length).trim();
  if (rest.length === 0) {
    return true;
  }
  const [first = ""] = rest.split(/\s+/);
  return RESERVED_AUTH_SUBCOMMANDS[first.toLowerCase()] !== true && !rest.startsWith("-");
}
/**
 * Enter belongs to the picker only when the composer is holding a bare `/auth`
 * or a provider filter. `/auth status`, `/auth login …` and friends keep going
 * to the engine so the existing auth actions stay reachable.
 */
export function shouldProviderAuthPickerHandleSubmit(input: {
  readonly line: string;
  readonly catalog: ProviderAuthPickerCatalog;
  readonly rowCount: number;
}): boolean {
  if (input.catalog.status !== "ready" || input.rowCount <= 0) {
    return false;
  }
  if (!shouldShowProviderAuthPicker(input.line)) {
    return false;
  }
  return true;
}
