import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const source = process.env.SECOND_CLAUDE_CORE_TARBALL?.trim();
if (!source) {
  process.stderr.write(
    "Set SECOND_CLAUDE_CORE_TARBALL to a prebuilt @second-claude/core tarball.\n",
  );
  process.exitCode = 2;
} else {
  const tarball = resolve(source);
  if (!existsSync(tarball)) {
    process.stderr.write(`Local SCC core tarball does not exist: ${tarball}\n`);
    process.exitCode = 2;
  } else {
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-save",
        "--package-lock=false",
        tarball,
      ],
      { stdio: "inherit" },
    );
    process.exitCode = result.status ?? 1;
  }
}
