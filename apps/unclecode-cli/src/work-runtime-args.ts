import { isModeReasoningEffort, type ModeReasoningEffort } from "@unclecode/contracts";
import { runRustCommandSync, toolDefinitions } from "@unclecode/orchestrator";

export type WorkEngine = "native" | "pi";

export type ParsedArgs = {
  cwd: string;
  provider?: "anthropic" | "gemini" | "openai" | "deepseek";
  model?: string;
  reasoning?: ModeReasoningEffort;
  sessionId?: string;
  prompt?: string;
  engine?: WorkEngine;
  showHelp: boolean;
  showTools: boolean;
};

export function printHelp(): void {
  process.stdout.write(`UncleCode Work (repo-local)\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  unclecode work\n`);
  process.stdout.write(`  unclecode work "summarize this project"\n`);
  process.stdout.write(`  unclecode work --provider gemini --cwd E:\\\\repo --model gemini-2.5-flash\n\n`);
  process.stdout.write(`Flags:\n`);
  process.stdout.write(`  --help   Show this help text\n`);
  process.stdout.write(`  --tools  List available local tools\n`);
  process.stdout.write(`  --cwd    Set the workspace root\n`);
  process.stdout.write(`  --provider  Choose openai, anthropic, gemini, or deepseek\n`);
  process.stdout.write(`  --model  Override the model for the chosen provider\n`);
  process.stdout.write(`  --reasoning  Override reasoning effort: none, low, medium, high, xhigh, max\n`);
  process.stdout.write(`  --session-id  Resume a persisted work session id\n`);
  process.stdout.write(`  --engine  pi (default, pi-mono runtime + OAuth) or native (legacy provider runtime)\n`);
}

export function printTools(): void {
  process.stdout.write(`Available tools:\n`);
  for (const tool of toolDefinitions) {
    process.stdout.write(`- ${tool.name}: ${tool.description}\n`);
  }
}

export function resolveRuntimeProvider(
  provider: string,
): "anthropic" | "gemini" | "openai" | "deepseek" {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "model", "provider-runtime-json", provider], process.cwd()).trim(),
  ) as unknown;
  const decision = isRecord(parsed) ? parsed : {};
  const routed = typeof decision.runtimeKind === "string" ? decision.runtimeKind : undefined;
  if (
    (routed === "anthropic" || routed === "gemini" || routed === "openai" || routed === "deepseek")
    && decision.runtimeSupported === true
  ) {
    return routed;
  }

  throw new Error(
    typeof decision.error === "string" ? decision.error : `Unsupported runtime provider: ${provider}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "work-runtime", "parse-args"],
      process.cwd(),
      JSON.stringify({ argv, cwd: process.cwd() }),
    ),
  ) as unknown;
  if (
    !isRecord(parsed) ||
    typeof parsed.cwd !== "string" ||
    typeof parsed.showHelp !== "boolean" ||
    typeof parsed.showTools !== "boolean"
  ) {
    throw new Error("Rust work runtime args command returned an invalid payload.");
  }

  const result: ParsedArgs = {
    cwd: parsed.cwd,
    showHelp: parsed.showHelp,
    showTools: parsed.showTools,
  };
  if (
    parsed.provider === "anthropic"
    || parsed.provider === "gemini"
    || parsed.provider === "openai"
    || parsed.provider === "deepseek"
  ) {
    result.provider = parsed.provider;
  }
  if (typeof parsed.model === "string") {
    result.model = parsed.model;
  }
  if (isModeReasoningEffort(parsed.reasoning)) {
    result.reasoning = parsed.reasoning;
  }
  if (typeof parsed.sessionId === "string") {
    result.sessionId = parsed.sessionId;
  }
  if (parsed.engine === "native" || parsed.engine === "pi") {
    result.engine = parsed.engine;
  }
  if (typeof parsed.prompt === "string") {
    result.prompt = parsed.prompt;
  }
  return result;
}
