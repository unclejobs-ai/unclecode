/**
 * `/auth` provider-catalog state: one lazy read of the injected OMP port, a
 * cursor derived from the current filter, and Enter → OMP-owned sign-in.
 *
 * The port is supplied by the app at the pane boundary; this hook never
 * constructs one, so the TUI keeps no dependency on provider infrastructure.
 * A missing port means the catalog stays undefined and `/auth` falls back to
 * the existing panel — no fabricated rows, no fabricated success.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInput } from "ink";

import {
  clampOmpAuthPickerCursor,
  filterOmpAuthProviders,
  formatOmpAuthSignInReceipt,
  formatOmpAuthUnavailableReceipt,
  moveOmpAuthPickerCursor,
  resolveOmpAuthPickerQuery,
  shouldOmpAuthPickerHandleSubmit,
  type OmpAuthCatalogPort,
  type OmpAuthPickerCatalog,
} from "./work-shell-auth-provider-picker-model.js";

export type OmpAuthProviderPickerState = {
  readonly catalog: OmpAuthPickerCatalog | undefined;
  readonly cursor: number;
  readonly signInReceipt: string | undefined;
  /** Returns true when the picker consumed Enter; false leaves the line to the engine. */
  readonly submit: (line: string) => Promise<boolean>;
};

export function useOmpAuthProviderPicker(input: {
  readonly port?: OmpAuthCatalogPort | undefined;
  readonly active: boolean;
  readonly inputValue: string;
}): OmpAuthProviderPickerState {
  const { active, inputValue, port } = input;
  const [catalog, setCatalog] = useState<OmpAuthPickerCatalog | undefined>(undefined);
  const [cursorState, setCursorState] = useState<{ query: string; cursor: number }>({
    query: "",
    cursor: 0,
  });
  // Each async handoff owns a request id. Closing/reopening the picker or
  // starting another handoff retires that id before an older promise can land.
  const nextSignInRequestIdRef = useRef(0);
  const [receipt, setReceipt] = useState<{
    readonly open: boolean;
    readonly requestId?: number;
    readonly text?: string;
  }>({
    open: false,
  });
  if (receipt.open !== active) {
    setReceipt({ open: active });
  }

  const query = resolveOmpAuthPickerQuery(inputValue);
  const matches = useMemo(
    () => (catalog?.status === "ready" ? filterOmpAuthProviders(catalog.providers, query) : []),
    [catalog, query],
  );
  // Derived, not stored: a new filter re-anchors the cursor to the first match
  // without an extra render pass.
  const cursor = clampOmpAuthPickerCursor(
    cursorState.query === query ? cursorState.cursor : 0,
    matches.length,
  );

  // External system sync: OMP's credential store lives in another process, so
  // the catalog is read once the /auth surface is actually opened.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!active || !port || loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    let cancelled = false;
    let settled = false;
    setCatalog({ status: "loading" });
    void port.list().then((result) => {
      settled = true;
      if (cancelled) {
        return;
      }
      setCatalog(
        result.ok
          ? { status: "ready", providers: result.providers }
          : { status: "error", code: result.error.code, message: result.error.message },
      );
    });
    return () => {
      cancelled = true;
      if (!settled) {
        loadedRef.current = false;
      }
    };
  }, [active, port]);

  useInput(
    (_value, key) => {
      const direction = key.upArrow ? -1 : key.downArrow ? 1 : undefined;
      if (direction === undefined) {
        return;
      }
      setCursorState({ query, cursor: moveOmpAuthPickerCursor(cursor, direction, matches.length) });
    },
    { isActive: active && catalog?.status === "ready" && matches.length > 0 },
  );

  const submit = useCallback(
    async (line: string): Promise<boolean> => {
      if (!port || catalog === undefined) {
        return false;
      }
      if (!shouldOmpAuthPickerHandleSubmit({ line, catalog, rowCount: matches.length })) {
        return false;
      }
      const row = matches[cursor];
      if (!row) {
        return false;
      }
      if (!row.available) {
        // Enter is still consumed: the row was a legitimate selection, it just
        // has no sign-in to hand off, so `/auth` must not fall through to the
        // engine either.
        setReceipt({
          open: true,
          requestId: ++nextSignInRequestIdRef.current,
          text: formatOmpAuthUnavailableReceipt(row),
        });
        return true;
      }
      const requestId = ++nextSignInRequestIdRef.current;
      setReceipt({ open: true, requestId });
      const handoff = await port.signIn(row.id);
      setReceipt((current) =>
        current.open && current.requestId === requestId
          ? { open: true, requestId, text: formatOmpAuthSignInReceipt(handoff) }
          : current,
      );
      return true;
    },
    [catalog, cursor, matches, port],
  );

  return {
    catalog,
    cursor,
    signInReceipt: active ? receipt.text : undefined,
    submit,
  };
}
