#!/usr/bin/env node
// Verifies docs/provenance/manifest.json stays consistent with the current repo state.
// - Each manifest subsystem name must map to a real package or top-level subsystem.
// - Status "rewritten" requires non-empty src/ tree.
// - Status "clean-room-adapted" additionally requires docs/provenance/notes explaining the boundary.
// - product.version must match every package.json and the workspace root.

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const MANIFEST_PATH = join(REPO_ROOT, "docs/provenance/manifest.json");

const KNOWN_PACKAGE_HINTS = {
	contracts: "packages/contracts",
	"config-core": "packages/config-core",
	"session-store": "packages/session-store",
	"context-broker": "packages/context-broker",
	"policy-engine": "packages/policy-engine",
	"providers-auth": "packages/providers",
	"runtime-broker": "packages/runtime-broker",
	"mcp-host": "packages/mcp-host",
	"orchestrator-research": "packages/orchestrator",
	tui: "packages/tui",
	"cli-release-surface": "apps/unclecode-cli",
};

async function readJson(path) {
	const raw = await readFile(path, "utf8");
	return JSON.parse(raw);
}

async function readPackageVersion(path) {
	try {
		const pkg = await readJson(path);
		return pkg.version;
	} catch {
		return null;
	}
}

async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function fail(errors) {
	for (const e of errors) {
		process.stderr.write(`  ✗ ${e}\n`);
	}
	process.exit(1);
}

async function main() {
	const errors = [];
	const manifest = await readJson(MANIFEST_PATH);

	// 1) product.version matches every package.json
	const productVersion = manifest?.product?.version;
	if (typeof productVersion !== "string" || productVersion.length === 0) {
		errors.push("manifest.product.version missing");
	} else {
		const lockFiles = [join(REPO_ROOT, "package.json")];
		const packagesDir = join(REPO_ROOT, "packages");
		// Only UncleCode workspace products, not vendored prototypes (e.g. apps/godness-web).
		const appsDir = join(REPO_ROOT, "apps");
		if (await pathExists(packagesDir)) {
			for (const name of await readdir(packagesDir)) {
				lockFiles.push(join(packagesDir, name, "package.json"));
			}
		}
		if (await pathExists(appsDir)) {
			for (const name of await readdir(appsDir)) {
				if (!name.startsWith("unclecode")) continue;
				lockFiles.push(join(appsDir, name, "package.json"));
			}
		}
		let mismatched = 0;
		for (const file of lockFiles) {
			const v = await readPackageVersion(file);
			if (v && v !== productVersion) {
				errors.push(`version drift: ${file.replace(REPO_ROOT + "/", "")} = ${v} (manifest says ${productVersion})`);
				mismatched += 1;
			}
		}
		if (mismatched === 0) {
			process.stdout.write(`  ✓ product.version (${productVersion}) matches all ${lockFiles.length} package.json files\n`);
		}
	}

	// 2) every subsystem maps to a real path with non-empty src/
	const subsystems = manifest?.subsystems ?? {};
	const subsystemNames = Object.keys(subsystems);
	if (subsystemNames.length === 0) {
		errors.push("manifest.subsystems is empty");
	}
	for (const [name, entry] of Object.entries(subsystems)) {
		const status = entry?.status;
		if (!["rewritten", "clean-room-adapted", "inherited", "removed"].includes(status)) {
			errors.push(`subsystem '${name}' has unknown status '${status}'`);
			continue;
		}
		if (status === "removed") continue;

		const hint = KNOWN_PACKAGE_HINTS[name];
		if (!hint) {
			errors.push(`subsystem '${name}' is not in KNOWN_PACKAGE_HINTS; add a mapping if intentional`);
			continue;
		}
		const target = join(REPO_ROOT, hint);
		if (!existsSync(target)) {
			errors.push(`subsystem '${name}' path missing: ${hint}`);
			continue;
		}
		const src = join(target, "src");
		if (await pathExists(src)) {
			const entries = await readdir(src);
			const tsFiles = entries.filter((e) => e.endsWith(".ts") || e.endsWith(".rs"));
			if (tsFiles.length === 0) {
				errors.push(`subsystem '${name}' (${hint}/src) has no .ts/.rs files`);
			} else {
				process.stdout.write(`  ✓ ${name} (${status}, ${tsFiles.length} source files)\n`);
			}
		} else {
			errors.push(`subsystem '${name}' (${hint}) has no src/ directory`);
		}
	}

	if (errors.length > 0) fail(errors);
	process.stdout.write(`\nProvenance manifest: ${subsystemNames.length} subsystems verified.\n`);
}

main().catch((err) => {
	process.stderr.write(`provenance:check failed: ${err.message}\n`);
	process.exit(1);
});
