import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("the standalone server CLI serves the persistent control-room adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-server-cli-"));
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--conditions=source",
      "--import",
      "tsx",
      "apps/unclecode-server/src/cli.ts",
    ],
    {
      cwd: new URL("../..", import.meta.url),
      env: {
        ...process.env,
        HOME: root,
        UNCLECODE_SESSION_STORE_ROOT: join(root, "sessions"),
        UNCLECODE_SERVER_HOST: "127.0.0.1",
        UNCLECODE_SERVER_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    const url = await waitForServerUrl(() => output);
    const token = (
      await readFile(join(root, ".unclecode", "server.token"), "utf8")
    ).trim();
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const controlRoom = await fetch(`${url}/control-room`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(controlRoom.status, 200);
    assert.deepEqual((await controlRoom.json()).runs, []);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("server CLI did not terminate")),
        2_000,
      );
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
  }
});

async function waitForServerUrl(readOutput) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = readOutput().match(
      /unclecode-server listening on (http:\/\/127\.0\.0\.1:\d+)/u,
    );
    if (match?.[1]) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`server CLI did not start: ${readOutput()}`);
}
