import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkCommandArgs,
  resolveWorkEntrypointModuleUrls,
  withWorkCwd,
} from "../../apps/unclecode-cli/src/work-bootstrap.ts";

test("withWorkCwd injects caller cwd when none is present", () => {
  assert.deepEqual(withWorkCwd(["--tools"], "/tmp/project-a"), ["--cwd", "/tmp/project-a", "--tools"]);
});

test("withWorkCwd preserves explicit cwd when already provided", () => {
  assert.deepEqual(withWorkCwd(["--cwd", "/tmp/other", "--tools"], "/tmp/project-a"), ["--cwd", "/tmp/other", "--tools"]);
});

test("buildWorkCommandArgs assembles work argv without leaking Commander concerns", () => {
  assert.deepEqual(
    buildWorkCommandArgs(["review", "auth.ts"], {
      tools: true,
      cwd: "/tmp/project-a",
      provider: "openai",
      model: "gpt-5.4",
      reasoning: "high",
      sessionId: "work-123",
    }),
    [
      "--tools",
      "--cwd",
      "/tmp/project-a",
      "--provider",
      "openai",
      "--model",
      "gpt-5.4",
      "--reasoning",
      "high",
      "--session-id",
      "work-123",
      "review",
      "auth.ts",
    ],
  );
});

test("resolveWorkEntrypointModuleUrls prefers dist-work and keeps a local dist fallback", () => {
  const urls = resolveWorkEntrypointModuleUrls();

  assert.ok(urls.some((value) => /dist-work\/apps\/unclecode-cli\/src\/work-entry\.js$/.test(value)));
  assert.ok(urls.some((value) => /apps\/unclecode-cli\/dist\/work-entry\.js$/.test(value)));
});
