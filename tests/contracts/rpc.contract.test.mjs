import assert from "node:assert/strict";
import test from "node:test";

import {
  UNCLECODE_RPC_PROTOCOL,
  UNCLECODE_RPC_TRANSPORT,
  encodeUnclecodeRpcFrame,
  isUnclecodeRpcFrame,
} from "@unclecode/contracts";

test("stdio JSONL RPC ready frame advertises the UncleCode protocol", () => {
  const frame = {
    type: "ready",
    protocol: UNCLECODE_RPC_PROTOCOL,
    transport: UNCLECODE_RPC_TRANSPORT,
    capabilities: ["session.run", "tool.call"],
  };

  assert.equal(encodeUnclecodeRpcFrame(frame).endsWith("\n"), true);
  assert.equal(isUnclecodeRpcFrame(frame), true);
  assert.equal(
    isUnclecodeRpcFrame({ ...frame, protocol: "jsonrpc-2.0" }),
    false,
  );
});

test("stdio JSONL RPC command frames are not JSON-RPC 2.0 envelopes", () => {
  const frame = {
    type: "command",
    id: "cmd-1",
    command: {
      name: "session.run",
      input: { prompt: "inspect providers", cwd: "/workspace" },
    },
  };

  assert.equal(isUnclecodeRpcFrame(frame), true);
  assert.equal(Object.hasOwn(frame, "jsonrpc"), false);
  assert.equal(JSON.parse(encodeUnclecodeRpcFrame(frame)).type, "command");
});
