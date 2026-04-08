import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceShellSections } from "../../packages/tui/src/index.tsx";

test("createWorkspaceShellSections exposes actionable startup guidance", () => {
  const sections = createWorkspaceShellSections({
    workspaceRoot: "/Users/parkeungje/project/unclecode",
  });

  assert.equal(sections.title, "unclecode");
  assert.match(sections.subtitle, /local coding shell/i);
  assert.ok(
    sections.actions.some(
      (action) => action.command === "unclecode auth status",
    ),
  );
  assert.ok(
    sections.actions.some(
      (action) => action.command === "unclecode auth login --browser",
    ),
  );
  assert.ok(
    sections.actions.some(
      (action) => action.command === "unclecode config explain",
    ),
  );
  assert.match(
    sections.workspaceLine,
    /\/Users\/parkeungje\/project\/unclecode/,
  );
});
