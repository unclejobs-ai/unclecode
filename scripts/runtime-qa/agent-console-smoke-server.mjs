import http from "node:http";

export const PROMPT_TEXT = "Refactor the agent console QA lanes end to end.";
export const ALPHA = "Console lane alpha";
export const BETA = "Console lane beta";
export const STEER_MESSAGE = "Follow the console QA checklist for lane alpha.";

const ALPHA_MARKER = "AGENT_CONSOLE_QA_LANE_ALPHA";
const BETA_MARKER = "AGENT_CONSOLE_QA_LANE_BETA";
const ALPHA_FIRST_TEXT = "AGENT_CONSOLE_QA_ALPHA_FIRST_OK";
const ALPHA_STEERED_TEXT = "AGENT_CONSOLE_QA_ALPHA_STEERED_OK";
const BETA_UNREACHED_TEXT = "AGENT_CONSOLE_QA_BETA_UNREACHED";
const FINAL_TEXT = "AGENT_CONSOLE_QA_FINAL_OK";
const GOAL = "Agent Console runtime QA fixture";
const PLANNER_MARKER = "<goal_task_planner>";
const STEER_MARKER = "Operator guidance:";

// Doc-only write paths keep the guardian phase cheap: no source/test/config
// file enters the change set, so the turn never launches project validation.
const PLAN = ["alpha", "beta"].map((lane, index) => ({
  id: `task-${index + 1}`,
  summary: lane === "alpha" ? ALPHA : BETA,
  prompt: `${lane === "alpha" ? ALPHA_MARKER : BETA_MARKER} — hold this console lane open.`,
  goal: GOAL,
  constraints: ["Touch only the lane fixture note"],
  acceptanceCriteria: [`Lane ${lane} reports its marker`],
  dependsOn: [],
  writePaths: [`docs/agent-console-qa-${lane}.md`],
}));

// One loopback server scripts both boundaries. Gemini requests receive the
// fixed planner/final replies; executor requests park until released or closed.
export function startAgentConsoleControlServer() {
  const geminiRequests = [];
  const lanes = [];
  const released = new Set();
  const parked = new Map();
  const observedLanes = new Set();
  const laneWaiters = new Map();

  const respond = (res, contentType, payload) => {
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  const respondExecutor = (res, text) => respond(res, "application/json", JSON.stringify({ text }));

  const respondGemini = (req, res, text) => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 },
    });
    const streaming = req.url?.includes(":streamGenerateContent") ?? false;
    respond(
      res,
      streaming ? "text/event-stream" : "application/json",
      streaming ? `data: ${body}\n\n` : body,
    );
  };

  const recordLane = (lane) => {
    observedLanes.add(lane);
    const waiters = laneWaiters.get(lane);
    if (!waiters) return;
    laneWaiters.delete(lane);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };

  const waitForLane = (lane, timeoutMs = 30_000) => {
    if (observedLanes.has(lane)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiters = laneWaiters.get(lane) ?? new Set();
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for executor lane ${lane}`));
        }, timeoutMs),
      };
      waiters.add(waiter);
      laneWaiters.set(lane, waiters);
    });
  };

  const handleExecutorTurn = (res, body) => {
    const request = JSON.parse(body || "{}");
    const lane = resolveExecutorLane(typeof request.prompt === "string" ? request.prompt : "");
    lanes.push(lane);
    recordLane(lane);
    if (lane === "steer") {
      respondExecutor(res, ALPHA_STEERED_TEXT);
      return;
    }
    const finish = () => respondExecutor(
      res,
      lane === "alpha" ? ALPHA_FIRST_TEXT : BETA_UNREACHED_TEXT,
    );
    if (released.has(lane)) {
      finish();
      return;
    }
    parked.set(lane, finish);
    res.on("close", () => {
      if (parked.get(lane) === finish) {
        parked.delete(lane);
      }
    });
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url?.startsWith("/omp")) {
        handleExecutorTurn(res, body);
        return;
      }
      const prompt = latestGeminiUserText(JSON.parse(body || "{}"));
      geminiRequests.push({ url: req.url ?? "", prompt });
      respondGemini(req, res, prompt.includes(PLANNER_MARKER) ? JSON.stringify(PLAN) : FINAL_TEXT);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        geminiRequestCount: () => geminiRequests.length,
        executorLanes: () => [...lanes].sort(),
        waitForLane,
        releaseLane: (lane) => {
          released.add(lane);
          const finish = parked.get(lane);
          if (finish) {
            parked.delete(lane);
            finish();
          }
        },
        close: () => new Promise((done) => {
          for (const [lane, finish] of [...parked]) {
            parked.delete(lane);
            finish();
          }
          for (const waiters of laneWaiters.values()) {
            for (const waiter of waiters) {
              clearTimeout(waiter.timer);
              waiter.reject(new Error("Agent Console control server closed"));
            }
          }
          laneWaiters.clear();
          server.closeAllConnections?.();
          server.close(done);
        }),
      });
    });
  });
}

function resolveExecutorLane(prompt) {
  if (prompt.includes(STEER_MARKER)) return "steer";
  if (prompt.includes(ALPHA_MARKER)) return "alpha";
  if (prompt.includes(BETA_MARKER)) return "beta";
  return "unknown";
}

function latestGeminiUserText(parsed) {
  const contents = Array.isArray(parsed?.contents) ? parsed.contents : [];
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const entry = contents[index];
    if (typeof entry?.role === "string" && entry.role !== "user") {
      continue;
    }
    const parts = Array.isArray(entry?.parts) ? entry.parts : [];
    const text = parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
    if (text.trim().length > 0) {
      return text;
    }
  }
  return "";
}
