import assert from "node:assert/strict";
import test from "node:test";

import React from "react";

import {
  OMP_AUTH_PICKER_KEY_HINTS,
  clampOmpAuthPickerCursor,
  describeOmpAuthCatalogError,
  describeOmpAuthProviderRow,
  filterOmpAuthProviders,
  formatOmpAuthPickerScrollSummary,
  formatOmpAuthSignInReceipt,
  formatOmpAuthUnavailableReceipt,
  layoutOmpAuthPickerKeyHints,
  moveOmpAuthPickerCursor,
  resolveOmpAuthPickerQuery,
  resolveOmpAuthPickerViewport,
  shouldOmpAuthPickerHandleSubmit,
} from "../../packages/tui/src/work-shell-auth-provider-picker-model.ts";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";
import { WorkShellView } from "../../packages/tui/src/work-shell-view.tsx";
import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

process.env.UNCLECODE_TERMINAL_BACKGROUND = "dark";

const PROVIDERS = [
  { id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)", available: true, credentialKey: "openai-codex", signedIn: true, originKind: "oauth" },
  { id: "anthropic", name: "Anthropic (Claude Pro/Max)", available: true, credentialKey: "anthropic", signedIn: true, originKind: "oauth" },
  { id: "kimi-code", name: "Kimi Code", available: true, credentialKey: "kimi-code", signedIn: true, originKind: "oauth" },
  { id: "openrouter", name: "OpenRouter", available: true, credentialKey: "openrouter", signedIn: true, originKind: "env", originEnvVar: "OPENROUTER_API_KEY" },
  { id: "zai-coding-plan", name: "Z.AI (GLM Coding Plan · Sign in)", available: true, storeCredentialsAs: "zai", credentialKey: "zai", signedIn: true, originKind: "api_key" },
  { id: "perplexity", name: "Perplexity", available: true, credentialKey: "perplexity", signedIn: false },
  { id: "devin", name: "Devin", available: false, credentialKey: "devin", signedIn: false },
];

const READY = { status: "ready", providers: PROVIDERS };

test("resolveOmpAuthPickerQuery reads the filter typed after /auth", () => {
  assert.equal(resolveOmpAuthPickerQuery("/auth"), "");
  assert.equal(resolveOmpAuthPickerQuery("  /auth  "), "");
  assert.equal(resolveOmpAuthPickerQuery("/auth kimi"), "kimi");
  assert.equal(resolveOmpAuthPickerQuery("/auth  Kimi Code "), "Kimi Code");
  assert.equal(resolveOmpAuthPickerQuery("/model gpt"), "");
});

test("filterOmpAuthProviders matches provider id and display name, case-insensitively", () => {
  assert.equal(filterOmpAuthProviders(PROVIDERS, "").length, PROVIDERS.length);
  assert.deepEqual(
    filterOmpAuthProviders(PROVIDERS, "KIMI").map((row) => row.id),
    ["kimi-code"],
  );
  assert.deepEqual(
    filterOmpAuthProviders(PROVIDERS, "open").map((row) => row.id),
    ["openai-codex", "openrouter"],
  );
  assert.deepEqual(
    filterOmpAuthProviders(PROVIDERS, "claude").map((row) => row.id),
    ["anthropic"],
  );
  assert.deepEqual(filterOmpAuthProviders(PROVIDERS, "no-such-provider"), []);
});

test("cursor navigation clamps at both ends and survives a shrinking filter", () => {
  assert.equal(moveOmpAuthPickerCursor(0, -1, 7), 0);
  assert.equal(moveOmpAuthPickerCursor(0, 1, 7), 1);
  assert.equal(moveOmpAuthPickerCursor(6, 1, 7), 6);
  assert.equal(moveOmpAuthPickerCursor(3, -1, 7), 2);
  assert.equal(moveOmpAuthPickerCursor(3, 1, 0), 0);

  assert.equal(clampOmpAuthPickerCursor(5, 2), 1);
  assert.equal(clampOmpAuthPickerCursor(-4, 7), 0);
  assert.equal(clampOmpAuthPickerCursor(2, 0), 0);
});

test("describeOmpAuthProviderRow renders a status glyph and a muted provenance suffix", () => {
  assert.deepEqual(describeOmpAuthProviderRow(PROVIDERS[2]), {
    id: "kimi-code",
    name: "Kimi Code",
    glyph: "●",
    tone: "signed-in",
    provenance: "oauth",
  });
  assert.equal(describeOmpAuthProviderRow(PROVIDERS[3]).provenance, "env OPENROUTER_API_KEY");
  assert.equal(describeOmpAuthProviderRow(PROVIDERS[4]).provenance, "api key · stored as zai");
  assert.deepEqual(describeOmpAuthProviderRow(PROVIDERS[5]), {
    id: "perplexity",
    name: "Perplexity",
    glyph: "○",
    tone: "available",
    provenance: "not signed in",
  });
  assert.deepEqual(describeOmpAuthProviderRow(PROVIDERS[6]), {
    id: "devin",
    name: "Devin",
    glyph: "×",
    tone: "unavailable",
    provenance: "unavailable",
  });
  assert.equal(
    describeOmpAuthProviderRow({ id: "wafer", name: "Wafer", available: true, credentialKey: "wafer", signedIn: true }).provenance,
    "signed in",
  );
});

test("the viewport window follows the cursor and reports what is scrolled away", () => {
  assert.deepEqual(resolveOmpAuthPickerViewport({ rowCount: 7, cursor: 0, maxRows: 3 }), {
    start: 0,
    end: 3,
    hiddenBefore: 0,
    hiddenAfter: 4,
  });
  assert.deepEqual(resolveOmpAuthPickerViewport({ rowCount: 7, cursor: 4, maxRows: 3 }), {
    start: 3,
    end: 6,
    hiddenBefore: 3,
    hiddenAfter: 1,
  });
  assert.deepEqual(resolveOmpAuthPickerViewport({ rowCount: 7, cursor: 6, maxRows: 3 }), {
    start: 4,
    end: 7,
    hiddenBefore: 4,
    hiddenAfter: 0,
  });
  assert.deepEqual(resolveOmpAuthPickerViewport({ rowCount: 2, cursor: 0, maxRows: 5 }), {
    start: 0,
    end: 2,
    hiddenBefore: 0,
    hiddenAfter: 0,
  });
});

test("the scroll summary counts matches, the catalog total, and hidden rows", () => {
  assert.equal(
    formatOmpAuthPickerScrollSummary({ hiddenBefore: 0, hiddenAfter: 58, matched: 66, total: 66 }),
    "66 providers · ↓ 58 more",
  );
  assert.equal(
    formatOmpAuthPickerScrollSummary({ hiddenBefore: 2, hiddenAfter: 3, matched: 12, total: 66 }),
    "12 of 66 providers · ↑ 2 more · ↓ 3 more",
  );
  assert.equal(
    formatOmpAuthPickerScrollSummary({ hiddenBefore: 0, hiddenAfter: 0, matched: 3, total: 66 }),
    "3 of 66 providers",
  );
  assert.equal(
    formatOmpAuthPickerScrollSummary({ hiddenBefore: 0, hiddenAfter: 0, matched: 0, total: 66 }),
    "no provider matches · 66 in catalog",
  );
});

test("the footer publishes two-tone key hints for every picker action", () => {
  assert.deepEqual(OMP_AUTH_PICKER_KEY_HINTS, [
    { key: "↑↓", label: "provider" },
    { key: "type", label: "filter" },
    { key: "⌫", label: "edit" },
    { key: "Enter", label: "sign in" },
    { key: "Esc", label: "back to work" },
  ]);
});

test("key hints wrap instead of truncating away the Enter affordance", () => {
  assert.deepEqual(layoutOmpAuthPickerKeyHints(96), [OMP_AUTH_PICKER_KEY_HINTS]);
  assert.deepEqual(
    layoutOmpAuthPickerKeyHints(44).map((row) => row.map((hint) => hint.key)),
    [["↑↓", "type", "⌫"], ["Enter", "Esc"]],
  );
  // Every hint survives at any width; nothing is dropped to fit.
  assert.deepEqual(
    layoutOmpAuthPickerKeyHints(8).flat(),
    [...OMP_AUTH_PICKER_KEY_HINTS],
  );
});

test("catalog failures become plain UI states instead of fabricated success", () => {
  assert.equal(describeOmpAuthCatalogError("OMP_UNAVAILABLE"), "OMP unavailable");
  assert.equal(describeOmpAuthCatalogError("OMP_CATALOG_UNAVAILABLE"), "catalog unavailable");
  assert.equal(describeOmpAuthCatalogError("OMP_PROTOCOL_ERROR"), "catalog unavailable");
});

test("the sign-in receipt reports the exact OMP handoff, or that the handoff failed", () => {
  assert.equal(
    formatOmpAuthSignInReceipt({ ok: true, binPath: "/x/omp", argv: ["auth-broker", "login", "kimi-code"], command: "omp auth-broker login kimi-code" }),
    "Sign-in handoff · run: omp auth-broker login kimi-code",
  );
  assert.equal(
    formatOmpAuthSignInReceipt({ ok: false, error: { code: "OMP_UNAVAILABLE", message: "omp executable not found on PATH" } }),
    "Sign-in handoff failed · omp executable not found on PATH",
  );
});

test("an unavailable provider gets an explicit receipt of its own, not a handoff", () => {
  assert.equal(
    formatOmpAuthUnavailableReceipt({ id: "devin", name: "Devin", available: false, credentialKey: "devin", signedIn: false }),
    "Sign-in unavailable · Devin is marked unavailable by OMP",
  );
});

test("Enter drives the picker only when the composer is not holding a real /auth subcommand", () => {
  assert.equal(shouldOmpAuthPickerHandleSubmit({ line: "/auth", catalog: READY, rowCount: 7 }), true);
  assert.equal(shouldOmpAuthPickerHandleSubmit({ line: "/auth kimi", catalog: READY, rowCount: 1 }), true);

  for (const reserved of ["status", "login", "key", "logout", "browser"]) {
    assert.equal(
      shouldOmpAuthPickerHandleSubmit({ line: `/auth ${reserved}`, catalog: READY, rowCount: 7 }),
      false,
      `/auth ${reserved} must stay routed to the existing auth action`,
    );
  }

  assert.equal(shouldOmpAuthPickerHandleSubmit({ line: "/auth login --api-key sk", catalog: READY, rowCount: 7 }), false);
  assert.equal(shouldOmpAuthPickerHandleSubmit({ line: "/model gpt", catalog: READY, rowCount: 7 }), false);
  assert.equal(shouldOmpAuthPickerHandleSubmit({ line: "/auth", catalog: { status: "loading" }, rowCount: 0 }), false);
  assert.equal(shouldOmpAuthPickerHandleSubmit({ line: "/auth zzz", catalog: READY, rowCount: 0 }), false);
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: measuring painted columns requires stripping SGR sequences.
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

function viewProps(overrides = {}) {
  return {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningLabel: "medium",
    reasoningSupported: true,
    mode: "Default",
    authLabel: "Saved OAuth",
    entries: [],
    isBusy: false,
    activePanel: { title: "Auth", lines: ["Auth", "status · login · key · logout · browser"] },
    composer: React.createElement("span", null, ""),
    inputValue: "/auth",
    slashSuggestionCount: 5,
    terminalColumns: 100,
    cwd: "/tmp/unclecode-auth-picker",
    ompAuthCatalog: READY,
    ompAuthPickerCursor: 0,
    ...overrides,
  };
}

async function renderView(overrides = {}, columns = 100) {
  const props = viewProps(overrides);
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, { ...props, terminalColumns: columns }),
    { columns, rows: 40 },
  );
  await waitForSettledFrame(getOutput);
  const output = getOutput();
  instance.unmount();
  instance.cleanup();
  return output.replace(ANSI_PATTERN, "");
}

test("/auth opens the OMP provider catalog as its first surface", async () => {
  const output = await renderView();

  assert.match(output, /OMP providers/);
  assert.match(output, /ChatGPT Plus\/Pro \(Codex Subscription\)/);
  assert.match(output, /Kimi Code/);
  assert.match(output, /oauth/);
  assert.match(output, /env OPENROUTER_API_KEY/);
  assert.match(output, /not signed in/);
  assert.match(output, /↑↓ provider/);
  assert.match(output, /Enter sign in/);
  assert.match(output, /Esc back to work/);
  // The copied Rust auth-picker lines must not be the /auth surface any more.
  assert.doesNotMatch(output, /status · login · key · logout · browser/);
});

test("/auth status keeps the existing auth panel even if a catalog prop is present", async () => {
  const output = await renderView({ inputValue: "/auth status" });

  assert.match(output, /status · login · key · logout · browser/);
  assert.doesNotMatch(output, /OMP providers|no provider matches/);
});

test("the selected row tracks the cursor and the search row echoes the filter", async () => {
  const output = await renderView({ inputValue: "/auth open", ompAuthPickerCursor: 1 });

  assert.match(output, /⌕ open/);
  assert.match(output, /› ● OpenRouter/);
  assert.doesNotMatch(output, /Anthropic/);
  assert.match(output, /2 of 7 providers/);
});

test("the picker keeps every row inside a 52-column terminal", async () => {
  const output = await renderView({}, 52);
  const overflow = output
    .split("\n")
    .filter((line) => getDisplayWidth(line) > 52)
    .map((line) => `${getDisplayWidth(line)}:${line}`);

  assert.deepEqual(overflow, [], "the provider picker overflowed a 52-column terminal");
  assert.match(output, /OMP providers/);
  assert.match(output, /Enter sign in/);
});

test("an unavailable OMP install renders an explicit failure state, never an empty catalog", async () => {
  const output = await renderView({
    ompAuthCatalog: { status: "error", code: "OMP_UNAVAILABLE", message: "omp executable not found on PATH" },
  });

  assert.match(output, /OMP unavailable/);
  assert.match(output, /omp executable not found on PATH/);
  assert.doesNotMatch(output, /Kimi Code|ChatGPT Plus|\d+ providers/);
});

test("a broken catalog read renders catalog unavailable and keeps Esc reachable", async () => {
  const output = await renderView({
    ompAuthCatalog: { status: "error", code: "OMP_CATALOG_UNAVAILABLE", message: "agent.db is locked" },
  });

  assert.match(output, /catalog unavailable/);
  assert.match(output, /agent\.db is locked/);
  assert.match(output, /Esc back to work/);
});

test("a failed sign-in handoff is reported instead of a fake success", async () => {
  const output = await renderView({
    ompAuthSignInReceipt: "Sign-in handoff failed · omp executable not found on PATH",
  });

  assert.match(output, /Sign-in handoff failed · omp executable not found on PATH/);
});

test("the picker says so while the catalog is still loading", async () => {
  const output = await renderView({ ompAuthCatalog: { status: "loading" } });

  assert.match(output, /Reading OMP credential catalog/);
  assert.doesNotMatch(output, /Kimi Code|ChatGPT Plus/);
  assert.doesNotMatch(output, /no provider matches/);
});
