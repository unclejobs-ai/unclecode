/**
 * Bun-side OMP worker.
 *
 * UncleCode runs on Node and OMP ships as a Bun package (`@oh-my-pi/*`), whose
 * TypeScript sources Node cannot resolve. This module is therefore executed as
 * a Bun child process: it reads one JSON request on stdin, drives exactly one
 * OMP agent turn through OMP's own SDK — OMP's tool loop, OMP's credential
 * lookup, OMP's prompt cache — and writes one sentinel-prefixed JSON result
 * line to stdout. Only text, provenance, and token/cost counters cross the
 * boundary; provider payloads, transcript content, and credentials never do.
 *
 * Everything above {@link runOmpWorkerTurn} is pure and importable from Node,
 * so the Node adapter shares one wire contract with the worker and both sides
 * are testable without an OMP install.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findOmpInstall } from "./omp-install.js";
import {
  canonicalizeOmpWorkspaceRoot,
  createOmpWorkspaceTools,
} from "./omp-workspace-tools.js";

/** The single selector every work/executor turn runs on. Not overridable. */
export const OMP_WORKER_DEFAULT_MODEL = "kimi-code/k3";

/**
 * The delegated worker has no interactive path back to UncleCode's approval
 * bridge. Keep its ambient OMP registry closed and expose only workspace file
 * tools; shell, task, browser, MCP, and other externally acting tools must run
 * through an UncleCode-owned runtime instead.
 */
export const OMP_WORKER_ALLOWED_TOOLS = ["read", "write", "edit", "grep", "glob"] as const;

/**
 * Prefix for the worker's single result line: OMP writes its own diagnostics to
 * the same stdout, so the reader locates the result by sentinel.
 */
export const OMP_WORKER_RESULT_SENTINEL = "__unclecode_omp_worker_result__";

export const OMP_WORKER_ERROR_CODES = [
  "OMP_UNAVAILABLE",
  "OMP_AUTH_REQUIRED",
  "OMP_MODEL_UNAVAILABLE",
  "OMP_TURN_FAILED",
  "OMP_PROTOCOL_ERROR",
] as const;

export type OmpWorkerErrorCode = (typeof OMP_WORKER_ERROR_CODES)[number];

export type OmpWorkerRequest = {
  readonly prompt: string;
  readonly cwd: string;
  /** `<ompProvider>/<modelId>` selector, e.g. `kimi-code/k3`. */
  readonly model: string;
  /** UncleCode reasoning effort, or `"unsupported"`. */
  readonly reasoning: string;
};

/**
 * Token counters as OMP reports them. `inputTokens` is the non-cached input
 * bucket, disjoint from the cache buckets — the same convention UncleCode's
 * `ProviderTokenUsage` uses, so the mapping is a rename, not arithmetic.
 */
export type OmpWorkerUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
};

export type OmpWorkerSuccess = {
  readonly ok: true;
  readonly result: {
    readonly text: string;
    /** Upstream OMP provider that actually served the turn, e.g. `kimi-code`. */
    readonly provider: string;
    /** The selector the turn ran under, echoed back for trace provenance. */
    readonly model: string;
    readonly usage?: OmpWorkerUsage;
  };
};

export type OmpWorkerFailure = {
  readonly ok: false;
  readonly error: {
    readonly code: OmpWorkerErrorCode;
    readonly message: string;
  };
};

export type OmpWorkerResult = OmpWorkerSuccess | OmpWorkerFailure;

export class OmpWorkerError extends Error {
  public readonly code: OmpWorkerErrorCode;

  public constructor(code: OmpWorkerErrorCode, message: string) {
    super(message);
    this.name = "OmpWorkerError";
    this.code = code;
  }
}

/** OMP's per-response usage record; every field is optional defensively. */
export type OmpAssistantUsage = {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
  readonly cost?: { readonly total?: number | undefined } | undefined;
};

/**
 * The slice of OMP the worker drives. Injected so the turn logic is testable
 * from Node, where the real OMP modules cannot be imported.
 */
export type OmpWorkerRuntime = {
  createAuthStorage(): Promise<OmpAuthStorageHandle>;
  createModelRegistry(authStorage: OmpAuthStorageHandle): OmpModelRegistryHandle;
  createSessionManager(cwd: string): unknown;
  createSettings(cwd: string): Promise<unknown>;
  createWorkspaceTools(cwd: string): Promise<readonly unknown[]>;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: OmpWorkerSession }>;
};

export type OmpAuthStorageHandle = { close(): void };

export type OmpModelRegistryHandle = {
  find(providerId: string, modelId: string): unknown;
  hasConfiguredAuth(model: unknown): boolean;
};

export type OmpWorkerSession = {
  subscribe(listener: (event: { readonly type: string; readonly message?: unknown }) => void): unknown;
  prompt(text: string): Promise<unknown>;
  getLastAssistantMessage(): unknown;
  dispose(): Promise<void>;
};

type OmpSdkModule = {
  discoverAuthStorage(agentDir?: string): Promise<OmpAuthStorageHandle>;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: OmpWorkerSession }>;
};

type OmpModelRegistryModule = {
  ModelRegistry: new (authStorage: OmpAuthStorageHandle) => OmpModelRegistryHandle;
};

type OmpSessionManagerModule = {
  SessionManager: { inMemory(cwd?: string): unknown };
};

type OmpSettingsModule = {
  Settings: {
    loadIsolated(options: {
      readonly cwd: string;
      readonly overrides: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
  };
};

type OmpSchemaModule = {
  type(definition: Readonly<Record<string, unknown>>): unknown;
};

const OMP_THINKING_LEVELS: Readonly<Record<string, string>> = {
  unsupported: "off",
  none: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export function parseOmpWorkerRequest(raw: string): OmpWorkerRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new OmpWorkerError(
      "OMP_PROTOCOL_ERROR",
      `OMP worker request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new OmpWorkerError("OMP_PROTOCOL_ERROR", "OMP worker request must be a JSON object.");
  }
  const { prompt, cwd, model, reasoning } = parsed;
  if (typeof prompt !== "string") {
    throw new OmpWorkerError("OMP_PROTOCOL_ERROR", "OMP worker request is missing a string prompt.");
  }
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new OmpWorkerError("OMP_PROTOCOL_ERROR", "OMP worker request is missing a workspace cwd.");
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new OmpWorkerError("OMP_PROTOCOL_ERROR", "OMP worker request is missing a model selector.");
  }
  if (typeof reasoning !== "string" || !reasoning.trim()) {
    throw new OmpWorkerError("OMP_PROTOCOL_ERROR", "OMP worker request is missing a reasoning effort.");
  }
  return { prompt, cwd: cwd.trim(), model: model.trim(), reasoning: reasoning.trim() };
}

/**
 * Split an OMP selector. Model ids may themselves contain slashes
 * (`groq/openai/gpt-oss-20b`), so only the first separator is structural.
 */
export function parseOmpModelSelector(selector: string): {
  readonly providerId: string;
  readonly modelId: string;
} {
  const trimmed = selector.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new OmpWorkerError(
      "OMP_MODEL_UNAVAILABLE",
      `OMP model selector must be "<provider>/<model>", received "${trimmed}".`,
    );
  }
  return {
    providerId: trimmed.slice(0, separator),
    modelId: trimmed.slice(separator + 1),
  };
}

export function toOmpThinkingLevel(reasoning: string): string {
  const mapped = OMP_THINKING_LEVELS[reasoning];
  if (!mapped) {
    throw new OmpWorkerError("OMP_PROTOCOL_ERROR", `Unknown reasoning effort for OMP: "${reasoning}".`);
  }
  return mapped;
}

export function mapOmpUsage(usages: readonly OmpAssistantUsage[]): OmpWorkerUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  for (const usage of usages) {
    inputTokens += toCounter(usage.input);
    outputTokens += toCounter(usage.output);
    cacheReadTokens += toCounter(usage.cacheRead);
    cacheWriteTokens += toCounter(usage.cacheWrite);
    costUsd += toCounter(usage.cost?.total);
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
}

export function serializeOmpWorkerResult(result: OmpWorkerResult): string {
  return `${OMP_WORKER_RESULT_SENTINEL} ${JSON.stringify(result)}\n`;
}

/**
 * Recover the worker's result from a stdout stream that may also carry OMP's
 * own logging. The last sentinel line wins so a retried write cannot resurrect
 * a stale record.
 */
export function parseOmpWorkerResultLine(stdout: string): OmpWorkerResult {
  const prefix = `${OMP_WORKER_RESULT_SENTINEL} `;
  let payload: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      payload = trimmed.slice(prefix.length);
    }
  }
  if (payload === undefined) {
    throw new OmpWorkerError(
      "OMP_PROTOCOL_ERROR",
      "The OMP worker produced no result record on stdout.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch (error) {
    throw new OmpWorkerError(
      "OMP_PROTOCOL_ERROR",
      `The OMP worker result record is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseOmpWorkerResult(parsed);
}

export function parseOmpWorkerResult(value: unknown): OmpWorkerResult {
  if (!isRecord(value)) {
    throw new OmpWorkerError("OMP_PROTOCOL_ERROR", "The OMP worker result must be a JSON object.");
  }
  if (value.ok === false) {
    const error = value.error;
    if (!isRecord(error) || typeof error.message !== "string" || !isOmpWorkerErrorCode(error.code)) {
      throw new OmpWorkerError("OMP_PROTOCOL_ERROR", "The OMP worker reported an unrecognized failure shape.");
    }
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  const result = value.result;
  if (value.ok !== true || !isRecord(result)) {
    throw new OmpWorkerError("OMP_PROTOCOL_ERROR", "The OMP worker result is neither a success nor a failure.");
  }
  if (typeof result.text !== "string" || typeof result.provider !== "string" || typeof result.model !== "string") {
    throw new OmpWorkerError("OMP_PROTOCOL_ERROR", "The OMP worker success record is missing text/provider/model.");
  }
  const usage = isRecord(result.usage)
    ? {
        inputTokens: toCounter(result.usage.inputTokens),
        outputTokens: toCounter(result.usage.outputTokens),
        cacheReadTokens: toCounter(result.usage.cacheReadTokens),
        cacheWriteTokens: toCounter(result.usage.cacheWriteTokens),
        costUsd: toCounter(result.usage.costUsd),
      }
    : undefined;
  return {
    ok: true,
    result: {
      text: result.text,
      provider: result.provider,
      model: result.model,
      ...(usage ? { usage } : {}),
    },
  };
}

export function toOmpWorkerFailure(error: unknown): OmpWorkerFailure {
  const code = error instanceof OmpWorkerError ? error.code : "OMP_UNAVAILABLE";
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code, message } };
}

/**
 * Load OMP through Bun. Static imports cannot work here: `@oh-my-pi/pi-coding-agent`
 * is a global Bun install outside the repo's dependency graph, so its location
 * is only known at runtime and Node's resolver would fail the build.
 */
export async function loadOmpWorkerRuntime(env: NodeJS.ProcessEnv = process.env): Promise<OmpWorkerRuntime> {
  const install = findOmpInstall(env);
  if (!install) {
    throw new OmpWorkerError(
      "OMP_UNAVAILABLE",
      "OMP is not installed or could not be located; install `omp` or set UNCLECODE_OMP_BIN.",
    );
  }
  const sdk = await importOmpModule<OmpSdkModule>(install.packageRoot, "src/sdk.ts");
  const registry = await importOmpModule<OmpModelRegistryModule>(
    install.packageRoot,
    "src/config/model-registry.ts",
  );
  const sessions = await importOmpModule<OmpSessionManagerModule>(
    install.packageRoot,
    "src/session/session-manager.ts",
  );
  const settings = await importOmpModule<OmpSettingsModule>(
    install.packageRoot,
    "src/config/settings.ts",
  );
  const schemas = await importOmpAbsoluteModule<OmpSchemaModule>(
    path.join(install.scopeRoot, "omptype", "src", "index.ts"),
    "@oh-my-pi/omptype",
  );
  return {
    createAuthStorage: () => sdk.discoverAuthStorage(),
    createModelRegistry: (authStorage) => new registry.ModelRegistry(authStorage),
    createSessionManager: (cwd) => sessions.SessionManager.inMemory(cwd),
    createSettings: (cwd) => settings.Settings.loadIsolated({
      cwd,
      overrides: {
        "retry.modelFallback": false,
        "retry.usageAwareFallback": false,
        "retry.fallbackChains": {},
        // Reads and workspace file edits remain useful to executor agents. No
        // exec-tier tool is registered below, so a future approval-mode default
        // cannot silently restore shell or external-write authority.
        "tools.approvalMode": "write",
      },
    }),
    createWorkspaceTools: async (cwd) => createOmpWorkspaceTools(cwd, schemas.type),
    createAgentSession: (options) => sdk.createAgentSession(options),
  };
}

/**
 * Run one OMP turn. OMP owns the restricted workspace-file loop, credentials,
 * and prompt caching; external execution remains outside this worker boundary.
 */
export async function runOmpWorkerTurn(
  request: OmpWorkerRequest,
  runtime: OmpWorkerRuntime,
): Promise<OmpWorkerSuccess> {
  const workspaceRoot = await canonicalizeOmpWorkspaceRoot(request.cwd);
  const selector = parseOmpModelSelector(request.model);
  const thinkingLevel = toOmpThinkingLevel(request.reasoning);
  const authStorage = await runtime.createAuthStorage();
  let session: OmpWorkerSession | undefined;
  try {
    const modelRegistry = runtime.createModelRegistry(authStorage);
    const model = modelRegistry.find(selector.providerId, selector.modelId);
    if (!model) {
      throw new OmpWorkerError(
        "OMP_MODEL_UNAVAILABLE",
        `OMP does not expose a model for selector "${request.model}".`,
      );
    }
    if (!modelRegistry.hasConfiguredAuth(model)) {
      throw new OmpWorkerError(
        "OMP_AUTH_REQUIRED",
        `OMP has no credential configured for provider "${selector.providerId}"; sign in with OMP first.`,
      );
    }
    const created = await runtime.createAgentSession({
      cwd: workspaceRoot,
      model,
      authStorage,
      modelRegistry,
      sessionManager: runtime.createSessionManager(workspaceRoot),
      settings: await runtime.createSettings(workspaceRoot),
      thinkingLevel,
      enableMCP: false,
      disableExtensionDiscovery: true,
      skills: [],
      toolNames: [...OMP_WORKER_ALLOWED_TOOLS],
      restrictToolNames: true,
      allowRestrictedCustomTools: true,
      customTools: await runtime.createWorkspaceTools(workspaceRoot),
      autoApprove: false,
    });
    session = created.session;

    // OMP's loop can span many assistant responses and usage is reported per
    // response, so the turn's real cache spend only exists as their sum.
    const usages: OmpAssistantUsage[] = [];
    session.subscribe((event) => {
      if (event.type !== "message_end") return;
      const message = event.message;
      if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return;
      usages.push(message.usage as OmpAssistantUsage);
    });

    await session.prompt(request.prompt);

    const last = session.getLastAssistantMessage();
    if (!isRecord(last)) {
      throw new OmpWorkerError("OMP_TURN_FAILED", "The OMP turn produced no assistant message.");
    }
    if (last.stopReason === "error" || last.stopReason === "aborted") {
      const detail = typeof last.errorMessage === "string" && last.errorMessage.trim()
        ? last.errorMessage.trim()
        : `stopReason=${String(last.stopReason)}`;
      throw new OmpWorkerError("OMP_TURN_FAILED", `The OMP turn did not complete: ${detail}`);
    }
    const usage = mapOmpUsage(usages);
    const reportedUsage = usage.inputTokens > 0
      || usage.outputTokens > 0
      || usage.cacheReadTokens > 0
      || usage.cacheWriteTokens > 0
      || usage.costUsd > 0;
    return {
      ok: true,
      result: {
        text: readAssistantText(last),
        provider: typeof last.provider === "string" ? last.provider : selector.providerId,
        model: request.model,
        ...(reportedUsage ? { usage } : {}),
      },
    };
  } finally {
    if (session) await session.dispose();
    authStorage.close();
  }
}

/**
 * Whole worker invocation: stdin text in, one serialized result line out.
 * Failures are in-band so the caller never has to guess from an exit code.
 */
export async function runOmpWorkerMain(input: {
  readonly stdin: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly loadRuntime?: (() => Promise<OmpWorkerRuntime>) | undefined;
}): Promise<string> {
  try {
    const request = parseOmpWorkerRequest(input.stdin);
    const loadRuntime = input.loadRuntime ?? (() => loadOmpWorkerRuntime(input.env ?? process.env));
    return serializeOmpWorkerResult(await runOmpWorkerTurn(request, await loadRuntime()));
  } catch (error) {
    return serializeOmpWorkerResult(toOmpWorkerFailure(error));
  }
}

export function isOmpWorkerDirectExecution(argv: readonly string[]): boolean {
  const entry = argv[1];
  return Boolean(entry) && path.resolve(entry as string) === fileURLToPath(import.meta.url);
}

async function importOmpModule<T>(packageRoot: string, relativePath: string): Promise<T> {
  // Runtime-selected specifier: see loadOmpWorkerRuntime.
  const specifier = pathToFileURL(path.join(packageRoot, relativePath)).href;
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    throw new OmpWorkerError(
      "OMP_UNAVAILABLE",
      `Failed to load OMP module "${relativePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function importOmpAbsoluteModule<T>(absolutePath: string, label: string): Promise<T> {
  try {
    return (await import(pathToFileURL(absolutePath).href)) as T;
  } catch (error) {
    throw new OmpWorkerError(
      "OMP_UNAVAILABLE",
      `Failed to load OMP module "${label}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readAssistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  const blocks: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      blocks.push(block.text);
    }
  }
  return blocks.join("").trim();
}

/** Absent, non-numeric, non-finite, and negative counters are all provider noise. */
function toCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isOmpWorkerErrorCode(value: unknown): value is OmpWorkerErrorCode {
  return typeof value === "string" && (OMP_WORKER_ERROR_CODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Promise-chained rather than top-level `await`: this module is re-exported from
// the providers barrel, and TLA would make every importer an async module.
if (isOmpWorkerDirectExecution(process.argv)) {
  void readAllStdin()
    .then((stdin) => runOmpWorkerMain({ stdin }))
    .catch((error: unknown) => serializeOmpWorkerResult(toOmpWorkerFailure(error)))
    .then((line) => {
      process.stdout.write(line);
    });
}
