export type WorkShellUiLocale = "en" | "ko";

const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
const LATIN_WORD = /[A-Za-z]{2,}/u;

/**
 * Remove non-prose tokens before language detection. User content is never
 * rewritten: this projection exists only to select UI chrome. In particular,
 * Korean identifiers and filenames must not turn an English session Korean.
 */
export function projectWorkShellUserProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/(?:^|\s)(?:[A-Za-z]:[\\/]|[.~]?[\\/])\S+/gu, " ")
    .replace(/(?:^|\s)(?:@|artifact[-_:])?\S*[\\/]\S*/giu, " ")
    .replace(/(?:^|\s)(?:@|artifact[-_:])?[^\s.]+\.[A-Za-z0-9]{1,12}(?=\s|$)/giu, " ")
    .trim();
}

/** Resolve only from meaningful user prose; slash commands and punctuation keep the session locale. */
export function detectWorkShellUserLocale(text: string): WorkShellUiLocale | undefined {
  const normalized = projectWorkShellUserProse(text);
  if (HANGUL.test(normalized)) return "ko";
  if (LATIN_WORD.test(normalized) && !normalized.startsWith("/")) return "en";
  return undefined;
}

export function resolveWorkShellUiLocale(
  text: string,
  fallback: WorkShellUiLocale = "en",
): WorkShellUiLocale {
  return detectWorkShellUserLocale(text) ?? fallback;
}

/** Resolve the operator's stable terminal preference without reading prose. */
export function resolveWorkShellTerminalUiLocale(
  env: Readonly<Record<string, string | undefined>>,
  fallback: WorkShellUiLocale = "en",
): WorkShellUiLocale {
  for (const field of ["LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG"] as const) {
    const raw = env[field]?.trim();
    if (!raw) continue;
    for (const candidate of raw.split(":")) {
      if (/^ko(?:[_-]|\.|@|$)/iu.test(candidate)) return "ko";
      if (/^en(?:[_-]|\.|@|$)/iu.test(candidate)) return "en";
      if (/^(?:C|POSIX)(?:\.|$)/u.test(candidate)) return "en";
    }
  }
  return fallback;
}

export type WorkShellMessageCatalog = Readonly<{
  ready: string;
  working: string;
  starting: string;
  last: string;
  nextMove: string;
  emptyHint: string;
  openers: string;
  starterPrompts: readonly [string, string, string];
  composerPlaceholder: string;
  composerEmptyHint: string;
  composerDraftHint: string;
  composerBusyHint: string;
  composerPausedHint: string;
  slashSelectHint: string;
  slashNoMatch: string;
  modelSelectHint: string;
  modelNoMatch: string;
  decisionTypeHint: string;
  decisionCancelHint: string;
  decisionBarHint: string;
  queueFollowUp: string;
  queueFollowUps: string;
  paused: string;
  resume: string;
  attachments: string;
  agent: string;
  agents: string;
  job: string;
  jobs: string;
  planning: string;
  synthesizing: string;
  reviewing: string;
  readingFiles: string;
  qualityEngine: string;
  review: string;
  evidence: string;
  failure: string;
  reason: string;
  gate: string;
  stage: string;
  profile: string;
  reviewer: string;
  route: string;
  current: string;
  stale: string;
  independent: string;
  notIndependent: string;
  pluginDiagnostic: Readonly<{
    externalPlugin: string;
    source: string;
    trust: string;
    plugin: string;
    hook: string;
    status: string;
    exit: string;
    error: string;
    dedupe: string;
    errorStatus: string;
  }>;
}>;

const UI_MESSAGES: Readonly<Record<WorkShellUiLocale, WorkShellMessageCatalog>> = {
  en: {
    ready: "Ready", working: "Working", starting: "starting", last: "last",
    nextMove: "Ready for the next move",
    emptyHint: "Start with a task or choose a shortcut.",
    openers: "/ commands · @ attach a file · ! shell · ? keys",
    starterPrompts: [
      "Explain this codebase and how it is organized",
      "Find the cause of a failing test and propose a fix",
      "Draft a plan for the next change",
    ],
    composerPlaceholder: "Describe a task · / for commands",
    composerEmptyHint: "Enter send · Shift+Enter newline · / commands · Ctrl+V image",
    composerDraftHint: "Enter send · Shift+Enter newline · Ctrl+V image",
    composerBusyHint: "Queue a follow-up... · Enter queue · Esc interrupt · /queue",
    composerPausedHint: "Queue paused after interrupt · check /queue · /queue clear drops",
    slashSelectHint: "↑↓ select · Enter run · Esc cancel",
    slashNoMatch: "No matches · try /model, /auth, /context, /queue",
    modelSelectHint: "↑↓ choose · Enter switch · type to filter · Esc cancel",
    modelNoMatch: "No exact model match · type to filter",
    decisionTypeHint: "type answers · Esc cancels decision · /cancel",
    decisionCancelHint: "answer · Esc cancels decision · or type",
    decisionBarHint: "answer · Esc cancel · or type",
    queueFollowUp: "follow-up", queueFollowUps: "follow-ups", paused: "paused", resume: "resume",
    attachments: "attachments", agent: "agent", agents: "agents", job: "job", jobs: "jobs",
    planning: "Planning parallel work", synthesizing: "Synthesizing answer",
    reviewing: "Reviewing results", readingFiles: "Reading files",
    qualityEngine: "Quality Engine", review: "Review", evidence: "Evidence", failure: "Failure",
    reason: "Reason", gate: "Gate", stage: "Stage", profile: "Profile", reviewer: "Reviewer",
    route: "Route", current: "current", stale: "stale", independent: "independent",
    notIndependent: "not independent",
    pluginDiagnostic: {
      externalPlugin: "External plugin", source: "source", trust: "trust", plugin: "plugin",
      hook: "hook", status: "status", exit: "exit", error: "error", dedupe: "dedupe",
      errorStatus: "error",
    },
  },
  ko: {
    ready: "준비 완료", working: "작업 중", starting: "시작 중", last: "최근",
    nextMove: "다음 작업 준비 완료",
    emptyHint: "작업을 입력하거나 바로가기를 선택하세요.",
    openers: "/ 명령 · @ 파일 첨부 · ! 셸 · ? 단축키",
    starterPrompts: [
      "이 코드베이스의 구조와 구성을 설명해 주세요",
      "실패한 테스트의 원인을 찾고 수정안을 제안해 주세요",
      "다음 변경 작업의 계획을 작성해 주세요",
    ],
    composerPlaceholder: "작업을 설명하세요 · / 명령",
    composerEmptyHint: "Enter 전송 · Shift+Enter 줄바꿈 · / 명령 · Ctrl+V 이미지",
    composerDraftHint: "Enter 전송 · Shift+Enter 줄바꿈 · Ctrl+V 이미지",
    composerBusyHint: "후속 요청 대기열 추가... · Enter 추가 · Esc 중단 · /queue",
    composerPausedHint: "중단 후 대기열 일시정지 · /queue 확인 · /queue clear 삭제",
    slashSelectHint: "↑↓ 선택 · Enter 실행 · Esc 취소",
    slashNoMatch: "일치 항목 없음 · /model, /auth, /context, /queue 시도",
    modelSelectHint: "↑↓ 선택 · Enter 전환 · 입력하여 필터 · Esc 취소",
    modelNoMatch: "정확한 모델 일치 없음 · 입력하여 필터",
    decisionTypeHint: "답변 입력 · Esc 결정 취소 · /cancel",
    decisionCancelHint: "답변 · Esc 결정 취소 · 또는 입력",
    decisionBarHint: "답변 · Esc 취소 · 또는 입력",
    queueFollowUp: "후속 요청", queueFollowUps: "후속 요청", paused: "일시정지", resume: "재개",
    attachments: "첨부 파일", agent: "에이전트", agents: "에이전트", job: "작업", jobs: "작업",
    planning: "병렬 작업 계획 중", synthesizing: "응답 정리 중",
    reviewing: "결과 검토 중", readingFiles: "파일 읽는 중",
    qualityEngine: "Quality Engine", review: "검토", evidence: "증거", failure: "실패",
    reason: "이유", gate: "게이트", stage: "단계", profile: "프로필", reviewer: "검토자",
    route: "경로", current: "현재", stale: "만료됨", independent: "독립 검증",
    notIndependent: "독립 검증 아님",
    pluginDiagnostic: {
      externalPlugin: "외부 플러그인", source: "출처", trust: "신뢰", plugin: "플러그인",
      hook: "훅", status: "상태", exit: "종료", error: "오류", dedupe: "중복 키",
      errorStatus: "오류",
    },
  },
};

export function getWorkShellMessages(locale: WorkShellUiLocale): WorkShellMessageCatalog {
  return UI_MESSAGES[locale];
}

const MODE_LABELS: Readonly<Record<WorkShellUiLocale, Readonly<Record<string, string>>>> = {
  en: {
    default: "Work mode",
    ultrawork: "Focus mode",
    search: "Search mode",
    analyze: "Analyze mode",
    yolo: "YOLO mode",
    plan: "Plan mode",
    build: "Build mode",
  },
  ko: {
    default: "작업 모드",
    ultrawork: "집중 작업 모드",
    search: "탐색 모드",
    analyze: "분석 모드",
    yolo: "YOLO 모드",
    plan: "계획 모드",
    build: "구현 모드",
  },
};

export function formatWorkShellModeLabelForLocale(
  mode: string,
  locale: WorkShellUiLocale,
): string {
  const normalized = mode.trim().toLowerCase();
  return MODE_LABELS[locale][normalized] ?? `${normalized} mode`;
}

export function workShellLanguageInstruction(locale: WorkShellUiLocale): string {
  return locale === "ko"
    ? "현재 세션의 사용자 언어를 따라 한국어로 답변하세요. 코드, 경로, 명령, 고유 명칭은 필요한 경우 원문을 유지하세요."
    : "Respond in English for this session. Preserve code, paths, commands, and proper names when needed.";
}
