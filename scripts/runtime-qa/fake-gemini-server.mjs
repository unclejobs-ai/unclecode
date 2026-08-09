import http from "node:http";

import {
  fullTuiResponseText,
  koreanBusyPromptText,
  koreanBusyResponseText,
  realUseFirstPromptText,
  realUseFirstResponseText,
  realUseQueuedPromptText,
  realUseQueuedResponseText,
  responseText,
  toolCallFinalResponseText,
  toolCallId,
  toolCallPromptText,
  toolCallShellOutput,
  ttyResponseText,
  yoloGreetingResponseText,
  parallelModeKoreanPromptText,
  parallelModeKoreanLeakyResponseText,
} from "./constants.mjs";

export function startGeminiServer(onRequest) {
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
      const requestText = latestGeminiUserText(parsed);
      const functionResponse = latestGeminiFunctionResponse(parsed);
      const functionResponseText = functionResponse ? JSON.stringify(functionResponse) : "";
      const currentUserRequest = extractRuntimeQaUserRequest(requestText);
      onRequest({
        count,
        url: req.url,
        hasApiKey: Boolean(req.headers["x-goog-api-key"]),
        hasConfig: Object.hasOwn(parsed, "config"),
        hasModel: Object.hasOwn(parsed, "model"),
        hasTools: JSON.stringify(parsed.tools ?? "").includes("run_shell"),
        hasFunctionResponse: functionResponseText.length > 0,
        functionResponseText,
        functionResponseId: typeof functionResponse?.id === "string" ? functionResponse.id : "",
        functionResponseName: typeof functionResponse?.name === "string" ? functionResponse.name : "",
        functionResponseIdMatched: functionResponse?.id === toolCallId,
        functionResponseNameMatched: functionResponse?.name === "run_shell",
        finalAnswerGatedByToolResult: functionResponseText.includes(toolCallShellOutput),
        contentCount: Array.isArray(parsed.contents) ? parsed.contents.length : 0,
        text: requestText,
      });
      let text = responseText;
      let responseParts;
      if (functionResponseText.includes(toolCallShellOutput)) {
        text = toolCallFinalResponseText;
      } else if (currentUserRequest === toolCallPromptText) {
        responseParts = [{
          functionCall: {
            id: toolCallId,
            name: "run_shell",
            args: { command: `printf ${toolCallShellOutput}` },
          },
        }];
      } else if (requestText.includes("Break this request into 2-4 independent subtasks")) {
        text = JSON.stringify([
          {
            id: "subtask-1",
            summary: "Planner leak sentinel",
            prompt: "If this appears for a greeting, YOLO routing regressed.",
          },
        ]);
      } else if (currentUserRequest === realUseQueuedPromptText) {
        text = realUseQueuedResponseText;
      } else if (currentUserRequest === realUseFirstPromptText) {
        text = realUseFirstResponseText;
      } else if (currentUserRequest === "hi") {
        text = yoloGreetingResponseText;
      } else if (currentUserRequest.includes("full-screen TUI QA")) {
        text = fullTuiResponseText;
      } else if (currentUserRequest.includes("runtime TTY QA")) {
        text = ttyResponseText;
      } else if (currentUserRequest === koreanBusyPromptText) {
        text = koreanBusyResponseText;
      } else if (currentUserRequest === parallelModeKoreanPromptText) {
        text = parallelModeKoreanLeakyResponseText;
      }
      responseParts ??= [{ text }];
      const respond = () => {
        const response = JSON.stringify({
          candidates: [{ content: { parts: responseParts }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
        });
        const streaming = req.url?.includes(":streamGenerateContent") ?? false;
        const payload = streaming ? `data: ${response}\n\n` : response;
        res.writeHead(200, {
          "content-type": streaming ? "text/event-stream" : "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      };
      if (currentUserRequest === koreanBusyPromptText || currentUserRequest === realUseFirstPromptText) {
        setTimeout(respond, 1200);
        return;
      }
      respond();
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

function latestGeminiUserText(parsed) {
  const contents = Array.isArray(parsed?.contents) ? parsed.contents : [];
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const content = contents[index];
    if (content?.role !== "user" || !Array.isArray(content.parts)) {
      continue;
    }
    if (content.parts.some((part) => part?.functionResponse !== undefined)) {
      return "";
    }
    const text = content.parts
      .map((part) => typeof part?.text === "string" ? part.text : "")
      .filter((partText) => partText.length > 0)
      .join("\n");
    if (text) {
      return text;
    }
  }
  return "";
}

function latestGeminiFunctionResponse(parsed) {
  const contents = Array.isArray(parsed?.contents) ? parsed.contents : [];
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const content = contents[index];
    if (content?.role !== "user" || !Array.isArray(content.parts)) {
      continue;
    }
    const responsePart = content.parts.find((part) => part?.functionResponse !== undefined);
    if (responsePart?.functionResponse !== undefined) {
      return responsePart.functionResponse;
    }
  }
  return undefined;
}

export function extractRuntimeQaUserRequest(requestText) {
  const marker = "\n\nUser request:\n";
  const markerOffset = requestText.lastIndexOf(marker);
  if (markerOffset >= 0) {
    return requestText.slice(markerOffset + marker.length).trim();
  }
  return requestText.trim();
}
