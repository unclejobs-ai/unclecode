import assert from "node:assert/strict";
import test from "node:test";

import {
  SGR_MOUSE_SEQUENCES,
  enableWorkShellMouseWheel,
  isSgrMouseInput,
  resolveTranscriptScrollDirection,
  resolveTranscriptWheelDirection,
} from "../../packages/tui/src/mouse-wheel.ts";

test("SGR mouse enable/disable uses 1006 then 1000, and reverses on restore", () => {
  const writes = [];
  const stdout = {
    isTTY: true,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
  };
  const restore = enableWorkShellMouseWheel(stdout);
  assert.deepEqual(writes, [SGR_MOUSE_SEQUENCES.enable]);
  assert.equal(SGR_MOUSE_SEQUENCES.enable, "\u001b[?1006h\u001b[?1000h");
  restore();
  assert.deepEqual(writes, [SGR_MOUSE_SEQUENCES.enable, SGR_MOUSE_SEQUENCES.disable]);
  assert.equal(SGR_MOUSE_SEQUENCES.disable, "\u001b[?1000l\u001b[?1006l");
});

test("enableWorkShellMouseWheel leaves a non-TTY stdout alone", () => {
  const writes = [];
  const restore = enableWorkShellMouseWheel({
    isTTY: false,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
  });
  restore();
  assert.deepEqual(writes, []);
});

test("resolveTranscriptWheelDirection maps SGR wheel buttons to PageUp/PageDown directions", () => {
  assert.equal(resolveTranscriptWheelDirection("\u001b[<64;10;5M"), -1);
  assert.equal(resolveTranscriptWheelDirection("\u001b[<65;10;5M"), 1);
  // Ink 6 strips the leading ESC before useInput, so the handler sees this form.
  assert.equal(resolveTranscriptWheelDirection("[<64;1;1M"), -1);
  assert.equal(resolveTranscriptWheelDirection("[<65;8;12M"), 1);
  assert.equal(resolveTranscriptWheelDirection("[<68;1;1M"), -1, "shift+wheel up");
  assert.equal(resolveTranscriptWheelDirection("[<0;1;1M"), undefined);
  assert.equal(resolveTranscriptWheelDirection("[<64;1;1m"), undefined, "SGR release must not page");
  assert.equal(resolveTranscriptWheelDirection("hello"), undefined);
});

test("isSgrMouseInput recognizes clicks and wheel so the composer can ignore them", () => {
  assert.equal(isSgrMouseInput("[<64;1;1M"), true);
  assert.equal(isSgrMouseInput("\u001b[<0;4;8M"), true);
  assert.equal(isSgrMouseInput("[<0;4;8m"), true);
  assert.equal(isSgrMouseInput("안녕"), false);
  assert.equal(isSgrMouseInput("[64;1;1M"), false);
});

test("resolveTranscriptScrollDirection shares the PageUp overlay/ctrl gate with wheel", () => {
  assert.equal(resolveTranscriptScrollDirection({ overlayOpen: false, pageUp: true }), -1);
  assert.equal(resolveTranscriptScrollDirection({ overlayOpen: false, pageDown: true }), 1);
  assert.equal(
    resolveTranscriptScrollDirection({ overlayOpen: false, input: "[<64;1;1M" }),
    -1,
  );
  assert.equal(
    resolveTranscriptScrollDirection({ overlayOpen: false, input: "\u001b[<65;1;1M" }),
    1,
  );
  assert.equal(
    resolveTranscriptScrollDirection({ overlayOpen: true, pageUp: true }),
    undefined,
  );
  assert.equal(
    resolveTranscriptScrollDirection({ overlayOpen: true, input: "[<64;1;1M" }),
    undefined,
  );
  assert.equal(
    resolveTranscriptScrollDirection({ overlayOpen: false, ctrl: true, pageUp: true }),
    undefined,
  );
  assert.equal(
    resolveTranscriptScrollDirection({ overlayOpen: false, input: "[<0;1;1M" }),
    undefined,
  );
});
