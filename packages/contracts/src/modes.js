export const MODE_PROFILE_IDS = [
    "default",
    "ultrawork",
    "search",
    "analyze",
    "yolo",
    "plan",
    "build",
];
export const MODE_EDITING_POLICIES = ["allowed", "reviewed", "forbidden"];
export const MODE_SEARCH_DEPTHS = ["balanced", "deep"];
export const MODE_BACKGROUND_TASK_POLICIES = ["allowed", "preferred", "forbidden"];
export const MODE_EXPLANATION_STYLES = ["concise", "balanced", "detailed"];
export const MODE_REASONING_EFFORTS = ["low", "medium", "high"];
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
    yolo: {
        id: "yolo",
        label: "YOLO",
        editing: "allowed",
        searchDepth: "balanced",
        backgroundTasks: "preferred",
        explanationStyle: "concise",
        reasoningDefault: "medium",
    },
    plan: {
        id: "plan",
        label: "Plan",
        editing: "forbidden",
        searchDepth: "deep",
        backgroundTasks: "forbidden",
        explanationStyle: "detailed",
        reasoningDefault: "high",
    },
    build: {
        id: "build",
        label: "Build",
        editing: "allowed",
        searchDepth: "balanced",
        backgroundTasks: "allowed",
        explanationStyle: "balanced",
        reasoningDefault: "medium",
    },
};
//# sourceMappingURL=modes.js.map