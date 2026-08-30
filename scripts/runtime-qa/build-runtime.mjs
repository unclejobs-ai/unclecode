import { run } from "./cli-helpers.mjs";

export async function buildRuntimeForQa(runStep = run) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await runStep(npmCommand, ["run", "build", "--silent"], process.env);
  await runStep("cargo", ["build", "--quiet", "-p", "unclecode"], process.env);
}
