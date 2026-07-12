import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render } from "ink";
import React from "react";

import {
  Composer,
  WorkShellPane,
  resolveAttachmentOnlyInspectionPrompt,
  resolveWorkShellPaneTerminalRows,
} from "../../packages/tui/src/index.tsx";
import {
  getWorkShellSlashSuggestions,
  shouldBlockSlashSubmit,
} from "../../packages/orchestrator/src/index.ts";

const PNG_A = {
  type: "image",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,AAA=",
  path: "(clipboard)",
  displayName: "clipboard.png",
};

const PNG_B = {
  type: "image",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,BBB=",
  path: "(clipboard)",
  displayName: "clipboard-2.png",
};

function attachmentWirePayload(attachment) {
  return {
    type: attachment.type,
    mimeType: attachment.mimeType,
    dataUrl: attachment.dataUrl,
  };
}

function createInkInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  input.resume = () => input;
  input.pause = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

function createWritableOutput(columns = 120, rows = 40) {
  const output = new PassThrough();
  output.columns = columns;
  output.rows = rows;
  output.isTTY = true;
  return output;
}

function createWritableError(columns = 120, rows = 40) {
  const error = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  error.columns = columns;
  error.rows = rows;
  error.isTTY = true;
  return error;
}

function renderWithInput(element, options = {}) {
  const stdin = createInkInput();
  const stdout = createWritableOutput(options.columns ?? 120, options.rows ?? 40);
  let output = "";
  let renderCount = 0;
  stdout.on("data", (chunk) => {
    output += chunk.toString();
    renderCount += 1;
  });
  const instance = render(element, {
    stdin,
    stdout,
    stderr: createWritableError(options.columns ?? 120, options.rows ?? 40),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    stdin,
    stdout,
    instance,
    getOutput: () => output,
    getRenderCount: () => renderCount,
    clearOutput: () => {
      output = "";
    },
  };
}

async function waitForCondition(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

function createWorkShellPaneEngine() {
  const submitted = [];
  let state = {
    entries: [],
    model: "gpt-5.4",
    mode: "yolo",
    reasoning: "medium",
    authLabel: "oauth-file",
    isBusy: false,
    bridgeLines: [],
    memoryLines: [],
    panel: {
      title: "Session status",
      lines: ["Work context ready."],
    },
  };
  const listeners = new Set();

  return {
    submitted,
    engine: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      initialize: async () => {},
      dispose: () => {},
      handleSubmit: async (line, attachments) => {
        submitted.push({
          line,
          attachments: attachments ? attachments.map(attachmentWirePayload) : [],
        });
      },
      setMode: async () => {},
      openSessionsPanel: async () => {},
    },
  };
}

function paneProps(engine, extras = {}) {
  return {
    provider: "OpenAI",
    model: "gpt-5.4",
    mode: "yolo",
    engine,
    cwd: "/Users/parkeungje/project/unclecode",
    resolveComposerInput: async (value) => ({
      prompt: value,
      attachments: [],
      transcriptText: value,
    }),
    getSuggestions: (value) =>
      getWorkShellSlashSuggestions(value, {
        provider: "openai",
        currentModel: "gpt-5.4",
      }),
    onExit: () => {},
    shouldBlockSlashSubmit: (line) =>
      shouldBlockSlashSubmit(line, {
        provider: "openai",
        currentModel: "gpt-5.4",
      }),
    getReasoningLabel: () => "default medium",
    isReasoningSupported: () => true,
    ...extras,
  };
}

test("resolveAttachmentOnlyInspectionPrompt uses singular and plural copy", () => {
  assert.equal(resolveAttachmentOnlyInspectionPrompt(1), "Please inspect the attached image.");
  assert.equal(resolveAttachmentOnlyInspectionPrompt(2), "Please inspect the attached images.");
  assert.equal(resolveAttachmentOnlyInspectionPrompt(5), "Please inspect the attached images.");
});

test("resolveWorkShellPaneTerminalRows prefers live stdout rows", () => {
  assert.equal(resolveWorkShellPaneTerminalRows({ rows: 37 }), 37);
});

test("mounted Ctrl+V with injected synthetic PNG captures once and forwards badge state", async () => {
  const { engine, submitted } = createWorkShellPaneEngine();
  let captureCalls = 0;
  const { stdin, instance, getOutput } = renderWithInput(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        captureClipboardImage: () => {
          captureCalls += 1;
          return { status: "ok", attachment: PNG_A };
        },
      }),
    ),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("\u0016");
    await waitForCondition(() => captureCalls === 1);
    await waitForCondition(() => getOutput().includes("[1/5]"));

    stdin.write("\r");
    await waitForCondition(() => submitted.length === 1);

  } finally {
    instance.unmount();
    instance.cleanup();
  }

  assert.equal(captureCalls, 1);
  assert.deepEqual(submitted, [{
    line: "Please inspect the attached image.",
    attachments: [attachmentWirePayload(PNG_A)],
  }]);
});

test("text paste does not invoke clipboard image capture", async () => {
  const { engine } = createWorkShellPaneEngine();
  let captureCalls = 0;
  const { stdin, instance } = renderWithInput(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        captureClipboardImage: () => {
          captureCalls += 1;
          return { status: "ok", attachment: PNG_A };
        },
      }),
    ),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("paste this ordinary text without ctrl-v image capture");
    await new Promise((resolve) => setTimeout(resolve, 200));

  } finally {
    instance.unmount();
    instance.cleanup();
  }

  assert.equal(captureCalls, 0);
});

test("exact /attach clipboard uses injectable capture and does not submit the slash form", async () => {
  const { engine, submitted } = createWorkShellPaneEngine();
  let captureCalls = 0;
  const { stdin, instance, getOutput } = renderWithInput(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        captureClipboardImage: () => {
          captureCalls += 1;
          return { status: "ok", attachment: PNG_A };
        },
      }),
    ),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("/attach clipboard");
    stdin.write("\r");
    await waitForCondition(() => captureCalls === 1);
    await waitForCondition(() => getOutput().includes("[1/5]"));
    await new Promise((resolve) => setTimeout(resolve, 150));

  } finally {
    instance.unmount();
    instance.cleanup();
  }

  assert.equal(captureCalls, 1);
  assert.deepEqual(submitted, [], "exact /attach clipboard must attach only, not submit");
});

test("near-miss /attach forms surface a friendly error and skip capture", async () => {
  const { engine, submitted } = createWorkShellPaneEngine();
  let captureCalls = 0;
  const { stdin, instance, getOutput } = renderWithInput(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        captureClipboardImage: () => {
          captureCalls += 1;
          return { status: "ok", attachment: PNG_A };
        },
      }),
    ),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("/attach");
    stdin.write("\r");
    await waitForCondition(() => getOutput().includes("Use /attach clipboard"));
    await new Promise((resolve) => setTimeout(resolve, 100));

  } finally {
    instance.unmount();
    instance.cleanup();
  }

  assert.equal(captureCalls, 0);
  assert.deepEqual(submitted, []);
});

test("many clipboard attachments submit once with plural inspection prompt", async () => {
  const { engine, submitted } = createWorkShellPaneEngine();
  const queue = [PNG_A, PNG_B];
  const { stdin, instance, getOutput } = renderWithInput(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        captureClipboardImage: () => {
          const attachment = queue.shift();
          assert.ok(attachment, "unexpected extra capture");
          return { status: "ok", attachment };
        },
      }),
    ),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("\u0016");
    await waitForCondition(() => getOutput().includes("[1/5]"));
    stdin.write("\u0016");
    await waitForCondition(() => getOutput().includes("[2/5]"));
    stdin.write("\r");
    await waitForCondition(() => submitted.length === 1);

  } finally {
    instance.unmount();
    instance.cleanup();
  }

  assert.deepEqual(submitted, [{
    line: "Please inspect the attached images.",
    attachments: [attachmentWirePayload(PNG_A), attachmentWirePayload(PNG_B)],
  }]);
});

test("busy queue accepts an attachment-only follow-up and clears its badge", async () => {
  const submitted = [];
  const busyEngine = {
    getState: () => ({
      entries: [],
      model: "gpt-5.4",
      mode: "yolo",
      reasoning: "medium",
      authLabel: "oauth-file",
      isBusy: true,
      bridgeLines: [],
      memoryLines: [],
      panel: { title: "Session status", lines: ["Work context ready."] },
    }),
    subscribe: () => () => {},
    initialize: async () => {},
    dispose: () => {},
    handleSubmit: async (line, attachments) => {
      submitted.push({
        line,
        attachments: attachments ? attachments.map(attachmentWirePayload) : [],
      });
    },
    setMode: async () => {},
    openSessionsPanel: async () => {},
  };
  let captureCalls = 0;
  const { stdin, instance, getOutput, clearOutput, getRenderCount } = renderWithInput(
    React.createElement(
      WorkShellPane,
      paneProps(busyEngine, {
        captureClipboardImage: () => {
          captureCalls += 1;
          return { status: "ok", attachment: PNG_A };
        },
      }),
    ),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("\u0016");
    await waitForCondition(() => captureCalls === 1);
    await waitForCondition(() => getOutput().includes("[1/5]"));
    clearOutput();
    const renderCountBeforeSubmit = getRenderCount();
    stdin.write("\r");
    await waitForCondition(() => submitted.length === 1);
    await waitForCondition(() => getRenderCount() > renderCountBeforeSubmit);
    await waitForCondition(() => !getOutput().includes("[1/5]"));
    assert.deepEqual(submitted, [{
      line: "Please inspect the attached image.",
      attachments: [attachmentWirePayload(PNG_A)],
    }]);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("attachment pasted during an in-flight submit remains queued for the next turn", async () => {
  const submitted = [];
  let releaseFirstSubmit;
  const firstSubmitGate = new Promise((resolve) => {
    releaseFirstSubmit = resolve;
  });
  const engine = {
    ...createWorkShellPaneEngine().engine,
    handleSubmit: async (line, attachments) => {
      submitted.push({
        line,
        attachments: attachments ? attachments.map(attachmentWirePayload) : [],
      });
      if (submitted.length === 1) {
        await firstSubmitGate;
      }
    },
  };
  const captures = [PNG_A, PNG_B];
  const { stdin, instance, getOutput, clearOutput } = renderWithInput(
    React.createElement(
      WorkShellPane,
      paneProps(engine, {
        captureClipboardImage: () => {
          const attachment = captures.shift();
          assert.ok(attachment, "unexpected extra capture");
          return { status: "ok", attachment };
        },
      }),
    ),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("\u0016");
    await waitForCondition(() => getOutput().includes("[1/5]"));
    stdin.write("\r");
    await waitForCondition(() => submitted.length === 1);

    stdin.write("\u0016");
    await waitForCondition(() => getOutput().includes("[2/5]"));
    clearOutput();
    releaseFirstSubmit();
    await waitForCondition(() => getOutput().includes("[1/5]"));

    clearOutput();
    stdin.write("\r");
    await waitForCondition(() => submitted.length === 2);
    await waitForCondition(() => getOutput().includes("prompt deck") && !getOutput().includes("[1/5]"));
    assert.deepEqual(submitted, [
      {
        line: "Please inspect the attached image.",
        attachments: [attachmentWirePayload(PNG_A)],
      },
      {
        line: "Please inspect the attached image.",
        attachments: [attachmentWirePayload(PNG_B)],
      },
    ]);
  } finally {
    releaseFirstSubmit?.();
    instance.unmount();
    instance.cleanup();
  }
});

test("Composer injectable capture defaults are overridable without OS clipboard mutation", async () => {
  let captureCalls = 0;
  const attached = [];
  function Harness() {
    const [value, setValue] = React.useState("");
    return React.createElement(Composer, {
      value,
      onChange: setValue,
      onSubmit: () => {},
      captureClipboardImage: () => {
        captureCalls += 1;
        return { status: "ok", attachment: PNG_A };
      },
      onClipboardImage: (attachment) => {
        attached.push(attachment.displayName);
      },
    });
  }

  const { stdin, instance } = renderWithInput(React.createElement(Harness));
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write("\u0016");
    await waitForCondition(() => captureCalls === 1 && attached.length === 1);
  } finally {
    instance.unmount();
    instance.cleanup();
  }

  assert.deepEqual(attached, ["clipboard.png"]);
});
