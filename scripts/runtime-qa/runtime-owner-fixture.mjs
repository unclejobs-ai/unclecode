import { startPersistentRuntimeOwner } from "../../apps/unclecode-server/src/index.ts";

const [rootDir, leasePath, tokenPath] = process.argv.slice(2);
if (!rootDir || !leasePath || !tokenPath) throw new Error("rootDir, leasePath and tokenPath are required");

function makeEngine(sessionId) {
  let lifecycle = { state: "running", turnId: `turn-${sessionId}` };
  let state = { isBusy: true, queuePaused: false, model: "fixture-model", mode: "standard", uiLocale: "en", agentConsole: {} };
  const listeners = new Set();
  return {
    getSessionId: () => sessionId,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    interruptTurn() { lifecycle = { state: "cancelled" }; state = { ...state, isBusy: false }; for (const listener of listeners) listener(); },
    getTurnLifecycle: () => lifecycle,
    async requestTurnPause() { lifecycle = { state: "paused", turnId: `turn-${sessionId}`, boundary: "before_provider" }; for (const listener of listeners) listener(); return { turnId: `turn-${sessionId}`, boundary: "before_provider" }; },
    resumeTurn() { if (lifecycle.state !== "paused") return false; lifecycle = { state: "running", turnId: `turn-${sessionId}` }; for (const listener of listeners) listener(); return true; },
    setMode(mode) { state = { ...state, mode }; for (const listener of listeners) listener(); },
    async resumeQueueItems() {}, async handleSubmit() {}, answerPendingDecisionByIndex() { return false; },
    getAgentControlPort() { return { async steer() { return { status: "delivered" }; } }; },
  };
}
const owner = await startPersistentRuntimeOwner({
  rootDir, leasePath, tokenPath,
  async createSession(input) { return { engine: makeEngine(input.sessionId), projectPath: input.projectPath, provider: input.provider }; },
});
await owner.engines.create({ sessionId: "live-1", projectPath: process.cwd(), idempotencyKey: "fixture-live-1" });

process.stdout.write(`${JSON.stringify(owner.lease)}\n`);
const shutdown = async () => { await owner.stop(); process.exit(0); };
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
