// Acceptance helper: a local HTTP CONNECT proxy that tunnels traffic and logs each target.
// usage: node scripts/acceptance/connect-proxy.mjs <log-file>
// Prints `port=<n>` on stdout once listening; appends one `CONNECT host:port` line per tunnel.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";

const logFile = process.argv[2];
if (!logFile) throw new Error("usage: connect-proxy.mjs <log-file>");

const server = createServer((req, res) => {
  appendFileSync(logFile, `PLAIN ${req.method} ${req.url}\n`);
  res.writeHead(501).end();
});

server.on("connect", (req, clientSocket, head) => {
  appendFileSync(logFile, `CONNECT ${req.url}\n`);
  const [host, port] = String(req.url).split(":");
  const upstream = connect(Number(port) || 443, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on("error", close);
  clientSocket.on("error", close);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`port=${typeof address === "object" && address ? address.port : ""}\n`);
});
