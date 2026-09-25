/**
 * `/auth` provider picker for the pi shell. Same behaviour as the Ink picker
 * (`work-shell-auth-provider-picker-state.ts`), built on the same pure model:
 * typing `/auth [filter]` shows the catalog live, ↑↓ move, Enter hands the row
 * to the app-owned sign-in port. `/auth status|login|key|…` stay engine commands.
 */
import { Box, matchesKey, type OverlayHandle, Text, type TUI } from "@earendil-works/pi-tui";

import {
  clampProviderAuthPickerCursor,
  describeProviderAuthCatalogError,
  describeProviderAuthRow,
  filterProviderAuths,
  formatProviderAuthSignInReceipt,
  formatProviderAuthUnavailableReceipt,
  moveProviderAuthPickerCursor,
  resolveProviderAuthPickerQuery,
  shouldProviderAuthPickerHandleSubmit,
  shouldShowProviderAuthPicker,
  type ProviderAuthCatalogPort,
  type ProviderAuthPickerCatalog,
  type ProviderAuthRow,
} from "./work-shell-auth-provider-picker-model.js";

export type PiAuthPickerStyle = {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly background: (text: string) => string;
};

/** Rows of the picker as text: header, one row per provider (cursor marked), receipt. */
export function formatPiAuthPickerRows(input: {
  readonly catalog: ProviderAuthPickerCatalog;
  readonly matches: readonly ProviderAuthRow[];
  readonly cursor: number;
  readonly receipt: string | undefined;
}): readonly string[] {
  const rows: string[] = [];
  if (input.catalog.status === "loading") rows.push("Loading providers…");
  if (input.catalog.status === "error") {
    rows.push(`${describeProviderAuthCatalogError(input.catalog.code)} · ${input.catalog.message}`);
  }
  if (input.catalog.status === "ready" && input.matches.length === 0) rows.push("No provider matches.");
  input.matches.forEach((row, index) => {
    const view = describeProviderAuthRow(row);
    rows.push(`${index === input.cursor ? "›" : " "} ${view.glyph} ${view.name}  ${view.provenance}`);
  });
  if (input.receipt) rows.push("", input.receipt);
  return rows;
}

export class PiAuthPicker {
  private catalog: ProviderAuthPickerCatalog | undefined;
  private query = "";
  private cursor = 0;
  private receipt: string | undefined;
  private overlay: OverlayHandle | undefined;
  private signInRequest = 0;

  constructor(
    private readonly tui: TUI,
    private readonly port: ProviderAuthCatalogPort,
    private readonly style: PiAuthPickerStyle,
  ) {}

  get isOpen(): boolean {
    return this.overlay !== undefined;
  }

  /** Follows the editor text: opens on `/auth [filter]`, closes on anything else. */
  update(editorText: string): void {
    if (!shouldShowProviderAuthPicker(editorText)) {
      // Enter clears the draft; sign-in progress (a device code, a URL) must stay on screen.
      if (editorText.trim().length === 0 && this.receipt !== undefined) return;
      this.close();
      return;
    }
    const query = resolveProviderAuthPickerQuery(editorText);
    if (query !== this.query) this.cursor = 0;
    this.query = query;
    if (this.catalog === undefined) this.load();
    this.render();
  }

  /** ↑↓ while open move the cursor instead of the editor's history. */
  handleKey(data: string): boolean {
    if (!this.isOpen) return false;
    const direction = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : undefined;
    if (direction === undefined) return false;
    this.cursor = moveProviderAuthPickerCursor(this.cursor, direction, this.matches().length);
    this.render();
    return true;
  }

  /** True when Enter belonged to the picker; false leaves the line to the engine. */
  submit(line: string): boolean {
    const matches = this.matches();
    if (this.catalog === undefined || !shouldProviderAuthPickerHandleSubmit({ line, catalog: this.catalog, rowCount: matches.length })) {
      return false;
    }
    const row = matches[clampProviderAuthPickerCursor(this.cursor, matches.length)];
    if (!row) return false;
    const request = ++this.signInRequest;
    const show = (text: string) => {
      if (request !== this.signInRequest) return;
      this.receipt = text;
      this.render();
    };
    if (!row.available) {
      show(formatProviderAuthUnavailableReceipt(row));
      return true;
    }
    show(`Signing in · ${row.name}…`);
    void this.port.signIn(row.id, show).then((handoff) => {
      show(formatProviderAuthSignInReceipt(handoff));
      // The store changed: re-read it so the row turns ● signed in.
      if (handoff.ok && "signedIn" in handoff) this.load();
    });
    return true;
  }

  close(): void {
    this.overlay?.hide();
    this.overlay = undefined;
    this.receipt = undefined;
    this.signInRequest += 1;
  }

  private matches(): readonly ProviderAuthRow[] {
    return this.catalog?.status === "ready" ? filterProviderAuths(this.catalog.providers, this.query) : [];
  }

  private load(): void {
    this.catalog = { status: "loading" };
    void this.port.list().then((result) => {
      this.catalog = result.ok
        ? { status: "ready", providers: result.providers }
        : { status: "error", code: result.error.code, message: result.error.message };
      if (this.isOpen) this.render();
    });
  }

  private render(): void {
    if (this.catalog === undefined) return;
    const matches = this.matches();
    this.cursor = clampProviderAuthPickerCursor(this.cursor, matches.length);
    const box = new Box(1, 0, this.style.background);
    box.addChild(new Text(`${this.style.bold("Sign in")}  ${this.style.dim("↑↓ choose · Enter sign in · type to filter")}`, 0, 0));
    box.addChild(new Text(formatPiAuthPickerRows({
      catalog: this.catalog,
      matches,
      cursor: this.cursor,
      receipt: this.receipt,
    }).join("\n"), 0, 0));
    this.overlay?.hide();
    this.overlay = this.tui.showOverlay(box, {
      anchor: "bottom-center",
      width: "90%",
      maxHeight: "60%",
      offsetY: -4,
      nonCapturing: true,
    });
    this.tui.requestRender();
  }
}
