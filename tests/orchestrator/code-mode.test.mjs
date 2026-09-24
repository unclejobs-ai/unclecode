import assert from "node:assert/strict";
import test from "node:test";

import { createCodeModeToolRuntime, RUN_CODE_TOOL_NAME } from "@unclecode/orchestrator";

function fakeRuntime() {
  const calls = [];
  const definitions = [
    {
      name: "list_files",
      description: "List files in a directory.",
      input_schema: { type: "object", properties: { path: { type: "string", description: "Directory." } }, required: ["path"] },
    },
    {
      name: "read_file",
      description: "Read a file.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, mode: { type: "string", enum: ["text", "lines"] } },
        required: ["path"],
      },
    },
    {
      name: "ask_user",
      description: "Ask the user a question.",
      input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    },
  ];
  const executor = {
    async execute(request) {
      calls.push(request);
      if (request.toolName === "list_files") return { content: "a.txt\nb.txt" };
      if (request.toolName === "read_file") {
        return request.input.path === "missing.txt"
          ? { isError: true, content: "ENOENT: missing.txt" }
          : { content: `contents of ${request.input.path}` };
      }
      return { content: `direct:${request.toolName}` };
    },
  };
  return { runtime: { definitions, executor }, calls };
}

function runCode(runtime, code) {
  return runtime.executor.execute({ toolName: RUN_CODE_TOOL_NAME, input: { code }, cwd: "/work" });
}

test("run_code advertises the other tools as a typed API, without ask_user", () => {
  const { runtime } = fakeRuntime();
  const codeMode = createCodeModeToolRuntime(runtime);
  assert.deepEqual(codeMode.definitions.map((d) => d.name), ["run_code", "list_files", "read_file", "ask_user"]);
  const description = codeMode.definitions[0].description;
  assert.match(description, /list_files\(input: \{ path: string \}\): Promise<string>/);
  assert.match(description, /read_file\(input: \{ path: string; mode\?: "text" \| "lines" \}\): Promise<string>/);
  assert.doesNotMatch(description, /ask_user\(/);
});

test("code chains tool calls through the policy executor and returns only its result", async () => {
  const { runtime, calls } = fakeRuntime();
  const result = await runCode(createCodeModeToolRuntime(runtime), `
    const names = (await tools.list_files({ path: "." })).split("\\n");
    const bodies = await Promise.all(names.map((path) => tools.read_file({ path })));
    console.log("read", bodies.length);
    return bodies.map((body) => body.length);
  `);
  assert.equal(result.isError, undefined);
  assert.match(result.content, /\[\s*17,\s*17\s*\]/);
  assert.match(result.content, /read 2/);
  assert.match(result.content, /list_files ×1, read_file ×2/);
  assert.deepEqual(calls.map((c) => [c.toolName, c.cwd]), [["list_files", "/work"], ["read_file", "/work"], ["read_file", "/work"]]);
});

test("a failed nested tool call throws inside the code so it can be caught", async () => {
  const { runtime } = fakeRuntime();
  const result = await runCode(createCodeModeToolRuntime(runtime), `
    try { await tools.read_file({ path: "missing.txt" }); return "no error"; }
    catch (error) { return "caught: " + error.message; }
  `);
  assert.match(result.content, /caught: ENOENT: missing\.txt/);
});

test("code cannot reach the filesystem, secrets, or ask_user even by escaping the context", async () => {
  process.env.CODE_MODE_TEST_SECRET = "must-not-leak";
  try {
    const { runtime, calls } = fakeRuntime();
    const result = await runCode(createCodeModeToolRuntime(runtime), `
      const probes = { require: typeof require, process: typeof process, fetch: typeof fetch };
      const host = tools.list_files.constructor.constructor("return process")();
      try { host.getBuiltinModule("node:fs").readFileSync("/etc/hosts"); probes.fs = "open"; }
      catch (error) { probes.fs = error.code; }
      probes.secret = host.env.CODE_MODE_TEST_SECRET ?? "absent";
      try { await tools.ask_user({ question: "?" }); } catch (error) { probes.askUser = error.message; }
      return probes;
    `);
    const probes = JSON.parse(result.content.split("\n\n")[0]);
    assert.deepEqual(
      { ...probes, askUser: probes.askUser.includes("not available") },
      { require: "undefined", process: "undefined", fetch: "undefined", fs: "ERR_ACCESS_DENIED", secret: "absent", askUser: true },
    );
    assert.equal(calls.length, 0);
  } finally {
    delete process.env.CODE_MODE_TEST_SECRET;
  }
});

test("runaway code is stopped at the time limit", async () => {
  const { runtime } = fakeRuntime();
  const result = await createCodeModeToolRuntime(runtime, { timeoutMs: 1_000 }).executor.execute({
    toolName: RUN_CODE_TOOL_NAME,
    input: { code: "while (true) {}" },
    cwd: "/work",
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /time limit/);
});

test("other tools pass straight through", async () => {
  const { runtime, calls } = fakeRuntime();
  const result = await createCodeModeToolRuntime(runtime).executor.execute({ toolName: "list_files", input: { path: "." }, cwd: "/w" });
  assert.equal(result.content, "a.txt\nb.txt");
  assert.equal(calls.length, 1);
});

test("each nested call is reported as it starts and completes", async () => {
  const { runtime } = fakeRuntime();
  const events = [];
  const codeMode = createCodeModeToolRuntime(runtime, { onNestedCall: (event) => events.push(event) });
  await runCode(codeMode, `await tools.read_file({ path: "missing.txt" }).catch(() => null); return await tools.list_files({ path: "." });`);
  assert.deepEqual(
    events.map((e) => [e.phase, e.toolName, e.isError ?? null]),
    [["started", "read_file", null], ["completed", "read_file", true], ["started", "list_files", null], ["completed", "list_files", false]],
  );
  assert.equal(new Set(events.map((e) => e.callId)).size, 2);
  assert.deepEqual(events[0].input, { path: "missing.txt" });
});

test("TypeScript code that restates the tools declaration still runs", async () => {
  const { runtime } = fakeRuntime();
  const result = await runCode(createCodeModeToolRuntime(runtime), `
    declare const tools: { list_files(input: { path: string }): Promise<string> };
    const names: string[] = (await tools.list_files({ path: "." })).split("\\n");
    return names.length as number;
  `);
  assert.equal(result.isError, undefined, result.content);
  assert.match(result.content, /^2\n/);
});
