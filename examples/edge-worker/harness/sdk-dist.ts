/**
 * The edge worker bundles the **built** package entry (`@nervly/sdk` →
 * `dist/esm`), never `src`. Before `wrangler dev` starts, the harness verifies
 * the build exists and is not older than the SDK sources, so the example can
 * never silently prove a stale bundle.
 *
 * The repo dispatcher (`scripts/example.mjs`) already builds when stale; this
 * check is the loud failure path for direct invocations and for a build that
 * failed to refresh the entry.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EnvironmentFailure } from "./errors.js";

/** Newest mtime (ms) anywhere under `dir`; 0 when the directory is missing. */
export function newestMtimeMs(dir: string): number {
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

export interface SdkDistState {
	entry: string;
	exists: boolean;
	stale: boolean;
}

/** Inspect `<root>/dist/esm/index.js` against the newest file under `<root>/src`. */
export function sdkDistState(root: string): SdkDistState {
	const entry = join(root, "dist", "esm", "index.js");
	const exists = existsSync(entry);
	const stale =
		!exists ||
		(existsSync(join(root, "src")) &&
			newestMtimeMs(join(root, "src")) > statSync(entry).mtimeMs);
	return { entry, exists, stale };
}

/**
 * Refuse to run when the built SDK entry is missing or stale. Exit 2
 * (environment failure) with the remedy named: `npm run build`.
 */
export function assertSdkDist(root: string): void {
	const state = sdkDistState(root);
	if (!state.exists) {
		throw new EnvironmentFailure(
			`the built SDK entry is missing at ${state.entry}; run "npm run build" (or "npm run example -- edge-worker", which builds it when stale)`,
		);
	}
	if (state.stale) {
		throw new EnvironmentFailure(
			`the built SDK entry is stale at ${state.entry} (older than src/); run "npm run build" so the worker bundles the current SDK`,
		);
	}
}
