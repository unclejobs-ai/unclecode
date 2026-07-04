import http from "node:http";

import {
  openAIStreamChunkTexts,
  openAIStreamPromptText,
  openAIToolCallFinalResponseText,
  openAIToolCallId,
  openAIToolCallShellOutput,
} from "./constants.mjs";
import { extractRuntimeQaUserRequest } from "./fake-gemini-server.mjs";

export function startOpenAIChatServer(onRequest, options = {}) {
  const streamChunkDelayMs = options.streamChunkDelayMs ?? 0;
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
      const wantsStream = parsed.stream === true;
      const userRequest = lastMessageRole === "user"
        ? extractRuntimeQaUserRequest(lastMessageContent)
        : "";
      onRequest({
        count,
        method: req.method,
        url: req.url,
        hasAuthorization: typeof req.headers.authorization === "string"
          && req.headers.authorization.startsWith("Bearer "),
        hasTools: JSON.stringify(parsed.tools ?? "").includes("run_shell"),
        stream: wantsStream,
        messageCount: messages.length,
        lastMessageRole,
        lastMessageContent,
        hasToolResult: lastMessageRole === "tool" && lastMessageContent.includes(openAIToolCallShellOutput),
        toolCallId,
        toolCallIdMatched: toolCallId === openAIToolCallId,
        finalAnswerGatedByToolResult: lastMessageContent.includes(openAIToolCallShellOutput),
      });

      // The multi-chunk streaming reply is routed by prompt text (mirrors
      // the fake Gemini server) so the count-based tool-call contract below
      // stays untouched for the tool-loop smokes.
      if (userRequest === openAIStreamPromptText) {
        respondWithContentStream(res, {
          chunkTexts: openAIStreamChunkTexts,
          chunkDelayMs: streamChunkDelayMs,
        });
        return;
      }

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

      if (wantsStream) {
        respondWithMessageStream(res, message);
        return;
      }

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

function writeSseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
  });
}

function writeSseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function finishSse(res) {
  writeSseChunk(res, {
    id: "chatcmpl-runtime-qa",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Stream one message (content or tool_calls) as chat-completions SSE while
 * preserving the non-streaming contract: tool_calls arrive as deltas that
 * assemble into the same call id/name/arguments the JSON response carries.
 */
function respondWithMessageStream(res, message) {
  writeSseHead(res);
  writeSseChunk(res, {
    id: "chatcmpl-runtime-qa",
    choices: [{ index: 0, delta: { role: "assistant" } }],
  });
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    message.tool_calls.forEach((toolCall, index) => {
      writeSseChunk(res, {
        id: "chatcmpl-runtime-qa",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: toolCall.id,
              function: { name: toolCall.function.name, arguments: "" },
            }],
          },
        }],
      });
      writeSseChunk(res, {
        id: "chatcmpl-runtime-qa",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index, function: { arguments: toolCall.function.arguments } }],
          },
        }],
      });
    });
  } else if (typeof message.content === "string" && message.content.length > 0) {
    writeSseChunk(res, {
      id: "chatcmpl-runtime-qa",
      choices: [{ index: 0, delta: { content: message.content } }],
    });
  }
  finishSse(res);
}

/**
 * Stream a content-only reply in multiple delayed chunks so the TUI smoke
 * can capture partial text plus the streaming cursor mid-turn.
 */
function respondWithContentStream(res, { chunkTexts, chunkDelayMs }) {
  writeSseHead(res);
  writeSseChunk(res, {
    id: "chatcmpl-runtime-qa",
    choices: [{ index: 0, delta: { role: "assistant" } }],
  });

  const pending = [...chunkTexts];
  const writeNext = () => {
    const next = pending.shift();
    if (next === undefined) {
      finishSse(res);
      return;
    }
    writeSseChunk(res, {
      id: "chatcmpl-runtime-qa",
      choices: [{ index: 0, delta: { content: next } }],
    });
    setTimeout(writeNext, chunkDelayMs);
  };
  writeNext();
}
