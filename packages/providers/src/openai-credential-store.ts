import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const UNCLECODE_KEYTAR_SERVICE = "unclecode.openai";
const UNCLECODE_KEYTAR_ACCOUNT = "oauth";

type StoredOpenAICredentials =
  | {
      readonly authType: "oauth";
      readonly accessToken: string;
      readonly refreshToken: string;
      readonly expiresAt: number | null;
      readonly organizationId: string | null;
      readonly projectId: string | null;
      readonly accountId: string | null;
    }
  | {
      readonly authType: "api-key";
      readonly apiKey: string;
      readonly organizationId: string | null;
      readonly projectId: string | null;
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

type WriteOpenAICredentialsInput =
  | {
      readonly credentialsPath: string;
      readonly credentials: StoredOpenAICredentials;
      readonly rawContents?: never;
      readonly keytar?: KeytarLike;
    }
  | {
      readonly credentialsPath: string;
      readonly credentials?: never;
      readonly rawContents: string;
      readonly keytar?: KeytarLike;
    };

export async function writeOpenAICredentials(input: WriteOpenAICredentialsInput): Promise<void> {
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

function parseStoredOpenAICredentials(parsed: any): StoredOpenAICredentials | null {
  if (parsed?.authType === "oauth") {
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

  if (parsed?.authType === "api-key") {
    return {
      authType: "api-key",
      apiKey: String(parsed.apiKey ?? ""),
      organizationId: typeof parsed.organizationId === "string" ? parsed.organizationId : null,
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
    };
  }

  return null;
}

export async function readOpenAICredentials(input: {
  readonly credentialsPath: string;
  readonly keytar?: KeytarLike;
}): Promise<StoredOpenAICredentials | null> {
  const keytar = input.keytar ?? (await loadKeytar());

  if (keytar !== null) {
    try {
      const stored = await keytar.getPassword(UNCLECODE_KEYTAR_SERVICE, UNCLECODE_KEYTAR_ACCOUNT);

      if (stored !== null) {
        return parseStoredOpenAICredentials(JSON.parse(stored));
      }
    } catch {
    }
  }

  try {
    return parseStoredOpenAICredentials(JSON.parse(await readFile(input.credentialsPath, "utf8")));
  } catch {
    return null;
  }
}

export async function clearOpenAICredentials(input: {
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
