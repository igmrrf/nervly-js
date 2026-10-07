/**
 * The node-app checks (contract §3.3): drive the running app over HTTP and
 * assert the end state — the triggered message reads back `DELIVERED` through
 * the app's own `GET /messages` surface in test mode. HTTP acceptance alone is
 * never "green".
 *
 * Every endpoint the app exposes is exercised: health, single trigger
 * (idempotency + priority), event lookup, bulk trigger, preferences update,
 * messages list, and the typed-error surface (validation + not found).
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
	/** Base URL of the started node-app server. */
	appUrl: string;
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

interface AppResponse {
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
 * An app response other than the expected one: 5xx means the stack behind the
 * app is unusable (environment failure, exit 2); anything else is an
 * assertion failure (exit 1). Never returns.
 */
function failureFor(
	response: AppResponse,
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
 * Run the app's checks in order. Throws {@link EnvironmentFailure} when the
 * stack itself is unusable and {@link AssertionFailure} when an observed end
 * state does not hold; the failing check travels on the error.
 */
export async function runChecks(
	options: RunChecksOptions,
): Promise<RunChecksResult> {
	const { appUrl, runId, timeoutMs, log } = options;
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
	): Promise<AppResponse> => {
		let response: Response;
		try {
			response = await fetchFn(`${appUrl}${path}`, {
				method,
				headers:
					body === undefined
						? undefined
						: { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (error) {
			throw new EnvironmentFailure(
				`the app did not answer at ${method} ${path}: ${
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

	// 1. Health through the app (precondition; no observed end state yet).
	log.line("→ checks: app health (gateway reachable, NATS connected)");
	const health = await call("GET", "/health");
	if (health.status !== 200)
		failureFor(health, "GET /health", "gateway health");
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

	// 2. Single trigger with idempotency + priority through the app.
	log.line("→ checks: POST /events (idempotency + priority)");
	const idempotencyKey = `example-${runId}`;
	const triggerRequest = {
		name: "example.node_app.trigger",
		to: {
			subscriberId,
			email: `subscriber+${runId}@example.local`,
		},
		payload: { runId, source: "nervly-js/examples/node-app" },
		category: "transactional",
		idempotencyKey,
		priority: "NORMAL",
	};
	const trigger = await call("POST", "/events", triggerRequest);
	if (trigger.status !== 202) {
		failureFor(trigger, "POST /events", "trigger accepted");
	}
	const eventId = stringField(trigger.body, "eventId");
	if (eventId === null) {
		throw new AssertionFailure(
			"the app accepted the trigger but returned no eventId",
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

	// 3. Replay the same trigger with the same idempotency key: the gateway
	//    dedupes, so the same event id comes back. The message count after
	//    delivery (below) proves the replay did not double-send.
	log.line(
		`→ checks: replay POST /events with idempotency-key ${idempotencyKey}`,
	);
	const replay = await call("POST", "/events", triggerRequest);
	if (replay.status !== 202) {
		failureFor(replay, "POST /events (replay)", "idempotent replay");
	}
	const replayEventId = stringField(replay.body, "eventId");
	if (
		replayEventId === null ||
		normalizeEventId(replayEventId) !== normalizeEventId(eventId)
	) {
		throw new AssertionFailure(
			`the idempotent replay returned ${replayEventId ?? "no eventId"} instead of ${eventId}`,
			{
				name: "idempotent replay",
				status: "fail",
				detail: `replay returned ${describe(replay.body)}`,
			},
		);
	}
	log.line(`  replay returned the same event ${eventId}`);

	// 4. Event lookup through the app.
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

	// 5. Bulk trigger through the app.
	log.line("→ checks: POST /events/bulk (2 events)");
	const bulk = await call("POST", "/events/bulk", {
		events: [
			{
				name: "example.node_app.bulk",
				to: {
					subscriberId: `${subscriberId}-b1`,
					email: `subscriber+${runId}-b1@example.local`,
				},
				payload: { runId, index: 0 },
				category: "transactional",
			},
			{
				name: "example.node_app.bulk",
				to: {
					subscriberId: `${subscriberId}-b2`,
					email: `subscriber+${runId}-b2@example.local`,
				},
				payload: { runId, index: 1 },
				category: "transactional",
			},
		],
	});
	if (bulk.status !== 202) {
		failureFor(bulk, "POST /events/bulk", "bulk trigger");
	}
	const count = numberField(bulk.body, "count");
	const failedCount = numberField(bulk.body, "failedCount");
	const batchEvents =
		isRecord(bulk.body) && Array.isArray(bulk.body.events)
			? bulk.body.events
			: [];
	const acceptedIds = batchEvents
		.filter(isRecord)
		.map((event) => stringField(event, "eventId"))
		.filter((id): id is string => id !== null);
	if (
		count !== 2 ||
		failedCount !== 0 ||
		acceptedIds.length !== 2 ||
		batchEvents.length !== 2
	) {
		throw new AssertionFailure(
			`bulk trigger did not accept both events: ${describe(bulk.body)}`,
			{
				name: "bulk trigger",
				status: "fail",
				detail: describe(bulk.body),
			},
		);
	}
	checks.push({
		name: "bulk trigger",
		status: "pass",
		detail: `job ${stringField(bulk.body, "jobId") ?? "?"}: ${count} accepted, ${failedCount} failed`,
	});

	// 6. Subscriber preference update through the app.
	log.line(`→ checks: PUT /subscribers/${subscriberId}/preferences`);
	const preferences = await call(
		"PUT",
		`/subscribers/${encodeURIComponent(subscriberId)}/preferences`,
		{
			channels: { email: true, sms: false },
			categories: { transactional: { email: true } },
		},
	);
	if (preferences.status !== 200) {
		failureFor(
			preferences,
			"PUT /subscribers/:id/preferences",
			"preferences updated",
		);
	}
	if (stringField(preferences.body, "subscriberId") !== subscriberId) {
		throw new AssertionFailure(
			`preferences update echoed the wrong subscriber: ${describe(preferences.body)}`,
			{
				name: "preferences updated",
				status: "fail",
				detail: describe(preferences.body),
			},
		);
	}
	checks.push({
		name: "preferences updated",
		status: "pass",
		detail: `subscriber ${subscriberId} → ${stringField(preferences.body, "status") ?? "?"}`,
	});

	// 7. Typed error mapping, demonstrated against the real stack: the gateway
	//    rejects an empty bulk with 400 (SDK NervlyValidationError) and a
	//    missing event with 404 (SDK NervlyNotFoundError).
	log.line("→ checks: typed error mapping (validation, not found)");
	const invalidBulk = await call("POST", "/events/bulk", { events: [] });
	if (invalidBulk.status >= 500) {
		failureFor(
			invalidBulk,
			"POST /events/bulk (empty)",
			"typed error: validation",
		);
	}
	if (
		invalidBulk.status !== 400 ||
		errorTypeOf(invalidBulk.body) !== "VALIDATION_ERROR"
	) {
		throw new AssertionFailure(
			`an empty bulk must map to HTTP 400 VALIDATION_ERROR; got ${describe(invalidBulk)}`,
			{
				name: "typed error: validation",
				status: "fail",
				detail: describe(invalidBulk),
			},
		);
	}
	checks.push({
		name: "typed error: validation",
		status: "pass",
		detail: `HTTP 400 VALIDATION_ERROR — ${errorMessageOf(invalidBulk.body)}`,
	});

	const missingEventId = "evt_00000000000000000000000000000000";
	const missing = await call("GET", `/events/${missingEventId}`);
	if (missing.status >= 500) {
		failureFor(missing, "GET /events/<missing>", "typed error: not found");
	}
	if (missing.status !== 404 || errorTypeOf(missing.body) !== "NOT_FOUND") {
		throw new AssertionFailure(
			`a missing event must map to HTTP 404 NOT_FOUND; got ${describe(missing)}`,
			{
				name: "typed error: not found",
				status: "fail",
				detail: describe(missing),
			},
		);
	}
	checks.push({
		name: "typed error: not found",
		status: "pass",
		detail: `HTTP 404 NOT_FOUND — ${errorMessageOf(missing.body)}`,
	});

	// 8. Asserted end state: read the message back as DELIVERED (test mode),
	//    and prove the idempotent replay did not create a second message.
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
				log.line(`  asserted end state: ${eventId} is DELIVERED in test mode`);

				// The replay used the same Idempotency-Key and returned the same
				// event id; one message for the event proves no second send.
				if (matches.length !== 1) {
					throw new AssertionFailure(
						`idempotent replay produced ${matches.length} messages for ${eventId}`,
						{
							name: "idempotent replay",
							status: "fail",
							detail: `${matches.length} messages observed for event ${eventId}`,
						},
					);
				}
				checks.push({
					name: "idempotent replay",
					status: "pass",
					detail: `same event id on replay; ${matches.length} message observed for ${eventId}`,
				});
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
