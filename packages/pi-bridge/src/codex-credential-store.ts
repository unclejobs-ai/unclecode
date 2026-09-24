import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  Models,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { withCredentialFileLock, writeCredentialFileAtomically } from "./credential-file.js";

export const CODEX_PI_PROVIDER_ID = "openai-codex";


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

export class CodexCredentialStore implements CredentialStore {
  constructor(private readonly authPath: string) {}
  private readFile(): CodexAuthFile | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.authPath, "utf8")) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as CodexAuthFile) : undefined;
    } catch {
      return undefined;
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
    return withCredentialFileLock(this.authPath, "Codex", async () => {
      const current = await this.read(providerId, options);
      const next = await fn(current);
      if (!next || next.type !== "oauth") return next;
      const file = this.readFile() ?? {};
      const accountId = typeof next.accountId === "string" ? next.accountId : undefined;
      writeCredentialFileAtomically(this.authPath, {
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
