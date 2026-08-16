import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render, Text } from "ink";
import React from "react";

import {
  looksLikeStandaloneImagePathInput,
  resolveComposerVisibleWidth,
  resolveWorkShellPaneTerminalColumns,
  shouldAutoPromoteStandaloneImagePreview,
} from "@unclecode/tui";
import {
  GIT_FACTS_TTL_MS,
  parseGitFacts,
  readGitFacts,
  useGitFacts,
} from "../../packages/tui/src/facts.ts";

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
  assert.equal(resolveComposerVisibleWidth(143), 133);
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

// `git status --porcelain=v1 --branch` is the only Git call the work shell
// makes. The footer needs the branch and three counts, so the XY columns are
// parsed rather than reduced to "N modified", and the read is cached because
// the footer repaints on every keystroke.

const PORCELAIN = [
  "## feature/console...origin/feature/console [ahead 2, behind 1]",
  "M  staged-only.ts",
  " M unstaged-only.ts",
  "MM staged-and-unstaged.ts",
  "R  old-name.ts -> new-name.ts",
  "UU conflicted.ts",
  "?? untracked.ts",
  "!! ignored.ts",
  "",
].join("\n");

test("git facts count each file once in every category its XY columns claim", () => {
  assert.deepEqual(parseGitFacts(PORCELAIN), {
    branch: "feature/console",
    // M_, MM, R_, UU
    staged: 4,
    // _M, MM, UU
    unstaged: 3,
    untracked: 1,
  });
});

test("git facts read the branch header without its upstream or divergence", () => {
  assert.equal(parseGitFacts("## main...origin/main [ahead 7]\n").branch, "main");
  assert.equal(parseGitFacts("## main\n").branch, "main");
  assert.equal(parseGitFacts("## No commits yet on trunk\n").branch, "trunk");
  assert.equal(parseGitFacts("## HEAD (no branch)\n").branch, "detached");
});

test("a clean checkout reports zero counts, not an absent branch", () => {
  assert.deepEqual(parseGitFacts("## main...origin/main\n"), {
    branch: "main",
    staged: 0,
    unstaged: 0,
    untracked: 0,
  });
});

test("porcelain output with no branch header still yields countable facts", () => {
  assert.deepEqual(parseGitFacts(" M only-change.ts\n?? new.ts\n"), {
    staged: 0,
    unstaged: 1,
    untracked: 1,
  });
});

test("git facts execute once per cwd inside the cache window and again after it", () => {
  const calls = [];
  const reader = (cwd) => {
    calls.push(cwd);
    return "## main\n M a.ts\n";
  };
  const cwd = `/tmp/unclecode-git-facts-${process.pid}-window`;

  assert.equal(readGitFacts(cwd, 10_000, reader).unstaged, 1);
  assert.equal(calls.length, 1);
  readGitFacts(cwd, 10_000 + GIT_FACTS_TTL_MS - 1, reader);
  assert.equal(calls.length, 1, "a second read inside the TTL must reuse the cache");
  readGitFacts(cwd, 10_000 + GIT_FACTS_TTL_MS, reader);
  assert.equal(calls.length, 2, "a read at the TTL boundary must refresh");
});

test("a wall-clock rollback expires the git facts cache", () => {
  const calls = [];
  const cwd = `/tmp/unclecode-git-facts-${process.pid}-rollback`;
  const reader = (readCwd) => {
    calls.push(readCwd);
    return "## main\n";
  };

  readGitFacts(cwd, 50_000, reader);
  readGitFacts(cwd, 40_000, reader);
  assert.deepEqual(calls, [cwd, cwd]);
});

test("the git facts cache is keyed by cwd", () => {
  const calls = [];
  const reader = (cwd) => {
    calls.push(cwd);
    return cwd.endsWith("-b") ? "## topic\n?? x.ts\n" : "## main\nM  y.ts\n";
  };
  const a = `/tmp/unclecode-git-facts-${process.pid}-a`;
  const b = `/tmp/unclecode-git-facts-${process.pid}-b`;

  assert.deepEqual(readGitFacts(a, 20_000, reader), {
    branch: "main",
    staged: 1,
    unstaged: 0,
    untracked: 0,
  });
  assert.deepEqual(readGitFacts(b, 20_000, reader), {
    branch: "topic",
    staged: 0,
    unstaged: 0,
    untracked: 1,
  });
  assert.deepEqual(calls, [a, b], "one cwd's cache entry must not answer for another");
});

test("a repository error yields empty facts instead of throwing into the render", () => {
  const cwd = `/tmp/unclecode-git-facts-${process.pid}-broken`;
  assert.deepEqual(
    readGitFacts(cwd, 30_000, () => {
      throw new Error("fatal: not a git repository");
    }),
    { staged: 0, unstaged: 0, untracked: 0 },
  );
});

function GitFactsProbe({ cwd, active, reader }) {
  const facts = useGitFacts(cwd, active, reader);
  return React.createElement(
    Text,
    null,
    `${cwd}:${facts.branch ?? "none"}:${facts.staged}/${facts.unstaged}/${facts.untracked}`,
  );
}

function renderGitFactsProbe(props) {
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.rows = 10;
  stdout.isTTY = true;
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  stderr.columns = 100;
  stderr.rows = 10;
  stderr.isTTY = true;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(React.createElement(GitFactsProbe, props), {
    stdout,
    stderr,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    instance,
    getOutput: () => output,
    clearOutput: () => { output = ""; },
  };
}

async function waitForGitFacts(predicate, description, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

test("the git facts hook never pairs a new cwd with stale workspace facts", async () => {
  const a = `/tmp/unclecode-hook-${process.pid}-a`;
  const b = `/tmp/unclecode-hook-${process.pid}-b`;
  const calls = [];
  const reader = (cwd) => {
    calls.push(cwd);
    return cwd === a ? "## main\nM  staged.ts\n" : "## topic\n?? new.ts\n";
  };
  const probe = renderGitFactsProbe({ cwd: a, active: false, reader });

  try {
    await waitForGitFacts(
      () => probe.getOutput().includes(`${a}:main:1/0/0`),
      "the first workspace facts",
    );
    probe.clearOutput();
    probe.instance.rerender(React.createElement(GitFactsProbe, { cwd: b, active: false, reader }));
    await waitForGitFacts(
      () => probe.getOutput().includes(`${b}:topic:0/0/1`),
      "the second workspace facts",
    );
    assert.doesNotMatch(probe.getOutput(), new RegExp(`${b}:main`));
    assert.deepEqual(calls, [a, b]);
  } finally {
    probe.instance.unmount();
    probe.instance.cleanup();
  }
});

test("the active git facts hook refreshes on its TTL and stops after unmount", async () => {
  const cwd = `/tmp/unclecode-hook-${process.pid}-active`;
  const calls = [];
  const reader = (readCwd) => {
    calls.push(readCwd);
    return "## main\n";
  };
  const probe = renderGitFactsProbe({ cwd, active: true, reader });

  await waitForGitFacts(() => calls.length >= 2, "the active workspace refresh");
  probe.instance.unmount();
  probe.instance.cleanup();
  const callsAfterUnmount = calls.length;
  await new Promise((resolve) => setTimeout(resolve, GIT_FACTS_TTL_MS + 100));
  assert.equal(calls.length, callsAfterUnmount);
});
