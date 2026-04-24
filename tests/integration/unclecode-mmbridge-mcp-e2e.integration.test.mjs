import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, accessSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const mmbridgeMcpDist = path.resolve(
  workspaceRoot,
  "../mmbridge/packages/mcp/dist/index.js",
);
const localLauncher = path.resolve(
  workspaceRoot,
  "scripts/run-mmbridge-mcp.mjs",
);

function fileExists(filePath) {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function encodeFrame(message) {
  return `${JSON.stringify(message)}\n`;
}

async function callMmbridgeTool({ toolName, args }) {
  const child = spawn(process.execPath, [localLauncher], {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let nextId = 1;
  const pending = new Map();
  let stdoutBuffer = Buffer.alloc(0);
  let stderrText = "";

  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString();
  });

  child.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)]);
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf(0x0a);
      if (newlineIndex < 0) return;
      const line = stdoutBuffer
        .subarray(0, newlineIndex)
        .toString("utf8")
        .replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.subarray(newlineIndex + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id === "number" && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          entry.reject(
            new Error(message.error.message ?? "MCP request failed"),
          );
        } else {
          entry.resolve(message);
        }
      }
    }
  });

  const failPending = (error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  child.stdin.on("error", () => {});
  child.on("error", (error) => failPending(error));
  child.on("close", (code) => {
    if (pending.size > 0) {
      failPending(
        new Error(
          `mmbridge MCP exited with code ${code ?? 0}. stderr=${stderrText}`,
        ),
      );
    }
  });

  const timeoutMs = 20_000;
  const timer = setTimeout(() => {
    if (pending.size === 0) return;
    failPending(
      new Error(
        `mmbridge MCP request timed out after ${timeoutMs}ms. stderr=${stderrText}`,
      ),
    );
    child.kill("SIGTERM");
  }, timeoutMs);
  timer.unref();

  const request = (method, params = {}) => {
    const id = nextId++;
    child.stdin.write(
      encodeFrame({ jsonrpc: "2.0", id, method, params }),
      "utf8",
    );
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const notify = (method, params = {}) => {
    child.stdin.write(encodeFrame({ jsonrpc: "2.0", method, params }), "utf8");
  };

  try {
    await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "unclecode-e2e-smoke", version: "0.0.0" },
    });
    notify("notifications/initialized", {});

    const listResponse = await request("tools/list", {});
    const callResponse = await request("tools/call", {
      name: toolName,
      arguments: args,
    });
    return { list: listResponse.result, call: callResponse.result, stderrText };
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

const hasMmbridgeBuild = fileExists(mmbridgeMcpDist);

test(
  "host drives real tools/call mmbridge_doctor via project-local stdio MCP",
  {
    skip:
      !hasMmbridgeBuild && "mmbridge MCP dist not found; build mmbridge first",
    timeout: 30_000,
  },
  async () => {
    const { list, call, stderrText } = await callMmbridgeTool({
      toolName: "mmbridge_doctor",
      args: { projectDir: workspaceRoot },
    });

    const tools = Array.isArray(list?.tools) ? list.tools : [];
    const toolNames = tools.map((tool) => tool.name);
    for (const expected of [
      "mmbridge_doctor",
      "mmbridge_gate",
      "mmbridge_context_packet",
      "mmbridge_review",
    ]) {
      assert.ok(
        toolNames.includes(expected),
        `tools/list missing ${expected} (got: ${toolNames.join(", ")}; stderr=${stderrText})`,
      );
    }

    const content = Array.isArray(call?.content) ? call.content : [];
    const texts = content
      .filter(
        (item) => item && item.type === "text" && typeof item.text === "string",
      )
      .map((item) => item.text);
    assert.equal(
      texts.length,
      1,
      `mmbridge_doctor should return exactly one text block; stderr=${stderrText}`,
    );

    const report = JSON.parse(texts[0]);
    assert.equal(typeof report.generatedAt, "string");
    assert.equal(typeof report.projectDir, "string");
    assert.ok(
      Array.isArray(report.checks),
      "checks array missing in doctor report",
    );
    assert.equal(typeof report.mmbridgeHome, "string");
    assert.ok(
      report.sessionFileHints !== null &&
        typeof report.sessionFileHints === "object",
      "sessionFileHints should be a non-null object",
    );
  },
);
