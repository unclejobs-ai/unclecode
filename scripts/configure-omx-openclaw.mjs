#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();
const configPath = path.join(cwd, ".codex", ".omx-config.json");
const validGateways = new Set(["local", "clawship"]);

function parseGateway(argv) {
  const index = argv.indexOf("--gateway");
  if (index === -1) {
    return "local";
  }

  const value = argv[index + 1];
  if (!value || !validGateways.has(value)) {
    throw new Error("Use --gateway local or --gateway clawship.");
  }

  return value;
}

function buildInstruction(event) {
  switch (event) {
    case "session-start":
      return "[session-start|exec] project={{projectName}} session={{sessionId}}";
    case "session-idle":
      return "[session-idle|exec] project={{projectName}} session={{sessionId}}";
    case "ask-user-question":
      return "[ask-user-question|exec] session={{sessionId}} question={{question}}";
    case "stop":
      return "[stop|exec] session={{sessionId}} reason={{reason}}";
    case "session-end":
      return "[session-end|exec] project={{projectName}} session={{sessionId}}";
    default:
      throw new Error(`Unsupported event: ${event}`);
  }
}

const gateway = parseGateway(process.argv.slice(2));
const raw = await readFile(configPath, "utf8");
const config = JSON.parse(raw);

config.notifications ??= {};
config.notifications.enabled = true;
config.notifications.verbosity ??= "session";
config.notifications.idleCooldownSeconds ??= 60;
config.notifications.openclaw ??= {};
config.notifications.openclaw.enabled = true;
config.notifications.openclaw.gateways ??= {};
config.notifications.openclaw.hooks ??= {};

config.notifications.openclaw.gateways.local ??= {
  type: "http",
  url: "http://127.0.0.1:18789/hooks/agent",
  method: "POST",
  timeout: 10000,
};

if (gateway === "clawship") {
  const url = process.env.CLAWSHIP_OPENCLAW_URL?.trim();
  const token = process.env.CLAWSHIP_OPENCLAW_TOKEN?.trim();

  if (!url) {
    throw new Error("CLAWSHIP_OPENCLAW_URL is required when --gateway clawship is used.");
  }

  config.notifications.openclaw.gateways.clawship = {
    type: "http",
    url,
    method: "POST",
    timeout: 10000,
    ...(token
      ? {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      : {}),
  };
}

for (const event of [
  "session-start",
  "session-idle",
  "ask-user-question",
  "stop",
  "session-end",
]) {
  config.notifications.openclaw.hooks[event] = {
    enabled: true,
    gateway,
    instruction: buildInstruction(event),
  };
}

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

process.stdout.write(
  `Configured OMX OpenClaw gateway: ${gateway}\nConfig: ${configPath}\n`,
);
