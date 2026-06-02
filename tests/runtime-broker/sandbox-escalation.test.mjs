import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeBroker } from "@unclecode/runtime-broker";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "unclecode-sandbox-test-"));
}

function writeFakeOpenShellCli(workdir) {
  const cliPath = join(workdir, "fake-openshell.mjs");
  const logPath = join(workdir, "fake-openshell-log.jsonl");
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const logPath = process.env.OPENSHELL_FAKE_LOG;
if (logPath) {
  appendFileSync(logPath, JSON.stringify(args) + "\\n");
}

if (args[0] === "--help") {
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "select") {
  process.exit(Number(process.env.OPENSHELL_FAKE_GATEWAY_EXIT ?? "0"));
}

if (args[0] === "sandbox" && args[1] === "create") {
  if (process.env.OPENSHELL_FAKE_CREATE_EXIT !== undefined) {
    console.error("create failed");
    process.exit(Number(process.env.OPENSHELL_FAKE_CREATE_EXIT));
  }
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "upload") {
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "exec") {
  process.stdout.write(process.env.OPENSHELL_FAKE_STDOUT ?? "openshell-ok\\n");
  if (process.env.OPENSHELL_FAKE_STDERR !== undefined) {
    process.stderr.write(process.env.OPENSHELL_FAKE_STDERR);
  }
  process.exit(Number(process.env.OPENSHELL_FAKE_EXIT ?? "0"));
}

if (args[0] === "sandbox" && args[1] === "download") {
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "delete") {
  process.exit(0);
}

console.error("unexpected fake openshell args: " + JSON.stringify(args));
process.exit(42);
`,
  );
  chmodSync(cliPath, 0o755);
  return { cliPath, logPath };
}

function readFakeOpenShellLog(logPath) {
  const text = readFileSync(logPath, "utf8").trim();
  return text.length === 0
    ? []
    : text.split("\n").map((line) => JSON.parse(line));
}

test("docker mode either runs successfully or reports adapter unavailable", async () => {
  const workdir = makeTempDir();
  try {
    const broker = createRuntimeBroker({
      workingDirectory: workdir,
      runtimeMode: "docker",
      captureOutput: true,
      timeoutMs: 3000,
    });
    try {
      const container = await broker.spawn({
        command: "echo",
        args: ["hello"],
        config: { workingDirectory: workdir },
      });
      assert.equal(container.runtimeMode, "docker");
      assert.ok(
        container.state === "exited" || container.state === "failed",
        "state was: " + container.state,
      );
    } catch (err) {
      assert.equal(err.code, "ADAPTER_UNAVAILABLE");
      assert.ok(err.message.includes("Docker is not available"));
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("broker health aggregates adapter statuses after docker spawn attempt", async () => {
  const workdir = makeTempDir();
  try {
    const broker = createRuntimeBroker({
      workingDirectory: workdir,
      runtimeMode: "docker",
      captureOutput: true,
      timeoutMs: 3000,
    });
    try {
      await broker.spawn({
        command: "echo",
        args: ["health-check"],
        config: { workingDirectory: workdir },
      });
    } catch {
      // expected when Docker not available
    }
    const health = broker.health();
    assert.ok(health.adapters.some((a) => a.mode === "local" && a.available));
    assert.ok(health.adapters.some((a) => a.mode === "docker"));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

for (const runtimeMode of ["e2b", "openshell"]) {
  test(`${runtimeMode} mode is recognized but rejected as not yet supported`, async () => {
    const workdir = makeTempDir();
    try {
      const broker = createRuntimeBroker({
        workingDirectory: workdir,
        runtimeMode,
      });

      await assert.rejects(
        broker.spawn({
          command: "echo",
          args: ["hello"],
          config: { workingDirectory: workdir, runtimeMode },
        }),
        (error) => {
          assert.equal(error.code, "ADAPTER_UNAVAILABLE");
          assert.ok(error.message.includes("not yet supported"));
          return true;
        },
      );
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
}

test("openshell adapter is feature-gated and fails closed when gateway is missing", async () => {
  const workdir = makeTempDir();
  try {
    const broker = createRuntimeBroker({
      workingDirectory: workdir,
      runtimeMode: "openshell",
      openshell: { enabled: true },
    });

    await assert.rejects(
      broker.spawn({
        command: "echo",
        args: ["hello"],
        config: { workingDirectory: workdir, runtimeMode: "openshell" },
      }),
      (error) => {
        assert.equal(error.code, "ADAPTER_UNAVAILABLE");
        assert.match(error.message, /gateway is not configured/);
        return true;
      },
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("openshell adapter does not fall back to local execution when CLI is missing", async () => {
  const workdir = makeTempDir();
  try {
    const broker = createRuntimeBroker({
      workingDirectory: workdir,
      runtimeMode: "openshell",
      openshell: {
        enabled: true,
        gatewayName: "local",
        cliPath: join(workdir, "missing-openshell"),
      },
    });

    await assert.rejects(
      broker.spawn({
        command: "echo",
        args: ["should-not-run-locally"],
        config: { workingDirectory: workdir, runtimeMode: "openshell" },
      }),
      (error) => {
        assert.equal(error.code, "ADAPTER_UNAVAILABLE");
        assert.match(error.message, /OpenShell CLI is not available/);
        return true;
      },
    );

    const health = broker.health();
    assert.ok(health.adapters.some((adapter) => adapter.mode === "local" && adapter.available));
    assert.ok(health.adapters.some((adapter) => adapter.mode === "openshell" && !adapter.available));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("openshell adapter executes configured sandbox lifecycle through CLI", async () => {
  const workdir = makeTempDir();
  try {
    const { cliPath, logPath } = writeFakeOpenShellCli(workdir);
    const events = [];
    const downloadPath = join(workdir, "artifact.txt");
    const broker = createRuntimeBroker({
      workingDirectory: workdir,
      runtimeMode: "openshell",
      captureOutput: true,
      timeoutMs: 3000,
      environment: {
        OPENSHELL_FAKE_LOG: logPath,
      },
      openshell: {
        enabled: true,
        gatewayName: "local",
        cliPath,
        sandboxNamePrefix: "uc-test",
        sandboxImage: "base",
        policyPath: "policy.yaml",
        providers: ["openai"],
        uploadWorkspace: true,
        sandboxWorkspace: "/sandbox/unclecode",
        downloadPaths: [
          { sandboxPath: "/sandbox/unclecode/artifact.txt", localPath: downloadPath },
        ],
      },
    });
    broker.onEvent((event) => events.push(event));

    const container = await broker.spawn({
      command: "echo",
      args: ["hello"],
      config: { workingDirectory: workdir, runtimeMode: "openshell" },
    });

    assert.equal(container.runtimeMode, "openshell");
    assert.equal(container.state, "exited");
    assert.equal(container.exitCode, 0);
    assert.equal(container.stdout, "openshell-ok\n");
    assert.equal(container.stderr, "");
    assert.ok(container.startedAt <= container.finishedAt);
    assert.ok(events.some((event) => event.type === "stdout" && event.data === "openshell-ok\n"));
    assert.ok(events.some((event) => event.type === "exited" && event.exitCode === 0));

    const calls = readFakeOpenShellLog(logPath);
    assert.deepEqual(calls[0], ["--help"]);
    assert.deepEqual(calls[1], ["gateway", "select", "local"]);
    const createCall = calls.find((call) => call[0] === "sandbox" && call[1] === "create");
    assert.ok(createCall);
    assert.ok(createCall.includes("--name"));
    assert.ok(createCall.some((part) => String(part).startsWith("uc-test-")));
    assert.deepEqual(createCall.slice(createCall.indexOf("--from"), createCall.indexOf("--from") + 2), [
      "--from",
      "base",
    ]);
    assert.deepEqual(
      createCall.slice(createCall.indexOf("--policy"), createCall.indexOf("--policy") + 2),
      ["--policy", "policy.yaml"],
    );
    assert.deepEqual(
      createCall.slice(createCall.indexOf("--provider"), createCall.indexOf("--provider") + 2),
      ["--provider", "openai"],
    );

    const uploadCall = calls.find((call) => call[0] === "sandbox" && call[1] === "upload");
    assert.ok(uploadCall);
    assert.equal(uploadCall.at(-2), ".");
    assert.equal(uploadCall.at(-1), "/sandbox/unclecode");

    const execCall = calls.find((call) => call[0] === "sandbox" && call[1] === "exec");
    assert.ok(execCall);
    assert.equal(execCall[2], "-n");
    assert.ok(execCall.includes("--workdir"));
    assert.ok(execCall.includes("/sandbox/unclecode"));
    assert.ok(execCall.includes("--timeout"));
    assert.ok(execCall.includes("echo"));
    assert.ok(execCall.includes("hello"));

    const downloadCall = calls.find((call) => call[0] === "sandbox" && call[1] === "download");
    assert.ok(downloadCall);
    assert.equal(downloadCall.at(-2), "/sandbox/unclecode/artifact.txt");
    assert.equal(downloadCall.at(-1), downloadPath);

    const deleteCall = calls.at(-1);
    assert.deepEqual(deleteCall.slice(0, 2), ["sandbox", "delete"]);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("openshell adapter returns failed container for nonzero sandbox exec", async () => {
  const workdir = makeTempDir();
  try {
    const { cliPath, logPath } = writeFakeOpenShellCli(workdir);
    const events = [];
    const broker = createRuntimeBroker({
      workingDirectory: workdir,
      runtimeMode: "openshell",
      captureOutput: true,
      timeoutMs: 3000,
      environment: {
        OPENSHELL_FAKE_LOG: logPath,
        OPENSHELL_FAKE_EXIT: "7",
        OPENSHELL_FAKE_STDERR: "exec failed\n",
      },
      openshell: {
        enabled: true,
        gatewayName: "local",
        cliPath,
      },
    });
    broker.onEvent((event) => events.push(event));

    const container = await broker.spawn({
      command: "false",
      args: [],
      config: { workingDirectory: workdir, runtimeMode: "openshell" },
    });

    assert.equal(container.runtimeMode, "openshell");
    assert.equal(container.state, "failed");
    assert.equal(container.exitCode, 7);
    assert.equal(container.stderr, "exec failed\n");
    assert.ok(events.some((event) => event.type === "error" && event.exitCode === 7));

    const calls = readFakeOpenShellLog(logPath);
    assert.ok(calls.some((call) => call[0] === "sandbox" && call[1] === "exec"));
    assert.deepEqual(calls.at(-1).slice(0, 2), ["sandbox", "delete"]);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("openshell adapter reports sandbox create failure without local fallback", async () => {
  const workdir = makeTempDir();
  try {
    const { cliPath, logPath } = writeFakeOpenShellCli(workdir);
    const broker = createRuntimeBroker({
      workingDirectory: workdir,
      runtimeMode: "openshell",
      environment: {
        OPENSHELL_FAKE_LOG: logPath,
        OPENSHELL_FAKE_CREATE_EXIT: "17",
      },
      openshell: {
        enabled: true,
        gatewayName: "local",
        cliPath,
      },
    });

    await assert.rejects(
      broker.spawn({
        command: "echo",
        args: ["should-not-run"],
        config: { workingDirectory: workdir, runtimeMode: "openshell" },
      }),
      (error) => {
        assert.equal(error.code, "SPAWN_FAILED");
        assert.match(error.message, /OpenShell create sandbox failed/);
        return true;
      },
    );

    const calls = readFakeOpenShellLog(logPath);
    assert.ok(calls.some((call) => call[0] === "sandbox" && call[1] === "create"));
    assert.ok(!calls.some((call) => call[0] === "sandbox" && call[1] === "exec"));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
