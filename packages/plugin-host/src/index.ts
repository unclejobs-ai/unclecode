/**
 * Plugin host — UncleCode in-process extension point.
 *
 * A plugin is a TS module exporting either a default function or a named
 * `register(ctx)` that returns a partial Hooks record. Plugins live in
 * .unclecode/plugins/<name>.ts and are loaded by name; the host validates
 * each registration with a Zod schema before wiring.
 *
 * This commit ships the host shape + hook contract + Zod-validated
 * registration. Module-loader integration with the work-shell-engine
 * arrives in a follow-up; today the host accepts in-memory registrations
 * so tests + integration work can proceed in parallel.
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const HookKeysSchema = z.object({
  toolExecuteBefore: z.function().optional(),
  toolExecuteAfter: z.function().optional(),
  fileEdited: z.function().optional(),
  sessionCompacted: z.function().optional(),
  runStarted: z.function().optional(),
  runCompleted: z.function().optional(),
});

export type PluginHooks = {
  toolExecuteBefore?: (event: { toolName: string; input: Record<string, unknown> }) => Promise<void> | void;
  toolExecuteAfter?: (event: { toolName: string; output: string; isError: boolean }) => Promise<void> | void;
  fileEdited?: (event: { path: string; sha256: string }) => Promise<void> | void;
  sessionCompacted?: (event: { sessionId: string; messagesBefore: number; messagesAfter: number }) => Promise<void> | void;
  runStarted?: (event: { runId: string; persona?: string }) => Promise<void> | void;
  runCompleted?: (event: { runId: string; status: string }) => Promise<void> | void;
};

export type PluginContext = {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  log(message: string): void;
};

export type PluginRegistration = {
  readonly name: string;
  readonly hooks: PluginHooks;
};

export type PluginEntry = (ctx: PluginContext) => PluginHooks | Promise<PluginHooks>;

export class PluginHost {
  private readonly registrations: PluginRegistration[] = [];

  register(name: string, hooks: PluginHooks): void {
    HookKeysSchema.parse(hooks);
    this.registrations.push({ name, hooks });
  }

  async loadEntries(workspaceRoot: string, entries: ReadonlyArray<{ name: string; entry: PluginEntry }>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    for (const { name, entry } of entries) {
      const log = (message: string) => process.stderr.write(`[plugin:${name}] ${message}\n`);
      const hooks = await entry({ workspaceRoot, env, log });
      this.register(name, hooks);
    }
  }

  list(): ReadonlyArray<PluginRegistration> {
    return this.registrations.slice();
  }

  async dispatchToolExecuteBefore(event: { toolName: string; input: Record<string, unknown> }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.toolExecuteBefore?.(event);
    }
  }

  async dispatchToolExecuteAfter(event: { toolName: string; output: string; isError: boolean }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.toolExecuteAfter?.(event);
    }
  }

  async dispatchFileEdited(event: { path: string; sha256: string }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.fileEdited?.(event);
    }
  }

  async dispatchSessionCompacted(event: { sessionId: string; messagesBefore: number; messagesAfter: number }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.sessionCompacted?.(event);
    }
  }

  async dispatchRunStarted(event: { runId: string; persona?: string }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.runStarted?.(event);
    }
  }

  async dispatchRunCompleted(event: { runId: string; status: string }): Promise<void> {
    for (const reg of this.registrations) {
      await reg.hooks.runCompleted?.(event);
    }
  }
}

export function discoverPluginNames(workspaceRoot: string): ReadonlyArray<string> {
  const dir = resolve(workspaceRoot, ".unclecode", "plugins");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".mjs") || name.endsWith(".js"))
    .map((name) => name.replace(/\.(ts|mjs|js)$/, ""));
}
