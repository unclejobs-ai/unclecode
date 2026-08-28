#!/usr/bin/env node

import { getSessionStoreRoot } from "@unclecode/session-store";

import { createPersistentRuntimeAdapter, makeControlRoomHandlers, startServer } from "./index.js";

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.UNCLECODE_SERVER_PORT ?? "17677", 10);
  const host = process.env.UNCLECODE_SERVER_HOST ?? "127.0.0.1";
  const insecure = process.env.UNCLECODE_SERVER_INSECURE === "1";
  const { adapter, journal } = createPersistentRuntimeAdapter({ rootDir: getSessionStoreRoot(process.env) });
  const { url, token } = await startServer({ port, host, handlers: makeControlRoomHandlers({ adapter, journal }), insecure });
  process.stdout.write(`unclecode-server listening on ${url}\n`);
  process.stdout.write(`Auth token written to ~/.unclecode/server.token (mode 0600). Token: ${token.slice(0, 8)}...\n`);
  process.stdout.write("All endpoints except /health require Authorization: Bearer <token>.\n");
  process.stdout.write("Endpoints: GET /health, GET /control-room, GET /sessions/:id, GET /sessions/:id/events, POST /sessions/:id/actions/:action\n");
}

main().catch((error) => {
  process.stderr.write(`unclecode-server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
