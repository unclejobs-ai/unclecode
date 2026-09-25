import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import type { AuthEvent, AuthPrompt, Models } from "@earendil-works/pi-ai";
import {
  getUncleCodeCredentialModels,
  resolveProviderCredentialsPath,
  UncleCodeCredentialStore,
} from "@unclecode/pi-bridge";

function requireOAuthProvider(providerId: string): string {
  const provider = getUncleCodeCredentialModels().getProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  if (!provider.auth.oauth) {
    throw new Error(`${provider.name} has no sign-in flow. Set its API key in the environment instead.`);
  }
  return provider.auth.oauth.name;
}

// Long OAuth URLs break when copied out of a wrapped terminal (a truncated `state`
// fails the provider's check), so hand them to the browser directly.
function openInBrowser(url: string, onError: () => void): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
  child.once("error", onError);
  child.unref();
}

function reportBrowserUnavailable(): void {
  process.stdout.write("Could not open a browser; open the URL above manually.\n");
}

function printAuthEvent(event: AuthEvent): void {
  switch (event.type) {
    case "device_code":
      process.stdout.write(`Open ${event.verificationUri}\nEnter code: ${event.userCode}\n`);
      openInBrowser(event.verificationUri, reportBrowserUnavailable);
      if (event.expiresInSeconds) {
        process.stdout.write(`The code expires in ${Math.round(event.expiresInSeconds / 60)} min.\n`);
      }
      return;
    case "auth_url":
      process.stdout.write(`Open ${event.url}\n${event.instructions ? `${event.instructions}\n` : ""}`);
      openInBrowser(event.url, reportBrowserUnavailable);
      return;
    case "info":
    case "progress":
      process.stdout.write(`${event.message}\n`);
      return;
  }
}

async function answerAuthPrompt(prompt: AuthPrompt): Promise<string> {
  const lines = [prompt.message];
  if (prompt.type === "select") {
    for (const option of prompt.options) {
      lines.push(`  ${option.id}  ${option.label}${option.description ? ` — ${option.description}` : ""}`);
    }
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`${lines.join("\n")}\n> `, prompt.signal ? { signal: prompt.signal } : {});
    return answer.trim();
  } finally {
    readline.close();
  }
}

/** `unclecode auth login <provider>`: pi-ai's OAuth flow, persisted in UncleCode's credential store. */
export async function runProviderOAuthLogin(providerId: string): Promise<void> {
  const flowName = requireOAuthProvider(providerId);
  process.stdout.write(`Signing in: ${flowName}\n`);
  const abort = new AbortController();
  const onSigint = () => abort.abort(new Error("Login cancelled"));
  process.once("SIGINT", onSigint);
  try {
    const credential = await getUncleCodeCredentialModels().login(providerId, "oauth", {
      signal: abort.signal,
      prompt: answerAuthPrompt,
      notify: printAuthEvent,
    });
    process.stdout.write(`Signed in to ${providerId} (${credential.type}).\n`);
    process.stdout.write(`Credentials: ${resolveProviderCredentialsPath()}\n`);
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/** `unclecode auth status <provider>`: whether a model call can authenticate, without refreshing. */
export async function printProviderAuthStatus(providerId: string): Promise<void> {
  const models = getUncleCodeCredentialModels();
  if (!models.getProvider(providerId)) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  const check = await models.checkAuth(providerId);
  process.stdout.write(`provider=${providerId}\n`);
  process.stdout.write(`ready=${check ? "yes" : "no"}\n`);
  process.stdout.write(`authType=${check?.type ?? "none"}\n`);
  process.stdout.write(`source=${check?.source ?? "none"}\n`);
  if (!check) {
    process.stdout.write(`Next: unclecode auth login ${providerId}\n`);
  }
}

/** `unclecode auth logout <provider>`: remove the stored credential. */
export async function runProviderLogout(providerId: string): Promise<void> {
  await getUncleCodeCredentialModels().logout(providerId);
  process.stdout.write(`Signed out of ${providerId}.\n`);
}

type ProviderAuthCatalogRow = {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly credentialKey: string;
  readonly signedIn: boolean;
  readonly originKind?: "oauth" | "api_key" | "env";
  readonly originEnvVar?: string;
};

/**
 * The TUI's `/auth` catalog, answered by UncleCode's own credential store: every
 * provider pi-ai can sign in to with OAuth, and whether it is signed in (stored
 * login, or an environment key). Sign-in hands off to `unclecode auth login`.
 */
const TUI_SIGN_IN_TIMEOUT_MS = 15 * 60_000;

/**
 * Answers a login prompt without the terminal (Ink owns stdin): text and select
 * take their documented defaults; a manual code waits until the provider's own
 * browser callback supersedes it. Anything else needs `unclecode auth login`.
 */
function answerPromptInTui(prompt: AuthPrompt): Promise<string> {
  switch (prompt.type) {
    case "text":
      return Promise.resolve("");
    case "select":
      return Promise.resolve(prompt.options[0]?.id ?? "");
    case "manual_code":
      return new Promise((_resolve, reject) => {
        if (!prompt.signal) {
          reject(new Error("This sign-in needs a pasted code"));
          return;
        }
        prompt.signal.addEventListener("abort", () => reject(new Error("Superseded by the browser callback")), { once: true });
      });
    case "secret":
      return Promise.reject(new Error("This sign-in needs a secret typed in a terminal"));
  }
}

function describeAuthEventForTui(event: AuthEvent): string | undefined {
  switch (event.type) {
    case "device_code":
      return `Enter code ${event.userCode} at ${event.verificationUri} (browser opened)`;
    case "auth_url":
      return `Finish signing in in your browser (opened): ${event.url}`;
    case "info":
    case "progress":
      return event.message;
  }
}

export function createProviderAuthCatalog(
  env: NodeJS.ProcessEnv = process.env,
  deps: { readonly models?: Pick<Models, "getProviders" | "getProvider" | "checkAuth" | "login">; readonly openUrl?: (url: string) => void } = {},
) {
  const getModels = () => deps.models ?? getUncleCodeCredentialModels(env);
  return {
    async list(): Promise<{ readonly ok: true; readonly dbPath: string; readonly providers: readonly ProviderAuthCatalogRow[] }> {
      const models = getModels();
      const store = new UncleCodeCredentialStore(resolveProviderCredentialsPath(env));
      const providers = await Promise.all(
        models.getProviders()
          .filter((provider) => provider.auth.oauth !== undefined)
          .map(async (provider): Promise<ProviderAuthCatalogRow> => {
            const row = {
              id: provider.id,
              name: provider.auth.oauth?.name ?? provider.name,
              available: true,
              credentialKey: provider.id,
            };
            const stored = await store.read(provider.id);
            if (stored) return { ...row, signedIn: true, originKind: stored.type };
            const check = await models.checkAuth(provider.id);
            return check?.source
              ? { ...row, signedIn: true, originKind: "env", originEnvVar: check.source }
              : { ...row, signedIn: false };
          }),
      );
      return { ok: true, dbPath: resolveProviderCredentialsPath(env), providers };
    },
    async signIn(providerId: string, onProgress?: (text: string) => void) {
      const argv = ["auth", "login", providerId] as const;
      const command = `unclecode ${argv.join(" ")}`;
      // Without a progress sink there is nowhere to show a code: hand off to the terminal.
      if (!onProgress) return { ok: true as const, binPath: "unclecode", argv, command };
      const models = getModels();
      const flowName = models.getProvider(providerId)?.auth.oauth?.name;
      if (!flowName) {
        return { ok: false as const, error: { code: "SIGN_IN_UNAVAILABLE" as const, message: `${providerId} has no sign-in flow` } };
      }
      const openUrl = deps.openUrl
        ?? ((url: string) => openInBrowser(url, () => onProgress(`Open this URL in a browser: ${url}`)));
      try {
        await models.login(providerId, "oauth", {
          signal: AbortSignal.timeout(TUI_SIGN_IN_TIMEOUT_MS),
          prompt: answerPromptInTui,
          notify: (event) => {
            if (event.type === "device_code") openUrl(event.verificationUri);
            if (event.type === "auth_url") openUrl(event.url);
            const text = describeAuthEventForTui(event);
            if (text) onProgress(text);
          },
        });
        return { ok: true as const, signedIn: true as const, name: flowName };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false as const, error: { code: "SIGN_IN_UNAVAILABLE" as const, message: `${reason} · or run: ${command}` } };
      }
    },
  };
}
