import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const binEntrypoint = path.join(repoRoot, "bin", "unclecode.cjs");

test("work provider accepts GEMINI_API_BASE_URL as a native Gemini base URL alias", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-gemini-alias-"));
  const observed = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      observed.push({
        url: req.url,
        apiKey: req.headers["x-goog-api-key"],
        hasConfig: Object.hasOwn(parsed, "config"),
        hasModel: Object.hasOwn(parsed, "model"),
        text: parsed.contents?.[0]?.parts?.[0]?.text ?? null,
      });
      const response = JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ALIAS_SMOKE_OK" }] } }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 },
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(response),
      });
      res.end(response);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const result = await runNode(
      [
        binEntrypoint,
        "work",
        "--engine",
        "native",
        "--provider",
        "gemini",
        "--model",
        "gemini-2.5-flash",
        "Say hello through the alias provider.",
      ],
      {
        ...process.env,
        HOME: tempDir,
        UNCLECODE_SESSION_STORE_ROOT: path.join(tempDir, ".state"),
        UNCLECODE_MODE: "default",
        GEMINI_BASE_URL: "",
        GEMINI_API_BASE_URL: `http://127.0.0.1:${port}/v1beta`,
        GEMINI_API_KEY: "local-provider-test-key",
        NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"]
          .filter(Boolean)
          .join(","),
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ALIAS_SMOKE_OK/);
    assert.equal(observed.length, 1);
    assert.equal(
      observed[0].url,
      "/v1beta/models/gemini-2.5-flash:generateContent",
    );
    assert.equal(observed[0].apiKey, "local-provider-test-key");
    assert.equal(observed[0].hasConfig, false);
    assert.equal(observed[0].hasModel, false);
    assert.equal(observed[0].text, "Say hello through the alias provider.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
