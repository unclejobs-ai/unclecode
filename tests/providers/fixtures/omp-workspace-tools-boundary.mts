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
const read = (await tools.get("read")!.execute("read-1", { path: "src/one.txt" })).content[0].text;
const list = (await tools.get("read")!.execute("list-1", { path: "src" })).content[0].text;
const grep = (await tools.get("grep")!.execute("grep-1", { path: "src", pattern: "beta" })).content[0].text;
const glob = (await tools.get("glob")!.execute("glob-1", { path: "src/**/*.txt" })).content[0].text;
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

const readRaceParent = path.join(workspace, "read-race");
const readHeldParent = path.join(workspace, "read-race-held");
mkdirSync(readRaceParent);
writeFileSync(path.join(readRaceParent, "secret.txt"), "inside-readable\n");
writeFileSync(path.join(outside, "secret.txt"), "outside-secret-must-not-return\n");
let readRaceHookCalls = 0;
const readRacingTools = new Map(createOmpWorkspaceTools(
  workspace,
  (definition) => definition,
  {
    beforeAnchoredReadOpen() {
      readRaceHookCalls += 1;
      renameSync(readRaceParent, readHeldParent);
      symlinkSync(outside, readRaceParent, "dir");
    },
  },
).map((tool: any) => [tool.name, tool]));
let readRaceResult = "rejected";
try {
  readRaceResult = (await readRacingTools.get("read")!.execute("read-race", {
    path: "read-race/secret.txt",
  })).content[0].text;
} catch {
  // The descriptor-relative reopen must reject the swapped parent.
}

process.stdout.write(JSON.stringify({
  read,
  list,
  grep,
  glob,
  wrote: readFileSync(path.join(workspace, "src", "two.txt"), "utf8"),
  raceHookCalls,
  raceRejected,
  outside: readFileSync(path.join(outside, "victim.txt"), "utf8"),
  original: readFileSync(path.join(heldParent, "victim.txt"), "utf8"),
  readRaceHookCalls,
  readRaceResult,
}));
