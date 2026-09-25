import assert from "node:assert/strict";
import test from "node:test";

import { PiAuthPicker } from "@unclecode/tui";

const identity = (text) => text;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function createPicker() {
  const shown = [];
  const tui = {
    showOverlay(component) {
      const handle = { hidden: false, hide() { handle.hidden = true; } };
      shown.push({ component, handle });
      return handle;
    },
    requestRender() {},
  };
  const signIns = [];
  const port = {
    async list() {
      return {
        ok: true,
        dbPath: "/tmp/providers.json",
        providers: [
          { id: "anthropic", name: "Anthropic", available: true, credentialKey: "a", signedIn: true, originKind: "oauth" },
          { id: "xai", name: "xAI", available: true, credentialKey: "x", signedIn: false },
        ],
      };
    },
    async signIn(providerId, onProgress) {
      signIns.push(providerId);
      onProgress?.("Open https://x.ai/device and enter WXYZ-1234");
      return { ok: true, signedIn: true, name: "xAI" };
    },
  };
  const picker = new PiAuthPicker(tui, port, { bold: identity, dim: identity, background: identity });
  const screen = () => {
    const visible = shown.filter((entry) => !entry.handle.hidden).at(-1);
    return visible ? visible.component.render(80).join("\n") : "";
  };
  return { picker, screen, signIns };
}

test("typing /auth lists providers live, filters, and ↑↓ moves the cursor", async () => {
  const { picker, screen } = createPicker();
  picker.update("/auth");
  await flush();
  assert.match(screen(), /› ● Anthropic {2}oauth/u);
  assert.match(screen(), /○ xAI {2}not signed in/u);

  assert.equal(picker.handleKey("\u001b[B"), true);
  assert.match(screen(), /› ○ xAI/u);

  picker.update("/auth anth");
  assert.doesNotMatch(screen(), /xAI/u);
  picker.update("hello");
  assert.equal(picker.isOpen, false);
});

test("Enter signs in the chosen row and keeps the device-code progress on screen", async () => {
  const { picker, screen, signIns } = createPicker();
  picker.update("/auth xai");
  await flush();
  assert.equal(picker.submit("/auth xai"), true);
  picker.update("");
  await flush();
  assert.deepEqual(signIns, ["xai"]);
  assert.equal(picker.isOpen, true);
  assert.match(screen(), /Signed in · xAI/u);
});

test("/auth status stays an engine command", async () => {
  const { picker } = createPicker();
  picker.update("/auth status");
  await flush();
  assert.equal(picker.isOpen, false);
  assert.equal(picker.submit("/auth status"), false);
});
