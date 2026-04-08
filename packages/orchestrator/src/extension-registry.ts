import type {
  CommandMetadata,
  ModeBackgroundTaskPolicy,
  ModeEditingPolicy,
  ModeExplanationStyle,
  ModeProfileId,
  ModeSearchDepth,
} from "@unclecode/contracts";
import { homedir } from "node:os";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";

import type { RegisteredSlashCommand } from "./command-registry.js";

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

type ExtensionCommandManifest = {
  readonly name?: string;
  readonly commands?: readonly {
    readonly command: string;
    readonly routeTo: readonly string[];
    readonly description: string;
    readonly aliases?: readonly string[];
  }[];
  readonly config?: ExtensionManifestConfigLayer;
  readonly status?: {
    readonly label?: string;
    readonly lines?: readonly string[];
  };
};

const manifestCache = new Map<string, readonly { readonly filePath: string; readonly manifest: ExtensionCommandManifest }[]>();

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
  if (!input?.workspaceRoot && !input?.userHomeDir) {
    manifestCache.clear();
    return;
  }

  manifestCache.delete(getManifestCacheKey(input));
}

function normalizeSlashInput(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function loadManifestFile(filePath: string): ExtensionCommandManifest | undefined {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as ExtensionCommandManifest;
  } catch {
    return undefined;
  }
}

function listManifestFiles(root: string): readonly string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function pluginLocal(description: string, aliases?: readonly string[]): CommandMetadata {
  return {
    name: description,
    description,
    type: "local",
    source: "plugin",
    ...(aliases ? { aliases } : {}),
    userInvocable: true,
  };
}

function listLoadedManifests(input: {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
} = {}): readonly { readonly filePath: string; readonly manifest: ExtensionCommandManifest }[] {
  const cacheKey = getManifestCacheKey(input);
  const cached = manifestCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const userHomeDir = input.userHomeDir ?? process.env.HOME ?? homedir();
  const manifestFiles = [
    ...listManifestFiles(path.join(workspaceRoot, ".unclecode", "extensions")),
    ...listManifestFiles(path.join(userHomeDir, ".unclecode", "extensions")),
  ];

  const loaded = manifestFiles
    .map((filePath) => ({ filePath, manifest: loadManifestFile(filePath) }))
    .filter((entry): entry is { readonly filePath: string; readonly manifest: ExtensionCommandManifest } => entry.manifest !== undefined);

  manifestCache.set(cacheKey, loaded);
  return loaded;
}

export function loadExtensionSlashCommands(input: {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
} = {}): readonly RegisteredSlashCommand[] {
  const commands: RegisteredSlashCommand[] = [];

  for (const { manifest } of listLoadedManifests(input)) {
    if (!manifest.commands) {
      continue;
    }

    for (const command of manifest.commands) {
      if (!command.command.startsWith("/") || command.routeTo.length === 0) {
        continue;
      }
      commands.push({
        command: normalizeSlashInput(command.command),
        routeTo: [...command.routeTo],
        metadata: pluginLocal(command.description, command.aliases),
      });
    }
  }

  return commands;
}

export function loadExtensionConfigOverlays(input: {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
} = {}): readonly { readonly name: string; readonly config: ExtensionManifestConfigLayer }[] {
  return listLoadedManifests(input)
    .filter((entry) => entry.manifest.config !== undefined)
    .map((entry) => ({
      name: entry.manifest.name?.trim() || path.basename(entry.filePath, ".json"),
      config: entry.manifest.config as ExtensionManifestConfigLayer,
    }));
}

export function loadExtensionManifestSummaries(input: {
  readonly workspaceRoot?: string;
  readonly userHomeDir?: string;
} = {}): readonly ExtensionManifestSummary[] {
  return listLoadedManifests(input).map((entry) => ({
    name: entry.manifest.name?.trim() || path.basename(entry.filePath, ".json"),
    sourcePath: entry.filePath,
    statusLines: [...(entry.manifest.status?.lines ?? [])],
  }));
}
