import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentOpsPaths {
  readonly home: string;
  readonly dbPath: string;
  readonly artifactsDir: string;
}

export function defaultAgentOpsPaths(home = join(homedir(), ".unclecode", "agentops")): AgentOpsPaths {
  return {
    home,
    dbPath: join(home, "agentops.db"),
    artifactsDir: join(home, "artifacts"),
  };
}
