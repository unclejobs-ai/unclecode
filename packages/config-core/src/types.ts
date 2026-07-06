import type {
  ModeBackgroundTaskPolicy,
  ModeEditingPolicy,
  ModeExplanationStyle,
  ModeProfile,
  ModeProfileId,
  ModeSearchDepth,
} from "@unclecode/contracts";

export type ConfigSourceId =
  | "built-in-defaults"
  | "built-in-mode-profile"
  | "plugin-overlay"
  | "project-config"
  | "user-config"
  | "environment"
  | "cli-flags"
  | "session-overrides";

export type ConfigSourceDefinition = {
  readonly id: ConfigSourceId;
  readonly label: string;
};

export type UncleCodePromptSection = {
  readonly title: string;
  readonly body: string;
};

export type UncleCodeConfigLayer = {
  readonly mode?: ModeProfileId;
  readonly model?: string;
  readonly behavior?: {
    readonly editing?: ModeEditingPolicy;
    readonly searchDepth?: ModeSearchDepth;
    readonly backgroundTasks?: ModeBackgroundTaskPolicy;
    readonly explanationStyle?: ModeExplanationStyle;
  };
  readonly context?: {
    /** Context Runbook Protocol (CRP) — SQL-backed context selection. */
    readonly crp?: boolean;
    /** Token budget for context selection (default 32000). */
    readonly crpBudget?: number;
  };
  readonly prompt?: {
    readonly sections?: Readonly<Record<string, UncleCodePromptSection | null>>;
  };
  readonly composer?: {
    readonly maxClipboardAttachmentCount?: number;
    readonly maxClipboardAttachmentBytes?: number;
  };
};

export type UncleCodeNamedOverlay = {
  readonly name: string;
  readonly config: UncleCodeConfigLayer;
};

export type UncleCodeConfigExplainOptions = {
  readonly workspaceRoot: string;
  readonly userHomeDir?: string;
  readonly builtinDefaults?: UncleCodeConfigLayer;
  readonly pluginOverlays?: readonly UncleCodeNamedOverlay[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cliFlags?: UncleCodeConfigLayer;
  readonly sessionOverrides?: UncleCodeConfigLayer;
  readonly projectConfigPath?: string;
  readonly userConfigPath?: string;
};

export type SettingExplanation<T> = {
  readonly value: T;
  readonly winner: SettingContribution<T>;
  readonly contributors: readonly SettingContribution<T>[];
};

export type SettingContribution<T> = {
  readonly sourceId: ConfigSourceId;
  readonly sourceLabel: string;
  readonly detail?: string;
  readonly value: T;
};

export type ConfigSourceIssue = {
  readonly sourceId: ConfigSourceId;
  readonly sourceLabel: string;
  readonly detail?: string;
  readonly message: string;
};

export type PromptSectionExplanation = {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly deleted: boolean;
  readonly winner: SettingContribution<UncleCodePromptSection | null>;
  readonly contributors: readonly SettingContribution<UncleCodePromptSection | null>[];
};

export type UncleCodeConfigExplanation = {
  readonly sourceOrder: readonly ConfigSourceDefinition[];
  readonly sourceIssues: readonly ConfigSourceIssue[];
  readonly activeMode: ModeProfile;
  readonly settings: {
    readonly mode: SettingExplanation<ModeProfileId>;
    readonly model: SettingExplanation<string>;
    readonly editing: SettingExplanation<ModeEditingPolicy>;
    readonly searchDepth: SettingExplanation<ModeSearchDepth>;
    readonly backgroundTasks: SettingExplanation<ModeBackgroundTaskPolicy>;
    readonly explanationStyle: SettingExplanation<ModeExplanationStyle>;
    readonly crp: SettingExplanation<boolean>;
    readonly crpBudget: SettingExplanation<number>;
  };
  readonly prompt: {
    readonly sections: readonly PromptSectionExplanation[];
    readonly rendered: string;
  };
};
