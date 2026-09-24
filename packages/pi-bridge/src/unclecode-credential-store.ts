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

import { errorCode, withCredentialFileLock, writeCredentialFileAtomically } from "./credential-file.js";

type ProviderCredentialFile = Record<string, Credential>;

/** UncleCode's own provider credentials: one JSON map keyed by pi-ai provider id (pi's auth.json shape). */
export function resolveProviderCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.UNCLECODE_PROVIDER_CREDENTIALS_PATH?.trim();
  if (explicit) return explicit;
  return path.join(env.HOME ?? homedir(), ".unclecode", "credentials", "providers.json");
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "oauth" || type === "api_key";
}

export class UncleCodeCredentialStore implements CredentialStore {
  constructor(private readonly filePath: string) {}

  private readFile(): ProviderCredentialFile {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Provider credentials file is not a JSON object: ${this.filePath}`);
    }
    const credentials: ProviderCredentialFile = {};
    for (const [providerId, value] of Object.entries(parsed)) {
      if (isCredential(value)) credentials[providerId] = value;
    }
    return credentials;
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.readFile()[providerId];
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.readFile()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return withCredentialFileLock(this.filePath, "UncleCode", async () => {
      const file = this.readFile();
      const next = await fn(file[providerId]);
      if (!next) return file[providerId];
      writeCredentialFileAtomically(this.filePath, { ...file, [providerId]: next });
      return next;
    });
  }

  async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    await withCredentialFileLock(this.filePath, "UncleCode", async () => {
      const file = this.readFile();
      if (!(providerId in file)) return;
      const { [providerId]: _removed, ...rest } = file;
      writeCredentialFileAtomically(this.filePath, rest);
    });
  }
}

const modelsByPath = new Map<string, Models>();

/** pi-ai model registry backed by UncleCode's credential store; one instance per file per process. */
export function getUncleCodeCredentialModels(env: NodeJS.ProcessEnv = process.env): Models {
  const filePath = resolveProviderCredentialsPath(env);
  let models = modelsByPath.get(filePath);
  if (!models) {
    models = builtinModels({ credentials: new UncleCodeCredentialStore(filePath) });
    modelsByPath.set(filePath, models);
  }
  return models;
}
