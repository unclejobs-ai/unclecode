import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  MODE_BACKGROUND_TASK_POLICIES,
  MODE_EDITING_POLICIES,
  MODE_EXPLANATION_STYLES,
  MODE_PROFILE_IDS,
  MODE_SEARCH_DEPTHS,
  CONSOLE_MOTION_PREFERENCES,
  CONTEXT_PROFILE_IDS,
} from "@unclecode/contracts";
import type {
  ModeBackgroundTaskPolicy,
  ModeEditingPolicy,
  ModeExplanationStyle,
  ModeProfileId,
  ModeSearchDepth,
  ConsoleMotionPreference,
  ContextProfileId,
} from "@unclecode/contracts";

import {
  CONFIG_CORE_DEFAULT_CONTEXT_CRP,
  CONFIG_CORE_DEFAULT_CONTEXT_CRP_BUDGET,
  CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW,
  CONFIG_CORE_DEFAULT_CONTEXT_PROFILE,
  CONFIG_CORE_DEFAULT_TUI_MOTION,
  buildModeProfileOverlay,
  CONFIG_CORE_DEFAULTS,
  CONFIG_SOURCE_ORDER,
  getModeProfile,
} from "./defaults.js";
import type {
  ConfigSourceIssue,
  ConfigSourceDefinition,
  ConfigSourceId,
  PromptSectionExplanation,
  SettingContribution,
  SettingExplanation,
  UncleCodeConfigExplainOptions,
  UncleCodeConfigExplanation,
  UncleCodeConfigLayer,
  UncleCodeNamedOverlay,
  UncleCodePromptSection,
} from "./types.js";

type SourceInstance = {
  readonly sourceId: ConfigSourceId;
  readonly sourceLabel: string;
  readonly detail?: string;
  readonly config: UncleCodeConfigLayer;
  readonly issues: readonly ConfigSourceIssue[];
};

type PromptSectionAccumulator = {
  title: string;
  body: string;
  deleted: boolean;
  contributors: SettingContribution<UncleCodePromptSection | null>[];
};

type SanitizedConfigLayer = {
  readonly config: UncleCodeConfigLayer;
  readonly issues: readonly string[];
};

type FileConfigReadResult = {
  readonly config: UncleCodeConfigLayer;
  readonly issues: readonly string[];
};

type MutableBehavior = {
  editing?: ModeEditingPolicy;
  searchDepth?: ModeSearchDepth;
  backgroundTasks?: ModeBackgroundTaskPolicy;
  explanationStyle?: ModeExplanationStyle;
};

type MutableContext = {
  crp?: boolean;
  crpBudget?: number;
  modelWindow?: number;
  profile?: ContextProfileId;
};

type MutableTui = {
  motion?: ConsoleMotionPreference;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asModeProfileId(value: unknown): ModeProfileId | undefined {
  return typeof value === "string" && MODE_PROFILE_IDS.includes(value as ModeProfileId)
    ? (value as ModeProfileId)
    : undefined;
}

function asContextProfileId(value: unknown): ContextProfileId | undefined {
  return typeof value === "string" && CONTEXT_PROFILE_IDS.includes(value as ContextProfileId)
    ? (value as ContextProfileId)
    : undefined;
}

function asConsoleMotionPreference(value: unknown): ConsoleMotionPreference | undefined {
  return typeof value === "string" && CONSOLE_MOTION_PREFERENCES.includes(value as ConsoleMotionPreference)
    ? (value as ConsoleMotionPreference)
    : undefined;
}

function asModeEditingPolicy(value: unknown): ModeEditingPolicy | undefined {
  return typeof value === "string" && MODE_EDITING_POLICIES.includes(value as ModeEditingPolicy)
    ? (value as ModeEditingPolicy)
    : undefined;
}

function asModeSearchDepth(value: unknown): ModeSearchDepth | undefined {
  return typeof value === "string" && MODE_SEARCH_DEPTHS.includes(value as ModeSearchDepth)
    ? (value as ModeSearchDepth)
    : undefined;
}

function asModeBackgroundTaskPolicy(value: unknown): ModeBackgroundTaskPolicy | undefined {
  return typeof value === "string" &&
    MODE_BACKGROUND_TASK_POLICIES.includes(value as ModeBackgroundTaskPolicy)
    ? (value as ModeBackgroundTaskPolicy)
    : undefined;
}

function asModeExplanationStyle(value: unknown): ModeExplanationStyle | undefined {
  return typeof value === "string" &&
    MODE_EXPLANATION_STYLES.includes(value as ModeExplanationStyle)
    ? (value as ModeExplanationStyle)
    : undefined;
}

function asPromptSection(value: unknown): UncleCodePromptSection | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.body !== "string") {
    return undefined;
  }

  return {
    title: value.title,
    body: value.body,
  };
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Number.isInteger(value) ? value : undefined;
}

function sanitizeConfigLayer(value: unknown): SanitizedConfigLayer {
  if (!isRecord(value)) {
    return { config: {}, issues: ["Config must be a JSON object."] };
  }

  const issues: string[] = [];
  const promptSections: Record<string, UncleCodePromptSection | null> = {};
  const rawPrompt = isRecord(value.prompt) ? value.prompt : undefined;
  const rawSections = rawPrompt && isRecord(rawPrompt.sections) ? rawPrompt.sections : undefined;

  if ("prompt" in value && value.prompt !== undefined && rawPrompt === undefined) {
    issues.push("Invalid prompt configuration.");
  }
  if (rawPrompt && "sections" in rawPrompt && rawSections === undefined) {
    issues.push("Invalid prompt.sections configuration.");
  }

  if (rawSections) {
    for (const [sectionId, rawSection] of Object.entries(rawSections)) {
      const section = asPromptSection(rawSection);
      if (section !== undefined) {
        promptSections[sectionId] = section;
      } else {
        issues.push(`Invalid prompt section: ${sectionId}.`);
      }
    }
  }

  const rawBehavior = isRecord(value.behavior) ? value.behavior : undefined;
  if ("behavior" in value && value.behavior !== undefined && rawBehavior === undefined) {
    issues.push("Invalid behavior configuration.");
  }
  let behavior: MutableBehavior | undefined;

  if (rawBehavior) {
    const nextBehavior: MutableBehavior = {};
    const editing = asModeEditingPolicy(rawBehavior.editing);
    const searchDepth = asModeSearchDepth(rawBehavior.searchDepth);
    const backgroundTasks = asModeBackgroundTaskPolicy(rawBehavior.backgroundTasks);
    const explanationStyle = asModeExplanationStyle(rawBehavior.explanationStyle);

    if ("editing" in rawBehavior && rawBehavior.editing !== undefined && !editing) {
      issues.push("Invalid behavior.editing value.");
    }
    if ("searchDepth" in rawBehavior && rawBehavior.searchDepth !== undefined && !searchDepth) {
      issues.push("Invalid behavior.searchDepth value.");
    }
    if (
      "backgroundTasks" in rawBehavior &&
      rawBehavior.backgroundTasks !== undefined &&
      !backgroundTasks
    ) {
      issues.push("Invalid behavior.backgroundTasks value.");
    }
    if (
      "explanationStyle" in rawBehavior &&
      rawBehavior.explanationStyle !== undefined &&
      !explanationStyle
    ) {
      issues.push("Invalid behavior.explanationStyle value.");
    }

    if (editing) {
      nextBehavior.editing = editing;
    }
    if (searchDepth) {
      nextBehavior.searchDepth = searchDepth;
    }
    if (backgroundTasks) {
      nextBehavior.backgroundTasks = backgroundTasks;
    }
    if (explanationStyle) {
      nextBehavior.explanationStyle = explanationStyle;
    }

    behavior = Object.keys(nextBehavior).length > 0 ? nextBehavior : undefined;
  }

  const rawContext = isRecord(value.context) ? value.context : undefined;
  if ("context" in value && value.context !== undefined && rawContext === undefined) {
    issues.push("Invalid context configuration.");
  }
  let context: MutableContext | undefined;

  if (rawContext) {
    const nextContext: MutableContext = {};
    const crp = rawContext.crp;
    const crpBudget = asPositiveInteger(rawContext.crpBudget);
    const modelWindow = asPositiveInteger(rawContext.modelWindow);
    const profile = asContextProfileId(rawContext.profile);

    if ("crp" in rawContext && crp !== undefined && typeof crp !== "boolean") {
      issues.push("Invalid context.crp value.");
    }
    if ("crpBudget" in rawContext && rawContext.crpBudget !== undefined && crpBudget === undefined) {
      issues.push("Invalid context.crpBudget value.");
    }
    if ("modelWindow" in rawContext && rawContext.modelWindow !== undefined && modelWindow === undefined) {
      issues.push("Invalid context.modelWindow value.");
    }
    if ("profile" in rawContext && rawContext.profile !== undefined && profile === undefined) {
      issues.push("Invalid context.profile value.");
    }

    if (typeof crp === "boolean") {
      nextContext.crp = crp;
    }
    if (crpBudget !== undefined) {
      nextContext.crpBudget = crpBudget;
    }
    if (modelWindow !== undefined) {
      nextContext.modelWindow = modelWindow;
    }
    if (profile !== undefined) {
      nextContext.profile = profile;
    }

    context = Object.keys(nextContext).length > 0 ? nextContext : undefined;
  }

  const rawTui = isRecord(value.tui) ? value.tui : undefined;
  if ("tui" in value && value.tui !== undefined && rawTui === undefined) {
    issues.push("Invalid tui configuration.");
  }
  let tui: MutableTui | undefined;

  if (rawTui) {
    const motion = asConsoleMotionPreference(rawTui.motion);
    if ("motion" in rawTui && rawTui.motion !== undefined && motion === undefined) {
      issues.push("Invalid tui.motion value.");
    }
    if (motion !== undefined) {
      tui = { motion };
    }
  }

  const mode = asModeProfileId(value.mode);
  const model = typeof value.model === "string" && value.model.trim() !== "" ? value.model : undefined;
  const prompt = Object.keys(promptSections).length > 0 ? { sections: promptSections } : undefined;

  if ("mode" in value && value.mode !== undefined && !mode) {
    issues.push("Invalid mode value.");
  }
  if ("model" in value && value.model !== undefined && !model) {
    issues.push("Invalid model value.");
  }

  return {
    config: {
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(behavior ? { behavior } : {}),
      ...(context ? { context } : {}),
      ...(tui ? { tui } : {}),
      ...(prompt ? { prompt } : {}),
    } satisfies UncleCodeConfigLayer,
    issues,
  };
}

function readConfigFile(filePath: string): FileConfigReadResult {
  if (!existsSync(filePath)) {
    return { config: {}, issues: [] };
  }

  try {
    return sanitizeConfigLayer(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: {}, issues: [`Invalid JSON: ${message}`] };
  }
}

function buildEnvironmentLayer(env: NodeJS.ProcessEnv | undefined): UncleCodeConfigLayer {
  if (!env) {
    return {};
  }

  // CRP env vars: UNCLECODE_CRP (0/false/off disables) and
  // UNCLECODE_CRP_BUDGET (token budget). These fold into the config layer
  // so the `unclecode` command picks them up naturally without requiring
  // users to export env vars every session.
  const crpRaw = env.UNCLECODE_CRP;
  const crpBudgetRaw = env.UNCLECODE_CRP_BUDGET;
  const modelWindowRaw = env.UNCLECODE_CONTEXT_WINDOW;
  const contextProfileRaw = env.UNCLECODE_CONTEXT_PROFILE;
  const motionRaw = env.UNCLECODE_TUI_MOTION ?? (env.NO_COLOR === undefined ? undefined : "reduced");
  const crpContext: { crp?: boolean; crpBudget?: number; modelWindow?: number; profile?: string } = {};
  if (crpRaw !== undefined) {
    const normalized = crpRaw.toLowerCase();
    crpContext.crp = normalized !== "0" && normalized !== "false" && normalized !== "off";
  }
  if (crpBudgetRaw !== undefined) {
    const parsed = Number.parseInt(crpBudgetRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      crpContext.crpBudget = parsed;
    }
  }
  if (modelWindowRaw !== undefined) {
    const parsed = Number.parseInt(modelWindowRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      crpContext.modelWindow = parsed;
    }
  }
  if (contextProfileRaw !== undefined) {
    crpContext.profile = contextProfileRaw;
  }

  return sanitizeConfigLayer({
    mode: env.UNCLECODE_MODE,
    model: env.UNCLECODE_MODEL,
    behavior: {
      editing: env.UNCLECODE_EDITING_POLICY,
      searchDepth: env.UNCLECODE_SEARCH_DEPTH,
      backgroundTasks: env.UNCLECODE_BACKGROUND_TASKS,
      explanationStyle: env.UNCLECODE_EXPLANATION_STYLE,
    },
    ...(Object.keys(crpContext).length > 0 ? { context: crpContext } : {}),
    ...(motionRaw === undefined ? {} : { tui: { motion: motionRaw } }),
  }).config;
}

function buildProjectConfigPath(options: UncleCodeConfigExplainOptions): string {
  return options.projectConfigPath ?? path.join(options.workspaceRoot, ".unclecode", "config.json");
}

function buildUserConfigPath(options: UncleCodeConfigExplainOptions): string {
  const userHomeDir = options.userHomeDir ?? homedir();
  return options.userConfigPath ?? path.join(userHomeDir, ".unclecode", "config.json");
}

function collectModeSources(options: UncleCodeConfigExplainOptions): SourceInstance[] {
  const projectConfig = readConfigFile(buildProjectConfigPath(options));
  const userConfig = readConfigFile(buildUserConfigPath(options));
  const envConfig = buildEnvironmentLayer(options.env);

  const createSourceIssues = (
    sourceId: ConfigSourceId,
    sourceLabel: string,
    detail: string | undefined,
    issues: readonly string[],
  ): readonly ConfigSourceIssue[] =>
    issues.map((message) => ({
      sourceId,
      sourceLabel,
      ...(detail ? { detail } : {}),
      message,
    }));

  return [
    {
      sourceId: "built-in-defaults",
      sourceLabel: "built-in defaults",
      config: options.builtinDefaults ?? CONFIG_CORE_DEFAULTS,
      issues: [],
    },
    ...(options.pluginOverlays ?? []).map((overlay) => ({
      sourceId: "plugin-overlay" as const,
      sourceLabel: "plugin overlay",
      detail: overlay.name,
      config: overlay.config,
      issues: [],
    })),
    {
      sourceId: "project-config",
      sourceLabel: "project config",
      config: projectConfig.config,
      issues: createSourceIssues("project-config", "project config", undefined, projectConfig.issues),
    },
    {
      sourceId: "user-config",
      sourceLabel: "user config",
      config: userConfig.config,
      issues: createSourceIssues("user-config", "user config", undefined, userConfig.issues),
    },
    {
      sourceId: "environment",
      sourceLabel: "environment",
      config: envConfig,
      issues: [],
    },
    {
      sourceId: "cli-flags",
      sourceLabel: "cli flags",
      config: sanitizeConfigLayer(options.cliFlags).config,
      issues: [],
    },
    {
      sourceId: "session-overrides",
      sourceLabel: "session overrides",
      config: sanitizeConfigLayer(options.sessionOverrides).config,
      issues: [],
    },
  ];
}

function collectSourceInstances(options: UncleCodeConfigExplainOptions, activeMode: ModeProfileId): SourceInstance[] {
  const modeSources = collectModeSources(options);

  return [
    modeSources[0],
    {
      sourceId: "built-in-mode-profile",
      sourceLabel: "built-in mode profile",
      detail: activeMode,
      config: buildModeProfileOverlay(activeMode),
      issues: [],
    },
    ...modeSources.slice(1),
  ].filter((source): source is SourceInstance => source !== undefined);
}

function buildContribution<T>(source: SourceInstance, value: T): SettingContribution<T> {
  return {
    sourceId: source.sourceId,
    sourceLabel: source.sourceLabel,
    ...(source.detail ? { detail: source.detail } : {}),
    value,
  };
}

function explainSetting<T>(
  sources: readonly SourceInstance[],
  pickValue: (config: UncleCodeConfigLayer) => T | undefined,
  fallbackValue: T,
): SettingExplanation<T> {
  const contributors: SettingContribution<T>[] = [];

  for (const source of sources) {
    const value = pickValue(source.config);
    if (value !== undefined) {
      contributors.push(buildContribution(source, value));
    }
  }

  const winner = contributors[contributors.length - 1] ?? {
    sourceId: "built-in-defaults",
    sourceLabel: "built-in defaults",
    value: fallbackValue,
  };

  return {
    value: winner.value,
    winner,
    contributors,
  };
}

function explainPromptSections(sources: readonly SourceInstance[]): readonly PromptSectionExplanation[] {
  const promptSections = new Map<string, PromptSectionAccumulator>();

  for (const source of sources) {
    const sections = source.config.prompt?.sections;
    if (!sections) {
      continue;
    }

    for (const [sectionId, section] of Object.entries(sections)) {
      const existing = promptSections.get(sectionId);

      if (section === null) {
        const contribution = buildContribution(source, null);
        if (existing) {
          existing.deleted = true;
          existing.contributors.push(contribution);
        } else {
          promptSections.set(sectionId, {
            title: sectionId,
            body: "",
            deleted: true,
            contributors: [contribution],
          });
        }
        continue;
      }

      const contribution = buildContribution(source, section);
      if (existing) {
        existing.title = section.title;
        existing.body = section.body;
        existing.deleted = false;
        existing.contributors.push(contribution);
        continue;
      }

      promptSections.set(sectionId, {
        title: section.title,
        body: section.body,
        deleted: false,
        contributors: [contribution],
      });
    }
  }

  const orderedSections = Array.from(promptSections.entries()).map(([id, section]) => {
    const winner = section.contributors[section.contributors.length - 1];
    if (!winner) {
      throw new Error(`Prompt section \"${id}\" has no contributors`);
    }

    return {
      id,
      title: section.title,
      body: section.body,
      deleted: winner.value === null,
      winner,
      contributors: section.contributors,
    } satisfies PromptSectionExplanation;
  });

  const activeModeSection = orderedSections.find((section) => section.id === "active-mode");
  const otherSections = orderedSections.filter((section) => section.id !== "active-mode");

  return activeModeSection ? [...otherSections, activeModeSection] : otherSections;
}

function renderPrompt(sections: readonly PromptSectionExplanation[]): string {
  return sections
    .filter((section) => !section.deleted)
    .map((section) => `## ${section.title}\n${section.body}`)
    .join("\n\n");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function formatContributors<T>(contributors: readonly SettingContribution<T>[]): string {
  return contributors
    .map((contributor) => {
      const suffix = contributor.detail ? ` (${contributor.detail})` : "";
      return `${contributor.sourceLabel}${suffix}=${formatValue(contributor.value)}`;
    })
    .join(" -> ");
}

export function explainUncleCodeConfig(
  options: UncleCodeConfigExplainOptions,
): UncleCodeConfigExplanation {
  const modeSources = collectModeSources(options);
  const modeExplanation = explainSetting(
    modeSources,
    (config) => config.mode,
    (options.builtinDefaults ?? CONFIG_CORE_DEFAULTS).mode ?? CONFIG_CORE_DEFAULTS.mode!,
  );
  const activeMode = modeExplanation.value;
  const sources = collectSourceInstances(options, activeMode);
  const promptSections = explainPromptSections(sources);

  return {
    sourceOrder: CONFIG_SOURCE_ORDER,
    sourceIssues: sources.flatMap((source) => source.issues),
    activeMode: getModeProfile(activeMode),
    settings: {
      mode: modeExplanation,
      model: explainSetting(
        sources,
        (config) => config.model,
        (options.builtinDefaults ?? CONFIG_CORE_DEFAULTS).model ?? CONFIG_CORE_DEFAULTS.model!,
      ),
      editing: explainSetting(
        sources,
        (config) => config.behavior?.editing,
        getModeProfile(activeMode).editing,
      ),
      searchDepth: explainSetting(
        sources,
        (config) => config.behavior?.searchDepth,
        getModeProfile(activeMode).searchDepth,
      ),
      backgroundTasks: explainSetting(
        sources,
        (config) => config.behavior?.backgroundTasks,
        getModeProfile(activeMode).backgroundTasks,
      ),
      explanationStyle: explainSetting(
        sources,
        (config) => config.behavior?.explanationStyle,
        getModeProfile(activeMode).explanationStyle,
      ),
      crp: explainSetting(
        sources,
        (config) => config.context?.crp,
        CONFIG_CORE_DEFAULT_CONTEXT_CRP,
      ),
      crpBudget: explainSetting(
        sources,
        (config) => config.context?.crpBudget,
        CONFIG_CORE_DEFAULT_CONTEXT_CRP_BUDGET,
      ),
      modelWindow: explainSetting(
        sources,
        (config) => config.context?.modelWindow,
        CONFIG_CORE_DEFAULT_CONTEXT_MODEL_WINDOW,
      ),
      contextProfile: explainSetting(
        sources,
        (config) => config.context?.profile,
        CONFIG_CORE_DEFAULT_CONTEXT_PROFILE,
      ),
      motion: explainSetting(
        sources,
        (config) => config.tui?.motion,
        CONFIG_CORE_DEFAULT_TUI_MOTION,
      ),
    },
    prompt: {
      sections: promptSections,
      rendered: renderPrompt(promptSections),
    },
  };
}

export function formatUncleCodeConfigExplanation(explanation: UncleCodeConfigExplanation): string {
  const lines = [
    "Source order (lowest -> highest):",
    ...explanation.sourceOrder.map((source, index) => `${index + 1}. ${source.label}`),
    "",
    ...(explanation.sourceIssues.length > 0
      ? [
          "Broken sources:",
          ...explanation.sourceIssues.map((issue) => {
            const suffix = issue.detail ? ` (${issue.detail})` : "";
            return `- ${issue.sourceLabel}${suffix}: ${issue.message}`;
          }),
          "",
        ]
      : []),
    `Active mode: ${explanation.activeMode.id}`,
    "",
    "Resolved settings:",
    `- mode = ${explanation.settings.mode.value}`,
    `  winner: ${explanation.settings.mode.winner.sourceLabel}`,
    `  sources: ${formatContributors(explanation.settings.mode.contributors)}`,
    `- model = ${explanation.settings.model.value}`,
    `  winner: ${explanation.settings.model.winner.sourceLabel}`,
    `  sources: ${formatContributors(explanation.settings.model.contributors)}`,
    `- editing = ${explanation.settings.editing.value}`,
    `  winner: ${explanation.settings.editing.winner.sourceLabel}`,
    `  sources: ${formatContributors(explanation.settings.editing.contributors)}`,
    `- searchDepth = ${explanation.settings.searchDepth.value}`,
    `  winner: ${explanation.settings.searchDepth.winner.sourceLabel}`,
    `  sources: ${formatContributors(explanation.settings.searchDepth.contributors)}`,
    `- backgroundTasks = ${explanation.settings.backgroundTasks.value}`,
    `  winner: ${explanation.settings.backgroundTasks.winner.sourceLabel}`,
    `  sources: ${formatContributors(explanation.settings.backgroundTasks.contributors)}`,
    `- explanationStyle = ${explanation.settings.explanationStyle.value}`,
    `  winner: ${explanation.settings.explanationStyle.winner.sourceLabel}`,
    `  sources: ${formatContributors(explanation.settings.explanationStyle.contributors)}`,
    `- crp = ${String(explanation.settings.crp.value)}`,
    `  winner: ${explanation.settings.crp.winner.sourceLabel}`,
    `  sources: ${formatContributors(explanation.settings.crp.contributors)}`,
    `- crpBudget = ${String(explanation.settings.crpBudget.value)}`,
    `  winner: ${explanation.settings.crpBudget.winner.sourceLabel}`,
    `  sources: ${formatContributors(explanation.settings.crpBudget.contributors)}`,
    `- modelWindow = ${String(explanation.settings.modelWindow.value)}`,
    `  winner: ${explanation.settings.modelWindow.winner.sourceLabel}`,
    `  sources: ${formatContributors(explanation.settings.modelWindow.contributors)}`,
    `- contextProfile = ${explanation.settings.contextProfile.value}`,
    `  winner: ${explanation.settings.contextProfile.winner.sourceLabel}`,
    `  sources: ${formatContributors(explanation.settings.contextProfile.contributors)}`,
    `- motion = ${explanation.settings.motion.value}`,
    `  winner: ${explanation.settings.motion.winner.sourceLabel}`,
    `  sources: ${formatContributors(explanation.settings.motion.contributors)}`,
    "",
    "Prompt sections:",
    ...explanation.prompt.sections.flatMap((section) => [
      `- ${section.id}${section.deleted ? " (deleted)" : ""}`,
      `  winner: ${section.winner.sourceLabel}`,
      `  sources: ${formatContributors(section.contributors)}`,
    ]),
    "",
    "Effective prompt:",
    explanation.prompt.rendered,
  ];

  return lines.join("\n");
}
