import type { CacheTelemetrySnapshot } from "@unclecode/contracts";

import { defaultRepoMapCache } from "./repo-map-cache.js";
import { getWorkspaceGuidanceCacheTelemetrySnapshot } from "./workspace-guidance.js";
import { getWorkspaceSkillCacheTelemetrySnapshot } from "./workspace-skills.js";

export function getContextBrokerCacheTelemetrySnapshot(): readonly CacheTelemetrySnapshot[] {
  return [
    defaultRepoMapCache.snapshot(),
    getWorkspaceGuidanceCacheTelemetrySnapshot(),
    getWorkspaceSkillCacheTelemetrySnapshot(),
  ];
}
