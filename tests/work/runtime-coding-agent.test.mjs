import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeCodingAgent } from "../../apps/unclecode-cli/src/runtime-coding-agent.ts";

test("createRuntimeCodingAgent can wrap an injected provider and refresh auth tokens in place", async () => {
  const refreshed = [];
  let activeToken = "initial-token";
  const provider = {
    clear() {},
    setTraceListener() {},
    updateRuntimeSettings() {},
    updateAuthToken(apiKey) {
      refreshed.push(apiKey);
      activeToken = apiKey;
    },
    async runTurn(prompt) {
      return { text: `${activeToken}:${prompt}` };
    },
  };

  const agent = await createRuntimeCodingAgent({
    provider: "openai",
    apiKey: "initial-token",
    model: "gpt-5.4",
    cwd: process.cwd(),
    reasoning: {
      effort: "medium",
      source: "mode-default",
      support: {
        status: "supported",
        defaultEffort: "medium",
        supportedEfforts: ["low", "medium", "high"],
      },
    },
    providerOverride: provider,
  });

  const first = await agent.runTurn("hello");
  assert.equal(first.text, "initial-token:hello");

  agent.refreshAuthToken("next-token");
  const second = await agent.runTurn("again");

  assert.deepEqual(refreshed, ["next-token"]);
  assert.equal(second.text, "next-token:again");
});
