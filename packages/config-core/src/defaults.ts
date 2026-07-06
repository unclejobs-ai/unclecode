import { MODE_PROFILES } from "@unclecode/contracts";
import type { ModeProfile, ModeProfileId } from "@unclecode/contracts";

import type {
  ConfigSourceDefinition,
  UncleCodeConfigLayer,
  UncleCodePromptSection,
} from "./types.js";

export const CONFIG_SOURCE_ORDER = [
  { id: "built-in-defaults", label: "built-in defaults" },
  { id: "built-in-mode-profile", label: "built-in mode profile" },
  { id: "plugin-overlay", label: "plugin overlay" },
  { id: "project-config", label: "project config" },
  { id: "user-config", label: "user config" },
  { id: "environment", label: "environment" },
  { id: "cli-flags", label: "cli flags" },
  { id: "session-overrides", label: "session overrides" },
] as const satisfies readonly ConfigSourceDefinition[];

export const CONFIG_CORE_DEFAULT_MODE_PROFILE = MODE_PROFILES.default.id;
export const CONFIG_CORE_DEFAULT_MODEL = "claude-sonnet-4-20250514";
export const CONFIG_CORE_DEFAULT_CONTEXT_CRP = true;
export const CONFIG_CORE_DEFAULT_CONTEXT_CRP_BUDGET = 32000;

/**
 * v1 composer attachment caps — mirrored by provider and orchestrator
 * defensive layers. Users can override via project/user config JSON,
 * env vars, CLI flags, or session overrides through the standard
 * config-core resolution chain.
 */
export const CONFIG_CORE_DEFAULT_MAX_CLIPBOARD_ATTACHMENT_COUNT = 5;
export const CONFIG_CORE_DEFAULT_MAX_CLIPBOARD_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const CONFIG_CORE_DEFAULTS: UncleCodeConfigLayer = {
  mode: CONFIG_CORE_DEFAULT_MODE_PROFILE,
  model: CONFIG_CORE_DEFAULT_MODEL,
  prompt: {
    sections: {
      identity: {
        title: "Role",
        body: "You are an autonomous coding agent. Execute tasks to completion. Do not ask for permission on obvious next steps — proceed. If blocked, try an alternative approach. Only ask when truly ambiguous or destructive.",
      },
      execution: {
        title: "Quality",
        body: "Write correct, type-safe code. Never use `as any`, `@ts-ignore`, or placeholder logic. Delete dead code immediately. Run verification after changes — format, lint, typecheck, then tests — and report failures honestly.",
      },
    },
  },
  context: {
    crp: CONFIG_CORE_DEFAULT_CONTEXT_CRP,
    crpBudget: CONFIG_CORE_DEFAULT_CONTEXT_CRP_BUDGET,
  },
  composer: {
    maxClipboardAttachmentCount: CONFIG_CORE_DEFAULT_MAX_CLIPBOARD_ATTACHMENT_COUNT,
    maxClipboardAttachmentBytes: CONFIG_CORE_DEFAULT_MAX_CLIPBOARD_ATTACHMENT_BYTES,
  },
};

function buildActiveModeSection(profile: ModeProfile): UncleCodePromptSection {
  const shared = `Keep replies ${profile.explanationStyle} and operator-friendly.`;

  if (profile.id === "search") {
    return {
      title: "Active Mode",
      body: [
        "Search mode is active.",
        "Stay read-only and do not edit files.",
        "If the user asks for edits, answer in at most two short lines and suggest `/mode set yolo` or `/mode set default`.",
        shared,
      ].join("\n"),
    };
  }

  if (profile.id === "analyze") {
    return {
      title: "Active Mode",
      body: [
        "Analyze mode is active.",
        "Prefer diagnosis, evidence, and concrete next steps before edits.",
        "If editing is needed, say so briefly and suggest `/mode set yolo` or `/mode set default`.",
        shared,
      ].join("\n"),
    };
  }

  if (profile.id === "ultrawork") {
    return {
      title: "Active Mode",
      body: [
        "Ultra Work mode is active.",
        "Edit directly, use deeper search, and prefer background or parallel work when it helps.",
        shared,
      ].join("\n"),
    };
  }

  if (profile.id === "yolo") {
    return {
      title: "Active Mode",
      body: [
        "YOLO mode is active.",
        "Edit directly on clear requests and avoid needless confirmation on low-risk reversible steps.",
        shared,
      ].join("\n"),
    };
  }

  return {
    title: "Active Mode",
    body: [
      "Default mode is active.",
      "Edit when needed, but stay inside scope and use balanced search depth.",
      shared,
    ].join("\n"),
  };
}

export function getModeProfile(modeId: ModeProfileId): ModeProfile {
  return MODE_PROFILES[modeId];
}

export function buildModeProfileOverlay(modeId: ModeProfileId): UncleCodeConfigLayer {
  const profile = getModeProfile(modeId);

  return {
    behavior: {
      editing: profile.editing,
      searchDepth: profile.searchDepth,
      backgroundTasks: profile.backgroundTasks,
      explanationStyle: profile.explanationStyle,
    },
    prompt: {
      sections: {
        "active-mode": buildActiveModeSection(profile),
      },
    },
  };
}
