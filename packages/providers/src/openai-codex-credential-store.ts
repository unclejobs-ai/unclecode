import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const UNCLECODE_KEYTAR_SERVICE = "unclecode.openai-codex";
const UNCLECODE_KEYTAR_ACCOUNT = "oauth";

type StoredOpenAICodexCredentials = {
  readonly authType: "oauth";
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number | null;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly accountId: string | null;
};

type KeytarLike = {
  readonly getPassword: (service: string, account: string) => Promise<string | null>;
  readonly setPassword: (service: string, account: string, password: string) => Promise<void>;
  readonly deletePassword?: (service: string, account: string) => Promise<boolean>;
};

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

async function loadKeytar(): Promise<KeytarLike | null> {
  try {
    const imported = await dynamicImport("keytar");

    if (
      typeof imported === "object" &&
      imported !== null &&
      "default" in imported &&
      typeof imported.default === "object" &&
      imported.default !== null &&
      "getPassword" in imported.default &&
      typeof imported.default.getPassword === "function" &&
      "setPassword" in imported.default &&
      typeof imported.default.setPassword === "function"
    ) {
      return imported.default as KeytarLike;
    }

    return null;
  } catch {
    return null;
  }
}

export async function writeOpenAICodexCredentials(input: {
  readonly credentialsPath: string;
  readonly credentials: StoredOpenAICodexCredentials;
  readonly rawContents?: string | undefined;
  readonly keytar?: KeytarLike;
}): Promise<void> {
  const serialized = input.rawContents ?? JSON.stringify(input.credentials, null, 2);
  const keytar = input.keytar ?? (await loadKeytar());

  if (keytar !== null) {
    try {
      await keytar.setPassword(UNCLECODE_KEYTAR_SERVICE, UNCLECODE_KEYTAR_ACCOUNT, serialized);
      return;
    } catch {
    }
  }

  await mkdir(path.dirname(input.credentialsPath), { recursive: true });
  await writeFile(input.credentialsPath, serialized, "utf8");
  await chmod(input.credentialsPath, 0o600);
}

function parseStoredOpenAICodexCredentials(parsed: any): StoredOpenAICodexCredentials | null {
  if (parsed?.authType !== "oauth") {
    return null;
  }

  return {
    authType: "oauth",
    accessToken: String(parsed.accessToken ?? ""),
    refreshToken: String(parsed.refreshToken ?? ""),
    expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
    organizationId: typeof parsed.organizationId === "string" ? parsed.organizationId : null,
    projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
    accountId: typeof parsed.accountId === "string" ? parsed.accountId : null,
  };
}

export async function readOpenAICodexCredentials(input: {
  readonly credentialsPath: string;
  readonly keytar?: KeytarLike;
}): Promise<StoredOpenAICodexCredentials | null> {
  const keytar = input.keytar ?? (await loadKeytar());

  if (keytar !== null) {
    try {
      const stored = await keytar.getPassword(UNCLECODE_KEYTAR_SERVICE, UNCLECODE_KEYTAR_ACCOUNT);
      if (stored !== null) {
        return parseStoredOpenAICodexCredentials(JSON.parse(stored));
      }
    } catch {
    }
  }

  try {
    return parseStoredOpenAICodexCredentials(JSON.parse(await readFile(input.credentialsPath, "utf8")));
  } catch {
    return null;
  }
}

export async function clearOpenAICodexCredentials(input: {
  readonly credentialsPath: string;
  readonly keytar?: KeytarLike;
}): Promise<void> {
  const keytar = input.keytar ?? (await loadKeytar());

  if (keytar?.deletePassword) {
    try {
      await keytar.deletePassword(UNCLECODE_KEYTAR_SERVICE, UNCLECODE_KEYTAR_ACCOUNT);
    } catch {
    }
  }

  await rm(input.credentialsPath, { force: true });
}
