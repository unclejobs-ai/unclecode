import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { completeOpenAIDeviceLogin } from "@unclecode/providers";

test("completeOpenAIDeviceLogin completes device flow end-to-end with fake server", async () => {
  const credentialsDir = mkdtempSync(
    path.join(os.tmpdir(), "unclecode-integ-"),
  );
  const credentialsPath = path.join(credentialsDir, "openai.json");
  const writes = [];

  const fakeFetch = async (url, init) => {
    const urlObj = new URL(String(url));
    if (urlObj.pathname === "/oauth/device/code") {
      return new Response(
        JSON.stringify({
          device_code: "device_123",
          user_code: "user_123",
          verification_uri: "https://auth.openai.com/activate",
          expires_in: 900,
          interval: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (urlObj.pathname === "/oauth/token") {
      return new Response(
        JSON.stringify({
          access_token: "at_123",
          refresh_token: "rt_123",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response("not found", { status: 404 });
  };

  const result = await completeOpenAIDeviceLogin({
    clientId: "client_123",
    scopes: ["openid", "profile", "offline_access"],
    credentialsPath,
    fetch: fakeFetch,
    writeCredentials: async (input) => {
      writes.push(input);
    },
  });

  assert.equal(result.userCode, "user_123");
  assert.ok(result.verificationUri.includes("openai.com"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].credentials.accessToken, "at_123");
  assert.equal(writes[0].credentials.refreshToken, "rt_123");
});
