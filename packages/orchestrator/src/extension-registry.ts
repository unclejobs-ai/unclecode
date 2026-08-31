import type {
  CacheTelemetrySnapshot,
  ModeBackgroundTaskPolicy,
  ModeEditingPolicy,
  ModeExplanationStyle,
  ModeProfileId,
  ModeSearchDepth,
} from "@unclecode/contracts";
import { createInstrumentedLruCache } from "@unclecode/contracts";
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

const MANIFEST_CACHE_MAX_ENTRIES = 32;
const MANIFEST_CACHE_MAX_RETAINED_BYTES = 4 * 1024 * 1024;
const manifestCache = createInstrumentedLruCache<string, ExtensionManifestPayload>({
  name: "orchestrator-extension-manifests",
  maxEntries: MANIFEST_CACHE_MAX_ENTRIES,
  maxRetainedBytes: MANIFEST_CACHE_MAX_RETAINED_BYTES,
});
let extensionRegistryCacheGeneration = 0;

type ExtensionRegistryInput = {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
};

function resolveUserHomeDir(input: ExtensionRegistryInput): string {
  if (input.userHomeDir !== undefined) {
    return input.userHomeDir;
  }
  return (input.env ? input.env.HOME : process.env.HOME) ?? homedir();
}

function getManifestCacheKey(input: ExtensionRegistryInput = {}): string {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const userHomeDir = resolveUserHomeDir(input);
  return `${path.resolve(workspaceRoot)}::${path.resolve(userHomeDir)}`;
}

export function clearExtensionRegistryCache(input?: ExtensionRegistryInput): void {
  extensionRegistryCacheGeneration += 1;
  if (!input?.workspaceRoot && !input?.userHomeDir) {
    manifestCache.invalidateAll();
    return;
  }

  manifestCache.invalidate(getManifestCacheKey(input));
}

export function getExtensionRegistryCacheGeneration(): number {
  return extensionRegistryCacheGeneration;
}

export function getExtensionRegistryCacheTelemetrySnapshot(): CacheTelemetrySnapshot {
  return manifestCache.snapshot();
}

function loadExtensionManifestPayload(input: ExtensionRegistryInput = {}): ExtensionManifestPayload {
  const cacheKey = getManifestCacheKey(input);
  const cached = manifestCache.lookup(cacheKey);
  if (cached.hit) {
    return cached.value;
  }

  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const userHomeDir = resolveUserHomeDir(input);
  const raw = runRustCommandSync(
    ["rust", "command", "extension-manifests", workspaceRoot, userHomeDir || "-"],
    workspaceRoot,
    undefined,
    input.env ?? process.env,
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

export function loadExtensionSlashCommands(input: ExtensionRegistryInput = {}): readonly RegisteredSlashCommand[] {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const userHomeDir = resolveUserHomeDir(input);
  const raw = runRustCommandSync(
    ["rust", "command", "extension-slash-commands", workspaceRoot, userHomeDir || "-"],
    workspaceRoot,
    undefined,
    input.env ?? process.env,
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

export function loadExtensionConfigOverlays(
  input: ExtensionRegistryInput = {},
): readonly { readonly name: string; readonly config: ExtensionManifestConfigLayer }[] {
  return loadExtensionManifestPayload(input).configOverlays;
}

export function loadExtensionManifestSummaries(
  input: ExtensionRegistryInput = {},
): readonly ExtensionManifestSummary[] {
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
