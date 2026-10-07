/**
 * The edge-worker checks (contract §3.3): drive the running worker over HTTP
 * and assert the end state — the triggered message reads back `DELIVERED`
 * through the worker's own `GET /messages` surface in test mode. HTTP
 * acceptance alone is never "green".
 *
 * The worker's SDK surface exercised here: `health.check`, `events.trigger`,
 * `events.get` (read-back) and `messages.list` (the asserted end state).
 */

import { AssertionFailure, EnvironmentFailure } from "./errors.js";
import type { CheckResult } from "./summary.js";
import type { Transcript } from "./transcript.js";

/** Statuses that will never become DELIVERED; fail fast when one is seen. */
const TERMINAL_FAILURES = new Set([
	"FAILED",
	"BOUNCED",
	"SUPPRESSED",
	"CANCELLED",
	"REJECTED",
	"DLQ",
]);

/** `evt_<hex>` and `<hex>` name the same event; compare one normalized form. */
export function normalizeEventId(eventId: string): string {
	return eventId.replace(/^evt[_-]?/i, "").toLowerCase();
}

export function isTerminalFailure(status: string): boolean {
	return TERMINAL_FAILURES.has(status.toUpperCase());
}

export interface RunChecksOptions {
	/** Base URL of the running worker. */
	workerUrl: string;
	runId: string;
	timeoutMs: number;
	log: Transcript;
	/** Test seams. */
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export interface RunChecksResult {
	checks: CheckResult[];
	eventId: string;
	/** The subscriber this run triggered for (also the search key for read-back). */
	subscriberId: string;
}

const STACK_HINT = ' Is the local stack up? Run "make up" in nervly-base.';

interface WorkerResponse {
	status: number;
	body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
	if (!isRecord(value)) return null;
	const found = value[key];
	return typeof found === "string" && found !== "" ? found : null;
}

function numberField(value: unknown, key: string): number | null {
	if (!isRecord(value)) return null;
	const found = value[key];
	return typeof found === "number" ? found : null;
}

function errorTypeOf(body: unknown): string | null {
	if (!isRecord(body) || !isRecord(body.error)) return null;
	const type = body.error.type;
	return typeof type === "string" ? type : null;
}

function errorMessageOf(body: unknown): string {
	if (!isRecord(body) || !isRecord(body.error))
		return "no machine-readable error body";
	const message = body.error.message;
	return typeof message === "string" ? message : "no error message";
}

function describe(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text === undefined || text === "") return "(no body)";
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * A worker response other than the expected one: 5xx means the stack behind the
 * worker is unusable (environment failure, exit 2); anything else is an
 * assertion failure (exit 1). Never returns.
 */
function failureFor(
	response: WorkerResponse,
	context: string,
	checkName: string,
): never {
	const detail = `HTTP ${response.status} ${errorTypeOf(response.body) ?? "?"}: ${errorMessageOf(response.body)}`;
	if (response.status >= 500) {
		throw new EnvironmentFailure(
			`${context} failed at the stack level: ${detail}${STACK_HINT}`,
			{ name: checkName, status: "fail", detail },
		);
	}
	throw new AssertionFailure(`${context} failed: ${detail}`, {
		name: checkName,
		status: "fail",
		detail,
	});
}

/**
 * Run the worker's checks in order. Throws {@link EnvironmentFailure} when the
 * stack itself is unusable and {@link AssertionFailure} when an observed end
 * state does not hold; the failing check travels on the error.
 */
export async function runChecks(
	options: RunChecksOptions,
): Promise<RunChecksResult> {
	const { workerUrl, runId, timeoutMs, log } = options;
	const fetchFn = options.fetchFn ?? fetch;
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = options.now ?? (() => Date.now());
	const checks: CheckResult[] = [];
	const subscriberId = `sub-example-${runId.toLowerCase()}`;

	const call = async (
		method: string,
		path: string,
		body?: unknown,
	): Promise<WorkerResponse> => {
		let response: Response;
		try {
			response = await fetchFn(`${workerUrl}${path}`, {
				method,
				headers:
					body === undefined
						? undefined
						: { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (error) {
			throw new EnvironmentFailure(
				`the worker did not answer at ${method} ${path}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				undefined,
				{ cause: error },
			);
		}
		const text = await response.text();
		let parsed: unknown = null;
		if (text !== "") {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		}
		return { status: response.status, body: parsed };
	};

	// 1. Health through the worker (precondition; no observed end state yet).
	log.line("→ checks: GET /health (worker -> gateway, NATS connected)");
	const health = await call("GET", "/health");
	if (health.status !== 200) {
		failureFor(health, "GET /health", "gateway health");
	}
	if (!isRecord(health.body) || health.body.nats_connected !== true) {
		throw new EnvironmentFailure(
			"gateway reports NATS disconnected; delivery cannot flow",
			{
				name: "gateway health",
				status: "fail",
				detail: `status=${isRecord(health.body) ? String(health.body.status) : "?"} nats_connected=false`,
			},
		);
	}
	const healthStatus = String(health.body.status ?? "unknown");
	checks.push({
		name: "gateway health",
		status: "pass",
		detail: `status=${healthStatus} nats_connected=true`,
	});
	log.line(`  gateway healthy (status=${healthStatus})`);

	// 2. Trigger a test-mode event through the worker's SDK surface.
	log.line("→ checks: POST /events (events.trigger with idempotency key)");
	const idempotencyKey = `example-edge-${runId}`;
	const trigger = await call("POST", "/events", {
		name: "example.edge_worker.trigger",
		to: {
			subscriberId,
			email: `subscriber+${runId}@example.local`,
		},
		payload: { runId, source: "nervly-js/examples/edge-worker" },
		category: "transactional",
		idempotencyKey,
		priority: "NORMAL",
	});
	if (trigger.status !== 202) {
		failureFor(trigger, "POST /events", "trigger accepted");
	}
	const eventId = stringField(trigger.body, "eventId");
	if (eventId === null) {
		throw new AssertionFailure(
			"the worker accepted the trigger but returned no eventId",
			{
				name: "trigger accepted",
				status: "fail",
				detail: `response ${describe(trigger.body)}`,
			},
		);
	}
	checks.push({
		name: "trigger accepted",
		status: "pass",
		detail: `event ${eventId} accepted (idempotency-key=${idempotencyKey})`,
	});
	log.line(`  trigger accepted (event ${eventId})`);

	// 3. Event lookup through the worker (read-back via events.get).
	log.line(`→ checks: GET /events/${eventId}`);
	const lookup = await call("GET", `/events/${encodeURIComponent(eventId)}`);
	if (lookup.status !== 200) {
		failureFor(lookup, `GET /events/${eventId}`, "event lookup");
	}
	const lookupId = stringField(lookup.body, "event_id");
	if (
		lookupId === null ||
		normalizeEventId(lookupId) !== normalizeEventId(eventId)
	) {
		throw new AssertionFailure(
			`event lookup returned ${lookupId ?? "no event_id"} for ${eventId}`,
			{
				name: "event lookup",
				status: "fail",
				detail: `lookup returned ${describe(lookup.body)}`,
			},
		);
	}
	checks.push({
		name: "event lookup",
		status: "pass",
		detail: `event ${eventId} readable (status ${stringField(lookup.body, "status") ?? "?"})`,
	});

	// 4. Asserted end state: read the message back as DELIVERED (test mode).
	log.line(
		`→ checks: read back ${eventId} via GET /messages (bound ${timeoutMs}ms)`,
	);
	const deadline = now() + timeoutMs;
	const wanted = normalizeEventId(eventId);
	let lastStatus: string | null = null;
	for (;;) {
		const page = await call(
			"GET",
			`/messages?subscriberId=${encodeURIComponent(subscriberId)}&limit=20`,
		);
		if (page.status !== 200) {
			failureFor(page, "GET /messages", "trigger delivered");
		}
		const messages =
			isRecord(page.body) && Array.isArray(page.body.messages)
				? page.body.messages
				: null;
		if (messages === null) {
			throw new AssertionFailure(
				`GET /messages returned no messages array: ${describe(page.body)}`,
				{
					name: "trigger delivered",
					status: "fail",
					detail: describe(page.body),
				},
			);
		}

		const matches = messages.filter(
			(candidate) =>
				isRecord(candidate) &&
				normalizeEventId(String(candidate.event_id ?? "")) === wanted,
		);
		const message = matches[0];
		if (message !== undefined) {
			const status = String(message.status ?? "");
			lastStatus = status;
			if (status === "DELIVERED") {
				if (message.test_mode !== true) {
					throw new AssertionFailure(
						"message was delivered outside test mode; examples only run test keys",
						{
							name: "trigger delivered",
							status: "fail",
							detail: `event ${String(message.event_id)} DELIVERED with test_mode=false`,
						},
					);
				}
				checks.push({
					name: "trigger delivered",
					status: "pass",
					detail: `event ${eventId} status DELIVERED (test_mode=true, channel=${
						stringField(message, "channel") ?? "?"
					}, attempts=${numberField(message, "attempts") ?? "?"})`,
				});
				log.line(
					`  asserted end state: ${eventId} is DELIVERED in test mode (channel=${stringField(message, "channel") ?? "?"})`,
				);
				return { checks, eventId, subscriberId };
			}
			if (isTerminalFailure(status)) {
				throw new AssertionFailure(
					`message reached terminal status ${status}, not DELIVERED`,
					{
						name: "trigger delivered",
						status: "fail",
						detail: `event ${eventId} status ${status}`,
					},
				);
			}
		}

		if (now() >= deadline) {
			throw new AssertionFailure(
				`timed out after ${timeoutMs}ms waiting for DELIVERED (last observed status: ${lastStatus ?? "message not found"})`,
				{
					name: "trigger delivered",
					status: "fail",
					detail: `event ${eventId} last status ${lastStatus ?? "not found"} after ${timeoutMs}ms`,
				},
			);
		}
		await sleep(Math.min(500, Math.max(25, Math.floor(timeoutMs / 20))));
	}
}
