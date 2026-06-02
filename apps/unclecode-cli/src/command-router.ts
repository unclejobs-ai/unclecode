import {
  createCliSlashCommandRegistry,
  loadExtensionSlashCommands,
  runRustCommandSync,
} from "@unclecode/orchestrator";

export type ParsedSlashCommand =
  | {
      readonly kind: "plain";
      readonly raw: string;
    }
  | {
      readonly kind: "slash";
      readonly name: string;
      readonly args: readonly string[];
      readonly raw: string;
    };

function normalizeSlashInput(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function getCliSlashCommandRegistry(options?: { readonly workspaceRoot?: string; readonly userHomeDir?: string }) {
  return createCliSlashCommandRegistry(loadExtensionSlashCommands(options));
}

function getCliSlashCommands(options?: { readonly workspaceRoot?: string; readonly userHomeDir?: string }) {
  return getCliSlashCommandRegistry(options).list();
}

type RustSlashRoute = {
  readonly kind: "plain" | "matched" | "dynamic" | "fallback";
  readonly route: readonly string[];
};

export function parseSlashCommand(input: string): ParsedSlashCommand {
  const raw = input.trim();

  if (!raw.startsWith("/")) {
    return { kind: "plain", raw };
  }

  const tokens = raw.slice(1).split(/\s+/).filter((token) => token.length > 0);
  const [name = "", ...args] = tokens;

  return {
    kind: "slash",
    name,
    args,
    raw,
  };
}

export function routeSlashCommand(input: string, options?: { readonly workspaceRoot?: string; readonly userHomeDir?: string }): readonly string[] {
  const parsed = parseSlashCommand(input);

  if (parsed.kind === "plain") {
    return [];
  }

  const routed = routeSlashCommandWithRust(parsed.raw, options);
  if (routed.kind === "matched" || routed.kind === "dynamic" || routed.kind === "plain") {
    return routed.route;
  }

  const extensionRoute = getCliSlashCommandRegistry(options).resolve(normalizeSlashInput(parsed.raw));
  if (extensionRoute) {
    return extensionRoute;
  }

  return routed.route;
}

function routeSlashCommandWithRust(
  input: string,
  options?: { readonly workspaceRoot?: string; readonly userHomeDir?: string },
): RustSlashRoute {
  const stdout = runRustCommandSync(
    ["rust", "command", "route", normalizeSlashInput(input)],
    options?.workspaceRoot ?? process.cwd(),
  ).trim();
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed) || !isRustRouteKind(parsed.kind) || !Array.isArray(parsed.route)) {
    throw new Error("Rust slash command router returned an invalid payload.");
  }

  return {
    kind: parsed.kind,
    route: parsed.route.filter((item): item is string => typeof item === "string"),
  };
}

function isRustRouteKind(value: unknown): value is RustSlashRoute["kind"] {
  return value === "plain" || value === "matched" || value === "dynamic" || value === "fallback";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatSlashCommandHelp(options?: { readonly workspaceRoot?: string; readonly userHomeDir?: string }): string {
  return [
    "Slash commands",
    ...getCliSlashCommands(options).map((entry) => `${entry.command} — ${entry.metadata.description}`),
  ].join("\n");
}
