#!/usr/bin/env node
/**
 * Light CI check for the example apps (ticket 15), no stack boot.
 *
 * The typecheck half is `npm run check:types` (tsconfig.check.json includes
 * `examples/**`, so every example compiles against the SDK sources). This
 * script covers what that cannot see:
 *
 *   1. every landed example still has its README and entrypoint (the
 *      dispatcher resolves `examples/<name>/main.ts`, so a rename that misses
 *      the docs or deletes the entry fails here);
 *   2. the built package entry the edge/mcp examples import at run time
 *      (`@nervly/sdk` → `dist/esm/index.js`) exists and is not older than the
 *      SDK sources — the same stale-dist rule each example's harness enforces
 *      at run time, so a broken build cannot silently pass.
 *
 * Run with `npm run check:examples` (CI: the Examples job in
 * .github/workflows/ci.yml). The root suite that runs the examples against a
 * booted stack lives in nervly-base (scripts/examples-suite.sh).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Newest mtime (ms) anywhere under `dir`; 0 when the directory is missing. */
function newestMtimeMs(dir) {
	if (!existsSync(dir)) return 0;
	let newest = 0;
	for (const child of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, child.name);
		const mtime = child.isDirectory()
			? newestMtimeMs(full)
			: statSync(full).mtimeMs;
		newest = Math.max(newest, mtime);
	}
	return newest;
}

const examples = [
	{ name: "node-app", extra: [] },
	{ name: "edge-worker", extra: ["wrangler.jsonc"] },
	{ name: "mcp-agent", extra: [] },
];

const problems = [];

for (const { name, extra } of examples) {
	const dir = join(root, "examples", name);
	for (const file of ["README.md", "main.ts", ...extra]) {
		const path = join(dir, file);
		if (!existsSync(path)) {
			problems.push(`examples/${name}/${file} is missing`);
		} else if (statSync(path).size === 0) {
			problems.push(`examples/${name}/${file} is empty`);
		}
	}
}

// The examples import the built package entry, never `src`. After
// `npm run build` this must exist and be at least as new as the SDK sources.
const distEntry = join(root, "dist", "esm", "index.js");
if (!existsSync(distEntry)) {
	problems.push("dist/esm/index.js is missing (run `npm run build`)");
} else {
	const srcNewest = newestMtimeMs(join(root, "src"));
	if (srcNewest > statSync(distEntry).mtimeMs) {
		problems.push(
			"dist/esm/index.js is older than src/** (run `npm run build`)",
		);
	}
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.error(`::error::${problem}`);
	}
	process.exit(1);
}

console.log(
	`check:examples ok — ${examples.length} examples present, SDK dist fresh`,
);
