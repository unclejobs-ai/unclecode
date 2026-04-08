import { useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createWorkShellDashboardHomePatch,
  createWorkShellDashboardHomeSyncState,
  shouldRefreshDashboardHomeState,
  type WorkShellDashboardHomeSyncState,
} from "./work-shell-dashboard-sync.js";
import type { TuiShellHomeState } from "./shell-state.js";
import {
  clampWorkShellSlashSelection,
  cycleWorkShellSlashSelection,
  resolveWorkShellActivePanel,
} from "./work-shell-panels.js";
import {
  resolveWorkShellInputAction,
  resolveWorkShellSubmitAction,
} from "./work-shell-input.js";
import type { WorkShellEntry, WorkShellPanel } from "./work-shell-view.js";

export type WorkShellComposerPreview<Attachment = never> = {
  readonly prompt: string;
  readonly attachments: readonly Attachment[];
  readonly transcriptText: string;
};

export function createEmptyWorkShellComposerPreview<Attachment = never>(): WorkShellComposerPreview<Attachment> {
  return {
    prompt: "",
    attachments: [],
    transcriptText: "",
  };
}

export interface WorkShellStateSource<State> {
  getState(): State;
  subscribe(listener: (state: State) => void): () => void;
  initialize(): Promise<void>;
  dispose(): void;
}

export function useWorkShellEngineState<State>(engine: WorkShellStateSource<State>): State {
  const [state, setState] = useState(() => engine.getState());

  useEffect(() => {
    setState(engine.getState());
    const unsubscribe = engine.subscribe(setState);
    void engine.initialize();
    return () => {
      unsubscribe();
      engine.dispose();
    };
  }, [engine]);

  return state;
}

export function useWorkShellDashboardHomeSync(input: {
  readonly isBusy: boolean;
  readonly authLabel: string;
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly onSyncHomeState?: ((homeState: Partial<TuiShellHomeState>) => void) | undefined;
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
}): void {
  const previousHomeSyncStateRef = useRef<WorkShellDashboardHomeSyncState | undefined>(undefined);

  useEffect(() => {
    input.onSyncHomeState?.(
      createWorkShellDashboardHomePatch({
        authLabel: input.authLabel,
        bridgeLines: input.bridgeLines,
        memoryLines: input.memoryLines,
      }),
    );
  }, [
    input.authLabel,
    input.bridgeLines,
    input.memoryLines,
    input.onSyncHomeState,
  ]);

  useEffect(() => {
    const nextHomeSyncState = createWorkShellDashboardHomeSyncState({
      isBusy: input.isBusy,
      authLabel: input.authLabel,
      bridgeLines: input.bridgeLines,
      memoryLines: input.memoryLines,
    });
    const previousHomeSyncState = previousHomeSyncStateRef.current;
    previousHomeSyncStateRef.current = nextHomeSyncState;

    if (!input.refreshHomeState || !input.onSyncHomeState) {
      return;
    }
    if (!shouldRefreshDashboardHomeState(previousHomeSyncState, nextHomeSyncState)) {
      return;
    }

    let cancelled = false;
    void input.refreshHomeState()
      .then((homeState) => {
        if (!cancelled) {
          input.onSyncHomeState?.(homeState);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [
    input.authLabel,
    input.bridgeLines,
    input.isBusy,
    input.memoryLines,
    input.onSyncHomeState,
    input.refreshHomeState,
  ]);
}

export type WorkShellSlashSuggestion = {
  readonly command: string;
  readonly description: string;
};

export type WorkShellPaneRuntimeState<Reasoning = unknown> = {
  readonly entries: readonly WorkShellEntry[];
  readonly model: string;
  readonly reasoning: Reasoning;
  readonly authLabel: string;
  readonly isBusy: boolean;
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly authLauncherLines?: readonly string[];
  readonly composerMode?: "default" | "api-key-entry";
  readonly panel: WorkShellPanel;
};

export interface WorkShellPaneEngine<State extends WorkShellPaneRuntimeState>
  extends WorkShellStateSource<State> {
  handleSubmit(line: string): Promise<void>;
  openSessionsPanel(): Promise<void>;
  cancelSensitiveInput?(): void;
  closeOverlay?(): void;
}

export function useWorkShellSlashState(input: {
  readonly value: string;
  readonly authLabel?: string;
  readonly authLauncherLines?: readonly string[];
  readonly browserOAuthAvailable?: boolean;
  readonly fallbackPanel: WorkShellPanel;
  readonly getSuggestions: (value: string) => readonly WorkShellSlashSuggestion[];
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const suggestions = useMemo(
    () =>
      input.value.trim().startsWith("/")
        ? input.getSuggestions(input.value)
        : [],
    [input.value, input.getSuggestions],
  );

  useEffect(() => {
    setSelectedIndex((current) =>
      clampWorkShellSlashSelection(current, suggestions.length),
    );
  }, [input.value, suggestions.length]);

  const selectedSuggestion = suggestions[selectedIndex];
  const activePanel = useMemo(
    () =>
      resolveWorkShellActivePanel({
        input: input.value,
        suggestions,
        selectedIndex,
        ...(input.authLabel ? { authLabel: input.authLabel } : {}),
        ...(input.browserOAuthAvailable !== undefined
          ? { browserOAuthAvailable: input.browserOAuthAvailable }
          : {}),
        ...(input.authLauncherLines
          ? { authLauncherLines: input.authLauncherLines }
          : {}),
        fallbackPanel: input.fallbackPanel,
      }),
    [
      input.authLabel,
      input.authLauncherLines,
      input.browserOAuthAvailable,
      input.fallbackPanel,
      input.value,
      selectedIndex,
      suggestions,
    ],
  );

  return {
    suggestions,
    selectedIndex,
    setSelectedIndex,
    selectedSuggestion,
    activePanel,
  };
}

export function useWorkShellInputController(input: {
  readonly value: string;
  readonly replaceValue: (value: string) => void;
  readonly slashSuggestionCount: number;
  readonly selectedSlashCommand?: string;
  readonly setSelectedSlashIndex: (value: number | ((current: number) => number)) => void;
  readonly isBusy: boolean;
  readonly onExit: () => void;
  readonly onRequestSessionsView?: (() => void) | undefined;
  readonly openEngineSessions: () => void;
  readonly shouldBlockSlashSubmit: (line: string) => boolean;
  readonly handleSubmit: (line: string) => Promise<void>;
  readonly hasSensitiveInput?: boolean;
  readonly hasOverlayOpen?: boolean;
  readonly cancelSensitiveInput?: (() => void) | undefined;
  readonly closeOverlay?: (() => void) | undefined;
}): { readonly submit: (value: string) => Promise<void> } {
  useInput((value, key) => {
    const action = resolveWorkShellInputAction({
      value,
      key,
      input: input.value,
      slashSuggestionCount: input.slashSuggestionCount,
      ...(input.selectedSlashCommand
        ? { selectedSlashCommand: input.selectedSlashCommand }
        : {}),
      isBusy: input.isBusy,
      hasRequestSessionsView: Boolean(input.onRequestSessionsView),
      ...(input.hasSensitiveInput ? { hasSensitiveInput: input.hasSensitiveInput } : {}),
      ...(input.hasOverlayOpen ? { hasOverlayOpen: input.hasOverlayOpen } : {}),
    });

    switch (action.type) {
      case "exit":
        input.onExit();
        return;
      case "complete-slash":
        input.replaceValue(action.value);
        return;
      case "move-slash-selection":
        input.setSelectedSlashIndex((current) =>
          cycleWorkShellSlashSelection(current, input.slashSuggestionCount, action.direction),
        );
        return;
      case "cancel-sensitive-input":
        input.cancelSensitiveInput?.();
        return;
      case "close-overlay":
        input.closeOverlay?.();
        return;
      case "open-sessions-view":
        input.onRequestSessionsView?.();
        return;
      case "open-engine-sessions":
        input.openEngineSessions();
        return;
      case "none":
        return;
    }
  }, { isActive: true });

  const submit = useCallback(
    async (value: string) => {
      const line = value.trim();
      const action = resolveWorkShellSubmitAction({
        value,
        isBusy: input.isBusy,
        shouldBlockSlashSubmit: input.shouldBlockSlashSubmit(line),
        ...(input.selectedSlashCommand
          ? { selectedSlashCommand: input.selectedSlashCommand }
          : {}),
      });

      if (action.type === "noop") {
        return;
      }

      if (action.clearInput) {
        input.replaceValue("");
      }

      await input.handleSubmit(action.line);
    },
    [
      input.handleSubmit,
      input.isBusy,
      input.replaceValue,
      input.selectedSlashCommand,
      input.shouldBlockSlashSubmit,
    ],
  );

  return { submit };
}

export function useWorkShellPaneState<
  Attachment,
  State extends WorkShellPaneRuntimeState,
>(input: {
  readonly engine: WorkShellPaneEngine<State>;
  readonly cwd: string;
  readonly resolveComposerInput: (
    value: string,
    cwd: string,
  ) => Promise<WorkShellComposerPreview<Attachment>>;
  readonly getSuggestions: (value: string) => readonly WorkShellSlashSuggestion[];
  readonly browserOAuthAvailable?: boolean;
  readonly onExit: () => void;
  readonly onRequestSessionsView?: (() => void) | undefined;
  readonly onSyncHomeState?: ((homeState: Partial<TuiShellHomeState>) => void) | undefined;
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
  readonly shouldBlockSlashSubmit: (line: string) => boolean;
}) {
  const [inputValue, setInputValue] = useState("");
  const engineState = useWorkShellEngineState(input.engine);
  const composerPreview = useWorkShellComposerPreview({
    value: inputValue,
    cwd: input.cwd,
    resolveComposerInput: input.resolveComposerInput,
  });

  useWorkShellDashboardHomeSync({
    isBusy: engineState.isBusy,
    authLabel: engineState.authLabel,
    bridgeLines: engineState.bridgeLines,
    memoryLines: engineState.memoryLines,
    onSyncHomeState: input.onSyncHomeState,
    refreshHomeState: input.refreshHomeState,
  });

  const {
    suggestions: slashSuggestions,
    setSelectedIndex: setSelectedSlashIndex,
    selectedSuggestion,
    activePanel,
  } = useWorkShellSlashState({
    value: inputValue,
    ...(engineState.authLabel ? { authLabel: engineState.authLabel } : {}),
    ...(input.browserOAuthAvailable !== undefined
      ? { browserOAuthAvailable: input.browserOAuthAvailable }
      : {}),
    ...(engineState.authLauncherLines
      ? { authLauncherLines: engineState.authLauncherLines }
      : {}),
    fallbackPanel: engineState.panel,
    getSuggestions: input.getSuggestions,
  });

  const openEngineSessions = useCallback(() => {
    void input.engine.openSessionsPanel();
  }, [input.engine]);

  const handleSubmit = useCallback(
    (line: string) => input.engine.handleSubmit(line),
    [input.engine],
  );

  const { submit } = useWorkShellInputController({
    value: inputValue,
    replaceValue: setInputValue,
    slashSuggestionCount: slashSuggestions.length,
    ...(selectedSuggestion?.command
      ? { selectedSlashCommand: selectedSuggestion.command }
      : {}),
    setSelectedSlashIndex,
    isBusy: engineState.isBusy,
    onExit: input.onExit,
    onRequestSessionsView: input.onRequestSessionsView,
    openEngineSessions,
    shouldBlockSlashSubmit: input.shouldBlockSlashSubmit,
    handleSubmit,
    hasSensitiveInput: engineState.composerMode === "api-key-entry",
    hasOverlayOpen: engineState.panel.title === "Context expanded",
    ...(input.engine.cancelSensitiveInput
      ? { cancelSensitiveInput: () => input.engine.cancelSensitiveInput?.() }
      : {}),
    ...(input.engine.closeOverlay
      ? { closeOverlay: () => input.engine.closeOverlay?.() }
      : {}),
  });

  return {
    inputValue,
    setInputValue,
    engineState,
    composerPreview,
    activePanel,
    slashSuggestionCount: slashSuggestions.length,
    submit,
  };
}

export function useWorkShellComposerPreview<Attachment>(input: {
  readonly value: string;
  readonly cwd: string;
  readonly resolveComposerInput: (
    value: string,
    cwd: string,
  ) => Promise<WorkShellComposerPreview<Attachment>>;
}): WorkShellComposerPreview<Attachment> {
  const [preview, setPreview] = useState<WorkShellComposerPreview<Attachment>>(
    () => createEmptyWorkShellComposerPreview(),
  );

  useEffect(() => {
    if (!input.value.trim()) {
      setPreview(createEmptyWorkShellComposerPreview());
      return;
    }

    let cancelled = false;
    void input.resolveComposerInput(input.value, input.cwd)
      .then((nextPreview) => {
        if (!cancelled) {
          setPreview(nextPreview);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [input.cwd, input.resolveComposerInput, input.value]);

  return preview;
}
