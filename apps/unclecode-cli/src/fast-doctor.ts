import { explainUncleCodeConfig } from "@unclecode/config-core";
import {
  MCP_HOST_SUPPORTED_TRANSPORTS,
  loadMcpHostRegistry,
} from "@unclecode/mcp-host";
import { loadExtensionConfigOverlays } from "@unclecode/orchestrator/extension-registry";
import {
  formatEffectiveOpenAIAuthStatus,
  resolveEffectiveOpenAIAuthStatus,
} from "@unclecode/providers";
import { createRuntimeBroker } from "@unclecode/runtime-broker";
import { createSessionStore } from "@unclecode/session-store";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DOCTOR_LATENCY_THRESHOLDS = {
  configMsBudget: 50,
  authMsBudget: 50,
  runtimeMsBudget: 25,
  sessionStoreMsBudget: 50,
  mcpMsBudget: 50,
  totalMsBudget: 250,
} as const;

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function getSessionStoreRoot(env: NodeJS.ProcessEnv): string {
  return env.UNCLECODE_SESSION_STORE_ROOT?.trim() || path.join(homedir(), ".unclecode", "state");
}

export async function buildFastDoctorReportData(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly verbose?: boolean;
}): Promise<{
  readonly lines: readonly string[];
  readonly report: {
    readonly command: "doctor";
    readonly verbose: boolean;
    readonly workspaceRoot: string;
    readonly verdicts: {
      readonly mode: "PASS";
      readonly auth: "PASS" | "WARN";
      readonly runtime: "PASS" | "WARN";
      readonly sessionStore: "PASS";
      readonly mcpHost: "PASS";
    };
    readonly labels: {
      readonly mode: string;
      readonly auth: string;
      readonly runtime: string;
      readonly sessionStore: string;
      readonly mcpHost: string;
    };
    readonly metrics: {
      readonly configMs: number;
      readonly authMs: number;
      readonly runtimeMs: number;
      readonly sessionStoreMs: number;
      readonly mcpMs: number;
      readonly totalMs: number;
    };
    readonly thresholds: typeof DOCTOR_LATENCY_THRESHOLDS;
  };
}> {
  const totalStartedAt = Date.now();

  const configStartedAt = Date.now();
  const explanation = explainUncleCodeConfig({
    workspaceRoot: input.workspaceRoot,
    env: input.env,
    pluginOverlays: loadExtensionConfigOverlays({
      workspaceRoot: input.workspaceRoot,
      ...(input.env.HOME ? { userHomeDir: input.env.HOME } : {}),
    }),
  });
  const configMs = elapsedSince(configStartedAt);

  const authStartedAt = Date.now();
  const authStatus = await resolveEffectiveOpenAIAuthStatus({ env: input.env });
  const authMs = elapsedSince(authStartedAt);

  const runtimeStartedAt = Date.now();
  const runtimeHealth = createRuntimeBroker({
    workingDirectory: input.workspaceRoot,
    runtimeMode: "local",
  }).health();
  const runtimeMs = elapsedSince(runtimeStartedAt);

  const sessionStoreStartedAt = Date.now();
  const sessionStoreRoot = getSessionStoreRoot(input.env);
  await mkdir(sessionStoreRoot, { recursive: true });
  const sessionStore = createSessionStore({ rootDir: sessionStoreRoot });
  sessionStore.getSessionPaths({
    projectPath: input.workspaceRoot,
    sessionId: "doctor-probe",
  });
  const sessionStoreMs = elapsedSince(sessionStoreStartedAt);

  const mcpStartedAt = Date.now();
  const mcpRegistry = loadMcpHostRegistry({
    workspaceRoot: input.workspaceRoot,
    ...(input.env.HOME ? { userHomeDir: input.env.HOME } : {}),
  });
  const mcpMs = elapsedSince(mcpStartedAt);

  const runtimeAdapter = runtimeHealth.adapters.find((adapter) => adapter.mode === "local");
  const authLabel = `${authStatus.activeSource} (${authStatus.authType})`;
  const modeLabel = `${explanation.activeMode.id} (${explanation.settings.mode.winner.sourceLabel})`;
  const runtimeLabel = runtimeAdapter?.available ? "local available" : "local unavailable";
  const authVerdict = authStatus.activeSource === "none" || authStatus.isExpired ? "WARN" : "PASS";
  const runtimeVerdict = runtimeAdapter?.available ? "PASS" : "WARN";
  const mcpLabel = `${mcpRegistry.entries.length} servers; transports ${MCP_HOST_SUPPORTED_TRANSPORTS.join(", ")}`;
  const totalMs = elapsedSince(totalStartedAt);

  const lines = [
    "Doctor report",
    `Mode           PASS  ${modeLabel}`,
    `Auth           ${authVerdict}  ${authLabel}`,
    `Runtime        ${runtimeVerdict}  ${runtimeLabel}`,
    `Session store  PASS  ${sessionStoreRoot}`,
    `MCP host       PASS  ${mcpLabel}`,
    ...(input.verbose
      ? [
          "",
          "Latency counters",
          `configMs=${configMs}`,
          `authMs=${authMs}`,
          `runtimeMs=${runtimeMs}`,
          `sessionStoreMs=${sessionStoreMs}`,
          `mcpMs=${mcpMs}`,
          `totalMs=${totalMs}`,
        ]
      : []),
  ] as const;

  return {
    lines,
    report: {
      command: "doctor",
      verbose: input.verbose ?? false,
      workspaceRoot: input.workspaceRoot,
      verdicts: {
        mode: "PASS",
        auth: authVerdict,
        runtime: runtimeVerdict,
        sessionStore: "PASS",
        mcpHost: "PASS",
      },
      labels: {
        mode: modeLabel,
        auth: authLabel,
        runtime: runtimeLabel,
        sessionStore: sessionStoreRoot,
        mcpHost: mcpLabel,
      },
      metrics: {
        configMs,
        authMs,
        runtimeMs,
        sessionStoreMs,
        mcpMs,
        totalMs,
      },
      thresholds: DOCTOR_LATENCY_THRESHOLDS,
    },
  };
}

export async function buildFastDoctorReport(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly verbose?: boolean;
}): Promise<string> {
  const { lines } = await buildFastDoctorReportData(input);
  return lines.join("\n");
}

export async function buildFastAuthStatusReport(env: NodeJS.ProcessEnv): Promise<string> {
  return formatEffectiveOpenAIAuthStatus(await resolveEffectiveOpenAIAuthStatus({ env }));
}
