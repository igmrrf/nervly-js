#!/usr/bin/env node
/**
 * Targeted mutation testing for the transport and resource layer.
 *
 * A coverage percentage says which lines ran; it does not say whether the
 * assertions would notice if the line were wrong. This harness seeds mutations
 * that invert real decisions — retry counts, the retryable status list, the
 * Authorization header, error-body parsing, the exponential curve, jitter, URL
 * encoding, the abort branch, and query serialization — then runs the test file
 * that owns each behaviour and requires it to fail.
 *
 * Stryker is deliberately not used: the runner is Node's built-in `node:test`
 * (driven by `tsx`), so Stryker's command runner would spawn a fresh full suite
 * per mutant, and the package takes no dev tools beyond `tsx`/`typescript`.
 * A condition-inversion harness scoped to one test file per mutation keeps the
 * feedback loop seconds long and the seed mutations readable in review.
 *
 * A surviving mutant, a mutation whose anchor text has disappeared, or a
 * control run that fails to pass all exit non-zero, so this doubles as a gate.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = resolve(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const REPORT = resolve(ROOT, "docs", "mutation-report.json");

/**
 * Each entry names the file, the exact anchor it rewrites, the test file that
 * must kill it, and the invariant the mutation would break.
 */
const MUTATIONS = [
	{
		id: "retry-budget-off-by-one",
		file: "src/client.ts",
		find: "return attempt < this.maxRetries && this.isRetryable(error);",
		replace: "return attempt <= this.maxRetries && this.isRetryable(error);",
		test: "tests/http-contract.test.ts",
		proves: "the retry budget is bounded by maxRetries",
	},
	{
		id: "retry-budget-disabled",
		file: "src/client.ts",
		find: "return attempt < this.maxRetries && this.isRetryable(error);",
		replace: "return attempt < 0 && this.isRetryable(error);",
		test: "tests/client.test.ts",
		proves: "retryable failures are retried",
	},
	{
		id: "retry-exhaustion-swallowed",
		file: "src/client.ts",
		find: "if (attempt > 0 && this.isRetryable(lastError)) {",
		replace: "if (false) {",
		test: "tests/http-contract.test.ts",
		proves: "spent retries surface as RetryExhaustedError",
	},
	{
		id: "retryable-status-503-removed",
		file: "src/client.ts",
		find: "return [429, 500, 502, 503, 504].includes(error.statusCode);",
		replace: "return [429, 500, 502, 504].includes(error.statusCode);",
		test: "tests/client.test.ts",
		proves: "503 is a retryable status",
	},
	{
		id: "network-error-not-retryable",
		file: "src/client.ts",
		find: "if (error instanceof NervlyNetworkError) return true;",
		replace: "if (error instanceof NervlyNetworkError) return false;",
		test: "tests/http-contract.test.ts",
		proves: "network failures are retried",
	},
	{
		id: "authorization-header-removed",
		file: "src/client.ts",
		find: '\t\t\theaders.set("Authorization", `Bearer ${this.apiKey}`);',
		replace: '\t\t\theaders.set("X-Mutated-No-Auth", "1");',
		test: "tests/http-contract.test.ts",
		proves: "authenticated requests carry the Bearer token",
	},
	{
		id: "error-payload-parsing-stripped",
		file: "src/client.ts",
		find: "message = errorBody.message || errorBody.error || message;",
		replace: "message = message;",
		test: "tests/http-contract.test.ts",
		proves: "the gateway error message reaches the caller",
	},
	{
		id: "timeout-abort-branch-disabled",
		file: "src/client.ts",
		find: '\t\t\tif (error instanceof Error && error.name === "AbortError") {',
		replace: "\t\t\tif (false) {",
		test: "tests/http-contract.test.ts",
		proves: "a timed-out request maps to a timeout network error",
	},
	{
		id: "exponential-curve-flattened",
		file: "src/retry.ts",
		find: "\treturn Math.min(\n\t\tretryBaseDelay * 2 ** attempt + jitter * jitterSpanMs,\n\t\tmaxDelayMs,\n\t);",
		replace:
			"\treturn Math.min(\n\t\tretryBaseDelay + jitter * jitterSpanMs,\n\t\tmaxDelayMs,\n\t);",
		test: "tests/backoff.test.ts",
		proves: "the backoff grows exponentially with the attempt",
	},
	{
		id: "jitter-removed",
		file: "src/retry.ts",
		find: "\treturn Math.min(\n\t\tretryBaseDelay * 2 ** attempt + jitter * jitterSpanMs,\n\t\tmaxDelayMs,\n\t);",
		replace:
			"\treturn Math.min(\n\t\tretryBaseDelay * 2 ** attempt + 0,\n\t\tmaxDelayMs,\n\t);",
		test: "tests/backoff.test.ts",
		proves: "jitter is added to the exponential delay",
	},
	{
		id: "backoff-ceiling-removed",
		file: "src/retry.ts",
		find: "\treturn Math.min(\n\t\tretryBaseDelay * 2 ** attempt + jitter * jitterSpanMs,\n\t\tmaxDelayMs,\n\t);",
		replace: "\treturn retryBaseDelay * 2 ** attempt + jitter * jitterSpanMs;",
		test: "tests/backoff.test.ts",
		proves: "the exponential delay is capped at 30s",
	},
	{
		id: "subscriber-id-not-encoded",
		file: "src/resources/subscribers.ts",
		find: "\t\t\t`/v1/subscribers/${encodeURIComponent(subscriberId)}`,",
		replace: "\t\t\t`/v1/subscribers/${subscriberId}`,",
		test: "tests/http-contract.test.ts",
		proves: "reserved characters in the subscriber id are encoded",
	},
	{
		id: "event-id-not-encoded",
		file: "src/resources/events.ts",
		find: "\t\treturn this.client.get<MessageDto>(\n\t\t\t`/v1/events/${encodeURIComponent(eventId)}`,\n\t\t);",
		replace:
			"\t\treturn this.client.get<MessageDto>(\n\t\t\t`/v1/events/${eventId}`,\n\t\t);",
		test: "tests/http-contract.test.ts",
		proves: "reserved characters in the event id are encoded",
	},
	{
		id: "idempotency-header-skipped",
		file: "src/resources/events.ts",
		find: '\t\theaders["Idempotency-Key"] = idempotencyKey;',
		replace: '\t\theaders["X-Mutated-No-Idempotency"] = idempotencyKey;',
		test: "tests/http-contract.test.ts",
		proves: "the Idempotency-Key header is sent",
	},
	{
		id: "message-filter-dropped",
		file: "src/resources/messages.ts",
		find: '\t\t\tif (params.subscriberId)\n\t\t\t\tsearchParams.set("subscriber_id", params.subscriberId);',
		replace:
			'\t\t\tif (false)\n\t\t\t\tsearchParams.set("subscriber_id", params.subscriberId);',
		test: "tests/http-contract.test.ts",
		proves: "the subscriber_id query filter is serialized",
	},
];

/** Files touched by a mutation, with their pristine contents. */
const snapshots = new Map();

function restoreAll() {
	for (const [path, contents] of snapshots) writeFileSync(path, contents);
	snapshots.clear();
}

process.on("SIGINT", () => {
	restoreAll();
	process.exit(130);
});
process.on("SIGTERM", () => {
	restoreAll();
	process.exit(143);
});

function runTestFile(testFile) {
	const result = spawnSync(process.execPath, [TSX, "--test", testFile], {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const ranAndFailed =
		/fail [1-9]\d*/i.test(output) || /not ok \d+/.test(output);
	return {
		status: result.status,
		output,
		killed: result.status !== 0 && ranAndFailed,
	};
}

function applyMutation(mutation) {
	const path = resolve(ROOT, mutation.file);
	const original = snapshots.get(path) ?? readFileSync(path, "utf8");
	snapshots.set(path, original);

	const occurrences = original.split(mutation.find).length - 1;
	if (occurrences !== 1) {
		throw new Error(
			`Mutation "${mutation.id}" anchors on text that appears ${occurrences} times in ` +
				`${mutation.file} (expected exactly 1). The source drifted — update the harness.`,
		);
	}

	writeFileSync(path, original.replace(mutation.find, mutation.replace));
}

function controlRun(testFile) {
	const { status, killed } = runTestFile(testFile);
	if (status !== 0) {
		throw new Error(
			`Control run of ${testFile} failed before any mutation (exit ${status}).`,
		);
	}
	if (killed) {
		throw new Error(
			`Control run of ${testFile} reported test failures unexpectedly.`,
		);
	}
}

const targetFiles = [...new Set(MUTATIONS.map((m) => m.test))];
console.log("mutation testing — control runs (unmutated)");
for (const testFile of targetFiles) {
	controlRun(testFile);
	console.log(`  control PASS  ${testFile}`);
}

const results = [];
let survived = 0;

for (const mutation of MUTATIONS) {
	let killed = false;
	try {
		applyMutation(mutation);
		const outcome = runTestFile(mutation.test);
		killed = outcome.killed;
	} finally {
		restoreAll();
	}

	if (!killed) survived += 1;

	results.push({
		id: mutation.id,
		file: mutation.file,
		test: mutation.test,
		proves: mutation.proves,
		status: killed ? "killed" : "SURVIVED",
	});

	console.log(
		`  ${killed ? "KILLED  " : "SURVIVED"} ${mutation.id} (${mutation.test})`,
	);
}

const killedCount = MUTATIONS.length - survived;
const score = Number(((killedCount / MUTATIONS.length) * 100).toFixed(1));

let generatedAt = new Date().toISOString();
try {
	const prev = JSON.parse(readFileSync(REPORT, "utf8"));
	if (
		prev.total === MUTATIONS.length &&
		prev.killed === killedCount &&
		prev.survived === survived &&
		prev.score === score &&
		JSON.stringify(prev.mutants) === JSON.stringify(results)
	) {
		generatedAt = prev.generatedAt ?? generatedAt;
	}
} catch {
	// Use fresh timestamp if report does not exist or cannot be parsed
}

const report = {
	generatedAt,
	runner: "node:test via tsx (targeted condition inversion)",
	tool: "scripts/mutation-test.mjs",
	total: MUTATIONS.length,
	killed: killedCount,
	survived,
	score,
	mutants: results,
};
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

console.log("");
console.log(
	`mutation score: ${score}% (${killedCount}/${MUTATIONS.length} killed)`,
);
console.log(`report: ${REPORT}`);

if (survived > 0) {
	console.error(
		`✗ ${survived} mutant(s) survived; tests did not detect the change.`,
	);
	process.exit(1);
}
console.log("✓ every seeded mutation was killed");
