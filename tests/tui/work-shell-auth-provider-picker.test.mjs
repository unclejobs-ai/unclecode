import assert from "node:assert/strict";
import test from "node:test";

import React from "react";

import {
  PROVIDER_AUTH_PICKER_KEY_HINTS,
  clampProviderAuthPickerCursor,
  describeProviderAuthCatalogError,
  describeProviderAuthRow,
  filterProviderAuths,
  formatProviderAuthPickerScrollSummary,
  formatProviderAuthSignInReceipt,
  formatProviderAuthUnavailableReceipt,
  layoutProviderAuthPickerKeyHints,
  moveProviderAuthPickerCursor,
  resolveProviderAuthPickerQuery,
  resolveProviderAuthPickerViewport,
  shouldProviderAuthPickerHandleSubmit,
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

test("resolveProviderAuthPickerQuery reads the filter typed after /auth", () => {
  assert.equal(resolveProviderAuthPickerQuery("/auth"), "");
  assert.equal(resolveProviderAuthPickerQuery("  /auth  "), "");
  assert.equal(resolveProviderAuthPickerQuery("/auth kimi"), "kimi");
  assert.equal(resolveProviderAuthPickerQuery("/auth  Kimi Code "), "Kimi Code");
  assert.equal(resolveProviderAuthPickerQuery("/model gpt"), "");
});

test("filterProviderAuths matches provider id and display name, case-insensitively", () => {
  assert.equal(filterProviderAuths(PROVIDERS, "").length, PROVIDERS.length);
  assert.deepEqual(
    filterProviderAuths(PROVIDERS, "KIMI").map((row) => row.id),
    ["kimi-code"],
  );
  assert.deepEqual(
    filterProviderAuths(PROVIDERS, "open").map((row) => row.id),
    ["openai-codex", "openrouter"],
  );
  assert.deepEqual(
    filterProviderAuths(PROVIDERS, "claude").map((row) => row.id),
    ["anthropic"],
  );
  assert.deepEqual(filterProviderAuths(PROVIDERS, "no-such-provider"), []);
});

test("cursor navigation clamps at both ends and survives a shrinking filter", () => {
  assert.equal(moveProviderAuthPickerCursor(0, -1, 7), 0);
  assert.equal(moveProviderAuthPickerCursor(0, 1, 7), 1);
  assert.equal(moveProviderAuthPickerCursor(6, 1, 7), 6);
  assert.equal(moveProviderAuthPickerCursor(3, -1, 7), 2);
  assert.equal(moveProviderAuthPickerCursor(3, 1, 0), 0);

  assert.equal(clampProviderAuthPickerCursor(5, 2), 1);
  assert.equal(clampProviderAuthPickerCursor(-4, 7), 0);
  assert.equal(clampProviderAuthPickerCursor(2, 0), 0);
});

test("describeProviderAuthRow renders a status glyph and a muted provenance suffix", () => {
  assert.deepEqual(describeProviderAuthRow(PROVIDERS[2]), {
    id: "kimi-code",
    name: "Kimi Code",
    glyph: "●",
    tone: "signed-in",
    provenance: "oauth",
  });
  assert.equal(describeProviderAuthRow(PROVIDERS[3]).provenance, "env OPENROUTER_API_KEY");
  assert.equal(describeProviderAuthRow(PROVIDERS[4]).provenance, "api key · stored as zai");
  assert.deepEqual(describeProviderAuthRow(PROVIDERS[5]), {
    id: "perplexity",
    name: "Perplexity",
    glyph: "○",
    tone: "available",
    provenance: "not signed in",
  });
  assert.deepEqual(describeProviderAuthRow(PROVIDERS[6]), {
    id: "devin",
    name: "Devin",
    glyph: "×",
    tone: "unavailable",
    provenance: "unavailable",
  });
  assert.equal(
    describeProviderAuthRow({ id: "wafer", name: "Wafer", available: true, credentialKey: "wafer", signedIn: true }).provenance,
    "signed in",
  );
});

test("the viewport window follows the cursor and reports what is scrolled away", () => {
  assert.deepEqual(resolveProviderAuthPickerViewport({ rowCount: 7, cursor: 0, maxRows: 3 }), {
    start: 0,
    end: 3,
    hiddenBefore: 0,
    hiddenAfter: 4,
  });
  assert.deepEqual(resolveProviderAuthPickerViewport({ rowCount: 7, cursor: 4, maxRows: 3 }), {
    start: 3,
    end: 6,
    hiddenBefore: 3,
    hiddenAfter: 1,
  });
  assert.deepEqual(resolveProviderAuthPickerViewport({ rowCount: 7, cursor: 6, maxRows: 3 }), {
    start: 4,
    end: 7,
    hiddenBefore: 4,
    hiddenAfter: 0,
  });
  assert.deepEqual(resolveProviderAuthPickerViewport({ rowCount: 2, cursor: 0, maxRows: 5 }), {
    start: 0,
    end: 2,
    hiddenBefore: 0,
    hiddenAfter: 0,
  });
});

test("the scroll summary counts matches, the catalog total, and hidden rows", () => {
  assert.equal(
    formatProviderAuthPickerScrollSummary({ hiddenBefore: 0, hiddenAfter: 58, matched: 66, total: 66 }),
    "66 providers · ↓ 58 more",
  );
  assert.equal(
    formatProviderAuthPickerScrollSummary({ hiddenBefore: 2, hiddenAfter: 3, matched: 12, total: 66 }),
    "12 of 66 providers · ↑ 2 more · ↓ 3 more",
  );
  assert.equal(
    formatProviderAuthPickerScrollSummary({ hiddenBefore: 0, hiddenAfter: 0, matched: 3, total: 66 }),
    "3 of 66 providers",
  );
  assert.equal(
    formatProviderAuthPickerScrollSummary({ hiddenBefore: 0, hiddenAfter: 0, matched: 0, total: 66 }),
    "no provider matches · 66 in catalog",
  );
});

test("the footer publishes two-tone key hints for every picker action", () => {
  assert.deepEqual(PROVIDER_AUTH_PICKER_KEY_HINTS, [
    { key: "↑↓", label: "provider" },
    { key: "type", label: "filter" },
    { key: "⌫", label: "edit" },
    { key: "Enter", label: "sign in" },
    { key: "Esc", label: "back to work" },
  ]);
});

test("key hints wrap instead of truncating away the Enter affordance", () => {
  assert.deepEqual(layoutProviderAuthPickerKeyHints(96), [PROVIDER_AUTH_PICKER_KEY_HINTS]);
  assert.deepEqual(
    layoutProviderAuthPickerKeyHints(44).map((row) => row.map((hint) => hint.key)),
    [["↑↓", "type", "⌫"], ["Enter", "Esc"]],
  );
  // Every hint survives at any width; nothing is dropped to fit.
  assert.deepEqual(
    layoutProviderAuthPickerKeyHints(8).flat(),
    [...PROVIDER_AUTH_PICKER_KEY_HINTS],
  );
});

test("catalog failures become plain UI states instead of fabricated success", () => {
  assert.equal(describeProviderAuthCatalogError("AUTH_UNAVAILABLE"), "sign-in unavailable");
  assert.equal(describeProviderAuthCatalogError("AUTH_CATALOG_UNAVAILABLE"), "catalog unavailable");
  assert.equal(describeProviderAuthCatalogError("AUTH_PROTOCOL_ERROR"), "catalog unavailable");
});

test("the sign-in receipt reports the exact OMP handoff, or that the handoff failed", () => {
  assert.equal(
    formatProviderAuthSignInReceipt({ ok: true, binPath: "/x/omp", argv: ["auth-broker", "login", "kimi-code"], command: "omp auth-broker login kimi-code" }),
    "Sign-in handoff · run: omp auth-broker login kimi-code",
  );
  assert.equal(
    formatProviderAuthSignInReceipt({ ok: false, error: { code: "AUTH_UNAVAILABLE", message: "omp executable not found on PATH" } }),
    "Sign-in failed · omp executable not found on PATH",
  );
});

test("a sign-in completed inside the TUI says so instead of handing off", () => {
  assert.equal(
    formatProviderAuthSignInReceipt({ ok: true, signedIn: true, name: "xAI (Grok/X subscription)" }),
    "Signed in · xAI (Grok/X subscription)",
  );
  assert.equal(
    formatProviderAuthSignInReceipt({ ok: false, error: { code: "SIGN_IN_UNAVAILABLE", message: "xAI device code expired · or run: unclecode auth login xai" } }),
    "Sign-in failed · xAI device code expired · or run: unclecode auth login xai",
  );
});

test("an unavailable provider gets an explicit receipt of its own, not a handoff", () => {
  assert.equal(
    formatProviderAuthUnavailableReceipt({ id: "devin", name: "Devin", available: false, credentialKey: "devin", signedIn: false }),
    "Sign-in unavailable · Devin is unavailable",
  );
});

test("Enter drives the picker only when the composer is not holding a real /auth subcommand", () => {
  assert.equal(shouldProviderAuthPickerHandleSubmit({ line: "/auth", catalog: READY, rowCount: 7 }), true);
  assert.equal(shouldProviderAuthPickerHandleSubmit({ line: "/auth kimi", catalog: READY, rowCount: 1 }), true);

  for (const reserved of ["status", "login", "key", "logout", "browser"]) {
    assert.equal(
      shouldProviderAuthPickerHandleSubmit({ line: `/auth ${reserved}`, catalog: READY, rowCount: 7 }),
      false,
      `/auth ${reserved} must stay routed to the existing auth action`,
    );
  }

  assert.equal(shouldProviderAuthPickerHandleSubmit({ line: "/auth login --api-key sk", catalog: READY, rowCount: 7 }), false);
  assert.equal(shouldProviderAuthPickerHandleSubmit({ line: "/model gpt", catalog: READY, rowCount: 7 }), false);
  assert.equal(shouldProviderAuthPickerHandleSubmit({ line: "/auth", catalog: { status: "loading" }, rowCount: 0 }), false);
  assert.equal(shouldProviderAuthPickerHandleSubmit({ line: "/auth zzz", catalog: READY, rowCount: 0 }), false);
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
    providerAuthCatalog: READY,
    providerAuthPickerCursor: 0,
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

  assert.match(output, /Providers · UncleCode sign-in/);
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
  assert.doesNotMatch(output, /Providers · UncleCode sign-in|no provider matches/);
});

test("the selected row tracks the cursor and the search row echoes the filter", async () => {
  const output = await renderView({ inputValue: "/auth open", providerAuthPickerCursor: 1 });

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
  assert.match(output, /Providers · UncleCode sign-in/);
  assert.match(output, /Enter sign in/);
});

test("an unavailable OMP install renders an explicit failure state, never an empty catalog", async () => {
  const output = await renderView({
    providerAuthCatalog: { status: "error", code: "AUTH_UNAVAILABLE", message: "omp executable not found on PATH" },
  });

  assert.match(output, /sign-in unavailable/);
  assert.match(output, /omp executable not found on PATH/);
  assert.doesNotMatch(output, /Kimi Code|ChatGPT Plus|\d+ providers/);
});

test("a broken catalog read renders catalog unavailable and keeps Esc reachable", async () => {
  const output = await renderView({
    providerAuthCatalog: { status: "error", code: "AUTH_CATALOG_UNAVAILABLE", message: "agent.db is locked" },
  });

  assert.match(output, /catalog unavailable/);
  assert.match(output, /agent\.db is locked/);
  assert.match(output, /Esc back to work/);
});

test("a failed sign-in handoff is reported instead of a fake success", async () => {
  const output = await renderView({
    providerAuthSignInReceipt: "Sign-in failed · omp executable not found on PATH",
  });

  assert.match(output, /Sign-in failed · omp executable not found on PATH/);
});

test("the picker says so while the catalog is still loading", async () => {
  const output = await renderView({ providerAuthCatalog: { status: "loading" } });

  assert.match(output, /Reading providers/);
  assert.doesNotMatch(output, /Kimi Code|ChatGPT Plus/);
  assert.doesNotMatch(output, /no provider matches/);
});
