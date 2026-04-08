export const MODE_PROFILE_IDS = ["default", "ultrawork", "search", "analyze"] as const;

export type ModeProfileId = (typeof MODE_PROFILE_IDS)[number];

export const MODE_EDITING_POLICIES = ["allowed", "reviewed", "forbidden"] as const;

export type ModeEditingPolicy = (typeof MODE_EDITING_POLICIES)[number];

export const MODE_SEARCH_DEPTHS = ["balanced", "deep"] as const;

export type ModeSearchDepth = (typeof MODE_SEARCH_DEPTHS)[number];

export const MODE_BACKGROUND_TASK_POLICIES = ["allowed", "preferred", "forbidden"] as const;

export type ModeBackgroundTaskPolicy = (typeof MODE_BACKGROUND_TASK_POLICIES)[number];

export const MODE_EXPLANATION_STYLES = ["concise", "balanced", "detailed"] as const;

export type ModeExplanationStyle = (typeof MODE_EXPLANATION_STYLES)[number];

export const MODE_REASONING_EFFORTS = ["low", "medium", "high"] as const;

export type ModeReasoningEffort = (typeof MODE_REASONING_EFFORTS)[number];

export type ModeProfile = {
  readonly id: ModeProfileId;
  readonly label: string;
  readonly editing: ModeEditingPolicy;
  readonly searchDepth: ModeSearchDepth;
  readonly backgroundTasks: ModeBackgroundTaskPolicy;
  readonly explanationStyle: ModeExplanationStyle;
  readonly reasoningDefault: ModeReasoningEffort;
};

export const MODE_PROFILES = {
  default: {
    id: "default",
    label: "Default",
    editing: "allowed",
    searchDepth: "balanced",
    backgroundTasks: "allowed",
    explanationStyle: "balanced",
    reasoningDefault: "medium",
  },
  ultrawork: {
    id: "ultrawork",
    label: "Ultra Work",
    editing: "allowed",
    searchDepth: "deep",
    backgroundTasks: "preferred",
    explanationStyle: "concise",
    reasoningDefault: "high",
  },
  search: {
    id: "search",
    label: "Search",
    editing: "forbidden",
    searchDepth: "deep",
    backgroundTasks: "preferred",
    explanationStyle: "concise",
    reasoningDefault: "low",
  },
  analyze: {
    id: "analyze",
    label: "Analyze",
    editing: "reviewed",
    searchDepth: "balanced",
    backgroundTasks: "allowed",
    explanationStyle: "detailed",
    reasoningDefault: "high",
  },
} as const satisfies Readonly<Record<ModeProfileId, ModeProfile>>;
