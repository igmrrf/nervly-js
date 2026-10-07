#!/usr/bin/env node
/**
 * Repo example dispatcher (harness contract §2).
 *
 *   npm run example                     → the default example (node-app)
 *   npm run example -- <name>           → examples/<name>
 *   npm run example -- --json           → default example, machine summary
 *   npm run example -- <name> --json    → named example, machine summary
 *
 * The dispatcher keeps `npm run example` stable as more examples land in this
 * repo; it forwards every other argument to the example's `main.ts` unchanged.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EXAMPLE = "node-app";

const HELP = `nervly-js examples

Usage:
  npm run example                     run ${DEFAULT_EXAMPLE} (human transcript)
  npm run example -- <name>           run examples/<name>
  npm run example -- --json           run ${DEFAULT_EXAMPLE}, print summary.json
  npm run example -- --help           show this message

The contract every example implements:
  nervly-base/docs/examples/harness-contract.md
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	process.stdout.write(HELP);
	process.exit(0);
}

const first = args[0];
const named = first !== undefined && !first.startsWith("-");
const name = named ? first : DEFAULT_EXAMPLE;
const forwarded = named ? args.slice(1) : args;

if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
	process.stderr.write(`example name "${name}" is invalid (use [a-z0-9-])\n`);
	process.exit(2);
}

const entry = join(ROOT, "examples", name, "main.ts");
if (!existsSync(entry)) {
	process.stderr.write(
		`unknown example "${name}": ${entry} does not exist\n\n${HELP}`,
	);
	process.exit(2);
}

const tsx = join(
	ROOT,
	"node_modules",
	".bin",
	process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const result = spawnSync(tsx, [entry, ...forwarded], {
	stdio: "inherit",
	cwd: ROOT,
	env: process.env,
});
if (result.error) {
	process.stderr.write(`failed to run tsx: ${result.error.message}\n`);
	process.exit(2);
}
process.exit(result.status ?? 2);
