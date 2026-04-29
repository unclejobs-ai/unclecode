import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertWithinWorkspace,
  PathContainmentError,
} from "@unclecode/orchestrator";

const SYMLINKS_REQUIRE_ELEVATION = process.platform === "win32";

/**
 * Regression — assertWithinWorkspace must follow symlinks even when the
 * leaf does not yet exist (`allowMissing:true`). Without this, an attacker
 * who can place a symlink in the workspace (e.g. via `git checkout` of a
 * tracked symlink, or a prior tool call) can write to an arbitrary
 * filesystem location by targeting a non-existent file underneath the
 * symlinked directory. Codex review (2026-04-29) flagged this at
 * packages/orchestrator/src/team-mini-loop.ts:136 and
 * packages/orchestrator/src/aci/apply-patch.ts:107.
 */

function makeFixture() {
  // Canonicalise the workspace root at fixture creation so macOS's
  // `/var → /private/var` symlink does not sneak past the test assertion
  // when the production path resolves through realpath but the test
  // string-compares against the un-canonical mkdtemp output.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uc-containment-")));
  const target = realpathSync(mkdtempSync(join(tmpdir(), "uc-containment-target-")));
  // Place a symlink INSIDE the workspace pointing OUTSIDE it. This mimics a
  // workspace whose contents include an attacker-controlled or pre-existing
  // symlink to a privileged location.
  symlinkSync(target, join(root, "escape-link"));
  return { root, target };
}

test("assertWithinWorkspace with allowMissing rejects escape via symlinked parent + non-existent leaf", { skip: SYMLINKS_REQUIRE_ELEVATION }, () => {
  const { root, target } = makeFixture();
  try {
    assert.throws(
      () =>
        assertWithinWorkspace(root, "escape-link/new-file.txt", {
          allowMissing: true,
        }),
      (error) => error instanceof PathContainmentError,
      "must reject writing to a path whose existing parent symlink points outside the workspace",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("assertWithinWorkspace with allowMissing still accepts a real new path under a real workspace dir", () => {
  // Canonicalise root the same way the fixture above does so the
  // resolved-path comparison below cannot be satisfied by a partial-string
  // match alone — see Codex review (2026-04-29) on weak assertion shape.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uc-containment-ok-")));
  try {
    mkdirSync(join(root, "real-subdir"), { recursive: true });
    const resolved = assertWithinWorkspace(root, "real-subdir/new-file.txt", {
      allowMissing: true,
    });
    assert.equal(
      resolved,
      join(root, "real-subdir", "new-file.txt"),
      "resolved path must equal the canonicalised workspace-relative target exactly",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertWithinWorkspace with allowMissing rejects deep traversal mixed with symlinked parent", { skip: SYMLINKS_REQUIRE_ELEVATION }, () => {
  const { root, target } = makeFixture();
  try {
    assert.throws(
      () =>
        assertWithinWorkspace(root, "escape-link/sub/deeper/file.txt", {
          allowMissing: true,
        }),
      (error) => error instanceof PathContainmentError,
      "must reject any path whose closest-existing ancestor is a symlink that escapes the workspace",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
