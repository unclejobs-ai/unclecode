import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open as openFile, unlink as unlinkFile, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  Models,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export const CODEX_PI_PROVIDER_ID = "openai-codex";
const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 60_000;
const LOCK_STALE_MS = 5 * 60_000;


type CodexAuthFile = {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  [key: string]: unknown;
};

export function resolveCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.UNCLECODE_OPENAI_CREDENTIALS_PATH?.trim();
  if (explicit) return explicit;
  return path.join(env.HOME ?? homedir(), ".codex", "auth.json");
}

function decodeJwtExpiryMs(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof decoded === "object" && decoded !== null && "exp" in decoded) {
      const exp = (decoded as { exp?: unknown }).exp;
      if (typeof exp === "number") return exp * 1000;
    }
  } catch {
    return 0;
  }
  return 0;
}
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}


export class CodexCredentialStore implements CredentialStore {
  constructor(private readonly authPath: string) {}
  private get lockPath(): string {
    return `${this.authPath}.lock`;
  }

  private lockIsStale(): boolean {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.lockPath, "utf8"));
      const pid = typeof parsed === "object" && parsed !== null && "pid" in parsed ? parsed.pid : undefined;
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
        if (!processIsAlive(pid)) return true;
      }
      return Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      try {
        return Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        return false;
      }
    }
  }

  private async acquireLock(): Promise<FileHandle> {
    mkdirSync(path.dirname(this.authPath), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      let handle: FileHandle;
      try {
        handle = await openFile(this.lockPath, "wx", 0o600);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        if (this.lockIsStale()) {
          throw new Error(
            `The Codex credential lock is stale: ${this.lockPath}. Remove it after confirming no Codex process is refreshing credentials.`,
          );
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for the Codex credential lock: ${this.lockPath}`);
        }
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        return handle;
      } catch (error) {
        await handle.close();
        try {
          await unlinkFile(this.lockPath);
        } catch (unlinkError) {
          if (errorCode(unlinkError) !== "ENOENT") {
            throw new AggregateError([error, unlinkError], "Failed to initialize the Codex credential lock");
          }
        }
        throw error;
      }
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const handle = await this.acquireLock();
    try {
      return await fn();
    } finally {
      await handle.close();
      try {
        await unlinkFile(this.lockPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }


  private readFile(): CodexAuthFile | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.authPath, "utf8")) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as CodexAuthFile) : undefined;
    } catch {
      return undefined;
    }
  }

  private writeFileAtomically(next: CodexAuthFile): void {
    mkdirSync(path.dirname(this.authPath), { recursive: true });
    const temporaryPath = `${this.authPath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.authPath);
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temp file may not have been created or may already have been renamed.
      }
      throw error;
    }
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (providerId !== CODEX_PI_PROVIDER_ID) return undefined;
    const file = this.readFile();
    const access = file?.tokens?.access_token;
    const refresh = file?.tokens?.refresh_token;
    if (!access || !refresh) return undefined;
    return {
      type: "oauth",
      access,
      refresh,
      expires: decodeJwtExpiryMs(access),
      ...(file?.tokens?.account_id ? { accountId: file.tokens.account_id } : {}),
    };
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const credential = await this.read(CODEX_PI_PROVIDER_ID);
    return credential ? [{ providerId: CODEX_PI_PROVIDER_ID, type: credential.type }] : [];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== CODEX_PI_PROVIDER_ID) {
      return fn(await this.read(providerId, options));
    }
    return this.withLock(async () => {
      const current = await this.read(providerId, options);
      const next = await fn(current);
      if (!next || next.type !== "oauth") return next;
      const file = this.readFile() ?? {};
      const accountId = typeof next.accountId === "string" ? next.accountId : undefined;
      this.writeFileAtomically({
        ...file,
        tokens: {
          ...file.tokens,
          access_token: next.access,
          refresh_token: next.refresh,
          ...(accountId ? { account_id: accountId } : {}),
        },
        last_refresh: new Date().toISOString(),
      });
      return next;
    });
  }

  async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
    throw new Error(
      "CodexCredentialStore is refresh-only. Sign out with the Codex CLI or `unclecode auth logout`.",
    );
  }
}

export function resolveCodexOAuthBridgeArgs(input: {
  readonly provider: string;
  readonly apiKey?: string | undefined;
  readonly openAIRuntime?: "api" | "codex" | undefined;
  readonly authPath?: string | undefined;
}): { models: Models; piProvider: string } | undefined {
  if (
    input.provider !== "openai"
    || input.openAIRuntime === "api"
    || (input.openAIRuntime !== "codex" && input.apiKey)
  ) {
    return undefined;
  }
  const models = createCodexOAuthModels(input.authPath);
  return models ? { models, piProvider: CODEX_PI_PROVIDER_ID } : undefined;
}

export function createCodexOAuthModels(authPath?: string): Models | undefined {
  const resolvedPath = authPath ?? resolveCodexAuthPath();
  const store = new CodexCredentialStore(resolvedPath);
  const file = (() => {
    try {
      return JSON.parse(readFileSync(resolvedPath, "utf8")) as CodexAuthFile;
    } catch {
      return undefined;
    }
  })();
  if (!file?.tokens?.access_token || !file.tokens.refresh_token) return undefined;
  return builtinModels({ credentials: store });
}
