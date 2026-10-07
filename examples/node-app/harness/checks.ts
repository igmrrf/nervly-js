/**
 * The walking skeleton's asserted checks (contract §3.3): gateway health, an
 * SDK trigger, and the asserted end state — the triggered message reads back
 * `DELIVERED` through `messages.list` in test mode. HTTP acceptance alone is
 * never "green".
 */

import type Nervly from "../../../src/index.js";
import {
	NervlyNetworkError,
	NervlyRetryExhaustedError,
	NervlyServerError,
} from "../../../src/index.js";
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
	client: Nervly;
	runId: string;
	timeoutMs: number;
	log: Transcript;
	/** Test seams. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export interface RunChecksResult {
	checks: CheckResult[];
	eventId: string;
	/** The subscriber this run triggered for (also the search key for read-back). */
	subscriberId: string;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const STACK_HINT = ' Is the local stack up? Run "make up" in nervly-base.';

/** Stack-down errors are environment failures; everything else is an assertion. */
function isEnvironmentError(error: unknown): boolean {
	return (
		error instanceof NervlyNetworkError ||
		error instanceof NervlyRetryExhaustedError ||
		error instanceof NervlyServerError
	);
}

function stackHint(error: unknown): string {
	return isEnvironmentError(error) ? STACK_HINT : "";
}

/**
 * Run the skeleton's checks in order. Throws {@link EnvironmentFailure} when
 * the stack itself is unusable and {@link AssertionFailure} when an observed
 * end state does not hold; the failing check travels on the error.
 */
export async function runChecks(
	options: RunChecksOptions,
): Promise<RunChecksResult> {
	const { client, runId, timeoutMs, log } = options;
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = options.now ?? (() => Date.now());
	const checks: CheckResult[] = [];
	const subscriberId = `sub-example-${runId.toLowerCase()}`;

	// 1. Gateway health (precondition; no observed end state yet).
	log.line("→ checks: gateway health");
	let healthStatus = "unknown";
	try {
		const health = await client.health.check();
		healthStatus = health.status;
		if (!health.nats_connected) {
			throw new EnvironmentFailure(
				"gateway reports NATS disconnected; delivery cannot flow",
				{
					name: "gateway health",
					status: "fail",
					detail: `status=${health.status} nats_connected=false`,
				},
			);
		}
	} catch (error) {
		if (error instanceof EnvironmentFailure) throw error;
		throw new EnvironmentFailure(
			`gateway health check failed: ${describeError(error)}${stackHint(error)}`,
			{
				name: "gateway health",
				status: "fail",
				detail: describeError(error),
			},
			{ cause: error },
		);
	}
	checks.push({
		name: "gateway health",
		status: "pass",
		detail: `status=${healthStatus} nats_connected=true`,
	});
	log.line(`  gateway healthy (status=${healthStatus})`);

	// 2. Trigger through the SDK.
	log.line("→ checks: trigger through the SDK");
	const idempotencyKey = `example-${runId}`;
	let eventId: string;
	try {
		const event = await client.events.trigger(
			{
				name: "example.node_app.trigger",
				to: {
					subscriberId,
					email: `subscriber+${runId}@example.local`,
				},
				payload: { runId, source: "nervly-js/examples/node-app" },
				category: "transactional",
			},
			{ idempotencyKey, priority: "NORMAL" },
		);
		if (!event.eventId) {
			throw new AssertionFailure("the trigger response carried no eventId", {
				name: "trigger accepted",
				status: "fail",
				detail: "missing eventId in the trigger response",
			});
		}
		eventId = event.eventId;
	} catch (error) {
		if (error instanceof EnvironmentFailure) throw error;
		if (error instanceof AssertionFailure) throw error;
		if (isEnvironmentError(error)) {
			throw new EnvironmentFailure(
				`trigger failed at the stack level: ${describeError(error)}${STACK_HINT}`,
				{
					name: "trigger accepted",
					status: "fail",
					detail: describeError(error),
				},
				{ cause: error },
			);
		}
		throw new AssertionFailure(`trigger rejected: ${describeError(error)}`, {
			name: "trigger accepted",
			status: "fail",
			detail: describeError(error),
		});
	}
	checks.push({
		name: "trigger accepted",
		status: "pass",
		detail: `event ${eventId} accepted (idempotency-key=${idempotencyKey})`,
	});
	log.line(`  trigger accepted (event ${eventId})`);

	// 3. Asserted end state: read the message back as DELIVERED (test mode).
	log.line(
		`→ checks: read back ${eventId} via messages.list (bound ${timeoutMs}ms)`,
	);
	const deadline = now() + timeoutMs;
	let lastStatus: string | null = null;
	for (;;) {
		let page: Awaited<ReturnType<typeof client.messages.list>>;
		try {
			page = await client.messages.list({ subscriberId, limit: 20 });
		} catch (error) {
			// messages.list is the read-back surface: a stack-level failure here
			// means the environment, not the end state, is broken.
			throw new EnvironmentFailure(
				`messages.list failed at the stack level: ${describeError(error)}${stackHint(error)}`,
				{
					name: "trigger delivered",
					status: "fail",
					detail: describeError(error),
				},
				{ cause: error },
			);
		}

		const wanted = normalizeEventId(eventId);
		const message = page.messages.find(
			(candidate) => normalizeEventId(candidate.event_id) === wanted,
		);
		if (message) {
			lastStatus = message.status;
			if (message.status === "DELIVERED") {
				if (message.test_mode !== true) {
					throw new AssertionFailure(
						"message was delivered outside test mode; examples only run test keys",
						{
							name: "trigger delivered",
							status: "fail",
							detail: `event ${message.event_id} DELIVERED with test_mode=false`,
						},
					);
				}
				checks.push({
					name: "trigger delivered",
					status: "pass",
					detail: `event ${message.event_id} status DELIVERED (test_mode=true, channel=${message.channel ?? "?"}, attempts=${message.attempts})`,
				});
				log.line(
					`  asserted end state: ${message.event_id} is DELIVERED in test mode`,
				);
				return { checks, eventId, subscriberId };
			}
			if (isTerminalFailure(message.status)) {
				throw new AssertionFailure(
					`message reached terminal status ${message.status}, not DELIVERED`,
					{
						name: "trigger delivered",
						status: "fail",
						detail: `event ${message.event_id} status ${message.status}`,
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
