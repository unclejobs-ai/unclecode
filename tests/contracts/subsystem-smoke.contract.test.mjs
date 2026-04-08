import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG_CORE_DEFAULT_MODE_PROFILE } from "@unclecode/config-core";
import { CONTEXT_BROKER_DEFAULT_CHECKPOINT } from "@unclecode/context-broker";
import {
  APPROVAL_INTENT_TYPES,
  BACKGROUND_TASK_TYPES,
  MCP_TRANSPORTS,
  MODE_PROFILES,
  PROVIDER_IDS,
  RUNTIME_MODES,
  SESSION_CHECKPOINT_TYPES,
  SESSION_STATES,
} from "@unclecode/contracts";
import { MCP_HOST_SUPPORTED_TRANSPORTS } from "@unclecode/mcp-host";
import { ORCHESTRATOR_TASK_TYPES } from "@unclecode/orchestrator";
import { POLICY_ENGINE_APPROVAL_INTENT_TYPES } from "@unclecode/policy-engine";
import { PROVIDERS_SUPPORTED_IDS } from "@unclecode/providers";
import { RUNTIME_BROKER_SUPPORTED_MODES } from "@unclecode/runtime-broker";
import { SESSION_STORE_DEFAULT_STATE } from "@unclecode/session-store";

test("planned subsystem packages smoke-import canonical contract exports", () => {
  assert.equal(CONFIG_CORE_DEFAULT_MODE_PROFILE, MODE_PROFILES.default.id);
  assert.equal(CONTEXT_BROKER_DEFAULT_CHECKPOINT, SESSION_CHECKPOINT_TYPES[0]);
  assert.deepEqual(POLICY_ENGINE_APPROVAL_INTENT_TYPES, APPROVAL_INTENT_TYPES);
  assert.equal(SESSION_STORE_DEFAULT_STATE, SESSION_STATES[0]);
  assert.deepEqual(RUNTIME_BROKER_SUPPORTED_MODES, RUNTIME_MODES);
  assert.deepEqual(PROVIDERS_SUPPORTED_IDS, PROVIDER_IDS);
  assert.deepEqual(MCP_HOST_SUPPORTED_TRANSPORTS, MCP_TRANSPORTS);
  assert.deepEqual(ORCHESTRATOR_TASK_TYPES, BACKGROUND_TASK_TYPES);
});
