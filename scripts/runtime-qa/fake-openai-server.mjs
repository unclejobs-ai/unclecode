import http from "node:http";

import {
  openAIToolCallFinalResponseText,
  openAIToolCallId,
  openAIToolCallShellOutput,
} from "./constants.mjs";

export function startOpenAIChatServer(onRequest) {
  let count = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      count += 1;
      const parsed = JSON.parse(body || "{}");
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const lastMessage = messages.at(-1) ?? {};
      const lastMessageRole = typeof lastMessage.role === "string" ? lastMessage.role : "";
      const lastMessageContent = typeof lastMessage.content === "string" ? lastMessage.content : "";
      const toolCallId = typeof lastMessage.tool_call_id === "string" ? lastMessage.tool_call_id : "";
      onRequest({
        count,
        method: req.method,
        url: req.url,
        hasAuthorization: typeof req.headers.authorization === "string"
          && req.headers.authorization.startsWith("Bearer "),
        hasTools: JSON.stringify(parsed.tools ?? "").includes("run_shell"),
        messageCount: messages.length,
        lastMessageRole,
        lastMessageContent,
        hasToolResult: lastMessageRole === "tool" && lastMessageContent.includes(openAIToolCallShellOutput),
        toolCallId,
        toolCallIdMatched: toolCallId === openAIToolCallId,
        finalAnswerGatedByToolResult: lastMessageContent.includes(openAIToolCallShellOutput),
      });

      const message = count === 1
        ? {
          content: "",
          tool_calls: [{
            id: openAIToolCallId,
            function: {
              name: "run_shell",
              arguments: JSON.stringify({ command: `printf ${openAIToolCallShellOutput}` }),
            },
          }],
        }
        : { content: openAIToolCallFinalResponseText };
      const response = JSON.stringify({
        choices: [{ message }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(response),
        connection: "close",
      });
      res.end(response);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
