import { runRustCommandSync } from "./rust-command.js";

export function redactSecrets(content: string): string {
  return runRustCommandSync(["rust", "redact"], process.cwd(), process.env, content);
}
