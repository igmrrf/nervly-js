/**
 * Run ids for the example harness.
 *
 * A run id is unique per run and appears in the signup email, the workspace
 * name/slug, the API-key name, subscriber ids and idempotency keys, which is
 * what makes parallel runs safe. The format is
 * `YYYYMMDDTHHMMSSZ-<4 random hex>` (e.g. `20261007T084712Z-a1b2`).
 */

/** Characters that are safe to embed in an email local part, a slug and a key name. */
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** True when `runId` is a usable run id supplied from the environment. */
export function isValidRunId(runId: string): boolean {
	return runId.length > 0 && runId.length <= 64 && RUN_ID_PATTERN.test(runId);
}

/** Generate a fresh run id. `now` and `random` are injectable for tests. */
export function newRunId(
	now: Date = new Date(),
	random: () => number = Math.random,
): string {
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
	const suffix = Math.floor(random() * 0x10000)
		.toString(16)
		.padStart(4, "0");
	return `${stamp}-${suffix}`;
}
