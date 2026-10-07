/**
 * Worker-routing tests for the edge-worker example.
 *
 * `handleRequest` is driven directly with a stubbed global `fetch`, so the
 * tests exercise the real `@nervly/sdk` client (built package entry) across the
 * worker's HTTP surface: request shapes on the wire, per-request client
 * construction from `env`, the response passthrough, and the SDK-error → HTTP
 * mapping table.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	NervlyNetworkError,
	NervlyRateLimitError,
	NervlyValidationError,
} from "@nervly/sdk";

import {
	CLIENT_DEFAULTS,
	createClient,
	DEFAULT_API_URL,
	handleRequest,
	mapErrorToResponse,
	type WorkerEnv,
} from "../examples/edge-worker/app.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/**
 * Synthetic API keys assembled at runtime from fragments, so secret scanners
 * never see a key-shaped literal in this file.
 */
function syntheticApiKey(mode: "test" | "live", ...segments: string[]): string {
	return ["nervly", "sk", mode, ...segments].join("_");
}

const TEST_KEY = syntheticApiKey("test", "worker", "stub");
const SECOND_KEY = syntheticApiKey("test", "worker", "second");

function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
	return {
		NERVLY_API_KEY: TEST_KEY,
		NERVLY_API_URL: "http://localhost:8080",
		...overrides,
	};
}

interface StubCall {
	url: string;
	method: string;
	headers: Headers;
	body: string | undefined;
}

function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/**
 * Replace the global `fetch` for one test. The worker's SDK client uses the
 * global at call time, so this is the only seam needed.
 */
async function withStubbedFetch<T>(
	handler: (call: StubCall) => Response | Promise<Response>,
	fn: (calls: StubCall[]) => Promise<T>,
): Promise<T> {
	const original = globalThis.fetch;
	const calls: StubCall[] = [];
	globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
		const call: StubCall = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? init.body : undefined,
		};
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
	try {
		return await fn(calls);
	} finally {
		globalThis.fetch = original;
	}
}

function urlOf(call: StubCall): URL {
	return new URL(call.url);
}

function workerRequest(path: string, init: RequestInit = {}): Request {
	return new Request(`http://worker.test${path}`, init);
}

function postJson(path: string, body: unknown): Request {
	return workerRequest(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const EVENT_ID = "evt_0123456789abcdef0123456789abcdef";

describe("client configuration", () => {
	it("pins edge-friendly tuning and defaults the gateway URL", () => {
		assert.deepEqual(CLIENT_DEFAULTS, {
			timeoutMs: 5_000,
			maxRetries: 1,
			retryBaseDelayMs: 250,
		});
		assert.equal(DEFAULT_API_URL, "http://localhost:8080");
		// Constructing without a key fails inside the SDK; the route maps it.
		assert.throws(() => createClient(env({ NERVLY_API_KEY: "" })));
	});
});

describe("worker routes", () => {
	it("GET /health passes the gateway health through (unauthenticated)", async () => {
		await withStubbedFetch(
			() =>
				jsonResponse(200, {
					status: "OK",
					service: "stub-gateway",
					nats_connected: true,
					key_mode: "test",
				}),
			async (calls) => {
				const response = await handleRequest(workerRequest("/health"), env());
				assert.equal(response.status, 200);
				const body = (await response.json()) as Record<string, unknown>;
				assert.equal(body.status, "OK");
				assert.equal(body.nats_connected, true);
				assert.equal(calls.length, 1);
				assert.equal(urlOf(calls[0] as StubCall).pathname, "/v1/health");
				assert.equal(calls[0]?.headers.get("authorization"), null);
			},
		);
	});

	it("POST /events forwards idempotency + priority and returns the event", async () => {
		await withStubbedFetch(
			(call) => {
				assert.equal(urlOf(call).pathname, "/v1/events/trigger");
				return jsonResponse(202, {
					eventId: EVENT_ID,
					status: "QUEUED",
					priority: "HIGH",
					channel: "email",
					idempotencyKey: call.headers.get("idempotency-key"),
					timestamp: new Date().toISOString(),
				});
			},
			async (calls) => {
				const response = await handleRequest(
					postJson("/events", {
						name: "example.edge_worker.trigger",
						to: { subscriberId: "sub-1", email: "sub@example.local" },
						payload: { runId: "r-1" },
						category: "transactional",
						idempotencyKey: "example-edge-r-1",
						priority: "HIGH",
					}),
					env(),
				);
				assert.equal(response.status, 202);
				const body = (await response.json()) as Record<string, unknown>;
				assert.equal(body.eventId, EVENT_ID);
				assert.equal(body.idempotencyKey, "example-edge-r-1");

				const call = calls[0] as StubCall;
				assert.equal(call.method, "POST");
				assert.equal(call.headers.get("authorization"), `Bearer ${TEST_KEY}`);
				assert.equal(call.headers.get("idempotency-key"), "example-edge-r-1");
				assert.equal(call.headers.get("x-priority-override"), "HIGH");
				const sent = JSON.parse(call.body ?? "") as Record<string, unknown>;
				assert.equal(sent.name, "example.edge_worker.trigger");
				assert.deepEqual(sent.to, {
					subscriberId: "sub-1",
					email: "sub@example.local",
				});
			},
		);
	});

	it("rejects invalid JSON and non-object bodies without touching the gateway", async () => {
		await withStubbedFetch(
			() => jsonResponse(200, {}),
			async (calls) => {
				const invalidJson = await handleRequest(
					workerRequest("/events", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{not json",
					}),
					env(),
				);
				assert.equal(invalidJson.status, 400);
				const invalidJsonBody = (await invalidJson.json()) as Record<
					string,
					unknown
				>;
				assert.equal(
					(invalidJsonBody.error as Record<string, unknown>).type,
					"INVALID_JSON",
				);

				const empty = await handleRequest(
					workerRequest("/events", { method: "POST" }),
					env(),
				);
				assert.equal(empty.status, 400);

				const array = await handleRequest(postJson("/events", [1, 2]), env());
				assert.equal(array.status, 400);
				const arrayBody = (await array.json()) as Record<string, unknown>;
				assert.equal(
					(arrayBody.error as Record<string, unknown>).type,
					"INVALID_BODY",
				);
				assert.equal(calls.length, 0);
			},
		);
	});

	it("GET /messages maps query params and passes the page through", async () => {
		await withStubbedFetch(
			(call) => {
				assert.equal(urlOf(call).pathname, "/v1/messages");
				assert.equal(urlOf(call).searchParams.get("subscriber_id"), "sub-1");
				assert.equal(urlOf(call).searchParams.get("limit"), "5");
				return jsonResponse(200, {
					messages: [{ event_id: EVENT_ID, status: "DELIVERED" }],
				});
			},
			async (calls) => {
				const response = await handleRequest(
					workerRequest("/messages?subscriberId=sub-1&limit=5"),
					env(),
				);
				assert.equal(response.status, 200);
				const body = (await response.json()) as { messages: unknown[] };
				assert.equal(body.messages.length, 1);
				assert.equal(
					calls[0]?.headers.get("authorization"),
					`Bearer ${TEST_KEY}`,
				);
			},
		);
	});

	it("rejects a malformed messages limit as INVALID_QUERY", async () => {
		await withStubbedFetch(
			() => jsonResponse(200, {}),
			async (calls) => {
				const response = await handleRequest(
					workerRequest("/messages?limit=0"),
					env(),
				);
				assert.equal(response.status, 400);
				const body = (await response.json()) as Record<string, unknown>;
				assert.equal(
					(body.error as Record<string, unknown>).type,
					"INVALID_QUERY",
				);
				assert.equal(calls.length, 0);
			},
		);
	});

	it("GET /events/:id reads back through events.get and maps a missing event", async () => {
		await withStubbedFetch(
			(call) =>
				urlOf(call).pathname === `/v1/events/${EVENT_ID}`
					? jsonResponse(200, {
							event_id: EVENT_ID,
							status: "DELIVERED",
							test_mode: true,
						})
					: jsonResponse(404, {
							error: "NOT_FOUND",
							message: "Event not found",
							status_code: 404,
						}),
			async () => {
				const found = await handleRequest(
					workerRequest(`/events/${EVENT_ID}`),
					env(),
				);
				assert.equal(found.status, 200);
				const foundBody = (await found.json()) as Record<string, unknown>;
				assert.equal(foundBody.event_id, EVENT_ID);

				const missing = await handleRequest(
					workerRequest("/events/evt_ffffffffffffffffffffffffffffffff"),
					env(),
				);
				assert.equal(missing.status, 404);
				const missingBody = (await missing.json()) as Record<string, unknown>;
				assert.equal(
					(missingBody.error as Record<string, unknown>).type,
					"NOT_FOUND",
				);
			},
		);
	});

	it("returns 404 for unknown routes without touching the gateway", async () => {
		await withStubbedFetch(
			() => jsonResponse(200, {}),
			async (calls) => {
				const response = await handleRequest(workerRequest("/nope"), env());
				assert.equal(response.status, 404);
				const body = (await response.json()) as Record<string, unknown>;
				assert.equal((body.error as Record<string, unknown>).type, "NOT_FOUND");
				assert.equal(calls.length, 0);
			},
		);
	});

	it("constructs a client per request, so each env key is used", async () => {
		await withStubbedFetch(
			(call) =>
				urlOf(call).pathname === "/v1/health"
					? jsonResponse(200, { status: "OK", nats_connected: true })
					: jsonResponse(202, { eventId: EVENT_ID, status: "QUEUED" }),
			async (calls) => {
				await handleRequest(workerRequest("/health"), env());
				await handleRequest(
					postJson("/events", { name: "x", to: { subscriberId: "s" } }),
					env(),
				);
				await handleRequest(
					postJson("/events", { name: "x", to: { subscriberId: "s" } }),
					env({ NERVLY_API_KEY: SECOND_KEY }),
				);
				assert.equal(calls.length, 3);
				// Health is unauthenticated (skipAuth); each trigger carries the key
				// from the env of its own request, not module state.
				assert.equal(calls[0]?.headers.get("authorization"), null);
				assert.equal(
					calls[1]?.headers.get("authorization"),
					`Bearer ${TEST_KEY}`,
				);
				assert.equal(
					calls[2]?.headers.get("authorization"),
					`Bearer ${SECOND_KEY}`,
				);
			},
		);
	});

	it("maps a retried upstream 5xx to 503 RETRY_EXHAUSTED", async () => {
		await withStubbedFetch(
			() =>
				jsonResponse(500, {
					error: "INTERNAL_ERROR",
					message: "gateway exploded",
					status_code: 500,
				}),
			async (calls) => {
				const response = await handleRequest(workerRequest("/health"), env());
				assert.equal(response.status, 503);
				const body = (await response.json()) as Record<string, unknown>;
				const error = body.error as Record<string, unknown>;
				assert.equal(error.type, "RETRY_EXHAUSTED");
				assert.equal(error.attempts, 1);
				assert.equal(calls.length, 2, "one retry is configured and used");
			},
		);
	});

	it("surfaces an unconfigured worker env as INTERNAL_ERROR", async () => {
		// The SDK's `Nervly` constructor throws a plain Error for an empty key;
		// a worker deployed without its binding is a server misconfiguration, so
		// the worker answers 500 (the checks phase then reports environment).
		await withStubbedFetch(
			() => jsonResponse(200, {}),
			async (calls) => {
				const response = await handleRequest(
					workerRequest("/health"),
					env({ NERVLY_API_KEY: "" }),
				);
				assert.equal(response.status, 500);
				const body = (await response.json()) as Record<string, unknown>;
				assert.equal(
					(body.error as Record<string, unknown>).type,
					"INTERNAL_ERROR",
				);
				assert.equal(calls.length, 0);
			},
		);
	});
});

describe("mapErrorToResponse", () => {
	it("maps SDK errors to the documented HTTP statuses", () => {
		const rate = new NervlyRateLimitError("slow down", 1500);
		const rateResponse = mapErrorToResponse(rate);
		assert.equal(rateResponse.status, 429);

		const validation = mapErrorToResponse(
			new NervlyValidationError("bad input", "req-1"),
		);
		assert.equal(validation.status, 400);

		const network = mapErrorToResponse(new NervlyNetworkError("socket down"));
		assert.equal(network.status, 503);
	});

	it("maps an unknown throwable to 500 INTERNAL_ERROR", async () => {
		const response = mapErrorToResponse(new Error("mystery"));
		assert.equal(response.status, 500);
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(
			(body.error as Record<string, unknown>).type,
			"INTERNAL_ERROR",
		);
	});
});
