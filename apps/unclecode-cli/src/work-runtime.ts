import { runWorkShellInlineCommand } from "@unclecode/orchestrator";
import { randomUUID } from "node:crypto";
import {
  RuntimeOwnerClient,
  defaultRuntimeOwnerPaths,
  ensureRuntimeOwner,
  probeRuntimeOwner,
} from "@unclecode/server";
import {
  createEmbeddedWorkPaneController,
  createManagedWorkShellDashboardProps,
  formatWorkShellError,
  renderEmbeddedWorkShellPaneDashboard,
  type EmbeddedWorkDashboardSnapshot,
  type TuiRenderOptions,
  type TuiShellHomeState,
} from "@unclecode/tui";

import {
  parseArgs,
  printHelp,
  printTools,
  type ParsedArgs,
} from "./work-runtime-args.js";
import {
  loadWorkCliBootstrap,
} from "./work-runtime-bootstrap.js";
import {
  createManagedDashboardInput,
  type ManagedDashboardSession,
  type StartReplAgent,
  type StartReplOptions,
} from "./work-runtime-dashboard.js";
import { createRemoteWorkShellEngine } from "./remote-work-shell-engine.js";
import { spawnDetachedRuntimeOwner } from "./runtime-owner-launcher.js";

export { loadWorkCliBootstrap } from "./work-runtime-bootstrap.js";
export { loadResumedWorkSession } from "./work-runtime-session.js";
export type { StartReplAgent, StartReplOptions } from "./work-runtime-dashboard.js";

export const resolveWorkShellInlineCommand = (
  args: readonly string[],
  runInlineCommand: (
    args: readonly string[],
    onProgress?: ((line: string) => void) | undefined,
  ) => Promise<readonly string[]>,
  onProgress?: ((line: string) => void) | undefined,
): Promise<{ readonly lines: readonly string[]; readonly failed: boolean }> =>
  runWorkShellInlineCommand(
    args,
    runInlineCommand,
    formatWorkShellError,
    onProgress,
  );

export function createManagedDashboardProps(
  session: ManagedDashboardSession & {
    readonly dispose?: (() => void | Promise<void>) | undefined;
  },
  paneEngine?: object,
): TuiRenderOptions<TuiShellHomeState> {
  return {
    ...createManagedWorkShellDashboardProps({
      ...createManagedDashboardInput(withDefaultWorkSessionLaunch(session), {
        resolveWorkShellInlineCommand,
        ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
      }),
      ...(paneEngine ? { paneEngine: paneEngine as never } : {}),
    }),
    ...(session.dispose ? { dispose: session.dispose } : {}),
  };
}

export function createWorkShellDashboardProps(
  agent: StartReplAgent,
  options: StartReplOptions,
): TuiRenderOptions<TuiShellHomeState> {
  return createManagedDashboardProps({ agent, options });
}

function withDefaultWorkSessionLaunch(
  session: ManagedDashboardSession & {
    readonly dispose?: (() => void | Promise<void>) | undefined;
  },
): ManagedDashboardSession & {
  readonly dispose?: (() => void | Promise<void>) | undefined;
} {
  return {
    ...session,
    agent: session.agent,
    options: {
      ...session.options,
      launchWorkSession:
        session.options.launchWorkSession ??
        ((forwardedArgs: readonly string[] = []) => runWorkCli(forwardedArgs)),
    },
  };
}

function withWorkSessionCwd(
  forwardedArgs: readonly string[],
  cwd: string,
): readonly string[] {
  if (forwardedArgs.includes("--cwd")) {
    return forwardedArgs;
  }
  return ["--cwd", cwd, ...forwardedArgs];
}

type DisposableRemoteEngine = object & {
  readonly dispose: () => void;
};

export type PersistentOwnerWorkShellController = {
  readonly initialProps: TuiRenderOptions<TuiShellHomeState>;
  readonly embeddedWorkPane: NonNullable<Awaited<ReturnType<typeof createEmbeddedWorkPaneController<TuiShellHomeState>>>>;
  readonly dispose: () => Promise<void>;
};

async function connectPersistentRuntimeOwner(): Promise<RuntimeOwnerClient> {
  const paths = defaultRuntimeOwnerPaths(process.env.HOME);
  const lease = await ensureRuntimeOwner({
    leasePath: paths.leasePath,
    lockPath: paths.lockPath,
    health: probeRuntimeOwner,
    startOwner: () => spawnDetachedRuntimeOwner({
      leasePath: paths.leasePath,
      tokenPath: paths.tokenPath,
    }),
  });
  return RuntimeOwnerClient.connect(lease);
}

type RemotePromptEngine = {
  readonly getState: () => Readonly<Record<string, unknown>>;
  readonly initialize: () => Promise<void>;
  readonly handleSubmit: (prompt: string) => Promise<unknown>;
  readonly dispose: () => void;
};

type WorkCliDependencies = {
  readonly connectOwner?: (() => Promise<RuntimeOwnerClient>) | undefined;
  readonly loadInteractiveSession?: typeof loadWorkCliBootstrap | undefined;
  readonly startInteractiveSession?: typeof startRepl | undefined;
  readonly writeOutput?: ((text: string) => void) | undefined;
};

type WorkSessionLoadDependencies = {
  readonly loadSession?: typeof loadWorkCliBootstrap | undefined;
};

function workShellEntries(state: Readonly<Record<string, unknown>>): readonly {
  readonly role: string;
  readonly text: string;
}[] {
  if (!Array.isArray(state.entries)) return [];
  return state.entries.filter((entry): entry is { readonly role: string; readonly text: string } => (
    typeof entry === "object"
    && entry !== null
    && typeof (entry as { readonly role?: unknown }).role === "string"
    && typeof (entry as { readonly text?: unknown }).text === "string"
  ));
}

function hasPendingOwnerDecision(state: Readonly<Record<string, unknown>>): boolean {
  const agentConsole = state.agentConsole;
  return typeof agentConsole === "object"
    && agentConsole !== null
    && (agentConsole as { readonly pendingDecision?: unknown }).pendingDecision !== undefined;
}

function workShellPanelLines(state: Readonly<Record<string, unknown>>): readonly string[] {
  const panel = state.panel;
  if (typeof panel !== "object" || panel === null) return [];
  const lines = (panel as { readonly lines?: unknown }).lines;
  return Array.isArray(lines) ? lines.filter((line): line is string => typeof line === "string") : [];
}

function hasNewTerminalOwnerTurn(
  state: Readonly<Record<string, unknown>>,
  baseline: { readonly entryCount: number; readonly turnId?: string | undefined },
): boolean {
  const turnLifecycle = state.turnLifecycle;
  if (typeof turnLifecycle !== "object" || turnLifecycle === null) return false;
  const lifecycle = turnLifecycle as { readonly state?: unknown; readonly turnId?: unknown };
  if (lifecycle.state !== "completed" && lifecycle.state !== "cancelled") return false;
  return workShellEntries(state).length > baseline.entryCount
    || (typeof lifecycle.turnId === "string" && lifecycle.turnId !== baseline.turnId);
}

async function waitForOwnerPromptState(
  engine: RemotePromptEngine,
  prompt: string,
): Promise<Readonly<Record<string, unknown>>> {
  const initialState = engine.getState();
  const initialLifecycle = initialState.turnLifecycle;
  const baseline = {
    entryCount: workShellEntries(initialState).length,
    ...(typeof initialLifecycle === "object"
      && initialLifecycle !== null
      && typeof (initialLifecycle as { readonly turnId?: unknown }).turnId === "string"
      ? { turnId: (initialLifecycle as { readonly turnId: string }).turnId }
      : {}),
  };
  let submissionSettled = false;
  const submission = engine.handleSubmit(prompt).then(
    () => ({ kind: "submitted" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  ).finally(() => {
    submissionSettled = true;
  });
  let detachedAtOwnerState = false;
  try {
    while (true) {
      let pollTimer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        submission,
        new Promise<{ readonly kind: "poll" }>((resolve) => {
          pollTimer = setTimeout(() => resolve({ kind: "poll" }), 100);
          pollTimer.unref?.();
        }),
      ]);
      if (pollTimer) clearTimeout(pollTimer);
      if (outcome.kind === "failed") {
        try {
          await engine.initialize();
          const state = engine.getState();
          if (hasPendingOwnerDecision(state) || hasNewTerminalOwnerTurn(state, baseline)) {
            detachedAtOwnerState = true;
            return state;
          }
        } catch {
          // Preserve the submission failure when authoritative recovery is
          // unavailable; it is the operation the caller asked to perform.
        }
        throw outcome.error;
      }
      if (outcome.kind === "submitted") return engine.getState();

      await engine.initialize();
      const state = engine.getState();
      if (hasPendingOwnerDecision(state) || hasNewTerminalOwnerTurn(state, baseline)) {
        detachedAtOwnerState = true;
        return state;
      }
    }
  } finally {
    engine.dispose();
    if (!submissionSettled) {
      const outcome = await submission;
      if (!detachedAtOwnerState && outcome.kind === "failed") throw outcome.error;
    }
  }
}

async function runPromptThroughPersistentOwner(
  parsed: ParsedArgs & { readonly prompt: string },
  dependencies: WorkCliDependencies,
): Promise<void> {
  const client = await (dependencies.connectOwner ?? connectPersistentRuntimeOwner)();
  const sessionId = parsed.sessionId ?? `work-${randomUUID()}`;
  const created = await client.createRuntimeSession({
    sessionId,
    projectPath: parsed.cwd,
    ...(parsed.provider ? { provider: parsed.provider } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
    resume: parsed.sessionId !== undefined,
    idempotencyKey: `prompt-${randomUUID()}`,
  });
  if (!created.ok) throw new Error(created.message);
  const attached = await client.attachRuntimeSession(created.session.sessionId);
  if (!attached.ok) throw new Error(attached.message);

  const engine = await createRemoteWorkShellEngine(
    client,
    attached.session.sessionId,
  ) as RemotePromptEngine;
  const baselineEntryCount = workShellEntries(engine.getState()).length;
  const state = await waitForOwnerPromptState(engine, parsed.prompt);
  const transcriptLines = workShellEntries(state)
    .slice(baselineEntryCount)
    .filter((entry) => entry.role !== "user")
    .map((entry) => entry.text);
  const lines = transcriptLines.length > 0
    ? transcriptLines
    : hasPendingOwnerDecision(state)
      ? workShellPanelLines(state)
      : [];
  if (lines.length > 0) {
    (dependencies.writeOutput ?? ((text: string) => { process.stdout.write(text); }))(`${lines.join("\n")}\n`);
  }
}

function resolveSwitchedSession(
  session: ManagedDashboardSession,
  forwardedArgs: readonly string[],
): { readonly session: ManagedDashboardSession; readonly resume: boolean } {
  const parsed = parseArgs([...withWorkSessionCwd(forwardedArgs, session.options.cwd)]);
  if (parsed.prompt) throw new Error("Cannot open a prompt as an embedded Work session.");
  const sessionId = parsed.sessionId ?? `work-${randomUUID()}`;
  return {
    session: {
      agent: session.agent,
      options: {
        ...session.options,
        cwd: parsed.cwd,
        provider: parsed.provider ?? session.options.provider,
        model: parsed.model ?? session.options.model,
        reasoning: parsed.reasoning
          ? { ...session.options.reasoning, effort: parsed.reasoning, source: "override" }
          : session.options.reasoning,
        sessionId,
      },
    },
    resume: parsed.sessionId !== undefined,
  };
}

async function createAndAttachOwnerSession(
  client: RuntimeOwnerClient,
  session: ManagedDashboardSession,
  resume: boolean,
): Promise<string> {
  const sessionId = session.options.sessionId ?? `work-${randomUUID()}`;
  const created = await client.createRuntimeSession({
    sessionId,
    projectPath: session.options.cwd,
    provider: session.options.provider,
    model: session.options.model,
    ...(session.options.reasoning.effort !== "unsupported"
      ? { reasoning: session.options.reasoning.effort }
      : {}),
    resume,
    idempotencyKey: `tui-${randomUUID()}`,
  });
  if (!created.ok) throw new Error(created.message);
  const attached = await client.attachRuntimeSession(created.session.sessionId);
  if (!attached.ok) throw new Error(attached.message);
  return attached.session.sessionId;
}

async function reattachOwnerSession(
  client: RuntimeOwnerClient,
  session: ManagedDashboardSession,
): Promise<void> {
  const sessionId = session.options.sessionId;
  if (!sessionId) throw new Error("Remote Work session is missing an owner session id.");
  const attached = await client.attachRuntimeSession(sessionId);
  if (attached.ok) return;
  await createAndAttachOwnerSession(client, session, true);
}

export async function createPersistentOwnerWorkShellController(input: {
  readonly client: RuntimeOwnerClient;
  readonly session: ManagedDashboardSession;
  readonly resume?: boolean | undefined;
  readonly reconnectOwner: () => Promise<RuntimeOwnerClient>;
}): Promise<PersistentOwnerWorkShellController> {
  let activeClient = input.client;
  let disposed = false;
  const attachments = new Set<DisposableRemoteEngine>();
  const sessions = new Map<string, ManagedDashboardSession>();
  let embeddedWorkPane: Awaited<ReturnType<typeof createEmbeddedWorkPaneController<TuiShellHomeState>>>;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await embeddedWorkPane?.dispose?.();
    } finally {
      for (const attachment of attachments) attachment.dispose();
      attachments.clear();
    }
  };
  const createSnapshot = async (
    target: ManagedDashboardSession,
    resume: boolean,
  ): Promise<TuiRenderOptions<TuiShellHomeState>> => {
    if (disposed) throw new Error("Persistent owner Work controller is closed.");
    const ownerSessionId = await createAndAttachOwnerSession(activeClient, target, resume);
    const attachedSession: ManagedDashboardSession = {
      agent: target.agent,
      options: { ...target.options, sessionId: ownerSessionId },
    };
    sessions.set(ownerSessionId, attachedSession);
    const remoteEngine = await createRemoteWorkShellEngine(activeClient, ownerSessionId, {
      reconnect: async ({ sessionId, signal }) => {
        const replacement = await input.reconnectOwner();
        if (signal.aborted || disposed) {
          throw signal.reason ?? new Error("Remote Work attachment closed.");
        }
        const reconnectSession = sessions.get(sessionId);
        if (!reconnectSession) throw new Error("Remote Work session metadata is unavailable.");
        await reattachOwnerSession(replacement, reconnectSession);
        if (signal.aborted || disposed) {
          throw signal.reason ?? new Error("Remote Work attachment closed.");
        }
        activeClient = replacement;
        return replacement;
      },
    }) as DisposableRemoteEngine;
    attachments.add(remoteEngine);
    let snapshotDisposed = false;
    const disposeSnapshot = () => {
      if (snapshotDisposed) return;
      snapshotDisposed = true;
      attachments.delete(remoteEngine);
      remoteEngine.dispose();
    };
    return {
      ...createManagedDashboardProps(attachedSession, remoteEngine),
      dispose: disposeSnapshot,
    };
  };

  try {
    const initialProps = await createSnapshot(input.session, input.resume === true);
    embeddedWorkPane = await createEmbeddedWorkPaneController<TuiShellHomeState>({
      loadSnapshot: async (forwardedArgs = []) => {
        if (forwardedArgs.length === 0) return initialProps;
        const switched = resolveSwitchedSession(input.session, forwardedArgs);
        return createSnapshot(switched.session, switched.resume);
      },
    });
    if (!embeddedWorkPane) throw new Error("Remote Work pane failed to initialize.");
    return { initialProps, embeddedWorkPane, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function startRepl(
  agent: StartReplAgent,
  options: StartReplOptions,
): Promise<void> {
  const requestedSessionId = options.sessionId ?? `work-${randomUUID()}`;
  const session = withDefaultWorkSessionLaunch({
    agent,
    options: {
      ...options,
      sessionId: requestedSessionId,
    },
  });
  const client = await connectPersistentRuntimeOwner();
  const controller = await createPersistentOwnerWorkShellController({
    client,
    session,
    resume: options.sessionId !== undefined,
    reconnectOwner: connectPersistentRuntimeOwner,
  });
  try {
    await renderEmbeddedWorkShellPaneDashboard({
      ...controller.initialProps,
      ...controller.embeddedWorkPane,
    });
  } finally {
    await controller.dispose();
  }
}

export async function loadWorkShellDashboardProps(
  argv: readonly string[] = [],
  dependencies: WorkSessionLoadDependencies = {},
): Promise<EmbeddedWorkDashboardSnapshot<TuiShellHomeState>> {
  const session = await (dependencies.loadSession ?? loadWorkCliBootstrap)({ argv });
  try {
    if (session.prompt) {
      throw new Error("Cannot build work-shell dashboard props for prompt mode.");
    }

    const homeState = session.options.refreshHomeState
      ? await session.options.refreshHomeState()
      : session.options.homeState;
    return createManagedDashboardProps({
      ...session,
      options: {
        ...session.options,
        homeState,
      },
    });
  } catch (error) {
    await session.dispose?.();
    throw error;
  }
}

export async function smokeWorkShellRuntime(
  argv: readonly string[] = [],
  dependencies: WorkSessionLoadDependencies = {},
): Promise<readonly string[]> {
  const session = await (dependencies.loadSession ?? loadWorkCliBootstrap)({ argv });
  try {
    if (session.prompt) {
      throw new Error("Cannot smoke-test interactive TUI with a prompt.");
    }

    const input = createManagedDashboardInput(
      { agent: session.agent, options: {
        ...session.options,
        launchWorkSession:
          session.options.launchWorkSession ??
          ((forwardedArgs: readonly string[] = []) => runWorkCli(forwardedArgs)),
      } },
      {
        resolveWorkShellInlineCommand,
        ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
      },
    );
    const props = createManagedWorkShellDashboardProps(input);
    const lines = ["Work shell TUI smoke OK"];

    if (!props.renderWorkPane) {
      throw new Error("renderWorkPane is not connected.");
    }
    if (!props.runAction) {
      throw new Error("runAction is not connected.");
    }
    if (!props.runSession) {
      throw new Error("runSession is not connected.");
    }
    if (!props.launchWorkSession) {
      throw new Error("launchWorkSession is not connected.");
    }

    const mcpServerName = props.mcpServers?.[0]?.name;
    const mcpLines = await props.runAction({
      actionId: "mcp-inspect",
      ...(mcpServerName ? { prompt: mcpServerName } : {}),
    });
    if (!mcpLines.some((line) => /MCP server inspect|No MCP server selected/i.test(line))) {
      throw new Error("MCP inspect smoke did not return an inspect result.");
    }
    lines.push("MCP inspect action connected");

    const researchLines = await props.runAction({ actionId: "research-status" });
    if (!researchLines.some((line) => /Work context status|Context brief status|Latest context/i.test(line))) {
      throw new Error("Work context status smoke did not return a status result.");
    }
    lines.push("Work context status action connected");

    if (props.sessions?.[0]) {
      const resumeLines = await props.runSession(props.sessions[0].sessionId);
      if (!resumeLines.some((line) => /Resume|Resuming session|Workspace context|Context/i.test(line))) {
        throw new Error("History resume smoke did not return session context.");
      }
      lines.push("History resume action connected");
    } else {
      lines.push("History resume action connected (no saved sessions)");
    }

    return lines;
  } finally {
    await session.dispose?.();
  }
}

export async function runWorkCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: WorkCliDependencies = {},
): Promise<void> {
  const { showHelp, showTools } = parseArgs([...argv]);
  if (showHelp) {
    printHelp();
    return;
  }
  if (showTools) {
    printTools();
    return;
  }

  const parsed = parseArgs([...argv]);
  if (parsed.prompt) {
    await runPromptThroughPersistentOwner(
      { ...parsed, prompt: parsed.prompt },
      dependencies,
    );
    return;
  }

  const session = await (dependencies.loadInteractiveSession ?? loadWorkCliBootstrap)({ argv, role: "client" });
  try {
    await (dependencies.startInteractiveSession ?? startRepl)(session.agent, session.options);
  } finally {
    await session.dispose?.();
  }
}
