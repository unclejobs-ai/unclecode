import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { createOmpWorkspaceTools } from "../../../packages/providers/src/omp-workspace-tools.ts";

const root = realpathSync(process.argv[2]!);
const workspace = path.join(root, "workspace");
const outside = path.join(root, "outside");
mkdirSync(path.join(workspace, "src"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(path.join(workspace, "src", "one.txt"), "alpha\nbeta\n");

const tools = new Map(createOmpWorkspaceTools(workspace, (definition) => definition)
  .map((tool: any) => [tool.name, tool]));
await tools.get("write")!.execute("write-1", { path: "src/two.txt", content: "needle\n" });
await tools.get("edit")!.execute("edit-1", {
  path: "src/two.txt",
  old_string: "needle",
  new_string: "changed",
});

const raceParent = path.join(workspace, "race");
const heldParent = path.join(workspace, "race-held");
mkdirSync(raceParent);
writeFileSync(path.join(raceParent, "victim.txt"), "inside\n");
writeFileSync(path.join(outside, "victim.txt"), "outside-owner-data\n");
let raceHookCalls = 0;
const racingTools = new Map(createOmpWorkspaceTools(
  workspace,
  (definition) => definition,
  {
    beforeAnchoredWriteOpen() {
      raceHookCalls += 1;
      renameSync(raceParent, heldParent);
      symlinkSync(outside, raceParent, "dir");
    },
  },
).map((tool: any) => [tool.name, tool]));

let raceRejected = false;
try {
  await racingTools.get("write")!.execute("write-race", {
    path: "race/victim.txt",
    content: "attacker-controlled\n",
  });
} catch {
  raceRejected = true;
}

process.stdout.write(JSON.stringify({
  wrote: readFileSync(path.join(workspace, "src", "two.txt"), "utf8"),
  raceHookCalls,
  raceRejected,
  outside: readFileSync(path.join(outside, "victim.txt"), "utf8"),
  original: readFileSync(path.join(heldParent, "victim.txt"), "utf8"),
}));
