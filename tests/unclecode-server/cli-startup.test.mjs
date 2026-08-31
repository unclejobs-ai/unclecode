import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultRuntimeOwnerPaths, startPersistentRuntimeOwner } from "../../apps/unclecode-server/src/index.ts";

test("the standalone server CLI attaches to the one persistent owner without opening a listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-server-cli-"));
  const paths = defaultRuntimeOwnerPaths(root);
  const owner = await startPersistentRuntimeOwner({
    rootDir: join(root, "sessions"), leasePath: paths.leasePath, tokenPath: paths.tokenPath,
  });
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
    assert.equal((await (await fetch(`${url}/health`)).json()).pid, owner.lease.pid);
    assert.notEqual(child.pid, owner.lease.pid);
    assert.match(output, /No second listener was created/);

    const controlRoom = await fetch(`${url}/control-room`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(controlRoom.status, 200);
    assert.deepEqual((await controlRoom.json()).runs, []);
  } finally {
    try {
      const closed = child.exitCode === null ? new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("server CLI did not terminate")),
          2_000,
        );
        child.once("close", (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      }) : Promise.resolve(child.exitCode);
      child.kill("SIGTERM");
      await closed;
    } finally {
      await owner.stop();
    }
  }
});

async function waitForServerUrl(readOutput) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = readOutput().match(
      /unclecode-server attached to runtime owner at (http:\/\/127\.0\.0\.1:\d+)/u,
    );
    if (match?.[1]) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`server CLI did not start: ${readOutput()}`);
}
