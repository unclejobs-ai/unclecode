import { readFileSync } from "node:fs";

import { loadOmpWorkerRuntime } from "../../../packages/providers/src/omp-worker-entry.ts";
import { canonicalizeOmpWorkspaceRoot } from "../../../packages/providers/src/omp-workspace-tools.ts";

const workspace = process.argv[2];
if (!workspace) throw new Error("workspace argument is required");

const runtime = await loadOmpWorkerRuntime(process.env);
const canonical = await canonicalizeOmpWorkspaceRoot(workspace);
const workspaceTools = await runtime.createWorkspaceTools(canonical);
const tools = new Map(workspaceTools.map((tool: any) => [tool.name, tool]));
await tools.get("write")!.execute("write", { path: "safe.txt", content: "contained\n" });

let escapeRejected = false;
try {
  await tools.get("read")!.execute("read", { path: "../outside.txt" });
} catch {
  escapeRejected = true;
}

const authStorage = await runtime.createAuthStorage();
let session: any;
let activeNames: string[] = [];
let enabledNames: string[] = [];
let builtInNames: string[] = [];
try {
  const modelRegistry = runtime.createModelRegistry(authStorage);
  const model = modelRegistry.find("kimi-code", "k3");
  if (!model) throw new Error("installed OMP does not expose kimi-code/k3");
  const created = await runtime.createAgentSession({
    cwd: canonical,
    model,
    authStorage,
    modelRegistry,
    sessionManager: runtime.createSessionManager(canonical),
    settings: await runtime.createSettings(canonical),
    thinkingLevel: "off",
    enableMCP: false,
    disableExtensionDiscovery: true,
    skills: [],
    toolNames: [...tools.keys()],
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    customTools: workspaceTools,
    autoApprove: false,
  });
  session = created.session;
  activeNames = session.getActiveToolNames();
  enabledNames = session.getEnabledToolNames();
  builtInNames = activeNames.filter((name) => session.hasBuiltInTool(name));
} finally {
  if (session) await session.dispose();
  authStorage.close();
}

process.stdout.write(JSON.stringify({
  names: [...tools.keys()],
  activeNames,
  enabledNames,
  builtInNames,
  wrote: readFileSync(`${canonical}/safe.txt`, "utf8"),
  escapeRejected,
}));
