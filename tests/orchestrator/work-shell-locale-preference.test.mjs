import assert from "node:assert/strict";
import test from "node:test";

import {
  detectWorkShellUserLocale,
  resolveWorkShellTerminalUiLocale,
  resolveWorkShellUiLocale,
} from "@unclecode/orchestrator";

test("terminal locale preference is deterministic across standard locale environment fields", () => {
  assert.equal(resolveWorkShellTerminalUiLocale({ LC_ALL: "ko_KR.UTF-8", LANG: "en_US.UTF-8" }), "ko");
  assert.equal(resolveWorkShellTerminalUiLocale({ LC_MESSAGES: "en_GB.UTF-8", LANG: "ko_KR.UTF-8" }), "en");
  assert.equal(resolveWorkShellTerminalUiLocale({ LANGUAGE: "ko_KR:en_US" }), "ko");
  assert.equal(resolveWorkShellTerminalUiLocale({ LANG: "C" }), "en");
  assert.equal(resolveWorkShellTerminalUiLocale({}, "ko"), "ko");
});

test("meaningful user prose resolves locale independently on each turn", () => {
  const terminalPreference = resolveWorkShellTerminalUiLocale({ LANG: "en_US.UTF-8" });
  assert.equal(resolveWorkShellUiLocale("이 요청을 처리해 줘", terminalPreference), "ko");
  assert.equal(resolveWorkShellUiLocale("Please inspect this file", terminalPreference), "en");
});

test("meaningful prose detection distinguishes a preference from neutral input", () => {
  assert.equal(detectWorkShellUserLocale("첫 요청을 처리해 주세요"), "ko");
  assert.equal(detectWorkShellUserLocale("Handle the first request"), "en");
  assert.equal(detectWorkShellUserLocale("/context"), undefined);
  assert.equal(detectWorkShellUserLocale("./fixtures/한국어.json"), undefined);
});
