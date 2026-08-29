import {
  BoundedEventJournal,
  createRuntimeAdapter,
  makeControlRoomHandlers,
  readRuntimeProcessObservability,
  startServer,
} from "@unclecode/server";

const token = process.env.UNCLECODE_FIXTURE_TOKEN ?? "unclecode-control-room-browser-fixture-token-2026";
const port = Number.parseInt(process.env.UNCLECODE_FIXTURE_PORT ?? "17677", 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new TypeError("UNCLECODE_FIXTURE_PORT must be an integer between 0 and 65535.");
}
const journal = new BoundedEventJournal();
const fixtureStartedAt = Date.now();
const koreanRun = { revision: 12, state: "running" };
const englishRun = { revision: 4, state: "completed" };

const qualityReview = {
  runId: "run-ko-scc-001", graphId: "graph-001", profile: "deep",
  currentStage: "critic", latestDecision: "unproven", iteration: 2,
  refineCount: 1, pivotCount: 0,
  history: [
    {
      event: "gate", stage: "plan", decision: "proceed", iteration: 0,
      failures: [], evidenceRefs: [], artifactRefs: [], independentVerification: false,
      stale: false, startedAt: 1,
    },
    {
      event: "refine", stage: "work", decision: "refine", iteration: 1,
      reason: "긴 한글 입력 회귀를 수정했습니다.", failures: ["긴 한글 입력 회귀를 수정했습니다."],
      evidenceRefs: [], artifactRefs: [".unclecode/artifacts/demo/input-test.txt"],
      artifactHash: "sha256:6b7a", count: 1, limit: 3, independentVerification: false,
      stale: false, startedAt: 2,
    },
    {
      event: "gate", stage: "critic", decision: "unproven", iteration: 2,
      failures: ["별도 공급자의 독립 검토 증거가 아직 없습니다."], evidenceRefs: [],
      artifactRefs: [".unclecode/artifacts/demo/tui-smoke.txt"], artifactHash: "sha256:91ce",
      independentVerification: false, stale: false, startedAt: 3,
    },
  ],
};

function workNode({ id, title, stage, role, status, attempt, dependsOn = [], artifactRefs = [] }) {
  return {
    id, title, prompt: title, status,
    dependsOn, fileOwnership: [], evidenceRefs: [],
    stage, role, attempt, artifactRefs,
    reviewRequired: stage === "critic" || stage === "promote",
  };
}

function systemObservability() {
  return {
    evidenceSources: { owner: "available", cacheTelemetry: "available" },
    ...readRuntimeProcessObservability(),
    journal: journal.stats,
    engines: {
      attachedSessions: 0, activeMutationsObserved: 0, pendingCreations: 0,
      pendingTeardowns: 0, clientLeaseProtectedSessionsObserved: 0, teardownFailuresRetained: 0,
      observedSessions: 0, scanTruncated: false, cleanupEntriesDropped: 0,
      unlistedPendingTeardowns: 0, observabilityCallbackFailures: 0,
      mcpConfigurationUnavailableObserved: 0,
    },
    providers: [{
      provider: "openai", model: "gpt-5.6-sol", configured: true,
      authentication: "unverified", liveProbe: "not-run",
      observedAt: fixtureStartedAt,
    }],
    mcpServers: [{
      name: "filesystem", transport: "stdio", configured: true,
      authentication: "unverified", liveProbe: "not-run",
      observedAt: fixtureStartedAt,
    }],
    pluginHosts: [{
      sessionId: "run-ko-scc-001",
      status: "active",
      registrationCount: 1,
      pendingCleanupCount: 0,
      registrations: [{
        name: "legacy-external-plugin",
        source: "workspace",
        trustLane: "workspace-trusted",
        hookCount: 1,
      }],
      truncated: false,
    }],
    cleanup: [{
      kind: "plugin-host", identity: "run-ko-scc-001:legacy-external-plugin", status: "completed",
      recordedAt: fixtureStartedAt,
    }],
    caches: [{
      name: "control-room-fixture",
      hits: 12, misses: 3,
      evictions: 0,
      byteEvictions: 0,
      invalidations: 0,
      currentSize: 4,
      maxEntries: 64,
      maxRetainedBytes: 1_048_576,
      retainedBytesEstimate: 16_384,
    }],
  };
}

const adapter = createRuntimeAdapter({
  async read() {
    return {
      generatedAt: Date.now(),
      sessions: [{
        sessionId: "run-ko-scc-001",
        projectPath: "/Users/example/project/unclecode",
        locale: "ko",
        state: koreanRun.state,
        revision: koreanRun.revision,
        updatedAt: new Date().toISOString(),
        metadata: { model: "gpt-5.6-sol", provider: "openai", permissionMode: "default" },
        agentConsole: {
          profileId: "build",
          qualityReview,
          workGraph: {
            id: "graph-001",
            qualityProfile: "deep",
            currentStage: "critic",
            gateStatus: "unproven",
            iteration: 2,
            approval: "approved",
            nodes: [
              workNode({ id: "explore", title: "요구사항과 실행 경계 확인", stage: "explore", role: "planner", status: "completed", attempt: 1 }),
              workNode({ id: "work", title: "TUI와 런타임 통합", stage: "work", role: "worker", status: "completed", attempt: 2, dependsOn: ["explore"], artifactRefs: [".unclecode/artifacts/demo/input-test.txt"] }),
              workNode({ id: "critic", title: "독립 검증", stage: "critic", role: "critic", status: "running", attempt: 1, dependsOn: ["work"] }),
            ],
          },
          activity: [],
          agents: [{
            id: "agent-critic", displayName: "검토자", agentType: "critic", status: "running",
            currentActivity: "증거 해시 검증", startedAt: 3,
          }],
          jobs: [{
            id: "job-tui", label: "TUI 회귀 테스트", status: "completed", type: "test",
            queuedAt: 1, startedAt: 2, completedAt: 3, summary: "TUI 회귀 테스트 통과",
          }],
          pluginDiagnostics: [{
            runId: "run-ko-scc-001", source: "workspace", trustLane: "workspace-trusted", pluginId: "legacy-external-plugin",
            pluginName: "legacy-external-plugin", hookName: "Stop", status: "error", errorName: "PluginHookError",
            errorMessage: "Stop hook failed: incompatible zod/v3 adapter", exitStatus: "2",
            dedupeKey: `sha256:${"d".repeat(64)}`, startedAt: 50,
          }],
        },
        context: {
          included: [{ id: "agents", label: "AGENTS.md", reason: "저장소 지침", tokenEstimate: 740 }],
          excluded: [{ id: "old-memory", label: "이전 세션 원문", reason: "원문 대신 압축 요약 사용", tokenEstimate: 2800 }],
          compacted: true,
          receiptId: "context-receipt-77",
        },
      }, {
        sessionId: "run-en-scc-002",
        projectPath: "/Users/example/project/api-service",
        locale: "en",
        state: englishRun.state,
        revision: englishRun.revision,
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        metadata: { model: "gpt-5.6-sol", provider: "openai" },
        agentConsole: {
          profileId: "build",
          qualityReview: {
            runId: "run-en-scc-002", graphId: "graph-en",
            profile: "standard", currentStage: "promote", latestDecision: "proceed", iteration: 1,
            refineCount: 0, pivotCount: 0,
            history: [{
              event: "completed", stage: "promote", decision: "proceed", iteration: 1,
              failures: [], evidenceRefs: [], artifactRefs: [".unclecode/artifacts/en/report.md"],
              artifactHash: "sha256:en77", independentVerification: false, stale: false,
              startedAt: 4,
            }],
          },
          workGraph: {
            id: "graph-en", qualityProfile: "standard", currentStage: "promote",
            gateStatus: "proceed", iteration: 1, approval: "approved",
            nodes: [workNode({
              id: "done", title: "Publish handoff", stage: "promote", role: "promoter",
              status: "completed", attempt: 1, artifactRefs: [".unclecode/artifacts/en/report.md"],
            })],
          },
          activity: [], agents: [], jobs: [], pluginDiagnostics: [],
        },
        context: { included: [], excluded: [], compacted: false },
      }],
      system: systemObservability(),
    };
  },
  controls: {
    async control(request) {
      const run = request.sessionId === "run-ko-scc-001"
        ? koreanRun
        : request.sessionId === "run-en-scc-002"
          ? englishRun
          : undefined;
      if (!run) return { ok: false, code: "not_found", message: "Unknown session." };
      run.revision += 1;
      if (request.action === "pause") run.state = "paused";
      else if (request.action === "resume" || request.action === "follow-up") run.state = "running";
      else if (request.action === "cancel") run.state = "cancelled";
      return { ok: true, revision: run.revision, state: run.state };
    },
  },
});

const server = await startServer({
  port,
  host: "127.0.0.1",
  authToken: token,
  handlers: makeControlRoomHandlers({ adapter, journal }),
});
process.stdout.write(`${server.url}\n`);

// This fixture is intentionally server-only. Runtime QA clients decide if and
// how to open the URL; the fixture never launches a browser process.
await new Promise((resolve, reject) => {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.stop().then(resolve, reject);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
