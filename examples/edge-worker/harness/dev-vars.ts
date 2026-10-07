/**
 * The local secret hand-off to workerd.
 *
 * `wrangler dev` reads `.dev.vars` from the directory that holds the wrangler
 * config and exposes each entry as a Worker binding (values are hidden from
 * wrangler's output). The file is written with `0600` permissions, is
 * git-ignored, and is deleted when the run tears down — success, failure or
 * signal. Values are never logged.
 */

import { rmSync, writeFileSync } from "node:fs";

/** Render `.dev.vars` content. Values must not smuggle extra lines. */
export function formatDevVars(
	values: Readonly<Record<string, string>>,
): string {
	const lines = Object.entries(values).map(([key, value]) => {
		if (value.includes("\n") || value.includes("\r")) {
			throw new Error(`refusing to write a multi-line value for ${key}`);
		}
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new Error(`refusing to write a malformed variable name: ${key}`);
		}
		return `${key}=${value}`;
	});
	return `${lines.join("\n")}\n`;
}

/** Write the run's `.dev.vars` file (`0600`). Overwrites a previous run's. */
export function writeDevVars(
	path: string,
	values: Readonly<Record<string, string>>,
): void {
	writeFileSync(path, formatDevVars(values), { encoding: "utf8", mode: 0o600 });
}

/** Remove the run's `.dev.vars`; idempotent. Returns false on a real failure. */
export function removeDevVars(path: string): boolean {
	try {
		rmSync(path, { force: true });
		return true;
	} catch {
		return false;
	}
}
