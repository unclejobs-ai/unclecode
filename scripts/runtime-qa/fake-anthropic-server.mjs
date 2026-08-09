import http from "node:http";

import {
  anthropicToolCallFinalResponseText,
  anthropicToolCallId,
  anthropicToolCallShellOutput,
} from "./constants.mjs";

export function startAnthropicMessagesServer(onRequest) {
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
      const lastMessageText = anthropicMessageText(lastMessage);
      const toolResultBlock = Array.isArray(lastMessage.content)
        ? lastMessage.content.find((block) => block?.type === "tool_result")
        : undefined;
      const toolResultContent = typeof toolResultBlock?.content === "string" ? toolResultBlock.content : "";
      onRequest({
        count,
        method: req.method,
        url: req.url,
        hasApiKey: typeof req.headers["x-api-key"] === "string",
        hasVersion: typeof req.headers["anthropic-version"] === "string",
        hasTools: JSON.stringify(parsed.tools ?? "").includes("run_shell"),
        messageCount: messages.length,
        lastMessageRole,
        lastMessageText,
        hasToolResult: toolResultContent.includes(anthropicToolCallShellOutput),
        toolUseId: typeof toolResultBlock?.tool_use_id === "string" ? toolResultBlock.tool_use_id : "",
        toolUseIdMatched: toolResultBlock?.tool_use_id === anthropicToolCallId,
        toolResultContent,
        finalAnswerGatedByToolResult: toolResultContent.includes(anthropicToolCallShellOutput),
      });

      const content = count === 1
        ? [{
          type: "tool_use",
          id: anthropicToolCallId,
          name: "run_shell",
          input: { command: `printf ${anthropicToolCallShellOutput}` },
        }]
        : [{ type: "text", text: anthropicToolCallFinalResponseText }];
      const stopReason = count === 1 ? "tool_use" : "end_turn";
      if (parsed.stream === true) {
        respondWithAnthropicStream(res, {
          id: `msg_runtime_anthropic_${count}`,
          content,
          stopReason,
        });
        return;
      }
      const response = JSON.stringify({
        id: `msg_runtime_anthropic_${count}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content,
        stop_reason: stopReason,
        usage: { input_tokens: 10, output_tokens: 4 },
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

function anthropicMessageText(message) {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((block) => {
      if (typeof block?.text === "string") {
        return block.text;
      }
      if (typeof block?.content === "string") {
        return block.content;
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function respondWithAnthropicStream(res, { id, content, stopReason }) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
  });
  writeAnthropicEvent(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  const block = content[0];
  if (block.type === "tool_use") {
    writeAnthropicEvent(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: {},
      },
    });
    writeAnthropicEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(block.input),
      },
    });
  } else {
    writeAnthropicEvent(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    writeAnthropicEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: block.text },
    });
  }
  writeAnthropicEvent(res, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  writeAnthropicEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 4 },
  });
  writeAnthropicEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

function writeAnthropicEvent(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
