import type {
  ContextPacketSourceCategory,
  ContextProfile,
  ContextProfileId,
} from "@unclecode/contracts";

const BUILD_CATEGORIES: readonly ContextPacketSourceCategory[] = [
  "workspace",
  "workspace-guidance",
  "provider-system-prompt",
  "runtime",
  "bridge",
  "memory",
];

const EXPLORE_CATEGORIES: readonly ContextPacketSourceCategory[] = [
  "workspace",
  "workspace-guidance",
  "loop-trail",
  "condensed-history",
  "memory",
  "bridge",
];

const REVIEW_CATEGORIES: readonly ContextPacketSourceCategory[] = [
  "workspace",
  "workspace-guidance",
  "provider-system-prompt",
  "runtime",
  "bridge",
  "memory",
];

export const CONTEXT_PROFILES: Readonly<Record<ContextProfileId, ContextProfile>> = {
  build: {
    id: "build",
    label: "Build",
    preferredSourceCategories: BUILD_CATEGORIES,
  },
  explore: {
    id: "explore",
    label: "Explore",
    preferredSourceCategories: EXPLORE_CATEGORIES,
  },
  review: {
    id: "review",
    label: "Review",
    preferredSourceCategories: REVIEW_CATEGORIES,
  },
};

export function resolveContextProfile(id: ContextProfileId): ContextProfile {
  return CONTEXT_PROFILES[id];
}
