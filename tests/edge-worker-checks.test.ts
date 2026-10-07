/**
 * Asserted-end-state tests for the edge-worker harness checks.
 *
 * `runChecks` is the only path to exit 0: these tests pin the read-back
 * semantics (DELIVERED + `test_mode` + channel evidence), the fail-fast
 * terminal statuses, the bounded wait, and the failure taxonomy
 * (5xx ⇒ environment/exit 2, everything else ⇒ assertion/exit 1).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	isTerminalFailure,
	normalizeEventId,
	runChecks,
} from "../examples/edge-worker/harness/checks.js";
import {
	AssertionFailure,
	EnvironmentFailure,
} from "../examples/edge-worker/harness/errors.js";
import { Transcript } from "../examples/edge-worker/harness/transcript.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const EVENT_ID = "evt_0123456789abcdef0123456789abcdef";
const RUN_ID = "20261007T084712Z-check";

const tempDirs: string[] = [];
function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "edge-checks-"));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function collectingTranscript(): { log: Transcript; lines: string[] } {
	const lines: string[] = [];
	return {
		log: new Transcript({
			artifactsDir: makeTempDir(),
			stdout: (line) => lines.push(line),
		}),
		lines,
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface ScriptedOptions {
	messageStatus?: string;
	testMode?: boolean;
	natsConnected?: boolean;
	healthStatus?: number;
	messagesBody?: unknown;
	triggerStatus?: number;
	triggerBody?: unknown;
	lookupBody?: unknown;
}

/** A fetch stub that behaves like the worker's HTTP surface. */
function scriptedFetch(options: ScriptedOptions = {}): {
	fetchFn: typeof fetch;
	calls: string[];
	requestBodies: unknown[];
} {
	const calls: string[] = [];
	const requestBodies: unknown[] = [];
	const fetchFn = (async (input: FetchInput, init?: FetchInit) => {
		const url = new URL(String(input));
		calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
		if (init?.body !== undefined) {
			requestBodies.push(JSON.parse(String(init.body)) as unknown);
		}
		if (url.pathname === "/health") {
			if (options.healthStatus !== undefined) {
				return jsonResponse(options.healthStatus, {
					error: { type: "UPSTREAM_ERROR", message: "gateway down" },
				});
			}
			return jsonResponse(200, {
				status: "OK",
				nats_connected: options.natsConnected !== false,
			});
		}
		if (url.pathname === "/events" && init?.method === "POST") {
			if (
				options.triggerStatus !== undefined &&
				options.triggerStatus !== 202
			) {
				return jsonResponse(options.triggerStatus, {
					error: { type: "VALIDATION_ERROR", message: "bad trigger" },
				});
			}
			return jsonResponse(
				202,
				options.triggerBody ?? {
					eventId: EVENT_ID,
					status: "QUEUED",
					channel: "email",
				},
			);
		}
		if (url.pathname === `/events/${EVENT_ID}`) {
			return jsonResponse(
				200,
				options.lookupBody ?? {
					event_id: EVENT_ID,
					status: "DELIVERED",
					test_mode: true,
				},
			);
		}
		if (url.pathname === "/messages") {
			return jsonResponse(
				200,
				options.messagesBody ?? {
					messages: [
						{
							event_id: EVENT_ID,
							status: options.messageStatus ?? "DELIVERED",
							test_mode: options.testMode !== false,
							channel: "email",
							attempts: 1,
						},
					],
				},
			);
		}
		return jsonResponse(404, {
			error: { type: "NOT_FOUND", message: "no route" },
		});
	}) as typeof fetch;
	return { fetchFn, calls, requestBodies };
}

function run(
	fetchFn: typeof fetch,
	overrides: {
		timeoutMs?: number;
		sleep?: (ms: number) => Promise<void>;
		now?: () => number;
		lines?: string[];
	} = {},
): ReturnType<typeof runChecks> {
	const { log, lines } = collectingTranscript();
	return runChecks({
		workerUrl: "http://worker.test",
		runId: RUN_ID,
		timeoutMs: overrides.timeoutMs ?? 5_000,
		log,
		fetchFn,
		sleep: overrides.sleep,
		now: overrides.now,
	}).then((result) => {
		overrides.lines?.push(...lines);
		return result;
	});
}

describe("event id helpers", () => {
	it("normalizes evt_ prefixes and rejects nothing it should keep", () => {
		assert.equal(normalizeEventId("evt_ABC123"), "abc123");
		assert.equal(normalizeEventId("EVT-abc123"), "abc123");
		assert.equal(normalizeEventId("abc123"), "abc123");
	});

	it("flags the terminal delivery failures", () => {
		for (const status of ["FAILED", "BOUNCED", "SUPPRESSED", "DLQ"]) {
			assert.equal(isTerminalFailure(status), true);
		}
		for (const status of ["TRIGGERED", "QUEUED", "DELIVERED", "SEEN"]) {
			assert.equal(isTerminalFailure(status), false);
		}
	});
});

describe("runChecks", () => {
	it("passes only after the message reads back DELIVERED in test mode", async () => {
		const { fetchFn, calls } = scriptedFetch();
		const lines: string[] = [];
		const result = await run(fetchFn, { lines });

		assert.deepEqual(
			result.checks.map((check) => check.name),
			[
				"gateway health",
				"trigger accepted",
				"event lookup",
				"trigger delivered",
			],
		);
		for (const check of result.checks) assert.equal(check.status, "pass");
		const delivered = result.checks[3];
		assert.match(delivered?.detail ?? "", /DELIVERED/);
		assert.match(delivered?.detail ?? "", /test_mode=true/);
		assert.equal(result.eventId, EVENT_ID);
		assert.equal(result.subscriberId, `sub-example-${RUN_ID.toLowerCase()}`);

		// The trigger goes through the worker's own route with the run's
		// subscriber and idempotency key.
		assert.deepEqual(calls[0], "GET /health");
		assert.deepEqual(calls[1], "POST /events");
		assert.deepEqual(calls[2], `GET /events/${EVENT_ID}`);
		assert.match(calls[3] ?? "", /^GET \/messages\?/);
		assert.equal(
			(calls[3] ?? "").includes(
				`subscriberId=${encodeURIComponent(result.subscriberId)}`,
			),
			true,
		);
		assert.equal(lines.join("\n").includes("asserted end state"), true);
	});

	it("sends the idempotency key and subscriber on the trigger", async () => {
		const { fetchFn, requestBodies } = scriptedFetch();
		await run(fetchFn);
		const trigger = requestBodies[0] as Record<string, unknown>;
		assert.equal(trigger.name, "example.edge_worker.trigger");
		assert.equal(trigger.idempotencyKey, `example-edge-${RUN_ID}`);
		assert.deepEqual(trigger.to, {
			subscriberId: `sub-example-${RUN_ID.toLowerCase()}`,
			email: `subscriber+${RUN_ID}@example.local`,
		});
		assert.equal(trigger.category, "transactional");
	});

	it("fails fast when the message reaches a terminal failure", async () => {
		const { fetchFn } = scriptedFetch({ messageStatus: "BOUNCED" });
		await assert.rejects(
			() => run(fetchFn),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.exitCode === 1 &&
				error.message.includes("terminal status BOUNCED") &&
				error.check?.name === "trigger delivered",
		);
	});

	it("fails an assertion when DELIVERED is read outside test mode", async () => {
		const { fetchFn } = scriptedFetch({ testMode: false });
		await assert.rejects(
			() => run(fetchFn),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.exitCode === 1 &&
				error.message.includes("outside test mode"),
		);
	});

	it("bounds the DELIVERED wait and records the last observed status", async () => {
		const { fetchFn } = scriptedFetch({ messageStatus: "TRIGGERED" });
		let clock = 0;
		await assert.rejects(
			() =>
				run(fetchFn, {
					timeoutMs: 100,
					sleep: async () => {},
					now: () => {
						clock += 1_000;
						return clock;
					},
				}),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.exitCode === 1 &&
				error.message.includes("timed out after 100ms") &&
				error.message.includes("last observed status: TRIGGERED") &&
				error.check?.name === "trigger delivered",
		);
	});

	it("treats an unusable gateway as an environment failure naming make up", async () => {
		const { fetchFn } = scriptedFetch({ healthStatus: 503 });
		await assert.rejects(
			() => run(fetchFn),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("make up"),
		);
	});

	it("treats a disconnected NATS as an environment failure", async () => {
		const { fetchFn } = scriptedFetch({ natsConnected: false });
		await assert.rejects(
			() => run(fetchFn),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("NATS disconnected"),
		);
	});

	it("treats an unreachable worker as an environment failure", async () => {
		const fetchFn = (() =>
			Promise.reject(new Error("connection refused"))) as typeof fetch;
		await assert.rejects(
			() => run(fetchFn),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("did not answer"),
		);
	});

	it("fails an assertion when the worker rejects the trigger", async () => {
		const { fetchFn } = scriptedFetch({ triggerStatus: 400 });
		await assert.rejects(
			() => run(fetchFn),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.exitCode === 1 &&
				error.message.includes("HTTP 400 VALIDATION_ERROR") &&
				error.check?.name === "trigger accepted",
		);
	});

	it("fails an assertion when the worker returns no eventId", async () => {
		const { fetchFn } = scriptedFetch({ triggerBody: { status: "QUEUED" } });
		await assert.rejects(
			() => run(fetchFn),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.exitCode === 1 &&
				error.message.includes("returned no eventId"),
		);
	});

	it("fails an assertion when the messages page is not an array", async () => {
		const { fetchFn } = scriptedFetch({ messagesBody: { messages: "nope" } });
		await assert.rejects(
			() => run(fetchFn),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.exitCode === 1 &&
				error.message.includes("no messages array"),
		);
	});
});
