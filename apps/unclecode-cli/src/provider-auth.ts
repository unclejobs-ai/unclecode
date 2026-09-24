import { createInterface } from "node:readline/promises";

import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { getUncleCodeCredentialModels, resolveProviderCredentialsPath } from "@unclecode/pi-bridge";

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

function printAuthEvent(event: AuthEvent): void {
  switch (event.type) {
    case "device_code":
      process.stdout.write(`Open ${event.verificationUri}\nEnter code: ${event.userCode}\n`);
      if (event.expiresInSeconds) {
        process.stdout.write(`The code expires in ${Math.round(event.expiresInSeconds / 60)} min.\n`);
      }
      return;
    case "auth_url":
      process.stdout.write(`Open ${event.url}\n${event.instructions ? `${event.instructions}\n` : ""}`);
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
