import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_OBSERVATION_VISIBILITIES,
  TOOL_RESOURCE_KINDS,
  TOOL_RESOURCE_MODES,
  TOOL_RESOURCE_RESOLVERS,
  TOOL_RISK_LEVELS,
} from "@unclecode/contracts";

test("tool metadata enums are stable and serializable", () => {
  assert.deepEqual(TOOL_RISK_LEVELS, ["low", "medium", "high", "unknown"]);
  assert.deepEqual(TOOL_RESOURCE_KINDS, [
    "workspace",
    "file",
    "directory",
    "shell",
    "patch",
    "network",
    "context",
    "unknown",
  ]);
  assert.deepEqual(TOOL_RESOURCE_MODES, [
    "read",
    "write",
    "delete",
    "execute",
    "unknown",
  ]);
  assert.deepEqual(TOOL_RESOURCE_RESOLVERS, ["apply-patch-files"]);
  assert.deepEqual(TOOL_OBSERVATION_VISIBILITIES, [
    "model",
    "summary",
    "hidden",
  ]);
});
