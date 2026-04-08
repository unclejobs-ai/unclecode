import { homedir } from "node:os";
import path from "node:path";

export function getSessionStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.UNCLECODE_SESSION_STORE_ROOT?.trim() || path.join(homedir(), ".unclecode", "state");
}
