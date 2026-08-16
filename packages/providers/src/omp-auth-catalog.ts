/**
 * Node-side client for the OMP OAuth provider catalog.
 *
 * The provider list is never copied into this repo. It is read from OMP's own
 * `getOAuthProviders()` and joined against the auth storage OMP's SDK
 * discovers for itself (`discoverAuthStorage()` — the same authority the work
 * executor authenticates through), in a Bun child process
 * (`omp-auth-catalog-worker.ts`) because `@oh-my-pi/*` is a Bun package Node
 * cannot resolve. Failures surface as stable codes so the UI can say "OMP
 * unavailable" or "catalog unavailable" instead of rendering an empty catalog
 * that looks like "no providers exist".
 *
 * Rows are display-safe by construction. The parser whitelists six fields *and*
 * normalizes every one of them here, at the Node boundary, before the TUI ever
 * sees them: terminal escapes and control characters are stripped, lengths are
 * bounded, ids and credential aliases must be slugs, `originEnvVar` must be an
 * environment identifier, and credential-shaped runs are redacted. A field that
 * cannot be normalized is dropped (optional) or fails its row (required), so a
 * compromised OMP catalog can neither drive the terminal nor smuggle a token
 * through a whitelisted field. `originEnvVar` is a variable *name*, never its
 * value.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { findOmpInstall, resolveBunExecutable } from "./omp-install.js";

const execFileAsync = promisify(execFile);

/** Cascade leg that supplies a provider's active credential, per OMP's `AuthStorage`. */
export type OmpCredentialOriginKind = "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";

const ORIGIN_KINDS: readonly OmpCredentialOriginKind[] = [
  "runtime",
  "config",
  "oauth",
  "api_key",
  "env",
  "fallback",
];

/** One OMP OAuth provider, reduced to what a picker may safely render. */
export type OmpAuthProviderRow = {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  /** OMP's own credential aliasing (e.g. `zai-coding-plan` stores as `zai`). */
  readonly storeCredentialsAs?: string;
  /** The key OMP actually looks credentials up under: `storeCredentialsAs ?? id`. */
  readonly credentialKey: string;
  readonly signedIn: boolean;
  readonly originKind?: OmpCredentialOriginKind;
  /** Env var NAME when `originKind === "env"`. Never a value. */
  readonly originEnvVar?: string;
};

export type OmpAuthCatalogErrorCode =
  | "OMP_UNAVAILABLE"
  | "OMP_CATALOG_UNAVAILABLE"
  | "OMP_PROTOCOL_ERROR";

const CATALOG_ERROR_CODES: readonly OmpAuthCatalogErrorCode[] = [
  "OMP_UNAVAILABLE",
  "OMP_CATALOG_UNAVAILABLE",
  "OMP_PROTOCOL_ERROR",
];

export type OmpAuthCatalogResult =
  | { readonly ok: true; readonly dbPath: string; readonly providers: readonly OmpAuthProviderRow[] }
  | { readonly ok: false; readonly error: { readonly code: OmpAuthCatalogErrorCode; readonly message: string } };

export type OmpAuthSignInHandoff =
  | { readonly ok: true; readonly binPath: string; readonly argv: readonly string[]; readonly command: string }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "OMP_UNAVAILABLE" | "OMP_SIGN_IN_UNAVAILABLE";
        readonly message: string;
      };
    };

/**
 * Injection seam so tests never spawn Bun.
 *
 * `env` is the environment the catalog resolved its OMP install from, and it is
 * the environment the Bun child must run under: OMP's directory resolver reads
 * `OMP_PROFILE`/`PI_CODING_AGENT_DIR` and its broker resolver reads
 * `OMP_AUTH_BROKER_*` at module load in that child. Inheriting the ambient
 * `process.env` instead would let the picker read a different profile than the
 * executor authenticates against.
 */
export type OmpAuthCatalogRunner = (input: {
  readonly bunPath: string;
  readonly workerPath: string;
  readonly scopeRoot: string;
  readonly packageRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}) => Promise<string>;

export type OmpAuthCatalogOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: OmpAuthCatalogRunner;
  readonly timeoutMs?: number;
};

export type OmpAuthCatalogClient = {
  list(): Promise<OmpAuthCatalogResult>;
  signIn(providerId: string): Promise<OmpAuthSignInHandoff>;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Bounds for the whitelisted display fields. OMP's own provider ids top out
 * around twenty characters and its env var names around twenty-five, so these
 * are generous for real data and hostile to a pasted credential.
 */
const SLUG_MAX_LENGTH = 64;
const ENV_NAME_MAX_LENGTH = 64;
const DISPLAY_NAME_MAX_LENGTH = 120;
const DB_PATH_MAX_LENGTH = 512;
const MESSAGE_MAX_LENGTH = 400;

const REDACTED = "…redacted…";
const TRUNCATION_MARK = "…";

/**
 * A 24+ character run with no separator is credential-shaped, and OMP error
 * strings and provider names can quote one. Paths and prose never reach that
 * length between separators, so redacting the run keeps the text diagnostic.
 */
const TOKEN_SHAPED_RUN = /[A-Za-z0-9_-]{24,}/g;
/**
 * The same threshold over letters and digits only, for fields validated as
 * identifiers. Separators are structural there — the longest word inside a real
 * provider id or env var name is about a dozen characters — so an unbroken
 * alphanumeric run of this length is a credential, not an identifier.
 * Deliberately non-global: `.test()` on a global regex carries `lastIndex`
 * between calls and would skip every other value.
 */
const SECRET_SHAPED_RUN = /[A-Za-z0-9]{24,}/;

/**
 * CSI, OSC, and two-character escape sequences, removed whole so no payload
 * survives as visible text once the lone `ESC` is stripped below.
 */
const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -\/]*[@-~]|\][\s\S]*?(?:\u0007|\u001B\\|$)|[@-Z\\-_])/g;
/** Anything a terminal would treat as the start of a new line, folded to a space. */
const LINE_BREAK = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
/** C0, DEL, and C1: invisible to a reader, meaningful to a terminal. */
const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/g;
const REPEATED_SPACE = / {2,}/g;

/** Provider ids and credential aliases OMP accepts: separator-joined lowercase slugs. */
const SLUG_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
/** A POSIX environment identifier — the only thing `originEnvVar` may ever be. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Normalize one free-text display field. Ordinary Unicode survives untouched —
 * `Z.AI (GLM Coding Plan · Sign in)` renders exactly as OMP spells it — while
 * escapes, control characters, credential-shaped runs, and unbounded length do
 * not.
 */
function sanitizeDisplayText(value: string, maxLength: number): string {
  const flattened = value
    .replace(ANSI_SEQUENCE, "")
    .replace(LINE_BREAK, " ")
    .replace(CONTROL_CHAR, "")
    .replace(TOKEN_SHAPED_RUN, REDACTED)
    .replace(REPEATED_SPACE, " ")
    .trim();
  return flattened.length > maxLength
    ? `${flattened.slice(0, maxLength - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`
    : flattened;
}

/** Returns undefined — never a mangled value — when the input is not a slug. */
function sanitizeSlug(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > SLUG_MAX_LENGTH) {
    return undefined;
  }
  if (!SLUG_PATTERN.test(candidate) || SECRET_SHAPED_RUN.test(candidate)) {
    return undefined;
  }
  return candidate;
}

/** Returns undefined when the input is not an environment variable *name*. */
function sanitizeEnvName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > ENV_NAME_MAX_LENGTH) {
    return undefined;
  }
  if (!ENV_NAME_PATTERN.test(candidate) || SECRET_SHAPED_RUN.test(candidate)) {
    return undefined;
  }
  return candidate;
}

function protocolError(message: string): OmpAuthCatalogResult {
  return { ok: false, error: { code: "OMP_PROTOCOL_ERROR", message } };
}

function readField(source: unknown, field: string): unknown {
  if (typeof source !== "object" || source === null || !(field in source)) {
    return undefined;
  }
  return Reflect.get(source, field);
}

function toProviderRow(entry: unknown): OmpAuthProviderRow | undefined {
  // The id is the login target and the row's identity; an unusable one makes
  // the whole row unusable, so the row is dropped rather than repaired.
  const id = sanitizeSlug(readField(entry, "id"));
  if (!id) {
    return undefined;
  }
  const alias = sanitizeSlug(readField(entry, "storeCredentialsAs"));
  const rawName = readField(entry, "name");
  const name = typeof rawName === "string"
    ? sanitizeDisplayText(rawName, DISPLAY_NAME_MAX_LENGTH)
    : "";
  const origin = readField(entry, "origin");
  const originKindRaw = readField(origin, "kind");
  const originKind = ORIGIN_KINDS.find((candidate) => candidate === originKindRaw);
  const originEnvVar = originKind === "env" ? sanitizeEnvName(readField(origin, "envVar")) : undefined;

  return {
    id,
    name: name.length > 0 ? name : id,
    available: readField(entry, "available") !== false,
    ...(alias ? { storeCredentialsAs: alias } : {}),
    credentialKey: alias ?? id,
    signedIn: readField(entry, "configured") === true,
    ...(originKind ? { originKind } : {}),
    ...(originEnvVar ? { originEnvVar } : {}),
  };
}

/**
 * Parses one worker stdout blob into a catalog result.
 *
 * Bun can print warnings before the envelope, so the last non-empty line wins.
 * Exported for the contract tests — this is the whole redaction, normalization,
 * and whitelisting surface between OMP's shapes and the UI.
 */
export function parseOmpAuthCatalogPayload(raw: string): OmpAuthCatalogResult {
  const line = raw
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .at(-1);
  if (!line) {
    return protocolError("OMP catalog worker produced no output");
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(line);
  } catch {
    return protocolError("OMP catalog worker output was not JSON");
  }

  const ok = readField(envelope, "ok");
  if (ok === false) {
    const error = readField(envelope, "error");
    const rawCode = readField(error, "code");
    const code = CATALOG_ERROR_CODES.find((candidate) => candidate === rawCode);
    const message = readField(error, "message");
    if (!code) {
      return protocolError("OMP catalog worker reported an unknown failure code");
    }
    return {
      ok: false,
      error: {
        code,
        message: sanitizeDisplayText(typeof message === "string" ? message : "", MESSAGE_MAX_LENGTH),
      },
    };
  }
  if (ok !== true) {
    return protocolError("OMP catalog worker output was not a result envelope");
  }

  const result = readField(envelope, "result");
  const rawDbPath = readField(result, "dbPath");
  const providers = readField(result, "providers");
  if (typeof rawDbPath !== "string" || !Array.isArray(providers)) {
    return protocolError("OMP catalog worker returned an incomplete result");
  }
  const dbPath = sanitizeDisplayText(rawDbPath, DB_PATH_MAX_LENGTH);
  if (dbPath.length === 0) {
    return protocolError("OMP catalog worker returned an incomplete result");
  }

  const rows: OmpAuthProviderRow[] = [];
  for (const entry of providers) {
    const row = toProviderRow(entry);
    if (row) {
      rows.push(row);
    }
  }
  return { ok: true, dbPath, providers: rows };
}

/**
 * The Bun helper sits beside this module in whichever tree is loaded — `src`
 * under tsx/`--conditions=source`, `dist` once built — so it inherits this
 * module's own extension. Bun runs either one.
 */
export function resolveOmpAuthCatalogWorkerPath(moduleUrl: string = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  return path.join(
    path.dirname(modulePath),
    `omp-auth-catalog-worker${path.extname(modulePath)}`,
  );
}

const spawnBunWorker: OmpAuthCatalogRunner = async (input) => {
  const { stdout } = await execFileAsync(
    input.bunPath,
    [input.workerPath, input.scopeRoot, input.packageRoot],
    { timeout: input.timeoutMs, maxBuffer: 4 * 1024 * 1024, env: input.env },
  );
  return stdout;
};

export async function loadOmpAuthCatalog(
  options: OmpAuthCatalogOptions = {},
): Promise<OmpAuthCatalogResult> {
  const env = options.env ?? process.env;
  const install = findOmpInstall(env);
  if (!install) {
    return {
      ok: false,
      error: {
        code: "OMP_UNAVAILABLE",
        message: "omp executable not found on PATH (set UNCLECODE_OMP_BIN to override)",
      },
    };
  }

  const run = options.run ?? spawnBunWorker;
  try {
    const stdout = await run({
      bunPath: resolveBunExecutable(env),
      workerPath: resolveOmpAuthCatalogWorkerPath(),
      scopeRoot: install.scopeRoot,
      packageRoot: install.packageRoot,
      env,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return parseOmpAuthCatalogPayload(stdout);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "OMP_CATALOG_UNAVAILABLE",
        message: sanitizeDisplayText(
          error instanceof Error ? error.message : String(error),
          MESSAGE_MAX_LENGTH,
        ),
      },
    };
  }
}

/**
 * OAuth login owns the terminal (browser redirect, device code prompts), which
 * an Ink render loop cannot safely hand over mid-frame. So the picker never
 * pretends to sign anyone in: it reports the exact OMP-owned command to run.
 */
export function resolveOmpSignInHandoff(
  providerId: string,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): OmpAuthSignInHandoff {
  const install = findOmpInstall(options.env ?? process.env);
  if (!install) {
    return {
      ok: false,
      error: {
        code: "OMP_UNAVAILABLE",
        message: "omp executable not found on PATH (set UNCLECODE_OMP_BIN to override)",
      },
    };
  }
  const id = sanitizeSlug(providerId);
  if (!id) {
    return {
      ok: false,
      error: {
        code: "OMP_SIGN_IN_UNAVAILABLE",
        message: `"${sanitizeDisplayText(providerId, MESSAGE_MAX_LENGTH)}" is not an OMP provider id`,
      },
    };
  }
  const argv = ["auth-broker", "login", id];
  return { ok: true, binPath: install.binPath, argv, command: `omp ${argv.join(" ")}` };
}

export function createOmpAuthCatalogClient(
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): OmpAuthCatalogClient {
  return {
    list: () => loadOmpAuthCatalog(options.env ? { env: options.env } : {}),
    signIn: async (providerId) => resolveOmpSignInHandoff(providerId, options),
  };
}
