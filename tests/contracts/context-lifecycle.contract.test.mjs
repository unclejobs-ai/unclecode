import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_PACKET_RECEIPT_STATES,
  CONTEXT_POLICY_ACTIONS,
  MEMORY_LINEAGE_STATES,
  isContextPacketReceiptState,
} from "@unclecode/contracts";

test("context lifecycle contracts expose closed state sets", () => {
  assert.deepEqual(CONTEXT_PACKET_RECEIPT_STATES, ["previewed", "submitted", "invalidated"]);
  assert.deepEqual(CONTEXT_POLICY_ACTIONS, ["keep", "summarize", "hold-back", "refresh"]);
  assert.deepEqual(MEMORY_LINEAGE_STATES, ["active", "superseded", "expired"]);
  assert.equal(isContextPacketReceiptState("submitted"), true);
  assert.equal(isContextPacketReceiptState("pending"), false);
});
