export type FastCliPath = "auth-status" | "doctor" | "doctor-json" | "setup" | "mode-status" | "sessions" | "config-explain";

function isSupportedDoctorFastPath(args: readonly string[]): boolean {
  if (args[0] !== "doctor") {
    return false;
  }

  return args.slice(1).every((arg) => arg === "--verbose" || arg === "--json");
}

export function resolveFastCliPath(args: readonly string[]): FastCliPath | undefined {
  if (args.length === 2 && args[0] === "auth" && args[1] === "status") {
    return "auth-status";
  }

  if (args.length >= 1 && isSupportedDoctorFastPath(args)) {
    return args.includes("--json") ? "doctor-json" : "doctor";
  }

  if (args.length === 1 && args[0] === "setup") {
    return "setup";
  }

  if (args.length === 2 && args[0] === "mode" && args[1] === "status") {
    return "mode-status";
  }

  if (args.length === 1 && args[0] === "sessions") {
    return "sessions";
  }

  if (args.length === 2 && args[0] === "config" && args[1] === "explain") {
    return "config-explain";
  }

  return undefined;
}

export async function maybeRunFastCliPath(args: readonly string[]): Promise<boolean> {
  const path = resolveFastCliPath(args);
  if (!path) {
    return false;
  }

  switch (path) {
    case "auth-status": {
      const { formatEffectiveOpenAIAuthStatus, resolveEffectiveOpenAIAuthStatus } = await import("@unclecode/providers");
      process.stdout.write(`${formatEffectiveOpenAIAuthStatus(await resolveEffectiveOpenAIAuthStatus({ env: process.env }))}\n`);
      return true;
    }
    case "doctor": {
      const { buildFastDoctorReport } = await import("./fast-doctor.js");
      process.stdout.write(
        `${await buildFastDoctorReport({
          workspaceRoot: process.cwd(),
          env: process.env,
          ...(args.includes("--verbose") ? { verbose: true } : {}),
        })}\n`,
      );
      return true;
    }
    case "doctor-json": {
      const { buildFastDoctorReportData } = await import("./fast-doctor.js");
      const { report } = await buildFastDoctorReportData({
        workspaceRoot: process.cwd(),
        env: process.env,
        verbose: true,
      });
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return true;
    }
    case "setup": {
      const { buildFastSetupReport } = await import("./fast-setup.js");
      process.stdout.write(
        `${await buildFastSetupReport({ workspaceRoot: process.cwd(), env: process.env })}\n`,
      );
      return true;
    }
    case "mode-status": {
      const { buildFastModeStatusReport } = await import("./fast-mode.js");
      process.stdout.write(
        `${buildFastModeStatusReport({ workspaceRoot: process.cwd(), env: process.env })}\n`,
      );
      return true;
    }
    case "sessions": {
      const { formatFastSessionsReport, listFastSessions } = await import("./fast-sessions.js");
      process.stdout.write(
        `${formatFastSessionsReport(await listFastSessions({ workspaceRoot: process.cwd(), env: process.env }))}\n`,
      );
      return true;
    }
    case "config-explain": {
      const { buildFastConfigExplainReport } = await import("./fast-mode.js");
      process.stdout.write(
        `${buildFastConfigExplainReport({ workspaceRoot: process.cwd(), env: process.env })}\n`,
      );
      return true;
    }
  }
}
