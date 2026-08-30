import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../../apps/godness-web/", import.meta.url));
let vite;
let synchronizeDocumentLocale;

before(async () => {
  vite = await createServer({
    root: webRoot,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ synchronizeDocumentLocale } = await vite.ssrLoadModule("/src/App.jsx"));
});

after(async () => {
  await vite?.close();
});

function fakeDocument(lang = "en", title = "Original") {
  return { documentElement: { lang }, title };
}

test("Korean active or authentication locale sets Korean document metadata", () => {
  const documentRef = fakeDocument();
  const cleanup = synchronizeDocumentLocale(documentRef, "ko");

  assert.equal(documentRef.documentElement.lang, "ko");
  assert.equal(documentRef.title, "UncleCode 관제실");

  cleanup();
  assert.deepEqual(documentRef, { documentElement: { lang: "en" }, title: "Original" });
});

test("English active or authentication locale sets English document metadata", () => {
  const documentRef = fakeDocument("ko", "이전 제목");
  const cleanup = synchronizeDocumentLocale(documentRef, "en");

  assert.equal(documentRef.documentElement.lang, "en");
  assert.equal(documentRef.title, "UncleCode Control Room");

  cleanup();
  assert.deepEqual(documentRef, { documentElement: { lang: "ko" }, title: "이전 제목" });
});

test("a stale locale cleanup cannot overwrite the latest document transition", () => {
  const documentRef = fakeDocument();
  const staleKoreanCleanup = synchronizeDocumentLocale(documentRef, "ko");
  const currentEnglishCleanup = synchronizeDocumentLocale(documentRef, "en");

  staleKoreanCleanup();
  assert.equal(documentRef.documentElement.lang, "en");
  assert.equal(documentRef.title, "UncleCode Control Room");

  currentEnglishCleanup();
});

test("App wires document synchronization to the single derived locale", async () => {
  const source = await readFile(new URL("../../apps/godness-web/src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /useEffect\(\(\) => synchronizeDocumentLocale\(globalThis\.document, locale\), \[locale\]\)/);
});
