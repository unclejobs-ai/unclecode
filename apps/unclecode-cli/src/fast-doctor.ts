import { runRustCommand } from "@unclecode/orchestrator";
import {
  formatOpenAIAuthStatus,
  resolveOpenAIAuthStatus,
} from "@unclecode/providers/openai-status";

const DOCTOR_LATENCY_THRESHOLDS = {
  configMsBudget: 50,
  authMsBudget: 50,
  runtimeMsBudget: 25,
  sessionStoreMsBudget: 50,
  mcpMsBudget: 50,
  totalMsBudget: 250,
} as const;

type FastDoctorReport = {
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

export async function buildFastDoctorReportData(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly verbose?: boolean;
}): Promise<{
  readonly lines: readonly string[];
  readonly report: FastDoctorReport;
}> {
  const raw = await runRustCommand(
    ["doctor", "--json"],
    input.workspaceRoot,
    undefined,
    input.env,
  );
  const report = parseFastDoctorReport(raw);

  return {
    lines: formatFastDoctorLines(report, input.verbose ?? false),
    report: { ...report, verbose: input.verbose ?? false },
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
  return formatOpenAIAuthStatus(await resolveOpenAIAuthStatus({ env }));
}

function formatFastDoctorLines(report: FastDoctorReport, verbose: boolean): readonly string[] {
  return [
    "Doctor report",
    `Mode           ${report.verdicts.mode}  ${report.labels.mode}`,
    `Auth           ${report.verdicts.auth}  ${report.labels.auth}`,
    `Runtime        ${report.verdicts.runtime}  ${report.labels.runtime}`,
    `Session store  ${report.verdicts.sessionStore}  ${report.labels.sessionStore}`,
    `MCP host       ${report.verdicts.mcpHost}  ${report.labels.mcpHost}`,
    ...(verbose
      ? [
          "",
          "Latency counters",
          `configMs=${report.metrics.configMs}`,
          `authMs=${report.metrics.authMs}`,
          `runtimeMs=${report.metrics.runtimeMs}`,
          `sessionStoreMs=${report.metrics.sessionStoreMs}`,
          `mcpMs=${report.metrics.mcpMs}`,
          `totalMs=${report.metrics.totalMs}`,
        ]
      : []),
  ];
}

function parseFastDoctorReport(raw: string): FastDoctorReport {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.command !== "doctor") {
    throw new Error("Rust doctor returned an invalid report.");
  }
  return parsed as FastDoctorReport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
