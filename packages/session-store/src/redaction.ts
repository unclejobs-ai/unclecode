import { runRustCommandSync } from "./rust-command.js";

export function redactSecrets(content: string): string {
  return runRustCommandSync(["rust", "redact"], process.cwd(), content);
}

export function stringifyWithRedaction(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === "string") {
      return redactSecrets(currentValue);
    }

    return currentValue;
  });
}
