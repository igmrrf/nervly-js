#!/usr/bin/env node
/**
 * Builds the dual ESM/CJS distribution.
 *
 * Two `tsc` passes over the same `src/`:
 *
 *   dist/esm/   module: NodeNext   ← `import` from an ESM consumer
 *   dist/cjs/   module: CommonJS   ← `require` from a CJS consumer
 *
 * Both passes emit their own `.d.ts`, so TypeScript resolves the declarations
 * that match the module system the consumer is using rather than falling back
 * to a single format and tripping `node16`/`nodenext` interop checks.
 *
 * Each directory then gets a one-line `package.json` marker. The nearest
 * `package.json` decides how Node interprets the `.js` files inside it, which
 * is what lets the root manifest stay `"type": "module"` while `dist/cjs`
 * remains CommonJS.
 *
 * No bundler, no runtime dependency, no generated code that is not in `src/`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** tsc is invoked through the local CLI so the build does not depend on PATH. */
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

rmSync(dist, { recursive: true, force: true });

for (const [project, outDir, type] of [
	["tsconfig.esm.json", join(dist, "esm"), "module"],
	["tsconfig.cjs.json", join(dist, "cjs"), "commonjs"],
]) {
	execFileSync(process.execPath, [tsc, "--project", join(root, project)], {
		cwd: root,
		stdio: "inherit",
	});

	mkdirSync(outDir, { recursive: true });
	writeFileSync(
		join(outDir, "package.json"),
		`${JSON.stringify({ type }, null, 2)}\n`,
	);
}

console.log("✓ built dist/esm (ESM) and dist/cjs (CommonJS)");
