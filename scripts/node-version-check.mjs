#!/usr/bin/env node
// Verifies that .nvmrc, engines.node, and the current node runtime are aligned.
// Avoids adding a `semver` dependency by parsing only what we need:
//   - .nvmrc must be `MAJOR.MINOR.PATCH`
//   - engines.node must be a space-separated list of `>=|<=|<|>|~|^X.Y.Z`
//   - .nvmrc and current process.version must satisfy every constraint

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const NVMRC_PATH = resolve(REPO_ROOT, ".nvmrc");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");

function fail(message) {
	process.stderr.write(`  ✗ ${message}\n`);
	process.exit(1);
}

function parseVersion(raw) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
	if (!match) return null;
	return { major: +match[1], minor: +match[2], patch: +match[3] };
}

function compare(a, b) {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}

function evaluateConstraint(version, op, target) {
	const cmp = compare(version, target);
	switch (op) {
		case ">=":
			return cmp >= 0;
		case "<=":
			return cmp <= 0;
		case ">":
			return cmp > 0;
		case "<":
			return cmp < 0;
		case "^":
			return (
				compare(version, { ...target, minor: target.minor + 1, patch: 0 }) < 0 &&
				compare(version, target) >= 0 &&
				version.major === target.major
			);
		case "~":
			return (
				version.major === target.major &&
				version.minor === target.minor &&
				version.patch >= target.patch
			);
		case "":
		case "=":
			return compare(version, target) === 0;
		default:
			throw new Error(`unsupported operator '${op}'`);
	}
}

function expandPartialVersion(target) {
	// Accept "24" → "24.0.0", "24.2" → "24.2.0", "24.2.1" → unchanged.
	const parts = target.split(".").map((n) => +n);
	while (parts.length < 3) parts.push(0);
	return { major: parts[0], minor: parts[1], patch: parts[2] };
}

function satisfiesAll(version, range) {
	const parts = range
		.split(/\s+(?=[<>=^~])/g)
		.map((p) => p.trim())
		.filter(Boolean);
	return parts.every((part) => {
		const match = /^(>=|<=|>|<|~|\^|)?\s*(\d+(?:\.\d+){0,2})$/.exec(part);
		if (!match) throw new Error(`unsupported range fragment '${part}'`);
		const op = match[1] ?? "=";
		const target = expandPartialVersion(match[2]);
		return evaluateConstraint(version, op, target);
	});
}

async function main() {
	const nvmrcRaw = (await readFile(NVMRC_PATH, "utf8")).trim();
	const nvmrc = parseVersion(nvmrcRaw);
	if (!nvmrc) fail(`.nvmrc contains a non-Semver value: '${nvmrcRaw}'`);

	const pkg = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8"));
	const range = pkg?.engines?.node;
	if (typeof range !== "string" || !range) fail("package.json has no engines.node field");

	const current = parseVersion(process.versions.node);
	if (!current) fail(`process.versions.node is unparseable: ${process.versions.node}`);

	if (!satisfiesAll(nvmrc, range)) {
		fail(`.nvmrc (${nvmrcRaw}) does not satisfy engines.node (${range})`);
	}
	if (!satisfiesAll(current, range)) {
		fail(`current node (${process.versions.node}) does not satisfy engines.node (${range})`);
	}

	process.stdout.write(
		`  ✓ .nvmrc (${nvmrcRaw}) and current node (${process.versions.node}) satisfy engines.node (${range})\n`,
	);
}

main().catch((err) => {
	process.stderr.write(`node:check failed: ${err.message}\n`);
	process.exit(1);
});
