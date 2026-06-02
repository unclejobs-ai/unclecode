import { runRustCommand } from "./rust-command.js";

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
      readonly runtime: "api" | "codex" | null;
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

  if (input.keytar) {
    try {
      await input.keytar.setPassword(UNCLECODE_KEYTAR_SERVICE, UNCLECODE_KEYTAR_ACCOUNT, serialized);
      return;
    } catch {
    }
  }

  await runRustCommand(
    ["rust", "auth", "write-raw"],
    process.cwd(),
    serialized,
    {
      ...process.env,
      UNCLECODE_OPENAI_CREDENTIALS_PATH: input.credentialsPath,
    },
  );
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
      runtime: parsed.runtime === "codex" || parsed.runtime === "api" ? parsed.runtime : null,
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
  if (input.keytar) {
    try {
      const stored = await input.keytar.getPassword(
        UNCLECODE_KEYTAR_SERVICE,
        UNCLECODE_KEYTAR_ACCOUNT,
      );

      if (stored !== null) {
        return parseStoredOpenAICredentials(JSON.parse(stored));
      }
    } catch {
    }
  }

  try {
    const stdout = await runRustCommand(
      ["rust", "auth", "read-credentials"],
      process.cwd(),
      undefined,
      {
        ...process.env,
        UNCLECODE_OPENAI_CREDENTIALS_PATH: input.credentialsPath,
      },
    );
    return parseRustStoredOpenAICredentials(stdout);
  } catch {
    return null;
  }
}

export async function clearOpenAICredentials(input: {
  readonly credentialsPath: string;
  readonly keytar?: KeytarLike;
}): Promise<void> {
  if (input.keytar?.deletePassword) {
    try {
      await input.keytar.deletePassword(UNCLECODE_KEYTAR_SERVICE, UNCLECODE_KEYTAR_ACCOUNT);
    } catch {
    }
  }

  await runRustCommand(
    ["rust", "auth", "logout"],
    process.cwd(),
    undefined,
    {
      ...process.env,
      UNCLECODE_OPENAI_CREDENTIALS_PATH: input.credentialsPath,
    },
  );
}

function parseRustStoredOpenAICredentials(stdout: string): StoredOpenAICredentials | null {
  const fields = parseRustKeyValueLines(stdout);
  const authType = fields.get("authType");
  if (fields.get("status") !== "ok") {
    return null;
  }

  if (authType === "oauth") {
    return {
      authType,
      accessToken: fields.get("accessToken") ?? "",
      refreshToken: fields.get("refreshToken") ?? "",
      expiresAt: parseOptionalNumber(fields.get("expiresAt")),
      organizationId: normalizeOptionalField(fields.get("organizationId")),
      projectId: normalizeOptionalField(fields.get("projectId")),
      accountId: normalizeOptionalField(fields.get("accountId")),
      runtime: parseRuntime(fields.get("runtime")),
    };
  }

  if (authType === "api-key") {
    return {
      authType,
      apiKey: fields.get("apiKey") ?? "",
      organizationId: normalizeOptionalField(fields.get("organizationId")),
      projectId: normalizeOptionalField(fields.get("projectId")),
    };
  }

  return null;
}

function parseRustKeyValueLines(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split(/\r?\n/)
      .map((line) => line.split("=", 2))
      .filter((parts): parts is [string, string] => parts.length === 2),
  );
}

function normalizeOptionalField(value: string | undefined): string | null {
  return value && value !== "none" ? value : null;
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (!value || value === "none") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRuntime(value: string | undefined): "api" | "codex" | null {
  return value === "api" || value === "codex" ? value : null;
}
