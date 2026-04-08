import assert from "node:assert/strict";
import test from "node:test";

import { createOrchestrator } from "../../packages/orchestrator/src/index.ts";

test("createOrchestrator runs a linear research flow and records ordered events", async () => {
  const observed = [];

  const orchestrator = createOrchestrator({
    async prepareResearchBundle(input) {
      observed.push(["bundle", input.prompt]);
      return {
        packet: { id: "packet-1" },
        relatedMemories: [],
        hypotheses: [],
        artifactsDir: "/tmp/artifacts",
      };
    },
    async startMcpProfile(profile) {
      observed.push(["start", profile.profileName]);
      return { profileName: profile.profileName, connectedServerNames: profile.serverNames };
    },
    async runResearchExecutor(input) {
      observed.push(["execute", input.prompt]);
      return {
        summary: "Research summary",
        artifactPaths: ["/tmp/artifacts/research.md"],
      };
    },
    async stopMcpProfile(run) {
      observed.push(["stop", run.profileName]);
    },
  });

  const result = await orchestrator.runResearch({
    rootDir: "/repo",
    prompt: "compare runtime strategies",
    sessionId: "session-1",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.summary, "Research summary");
  assert.deepEqual(result.events.map((event) => event.type), [
    "research.bootstrapping",
    "research.running",
    "research.completed",
  ]);
  assert.deepEqual(observed, [
    ["bundle", "compare runtime strategies"],
    ["start", "research-default"],
    ["execute", "compare runtime strategies"],
    ["stop", "research-default"],
  ]);
});

test("createOrchestrator stops the MCP profile when research execution fails", async () => {
  let stopCalls = 0;

  const orchestrator = createOrchestrator({
    async prepareResearchBundle() {
      return {
        packet: { id: "packet-2" },
        relatedMemories: [],
        hypotheses: [],
        artifactsDir: "/tmp/artifacts",
      };
    },
    async startMcpProfile(profile) {
      return { profileName: profile.profileName, connectedServerNames: profile.serverNames };
    },
    async runResearchExecutor() {
      throw new Error("executor failed");
    },
    async stopMcpProfile() {
      stopCalls += 1;
    },
  });

  const result = await orchestrator.runResearch({
    rootDir: "/repo",
    prompt: "broken run",
  });

  assert.equal(result.status, "failed");
  assert.match(result.summary, /executor failed/);
  assert.equal(stopCalls, 1);
  assert.equal(result.events.at(-1)?.type, "research.failed");
});
