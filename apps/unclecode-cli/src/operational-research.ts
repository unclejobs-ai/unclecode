import {
  type StartedMcpProfile,
  createMcpHostController,
  createMcpHostRegistry,
  formatMcpHostRegistry,
  getResearchMcpProfile,
  loadMcpHostRegistry,
} from "@unclecode/mcp-host";
import { createOrchestrator, loadExtensionConfigOverlays } from "@unclecode/orchestrator";
import {
  listProjectBridgeLines,
  listScopedMemoryLines,
  prepareResearchBundle,
} from "@unclecode/context-broker";
import { explainUncleCodeConfig } from "@unclecode/config-core";
import { createSessionStore, getSessionStoreRoot } from "@unclecode/session-store";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { elapsedSince, listSessions, type SessionListItem } from "./operational.js";

const RESEARCH_LATENCY_THRESHOLDS = {
  firstEventMsBudget: 1_500,
  totalMsBudget: 3_000,
  bundleMsBudget: 1_500,
  mcpStartMsBudget: 500,
  executorMsBudget: 1_500,
} as const;


export function buildResearchStatusReport(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly userHomeDir?: string;
}): Promise<string> {
  const registry = createMcpHostRegistry({});
  const loadedRegistry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const profile = getResearchMcpProfile(loadedRegistry);

  return listSessions({ workspaceRoot: input.workspaceRoot, env: input.env }).then((items) => {
    const latestResearchSession = items.find((item) => item.sessionId.startsWith("research-"));

    return [
      "Research status",
      `Profile: ${profile.profileName}`,
      `Configured servers: ${profile.serverNames.length}`,
      ...(latestResearchSession
        ? [
            `Last run: ${latestResearchSession.sessionId}`,
            `State: ${latestResearchSession.state}`,
            `Summary: ${latestResearchSession.taskSummary ?? "none"}`,
          ]
        : ["No active research run"]),
    ].join("\n");
  });
}

export function buildMcpListReport(input: {
  readonly workspaceRoot: string;
  readonly userHomeDir?: string;
}): string {
  const registry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });

  return formatMcpHostRegistry(registry);
}

export async function runResearchPassData(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly userHomeDir?: string;
}): Promise<{
  readonly lines: readonly string[];
  readonly report: {
    readonly command: "research.run";
    readonly sessionId: string;
    readonly prompt: string;
    readonly status: "completed" | "failed";
    readonly summary: string;
    readonly artifactPaths: readonly string[];
    readonly metrics: {
      readonly firstEventMs: number;
      readonly totalMs: number;
      readonly bundleMs: number;
      readonly mcpStartMs: number;
      readonly executorMs: number;
    };
    readonly thresholds: typeof RESEARCH_LATENCY_THRESHOLDS;
  };
}> {
  const totalStartedAt = Date.now();
  let firstEventMs = -1;
  let bundleMs = 0;
  let mcpStartMs = 0;
  let executorMs = 0;

  const markFirstEvent = () => {
    if (firstEventMs < 0) {
      firstEventMs = elapsedSince(totalStartedAt);
    }
  };

  markFirstEvent();

  const sessionStore = createSessionStore({ rootDir: getSessionStoreRoot(input.env) });
  const sessionId = `research-${randomUUID()}`;
  const ref = {
    projectPath: input.workspaceRoot,
    sessionId,
  } as const;

  await sessionStore.appendCheckpoint(ref, { type: "state", state: "running" });
  await sessionStore.appendCheckpoint(ref, {
    type: "metadata",
    metadata: { model: "research-local" },
  });

  const registry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.userHomeDir ? { userHomeDir: input.userHomeDir } : {}),
  });
  const hostController = createMcpHostController(registry);
  const profile = getResearchMcpProfile(registry);

  const orchestrator = createOrchestrator({
    async prepareResearchBundle({ rootDir, prompt, sessionId, artifactsDir }) {
      const startedAt = Date.now();
      const bundle = await prepareResearchBundle({
        rootDir,
        ...(sessionId ? { sessionId } : {}),
        artifactsDir,
        hypotheses: [prompt],
      });
      bundleMs = elapsedSince(startedAt);
      markFirstEvent();
      return bundle;
    },
    async startMcpProfile(profileInput) {
      const startedAt = Date.now();
      const startedProfile = await hostController.startProfile(profileInput);
      mcpStartMs = elapsedSince(startedAt);
      markFirstEvent();
      return startedProfile;
    },
    async runResearchExecutor({ prompt, bundle, profile: startedProfile }) {
      const startedAt = Date.now();
      markFirstEvent();
      await mkdir(bundle.artifactsDir, { recursive: true });
      const artifactPath = path.join(bundle.artifactsDir, "research.md");
      const changedFiles = bundle.packet.changedFiles ?? [];
      const hotspots = bundle.packet.hotspots ?? [];
      const policySignals = bundle.packet.policySignals ?? [];
      const summary = `Prepared a local research bundle for \"${prompt}\" with ${changedFiles.length} changed files and ${startedProfile.connectedServerNames.length} MCP servers.`;
      const body = [
        "# UncleCode Research Report",
        "",
        `Prompt: ${prompt}`,
        `Session: ${sessionId}`,
        `Packet: ${bundle.packet.id}`,
        `Changed files: ${changedFiles.length}`,
        `Hotspots: ${hotspots.length}`,
        `Policy signals: ${policySignals.join(", ") || "none"}`,
        `MCP servers: ${startedProfile.connectedServerNames.join(", ") || "none"}`,
        "",
        "## Findings",
        changedFiles.length > 0
          ? `- Changed files observed: ${changedFiles.join(", ")}`
          : "- No changed files observed in the current packet.",
        hotspots.length > 0
          ? `- Hotspots detected: ${hotspots.length}`
          : "- No hotspots detected in the current packet.",
        policySignals.length > 0
          ? `- Policy signals: ${policySignals.join(", ")}`
          : "- No policy signals were emitted.",
        startedProfile.connectedServerNames.length > 0
          ? `- Connected MCP servers: ${startedProfile.connectedServerNames.join(", ")}`
          : "- No MCP servers were connected for this run.",
        "",
        "## Recommended Next Steps",
        changedFiles.length > 0
          ? "1. Inspect the changed files above and decide whether the research should focus on one subsystem first."
          : "1. Introduce a concrete change set or target area so the next research pass can analyze a narrower scope.",
        hotspots.length > 0
          ? "2. Review the hotspot count and prioritize the densest area for the next implementation wave."
          : "2. Run another research pass after a meaningful code change so hotspots and policy signals become more informative.",
        startedProfile.connectedServerNames.length > 0
          ? "3. Use the connected MCP servers as the next source of truth for deeper investigation."
          : "3. Configure MCP servers if you need external tools or richer context for the next run.",
        "",
        `Summary: ${summary}`,
      ].join("\n");

      await writeFile(artifactPath, `${body}\n`, "utf8");
      executorMs = elapsedSince(startedAt);

      return {
        summary,
        artifactPaths: [artifactPath],
      };
    },
    async stopMcpProfile(startedProfile) {
      if (isStartedMcpProfile(startedProfile)) {
        await hostController.stopProfile(startedProfile);
      }
    },
  });

  const result = await orchestrator.runResearch({
    rootDir: input.workspaceRoot,
    prompt: input.prompt,
    sessionId,
    enabledServerNames: profile.serverNames,
  });

  await sessionStore.appendCheckpoint(ref, {
    type: "state",
    state: result.status === "completed" ? "idle" : "requires_action",
  });
  await sessionStore.appendCheckpoint(ref, {
    type: "task_summary",
    summary: result.summary,
    timestamp: new Date().toISOString(),
  });

  const canonicalWorkspaceRoot = await realpath(input.workspaceRoot).catch(() => input.workspaceRoot);
  const ledgerDir = path.join(canonicalWorkspaceRoot, ".unclecode");
  const ledgerPath = path.join(ledgerDir, "research-runs.jsonl");
  await mkdir(ledgerDir, { recursive: true });
  await writeFile(
    ledgerPath,
    `${JSON.stringify({
      sessionId,
      prompt: input.prompt,
      status: result.status,
      summary: result.summary,
      artifactPaths: result.artifactPaths,
      timestamp: new Date().toISOString(),
    })}\n`,
    { encoding: "utf8", flag: "a" },
  );

  const totalMs = elapsedSince(totalStartedAt);
  const lines = [
    result.status === "completed" ? "Research completed" : "Research failed",
    `Session: ${sessionId}`,
    `Summary: ${result.summary}`,
    ...result.artifactPaths.map((artifactPath) => `Artifact: ${artifactPath}`),
  ] as const;

  return {
    lines,
    report: {
      command: "research.run",
      sessionId,
      prompt: input.prompt,
      status: result.status,
      summary: result.summary,
      artifactPaths: result.artifactPaths,
      metrics: {
        firstEventMs: firstEventMs < 0 ? totalMs : firstEventMs,
        totalMs,
        bundleMs,
        mcpStartMs,
        executorMs,
      },
      thresholds: RESEARCH_LATENCY_THRESHOLDS,
    },
  };
}

export async function runResearchPass(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly userHomeDir?: string;
}): Promise<readonly string[]> {
  const { lines } = await runResearchPassData(input);
  return lines;
}

function isStartedMcpProfile(value: {
  readonly profileName: string;
  readonly connectedServerNames: readonly string[];
  readonly connections?: readonly unknown[];
}): value is StartedMcpProfile {
  return Array.isArray(value.connections);
}

export function createTuiActivityEntry(input: {
  readonly actionId: string;
  readonly lines: readonly string[];
  readonly status: "completed" | "failed" | "info";
}) {
  const titleMap: Record<string, string> = {
    doctor: "Doctor",
    "mode-status": "Mode Status",
    "mode-cycle": "Mode Cycle",
    "auth-status": "Auth Status",
    "browser-login": "Browser Login",
    "device-login": "Device Login",
    "mcp-list": "MCP List",
    "new-research": "Research",
  };

  return {
    id: `${input.actionId}-${Date.now()}`,
    source: input.actionId,
    title: titleMap[input.actionId] ?? input.actionId,
    timestamp: new Date().toISOString(),
    lines: input.lines,
    tone:
      input.status === "completed"
        ? "success"
        : input.status === "failed"
          ? "warning"
          : "info",
  } as const;
}
