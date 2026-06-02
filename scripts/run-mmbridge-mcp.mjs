#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const siblingDistEntrypoint = path.resolve(here, "../../mmbridge/packages/mcp/dist/index.js");

function fileExists(filePath) {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isLikelyPath(value) {
  return value.startsWith(".") || value.startsWith("/") || value.includes(path.sep);
}

async function main() {
  const override = process.env.MMBRIDGE_MCP_ENTRYPOINT?.trim();
  if (override) {
    if (isLikelyPath(override) && fileExists(override)) {
      await import(pathToFileURL(path.resolve(override)).href);
      return;
    }

    if (isLikelyPath(override)) {
      process.stderr.write(
        [
          "[unclecode] MMBRIDGE_MCP_ENTRYPOINT points to a file that is not readable.",
          `- Override: ${override}`,
          `- Resolved: ${path.resolve(override)}`,
          "- Build mmbridge first or point MMBRIDGE_MCP_ENTRYPOINT at packages/mcp/dist/index.js.",
        ].join("\n") + "\n",
      );
      process.exit(1);
    }

    const child = spawn(override, process.argv.slice(2), { stdio: "inherit", env: process.env });
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 0);
    });
    child.on("error", (error) => {
      process.stderr.write(
        [
          "[unclecode] Failed to launch MMBRIDGE_MCP_ENTRYPOINT command.",
          `- Override command: ${override}`,
          `- Error: ${error.message}`,
        ].join("\n") + "\n",
      );
      process.exit(1);
    });
    return;
  }

  if (fileExists(siblingDistEntrypoint)) {
    await import(pathToFileURL(siblingDistEntrypoint).href);
    return;
  }

  const child = spawn("mmbridge-mcp", process.argv.slice(2), { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
  child.on("error", (error) => {
    process.stderr.write(
      [
        "[unclecode] Could not locate mmbridge-mcp.",
        `- Expected sibling build: ${siblingDistEntrypoint}`,
        `- PATH fallback command: mmbridge-mcp`,
        `- PATH fallback error: ${error.message}`,
        "- Or set MMBRIDGE_MCP_ENTRYPOINT to a local mmbridge MCP entrypoint.",
        "- Or install @mmbridge/mcp globally so `mmbridge-mcp` is on PATH.",
      ].join("\n") + "\n",
    );
    process.exit(1);
  });
}

await main();
