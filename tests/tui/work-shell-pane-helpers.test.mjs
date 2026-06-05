import test from "node:test";
import assert from "node:assert/strict";

import {
  looksLikeStandaloneImagePathInput,
  resolveComposerVisibleWidth,
  resolveWorkShellPaneTerminalColumns,
  shouldAutoPromoteStandaloneImagePreview,
} from "@unclecode/tui";

const ATTACHMENT = {
  type: "image",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,AAAA",
  path: "(clipboard)",
  displayName: "clipboard.png",
};

test("resolveWorkShellPaneTerminalColumns prefers the live stdout width", () => {
  assert.equal(resolveWorkShellPaneTerminalColumns({ columns: 143 }), 143);
});


test("resolveComposerVisibleWidth tracks explicit terminal width changes", () => {
  assert.equal(resolveComposerVisibleWidth(143), 72);
  assert.equal(resolveComposerVisibleWidth(48), 38);
  assert.equal(resolveComposerVisibleWidth(18), 12);
});

test("looksLikeStandaloneImagePathInput recognizes absolute clipboard image paths", () => {
  assert.equal(
    looksLikeStandaloneImagePathInput("/var/folders/x/pi-clipboard-a6c08456-b9e7-4314-aa6b-2f680483f6f0.png"),
    true,
  );
  assert.equal(
    looksLikeStandaloneImagePathInput('"/tmp/two words.png"'),
    true,
  );
});

test("looksLikeStandaloneImagePathInput ignores natural-language prompts", () => {
  assert.equal(
    looksLikeStandaloneImagePathInput("이 이미지 설명해줘 /tmp/clipboard.png"),
    false,
  );
});

test("shouldAutoPromoteStandaloneImagePreview only promotes path-only image previews", () => {
  assert.equal(
    shouldAutoPromoteStandaloneImagePreview({
      inputValue: "/tmp/clipboard.png",
      composerPreview: {
        prompt: "Please inspect the attached image.",
        attachments: [ATTACHMENT],
      },
    }),
    true,
  );

  assert.equal(
    shouldAutoPromoteStandaloneImagePreview({
      inputValue: "what is in this? /tmp/clipboard.png",
      composerPreview: {
        prompt: "what is in this?",
        attachments: [ATTACHMENT],
      },
    }),
    false,
  );
});
