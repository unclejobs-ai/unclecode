export declare const MODE_PROFILE_IDS: readonly ["default", "ultrawork", "search", "analyze", "yolo", "plan", "build"];
export type ModeProfileId = (typeof MODE_PROFILE_IDS)[number];
export declare const MODE_EDITING_POLICIES: readonly ["allowed", "reviewed", "forbidden"];
export type ModeEditingPolicy = (typeof MODE_EDITING_POLICIES)[number];
export declare const MODE_SEARCH_DEPTHS: readonly ["balanced", "deep"];
export type ModeSearchDepth = (typeof MODE_SEARCH_DEPTHS)[number];
export declare const MODE_BACKGROUND_TASK_POLICIES: readonly ["allowed", "preferred", "forbidden"];
export type ModeBackgroundTaskPolicy = (typeof MODE_BACKGROUND_TASK_POLICIES)[number];
export declare const MODE_EXPLANATION_STYLES: readonly ["concise", "balanced", "detailed"];
export type ModeExplanationStyle = (typeof MODE_EXPLANATION_STYLES)[number];
export declare const MODE_REASONING_EFFORTS: readonly ["low", "medium", "high"];
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
export declare const MODE_PROFILES: {
    readonly default: {
        readonly id: "default";
        readonly label: "Default";
        readonly editing: "allowed";
        readonly searchDepth: "balanced";
        readonly backgroundTasks: "allowed";
        readonly explanationStyle: "balanced";
        readonly reasoningDefault: "medium";
    };
    readonly ultrawork: {
        readonly id: "ultrawork";
        readonly label: "Ultra Work";
        readonly editing: "allowed";
        readonly searchDepth: "deep";
        readonly backgroundTasks: "preferred";
        readonly explanationStyle: "concise";
        readonly reasoningDefault: "high";
    };
    readonly search: {
        readonly id: "search";
        readonly label: "Search";
        readonly editing: "forbidden";
        readonly searchDepth: "deep";
        readonly backgroundTasks: "preferred";
        readonly explanationStyle: "concise";
        readonly reasoningDefault: "low";
    };
    readonly analyze: {
        readonly id: "analyze";
        readonly label: "Analyze";
        readonly editing: "reviewed";
        readonly searchDepth: "balanced";
        readonly backgroundTasks: "allowed";
        readonly explanationStyle: "detailed";
        readonly reasoningDefault: "high";
    };
    readonly yolo: {
        readonly id: "yolo";
        readonly label: "YOLO";
        readonly editing: "allowed";
        readonly searchDepth: "balanced";
        readonly backgroundTasks: "preferred";
        readonly explanationStyle: "concise";
        readonly reasoningDefault: "medium";
    };
    readonly plan: {
        readonly id: "plan";
        readonly label: "Plan";
        readonly editing: "forbidden";
        readonly searchDepth: "deep";
        readonly backgroundTasks: "forbidden";
        readonly explanationStyle: "detailed";
        readonly reasoningDefault: "high";
    };
    readonly build: {
        readonly id: "build";
        readonly label: "Build";
        readonly editing: "allowed";
        readonly searchDepth: "balanced";
        readonly backgroundTasks: "allowed";
        readonly explanationStyle: "balanced";
        readonly reasoningDefault: "medium";
    };
};
//# sourceMappingURL=modes.d.ts.map