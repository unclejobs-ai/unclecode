import type {
  ModeBackgroundTaskPolicy,
  ModeEditingPolicy,
  ModeExplanationStyle,
  ModeProfileId,
  ModeSearchDepth,
} from "@unclecode/contracts";
import { homedir } from "node:os";
import path from "node:path";

import type { RegisteredSlashCommand } from "./command-registry.js";
import { runRustCommandSync } from "./rust-command.js";

export type ExtensionManifestConfigLayer = {
  readonly mode?: ModeProfileId;
  readonly model?: string;
  readonly behavior?: {
    readonly editing?: ModeEditingPolicy;
    readonly searchDepth?: ModeSearchDepth;
    readonly backgroundTasks?: ModeBackgroundTaskPolicy;
    readonly explanationStyle?: ModeExplanationStyle;
  };
  readonly prompt?: {
    readonly sections?: Readonly<Record<string, { readonly title: string; readonly body: string } | null>>;
  };
};

export type ExtensionManifestSummary = {
  readonly name: string;
  readonly sourcePath: string;
  readonly statusLines: readonly string[];
};

type ExtensionManifestPayload = {
  readonly configOverlays: readonly { readonly name: string; readonly config: ExtensionManifestConfigLayer }[];
  readonly summaries: readonly ExtensionManifestSummary[];
};

const manifestCache = new Map<string, ExtensionManifestPayload>();
let extensionRegistryCacheGeneration = 0;

function getManifestCacheKey(input: {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
} = {}): string {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const userHomeDir = input.userHomeDir ?? process.env.HOME ?? homedir();
  return `${path.resolve(workspaceRoot)}::${path.resolve(userHomeDir)}`;
}

export function clearExtensionRegistryCache(input?: {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
}): void {
  extensionRegistryCacheGeneration += 1;
  if (!input?.workspaceRoot && !input?.userHomeDir) {
    manifestCache.clear();
    return;
  }

  manifestCache.delete(getManifestCacheKey(input));
}

export function getExtensionRegistryCacheGeneration(): number {
  return extensionRegistryCacheGeneration;
}

function loadExtensionManifestPayload(input: {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
} = {}): ExtensionManifestPayload {
  const cacheKey = getManifestCacheKey(input);
  const cached = manifestCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const userHomeDir = input.userHomeDir ?? process.env.HOME ?? homedir();
  const raw = runRustCommandSync(
    ["rust", "command", "extension-manifests", workspaceRoot, userHomeDir || "-"],
    workspaceRoot,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.configOverlays) || !Array.isArray(parsed.summaries)) {
    throw new Error("Rust extension manifest loader returned an invalid payload.");
  }
  const loaded: ExtensionManifestPayload = {
    configOverlays: parsed.configOverlays.filter(isExtensionConfigOverlay),
    summaries: parsed.summaries.filter(isExtensionManifestSummary),
  };

  manifestCache.set(cacheKey, loaded);
  return loaded;
}

export function loadExtensionSlashCommands(input: {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
} = {}): readonly RegisteredSlashCommand[] {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const userHomeDir = input.userHomeDir ?? process.env.HOME ?? homedir();
  const raw = runRustCommandSync(
    ["rust", "command", "extension-slash-commands", workspaceRoot, userHomeDir || "-"],
    workspaceRoot,
  ).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Rust extension slash command loader returned an invalid payload.");
  }

  return parsed.filter(isRegisteredSlashCommand);
}

function isRegisteredSlashCommand(value: unknown): value is RegisteredSlashCommand {
  if (!isRecord(value) || typeof value.command !== "string" || !Array.isArray(value.routeTo) || !isRecord(value.metadata)) {
    return false;
  }
  const metadata = value.metadata;
  return (
    value.routeTo.every((item) => typeof item === "string")
    && typeof metadata.description === "string"
    && typeof metadata.name === "string"
    && metadata.type === "local"
    && metadata.source === "plugin"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadExtensionConfigOverlays(input: {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
} = {}): readonly { readonly name: string; readonly config: ExtensionManifestConfigLayer }[] {
  return loadExtensionManifestPayload(input).configOverlays;
}

export function loadExtensionManifestSummaries(input: {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
} = {}): readonly ExtensionManifestSummary[] {
  return loadExtensionManifestPayload(input).summaries;
}

function isExtensionConfigOverlay(value: unknown): value is { readonly name: string; readonly config: ExtensionManifestConfigLayer } {
  return isRecord(value) && typeof value.name === "string" && isRecord(value.config);
}

function isExtensionManifestSummary(value: unknown): value is ExtensionManifestSummary {
  return (
    isRecord(value)
    && typeof value.name === "string"
    && typeof value.sourcePath === "string"
    && Array.isArray(value.statusLines)
    && value.statusLines.every((line) => typeof line === "string")
  );
}
