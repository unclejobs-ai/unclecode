import assert from "node:assert/strict";
import test from "node:test";

import {
  formatWorkShellModeLabelForLocale,
  resolveWorkShellUiLocale,
  workShellLanguageInstruction,
} from "@unclecode/orchestrator";

test("session locale follows explicit English or Korean text and keeps fallback for neutral input", () => {
  assert.equal(resolveWorkShellUiLocale("Please inspect the failing test", "ko"), "en");
  assert.equal(resolveWorkShellUiLocale("실패한 테스트를 확인해 줘", "en"), "ko");
  assert.equal(resolveWorkShellUiLocale("/review", "ko"), "ko");
});

test("session locale ignores incidental Hangul inside code, paths, URLs, and artifact tokens", () => {
  assert.equal(resolveWorkShellUiLocale("```ts\nconst 이름 = 1\n```", "en"), "en");
  assert.equal(resolveWorkShellUiLocale("`한글변수`", "en"), "en");
  assert.equal(resolveWorkShellUiLocale("/Users/me/한글/project/file.ts", "en"), "en");
  assert.equal(resolveWorkShellUiLocale("https://example.com/한글", "en"), "en");
  assert.equal(resolveWorkShellUiLocale("artifact-한글.json", "en"), "en");
  assert.equal(resolveWorkShellUiLocale("Please fix src/한글/파일.ts", "ko"), "en");
  assert.equal(resolveWorkShellUiLocale("src/한글.ts 오류를 고쳐 주세요", "en"), "ko");
});

test("mode chrome comes from one EN/KO message boundary", () => {
  assert.equal(formatWorkShellModeLabelForLocale("default", "en"), "Work mode");
  assert.equal(formatWorkShellModeLabelForLocale("default", "ko"), "작업 모드");
  assert.equal(formatWorkShellModeLabelForLocale("ultrawork", "en"), "Focus mode");
  assert.equal(formatWorkShellModeLabelForLocale("ultrawork", "ko"), "집중 작업 모드");
});

test("provider instruction follows the current turn locale without mixed guidance", () => {
  assert.match(workShellLanguageInstruction("en"), /Respond in English/);
  assert.match(workShellLanguageInstruction("en"), /this turn/);
  assert.doesNotMatch(workShellLanguageInstruction("en"), /[가-힣]/u);
  assert.match(workShellLanguageInstruction("ko"), /한국어로 답변/);
  assert.doesNotMatch(workShellLanguageInstruction("ko"), /Respond in English/);
});
