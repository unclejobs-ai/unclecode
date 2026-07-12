export {
  CONFIG_CORE_DEFAULT_MODE_PROFILE,
  CONFIG_CORE_DEFAULT_MODEL,
  CONFIG_CORE_DEFAULT_CONTEXT_PROFILE,
  CONFIG_CORE_DEFAULT_TUI_MOTION,
  CONFIG_CORE_DEFAULT_MAX_CLIPBOARD_ATTACHMENT_COUNT,
  CONFIG_CORE_DEFAULT_MAX_CLIPBOARD_ATTACHMENT_BYTES,
  CONFIG_CORE_DEFAULTS,
  CONFIG_SOURCE_ORDER,
} from "./defaults.js";
export { explainUncleCodeConfig, formatUncleCodeConfigExplanation } from "./resolver.js";
export type {
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
