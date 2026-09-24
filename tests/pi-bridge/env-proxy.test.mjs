import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { enableEnvProxyForFetch } from "@unclecode/pi-bridge";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("pi-ai fetches follow HTTPS_PROXY while loopback stays direct", async () => {
  const seen = [];
  const proxy = createServer((req, res) => {
    seen.push(`PLAIN ${req.url}`);
    res.writeHead(502).end();
  });
  proxy.on("connect", (req, socket) => {
    seen.push(`CONNECT ${req.url}`);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  const local = createServer((_req, res) => res.end("direct"));
  const proxyPort = await listen(proxy);
  const localPort = await listen(local);
  try {
    enableEnvProxyForFetch({
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: "",
    });

    await assert.rejects(fetch("https://provider.invalid/v1/models"));
    assert.deepEqual(seen, ["CONNECT provider.invalid:443"]);

    // The TUI talks to the runtime owner over loopback; a corporate proxy cannot reach it.
    const response = await fetch(`http://127.0.0.1:${localPort}/owner`);
    assert.equal(await response.text(), "direct");
    assert.deepEqual(seen, ["CONNECT provider.invalid:443"]);
  } finally {
    proxy.close();
    local.close();
  }
});
