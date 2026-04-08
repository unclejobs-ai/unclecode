import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_INTENTS,
  APPROVAL_INTENT_TYPES,
  TRUST_ZONES,
} from "@unclecode/contracts";

test("policy-intent fixtures expose serializable trust zones and approval intents", () => {
  assert.deepEqual(TRUST_ZONES, [
    "workspace",
    "session",
    "local",
    "project",
    "user",
    "enterprise",
    "managed",
    "dynamic",
    "claudeai",
  ]);

  assert.deepEqual(APPROVAL_INTENT_TYPES, [
    "tool_execution",
    "plan",
    "mcp_server",
    "background_task",
  ]);

  assert.deepEqual(APPROVAL_INTENTS.plan, {
    type: "plan",
    label: "Plan approval",
    trustZone: "session",
    requiresRequestId: true,
    supportsMode: true,
  });

  assert.deepEqual(APPROVAL_INTENTS.tool_execution, {
    type: "tool_execution",
    label: "Tool execution approval",
    trustZone: "workspace",
    requiresRequestId: true,
    supportsMode: true,
  });
});
