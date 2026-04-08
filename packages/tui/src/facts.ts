import { execSync } from "node:child_process";
import os from "node:os";

export function getGitBranch(cwd: string): string {
  try {
    return execSync("git branch --show-current", { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return "unknown";
  }
}

export function getGitStatus(cwd: string): string {
  try {
    const status = execSync("git status --porcelain", { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    if (!status) return "clean";
    const lines = status.split("\n").length;
    return `${lines} modified`;
  } catch {
    return "unknown";
  }
}

export function getRuntimeFacts() {
  return {
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
  };
}
