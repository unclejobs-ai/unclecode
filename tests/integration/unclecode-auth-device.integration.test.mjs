import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const builtCliEntrypoint = path.join(
  workspaceRoot,
  "apps/unclecode-cli/dist/index.js",
);

test("built unclecode cli completes device login against a fake oauth server", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-device-login-"));
  const credentialsPath = path.join(tempDir, "openai.json");

  const server = createServer((req, res) => {
    if (req.url === "/oauth/device/code") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const parsed = new URLSearchParams(body);
        if (!String(parsed.get("scope") ?? "").includes("model.request")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "missing_scope_request" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            device_code: "device_123",
            user_code: "user_123",
            verification_uri: "https://auth.openai.com/activate",
            expires_in: 900,
            interval: 0,
          }),
        );
      });
      return;
    }

    if (req.url === "/oauth/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ access_token: "at_123", refresh_token: "rt_123" }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        "node",
        [builtCliEntrypoint, "auth", "login", "--device"],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            OPENAI_OAUTH_CLIENT_ID: "client_123",
            OPENAI_OAUTH_BASE_URL: baseUrl,
            UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Please visit https:\/\/auth\.openai\.com\/activate and enter code: user_123/,
    );
    assert.match(result.stdout, /Login successful/);

    const credentialFile = JSON.parse(readFileSync(credentialsPath, "utf8"));
    assert.equal(credentialFile.accessToken, "at_123");
    assert.equal(credentialFile.refreshToken, "rt_123");
  } finally {
    server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
