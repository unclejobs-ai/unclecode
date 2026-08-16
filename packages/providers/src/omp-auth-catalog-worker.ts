/**
 * Bun-side OMP auth catalog reader.
 *
 * Usage: `bun <this file> <scopeRoot> <packageRoot>`, where `scopeRoot` is the
 * installed `@oh-my-pi` directory and `packageRoot` is the `pi-coding-agent`
 * package inside it (see `omp-install.ts`).
 *
 * OMP is a Bun package; Node cannot resolve `@oh-my-pi/*`. This file runs only
 * under Bun, imports OMP's own sources, and asks OMP itself which OAuth
 * providers exist (`getOAuthProviders()`) and which of them have credentials.
 * The credential question goes through the SDK's `discoverAuthStorage()` — the
 * exact authority `omp-worker-entry.ts` authenticates the executor with — so
 * the picker and the executor share one set of auth semantics: the auth broker
 * when one is configured, OMP config overrides, the local `agent.db`, and the
 * env fallback resolver, in OMP's own precedence. Constructing `AuthStorage`
 * over `agent.db` directly would see only the last of those.
 *
 * Nothing here reads a credential value — only whether one exists, which
 * cascade leg supplied it, and the env-var *name* when that leg is env.
 *
 * Exactly one JSON envelope is written to stdout. Failures are envelopes too,
 * so the Node client can distinguish "OMP said no" from "the process died".
 * It deliberately has no `@unclecode/*` imports: the Bun boundary must stay a
 * cold start of OMP's modules and nothing else. The OMP imports are dynamic and
 * the run is guarded by an argv check so Node can import this module's pure
 * halves — `buildOmpAuthCatalog`, `runOmpAuthCatalogWorkerMain` — under test.
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Cascade legs OMP reports from `AuthStorage.getCredentialOrigin()`. */
const ORIGIN_KINDS = ["runtime", "config", "oauth", "api_key", "env", "fallback"] as const;

type OriginKind = (typeof ORIGIN_KINDS)[number];

export type OmpAuthCatalogWorkerRow = {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly storeCredentialsAs?: string;
  readonly configured: boolean;
  readonly origin?: { readonly kind: OriginKind; readonly envVar?: string };
};

export type OmpAuthCatalogWorkerErrorCode = "OMP_UNAVAILABLE" | "OMP_CATALOG_UNAVAILABLE";

export type OmpAuthCatalogWorkerEnvelope =
  | {
      readonly ok: true;
      readonly result: { readonly dbPath: string; readonly providers: readonly OmpAuthCatalogWorkerRow[] };
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: OmpAuthCatalogWorkerErrorCode; readonly message: string };
    };

/**
 * The slice of OMP's discovered `AuthStorage` the catalog uses. Both methods
 * answer questions *about* a credential; neither returns one.
 */
export type OmpAuthCatalogStorage = {
  hasAuth(provider: string): boolean;
  getCredentialOrigin(provider: string): unknown;
  close?(): void;
};

/**
 * The slice of OMP the catalog drives. Injected so the join logic is testable
 * from Node, where the real OMP modules cannot be imported.
 */
export type OmpAuthCatalogRuntime = {
  getAgentDbPath(): string;
  getOAuthProviders(): unknown;
  discoverAuthStorage(): Promise<OmpAuthCatalogStorage>;
};

export class OmpAuthCatalogWorkerError extends Error {
  readonly code: OmpAuthCatalogWorkerErrorCode;

  constructor(code: OmpAuthCatalogWorkerErrorCode, message: string) {
    super(message);
    this.name = "OmpAuthCatalogWorkerError";
    this.code = code;
  }
}

type OmpSdkModule = {
  discoverAuthStorage(agentDir?: string): Promise<OmpAuthCatalogStorage>;
};

type OmpOAuthRegistryModule = {
  getOAuthProviders(): unknown;
};

type OmpDirsModule = {
  getAgentDbPath(agentDir?: string): string;
};

/**
 * OMP's provider entries have no published Node types in this workspace, so
 * every value that crosses the boundary is narrowed here instead of asserted. A
 * field that fails to narrow is dropped: a missing row is honest, a fabricated
 * one is not. Display-level normalization (escapes, bounds, slug and env-name
 * validation, redaction) is the Node parser's job in `omp-auth-catalog.ts`.
 */
function readStringField(source: unknown, field: string): string | undefined {
  if (typeof source !== "object" || source === null || !(field in source)) {
    return undefined;
  }
  const value: unknown = Reflect.get(source, field);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Join OMP's OAuth provider list against the auth storage OMP discovered for
 * itself. Throws so the caller can turn any failure into one envelope.
 */
export async function buildOmpAuthCatalog(
  runtime: OmpAuthCatalogRuntime,
): Promise<OmpAuthCatalogWorkerEnvelope> {
  const dbPath: unknown = runtime.getAgentDbPath();
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    throw new OmpAuthCatalogWorkerError(
      "OMP_CATALOG_UNAVAILABLE",
      "OMP getAgentDbPath() did not return a path",
    );
  }

  const listed: unknown = runtime.getOAuthProviders();
  if (!Array.isArray(listed)) {
    throw new OmpAuthCatalogWorkerError(
      "OMP_CATALOG_UNAVAILABLE",
      "OMP getOAuthProviders() did not return a list",
    );
  }

  // Discovery reloads the store (broker snapshot or SQLite) before it returns,
  // so the rows below read a store OMP itself considers current.
  const storage = await runtime.discoverAuthStorage();
  try {
    const providers: OmpAuthCatalogWorkerRow[] = [];
    for (const entry of listed) {
      const id = readStringField(entry, "id");
      if (!id) {
        continue;
      }
      const storeCredentialsAs = readStringField(entry, "storeCredentialsAs");
      const credentialKey = storeCredentialsAs ?? id;
      const available: unknown = typeof entry === "object" && entry !== null && "available" in entry
        ? Reflect.get(entry, "available")
        : true;
      const rawOrigin: unknown = storage.getCredentialOrigin(credentialKey);
      const originKind = ORIGIN_KINDS.find((candidate) => candidate === readStringField(rawOrigin, "kind"));
      const envVar = originKind === "env" ? readStringField(rawOrigin, "envVar") : undefined;
      providers.push({
        id,
        name: readStringField(entry, "name") ?? id,
        available: available !== false,
        ...(storeCredentialsAs ? { storeCredentialsAs } : {}),
        configured: storage.hasAuth(credentialKey) === true,
        ...(originKind ? { origin: { kind: originKind, ...(envVar ? { envVar } : {}) } } : {}),
      });
    }
    return { ok: true, result: { dbPath, providers } };
  } finally {
    // A broker-backed storage may not own a handle; closing is best effort.
    if (typeof storage.close === "function") {
      try {
        storage.close();
      } catch {
        /* the envelope is already decided; a failed close must not replace it */
      }
    }
  }
}

/**
 * Load OMP through Bun. Static imports cannot work here: `@oh-my-pi/*` is a
 * global Bun install outside the repo's dependency graph, so its location is
 * only known at runtime and Node's resolver would fail the build.
 */
export async function loadOmpAuthCatalogRuntime(input: {
  readonly scopeRoot: string;
  readonly packageRoot: string;
}): Promise<OmpAuthCatalogRuntime> {
  const sdk = await importOmpModule<OmpSdkModule>(input.packageRoot, "src/sdk.ts");
  const oauth = await importOmpModule<OmpOAuthRegistryModule>(
    input.scopeRoot,
    "pi-ai/src/registry/oauth/index.ts",
  );
  const dirs = await importOmpModule<OmpDirsModule>(input.scopeRoot, "pi-utils/src/index.ts");
  if (
    typeof sdk.discoverAuthStorage !== "function"
    || typeof oauth.getOAuthProviders !== "function"
    || typeof dirs.getAgentDbPath !== "function"
  ) {
    throw new OmpAuthCatalogWorkerError(
      "OMP_UNAVAILABLE",
      "OMP discoverAuthStorage/getOAuthProviders/getAgentDbPath are unavailable",
    );
  }
  return {
    getAgentDbPath: () => dirs.getAgentDbPath(),
    getOAuthProviders: () => oauth.getOAuthProviders(),
    discoverAuthStorage: () => sdk.discoverAuthStorage(),
  };
}

export function serializeOmpAuthCatalogEnvelope(envelope: OmpAuthCatalogWorkerEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

/**
 * Whole worker invocation: install roots in, one serialized envelope out.
 * Failures are in-band so the Node client never has to guess from an exit code.
 */
export async function runOmpAuthCatalogWorkerMain(input: {
  readonly scopeRoot?: string | undefined;
  readonly packageRoot?: string | undefined;
  readonly loadRuntime?: (() => Promise<OmpAuthCatalogRuntime>) | undefined;
}): Promise<string> {
  try {
    let loadRuntime = input.loadRuntime;
    if (!loadRuntime) {
      const { scopeRoot, packageRoot } = input;
      if (!scopeRoot || !packageRoot) {
        throw new OmpAuthCatalogWorkerError(
          "OMP_UNAVAILABLE",
          "no @oh-my-pi scope root and package root were supplied",
        );
      }
      loadRuntime = () => loadOmpAuthCatalogRuntime({ scopeRoot, packageRoot });
    }
    return serializeOmpAuthCatalogEnvelope(await buildOmpAuthCatalog(await loadRuntime()));
  } catch (error) {
    return serializeOmpAuthCatalogEnvelope({
      ok: false,
      error: {
        code: error instanceof OmpAuthCatalogWorkerError ? error.code : "OMP_CATALOG_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export function isOmpAuthCatalogWorkerDirectExecution(argv: readonly string[]): boolean {
  const entry = argv[1];
  return Boolean(entry) && path.resolve(entry as string) === fileURLToPath(import.meta.url);
}

async function importOmpModule<T>(root: string, relativePath: string): Promise<T> {
  // Runtime-selected specifier: see loadOmpAuthCatalogRuntime.
  const specifier = pathToFileURL(path.join(root, relativePath)).href;
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    throw new OmpAuthCatalogWorkerError(
      "OMP_UNAVAILABLE",
      `Failed to load OMP module "${relativePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Promise-chained rather than top-level `await`: the pure halves above are
// imported from Node under test, and TLA would make every importer async.
if (isOmpAuthCatalogWorkerDirectExecution(process.argv)) {
  void runOmpAuthCatalogWorkerMain({
    scopeRoot: process.argv[2],
    packageRoot: process.argv[3],
  }).then((line) => {
    process.stdout.write(line);
  });
}
