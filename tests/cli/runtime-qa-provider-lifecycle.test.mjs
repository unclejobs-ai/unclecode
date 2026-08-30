import assert from "node:assert/strict";
import test from "node:test";

import {
  startGeminiServer,
} from "../../scripts/runtime-qa/fake-gemini-server.mjs";
import {
  waitForProviderRequest,
} from "../../scripts/runtime-qa/tui-scrollback-smoke.mjs";

test("fake Gemini streaming responses close their transport explicitly", async () => {
  const observations = [];
  const server = await startGeminiServer((observation) => observations.push(observation));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": "test" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "scroll turn 01" }] }],
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("connection"), "close");
    assert.match(await response.text(), /^data: /);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.responseFinished, true);
  } finally {
    await server.close();
  }
});

test("scrollback provider barrier ignores an unrelated SCC quality request", async () => {
  const observations = [{
    text: "Review the output for user request scroll turn 01 and return a gate decision.",
  }, {
    text: "<unclecode_context_packet>context</unclecode_context_packet>\n\nUser request:\nscroll turn 01",
    responseFinished: false,
  }];
  const expected = {
    text: "<unclecode_context_packet>context</unclecode_context_packet>\n\nUser request:\nscroll turn 01",
    responseFinished: true,
  };
  setTimeout(() => observations.push(expected), 10);

  const matched = await waitForProviderRequest({
    observations,
    afterIndex: 0,
    prompt: "scroll turn 01",
    timeoutMs: 1_000,
  });

  assert.equal(matched, expected);
});

test("fake Gemini gives every scrollback turn a unique settled reply marker", async () => {
  const server = await startGeminiServer(() => {});
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": "test" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "scroll turn 07" }] }],
        }),
      },
    );

    assert.match(await response.text(), /UNCLECODE_RUNTIME_QA_OK · scroll turn 07/);
  } finally {
    await server.close();
  }
});
