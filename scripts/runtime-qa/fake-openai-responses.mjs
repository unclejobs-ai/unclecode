import {
  openAIToolCallId,
  openAIToolCallShellOutput,
} from "./constants.mjs";

export function responseItemText(item) {
  if (item?.type === "function_call_output") {
    return typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
  }
  if (!Array.isArray(item?.content)) {
    return "";
  }
  return item.content
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .join("");
}

export function latestResponsesUserText(input) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.role === "user") {
      return responseItemText(input[index]);
    }
  }
  return "";
}

export function respondWithResponsesToolCall(res) {
  const item = {
    id: "fc_runtime_tool_item_1",
    type: "function_call",
    call_id: openAIToolCallId,
    name: "run_shell",
    arguments: JSON.stringify({ command: `printf ${openAIToolCallShellOutput}` }),
    status: "completed",
  };
  writeSseHead(res);
  writeSseChunk(res, {
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  writeSseChunk(res, {
    type: "response.completed",
    response: {
      id: "resp_runtime_tool_1",
      status: "completed",
      output: [item],
      usage: responsesUsage(),
    },
  });
  res.end();
}

export function respondWithResponsesContentStream(res, { chunkTexts, chunkDelayMs }) {
  const itemId = "msg_runtime_qa_1";
  const completeText = chunkTexts.join("");
  writeSseHead(res);
  writeSseChunk(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  });

  const pending = [...chunkTexts];
  const writeNext = () => {
    const next = pending.shift();
    if (next === undefined) {
      const item = {
        id: itemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: completeText, annotations: [] }],
      };
      writeSseChunk(res, {
        type: "response.output_item.done",
        output_index: 0,
        item,
      });
      writeSseChunk(res, {
        type: "response.completed",
        response: {
          id: "resp_runtime_text_1",
          status: "completed",
          output: [item],
          usage: responsesUsage(),
        },
      });
      res.end();
      return;
    }
    writeSseChunk(res, {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: next,
    });
    setTimeout(writeNext, chunkDelayMs);
  };
  writeNext();
}

function responsesUsage() {
  return {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
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
