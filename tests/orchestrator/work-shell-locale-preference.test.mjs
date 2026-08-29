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

test("the initial user language may select the session locale without making later sentences a preference", () => {
  const terminalPreference = resolveWorkShellTerminalUiLocale({ LANG: "en_US.UTF-8" });
  const sessionLocale = resolveWorkShellUiLocale("이 세션은 한국어로 진행해 줘", terminalPreference);
  assert.equal(sessionLocale, "ko");
  assert.equal(resolveWorkShellUiLocale("Please inspect this file", terminalPreference), "en");
  assert.equal(sessionLocale, "ko", "the selected session preference is stored rather than recomputed per sentence");
});

test("meaningful prose detection distinguishes a preference from neutral input", () => {
  assert.equal(detectWorkShellUserLocale("첫 요청을 처리해 주세요"), "ko");
  assert.equal(detectWorkShellUserLocale("Handle the first request"), "en");
  assert.equal(detectWorkShellUserLocale("/context"), undefined);
  assert.equal(detectWorkShellUserLocale("./fixtures/한국어.json"), undefined);
});
