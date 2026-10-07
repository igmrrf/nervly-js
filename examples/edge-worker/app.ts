/**
 * Edge SDK example worker — the workerd entry point (`wrangler dev` serves it).
 *
 * The worker exposes the SDK's own surface over HTTP: `health.check`,
 * `events.trigger`, `events.get` and `messages.list`. The Nervly client is
 * constructed **per request** from `env` (never at module scope), exactly as
 * the edge-runtime research requires: the key arrives through `.dev.vars`
 * locally or `wrangler secret` on deploy, and never lives in module state.
 *
 * Only Web APIs are used (`fetch`, `Request`, `Response`, `URL`) so the example
 * runs on workerd unmodified. The webhook verification helper (the only
 * Node-specific SDK path) is deliberately not exercised.
 */

import type {
	ListMessagesParams,
	Priority,
	Recipient,
	TriggerEventOptions,
	TriggerEventRequest,
} from "@nervly/sdk";
import Nervly, {
	NervlyApiError,
	NervlyAuthenticationError,
	NervlyIdempotencyError,
	NervlyNetworkError,
	NervlyNotFoundError,
	NervlyRateLimitError,
	NervlyRetryExhaustedError,
	NervlyServerError,
	NervlyValidationError,
} from "@nervly/sdk";

/** Worker bindings: the test-mode key and (optionally) the gateway base URL. */
export interface WorkerEnv {
	NERVLY_API_KEY: string;
	NERVLY_API_URL?: string;
}

/** Default gateway, matching the harness contract's local stack. */
export const DEFAULT_API_URL = "http://localhost:8080";

/**
 * Edge-friendly client tuning. The request timeout and the single retry keep a
 * failing gateway from eating an edge request's whole budget; the retry is safe
 * because trigger calls carry an idempotency key.
 */
export const CLIENT_DEFAULTS = {
	timeoutMs: 5_000,
	maxRetries: 1,
	retryBaseDelayMs: 250,
} as const;

/** Build the SDK client for one request from the Worker's `env`. */
export function createClient(env: WorkerEnv): Nervly {
	return new Nervly({
		apiKey: env.NERVLY_API_KEY,
		baseUrl: env.NERVLY_API_URL?.trim() || DEFAULT_API_URL,
		timeout: CLIENT_DEFAULTS.timeoutMs,
		maxRetries: CLIENT_DEFAULTS.maxRetries,
		retryBaseDelay: CLIENT_DEFAULTS.retryBaseDelayMs,
	});
}

/** An app-level request error (bad JSON, bad query, unknown route). */
export class HttpError extends Error {
	readonly status: number;
	readonly type: string;

	constructor(status: number, type: string, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.type = type;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PRIORITIES = new Set(["CRITICAL", "HIGH", "NORMAL", "LOW"]);

function isPriority(value: unknown): value is Priority {
	return typeof value === "string" && PRIORITIES.has(value);
}

function json(status: number, body: unknown): Response {
	return new Response(`${JSON.stringify(body)}\n`, {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function errorBody(
	status: number,
	type: string,
	message: string,
	extra: Record<string, unknown> = {},
): { error: Record<string, unknown> } {
	return { error: { type, message, status, ...extra } };
}

/**
 * Map any thrown value to the HTTP response the caller sees. The table mirrors
 * the node-app example's mapping so both examples speak the same error dialect.
 */
export function mapErrorToResponse(error: unknown): Response {
	if (error instanceof HttpError) {
		return json(
			error.status,
			errorBody(error.status, error.type, error.message),
		);
	}
	if (error instanceof NervlyRateLimitError) {
		return json(
			429,
			errorBody(429, "RATE_LIMIT_EXCEEDED", error.message, {
				...(error.requestId ? { request_id: error.requestId } : {}),
				retry_after_ms: error.retryAfterMs,
				...(error.purpose ? { purpose: error.purpose } : {}),
			}),
		);
	}
	if (error instanceof NervlyValidationError) {
		return json(
			400,
			errorBody(400, "VALIDATION_ERROR", error.message, {
				...(error.requestId ? { request_id: error.requestId } : {}),
			}),
		);
	}
	if (error instanceof NervlyAuthenticationError) {
		return json(
			401,
			errorBody(401, "AUTHENTICATION_ERROR", error.message, {
				...(error.requestId ? { request_id: error.requestId } : {}),
			}),
		);
	}
	if (error instanceof NervlyNotFoundError) {
		return json(
			404,
			errorBody(404, "NOT_FOUND", error.message, {
				...(error.requestId ? { request_id: error.requestId } : {}),
			}),
		);
	}
	if (error instanceof NervlyIdempotencyError) {
		return json(
			409,
			errorBody(409, "IDEMPOTENCY_CONFLICT", error.message, {
				...(error.requestId ? { request_id: error.requestId } : {}),
			}),
		);
	}
	if (error instanceof NervlyServerError) {
		return json(
			502,
			errorBody(502, "UPSTREAM_ERROR", error.message, {
				...(error.requestId ? { request_id: error.requestId } : {}),
			}),
		);
	}
	if (error instanceof NervlyRetryExhaustedError) {
		return json(
			503,
			errorBody(503, "RETRY_EXHAUSTED", error.message, {
				attempts: error.attempts,
			}),
		);
	}
	if (error instanceof NervlyNetworkError) {
		return json(503, errorBody(503, "NETWORK_ERROR", error.message));
	}
	if (error instanceof NervlyApiError) {
		const status =
			error.statusCode >= 400 && error.statusCode <= 599
				? error.statusCode
				: 502;
		const type =
			error.statusCode === 422
				? "VALIDATION_ERROR"
				: error.errorType !== "UNKNOWN_ERROR"
					? error.errorType
					: "API_ERROR";
		return json(
			status,
			errorBody(status, type, error.message, {
				...(error.requestId ? { request_id: error.requestId } : {}),
			}),
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	return json(500, errorBody(500, "INTERNAL_ERROR", message));
}

async function readJsonBody(request: Request): Promise<unknown> {
	let text: string;
	try {
		text = await request.text();
	} catch {
		throw new HttpError(400, "INVALID_JSON", "request body could not be read");
	}
	if (text.trim() === "") {
		throw new HttpError(
			400,
			"INVALID_JSON",
			"request body must be a JSON object",
		);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new HttpError(400, "INVALID_JSON", "request body is not valid JSON");
	}
}

function listMessageParams(url: URL): ListMessagesParams {
	const params: ListMessagesParams = {};
	const query = url.searchParams;
	const subscriberId = query.get("subscriberId") ?? query.get("subscriber_id");
	if (subscriberId) params.subscriberId = subscriberId;
	if (query.get("status")) params.status = query.get("status") as string;
	if (query.get("channel")) params.channel = query.get("channel") as string;
	if (query.get("from")) params.from = query.get("from") as string;
	if (query.get("to")) params.to = query.get("to") as string;
	if (query.get("cursor")) params.cursor = query.get("cursor") as string;
	if (query.has("limit")) {
		const raw = query.get("limit") ?? "";
		const limit = Number(raw);
		if (!Number.isInteger(limit) || limit < 1) {
			throw new HttpError(
				400,
				"INVALID_QUERY",
				`limit=${raw} must be a positive integer`,
			);
		}
		params.limit = limit;
	}
	return params;
}

/**
 * The worker's HTTP surface. Exported so tests can drive it directly with a
 * stub `fetch` (the SDK uses the global at call time); the default export below
 * is what workerd invokes.
 */
export async function handleRequest(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const url = new URL(request.url);
	const route = `${request.method} ${url.pathname}`;

	try {
		// Per request, from env — never module scope (edge research §4.2).
		const client = createClient(env);

		if (route === "GET /health") {
			return json(200, await client.health.check());
		}

		if (route === "POST /events") {
			const body = await readJsonBody(request);
			if (!isRecord(body)) {
				throw new HttpError(
					400,
					"INVALID_BODY",
					"request body must be a JSON object",
				);
			}
			const options: TriggerEventOptions = {};
			if (typeof body.idempotencyKey === "string" && body.idempotencyKey) {
				options.idempotencyKey = body.idempotencyKey;
			}
			if (isPriority(body.priority)) {
				options.priority = body.priority;
			}
			const trigger: TriggerEventRequest = {
				name: typeof body.name === "string" ? body.name : "",
				to: (isRecord(body.to) ? body.to : {}) as unknown as Recipient,
			};
			if (body.payload !== undefined) {
				trigger.payload = body.payload as Record<string, unknown> | null;
			}
			if (typeof body.category === "string") {
				trigger.category = body.category;
			}
			const event = await client.events.trigger(trigger, options);
			return json(202, {
				eventId: event.eventId,
				status: event.status,
				priority: event.priority,
				channel: event.channel,
				idempotencyKey: event.idempotencyKey ?? options.idempotencyKey ?? null,
			});
		}

		if (route === "GET /messages") {
			return json(200, await client.messages.list(listMessageParams(url)));
		}

		const lookup = /^GET \/events\/([^/]+)$/.exec(route);
		if (lookup) {
			const eventId = decodeURIComponent(lookup[1] as string);
			return json(200, await client.events.get(eventId));
		}

		throw new HttpError(
			404,
			"NOT_FOUND",
			`no route for ${request.method} ${url.pathname}`,
		);
	} catch (error) {
		return mapErrorToResponse(error);
	}
}

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		return handleRequest(request, env);
	},
};
