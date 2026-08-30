import assert from "node:assert/strict";
import test from "node:test";

import {
  ALT_SCREEN_SEQUENCES,
  enterAlternateScreen,
} from "../../packages/tui/src/alt-screen.ts";
import {
  RUNTIME_CONNECTION_STATUS,
  showRuntimeConnectionStatus,
} from "../../packages/tui/src/tui-entry.tsx";

function fakeStdout({ isTTY = true } = {}) {
  const writes = [];
  return {
    isTTY,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    get output() {
      return writes.join("");
    },
  };
}

function withoutDisableFlag(run) {
  const saved = process.env.UNCLECODE_DISABLE_ALT_SCREEN;
  delete process.env.UNCLECODE_DISABLE_ALT_SCREEN;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.UNCLECODE_DISABLE_ALT_SCREEN;
    else process.env.UNCLECODE_DISABLE_ALT_SCREEN = saved;
  }
}

test("entering the alternate screen swaps the buffer and hides the cursor", () => {
  withoutDisableFlag(() => {
    const stdout = fakeStdout();
    const session = enterAlternateScreen(stdout);

    assert.equal(session.active, true);
    assert.equal(stdout.output, `${ALT_SCREEN_SEQUENCES.enter}${ALT_SCREEN_SEQUENCES.hideCursor}`);

    session.restore();
    assert.equal(
      stdout.output,
      `${ALT_SCREEN_SEQUENCES.enter}${ALT_SCREEN_SEQUENCES.hideCursor}${ALT_SCREEN_SEQUENCES.showCursor}${ALT_SCREEN_SEQUENCES.leave}`,
    );
  });
});

test("restore is idempotent so the exit hook cannot double-leave", () => {
  withoutDisableFlag(() => {
    const stdout = fakeStdout();
    const session = enterAlternateScreen(stdout);
    session.restore();
    const afterFirst = stdout.output;
    session.restore();
    session.restore();
    assert.equal(stdout.output, afterFirst);
  });
});

test("a non-TTY stdout is left completely alone", () => {
  withoutDisableFlag(() => {
    const stdout = fakeStdout({ isTTY: false });
    const session = enterAlternateScreen(stdout);

    assert.equal(session.active, false);
    assert.equal(stdout.output, "");
    session.restore();
    assert.equal(stdout.output, "");
  });
});

test("UNCLECODE_DISABLE_ALT_SCREEN opts out for inline debugging", () => {
  const saved = process.env.UNCLECODE_DISABLE_ALT_SCREEN;
  process.env.UNCLECODE_DISABLE_ALT_SCREEN = "1";
  try {
    const stdout = fakeStdout();
    assert.equal(enterAlternateScreen(stdout).active, false);
    assert.equal(stdout.output, "");
  } finally {
    if (saved === undefined) delete process.env.UNCLECODE_DISABLE_ALT_SCREEN;
    else process.env.UNCLECODE_DISABLE_ALT_SCREEN = saved;
  }
});

test("entering does not leave process listeners behind after restore", () => {
  withoutDisableFlag(() => {
    const before = process.listenerCount("SIGINT") + process.listenerCount("exit");
    const session = enterAlternateScreen(fakeStdout());
    session.restore();
    const after = process.listenerCount("SIGINT") + process.listenerCount("exit");
    assert.equal(after, before, "restore must unregister its exit and signal hooks");
  });
});

test("runtime owner startup paints a localized first frame synchronously", () => {
  withoutDisableFlag(() => {
    const english = fakeStdout();
    const englishFrame = showRuntimeConnectionStatus({ locale: "en", stdout: english });
    assert.match(english.output, new RegExp(RUNTIME_CONNECTION_STATUS.en));
    assert.match(english.output, /UncleCode/);
    englishFrame.restore();

    const korean = fakeStdout();
    const koreanFrame = showRuntimeConnectionStatus({ locale: "ko", stdout: korean });
    assert.match(korean.output, new RegExp(RUNTIME_CONNECTION_STATUS.ko));
    assert.doesNotMatch(korean.output, new RegExp(RUNTIME_CONNECTION_STATUS.en));
    koreanFrame.restore();
  });
});
