/**
 * Server-app tests for the node-app example (ticket 8).
 *
 * `tests/node-app-harness.test.ts` pins the harness contract around the app;
 * this file drives the real `node:http` app (`examples/node-app/app.ts`) over
 * HTTP against a stubbed gateway and pins:
 *
 *   - every route's request shape on the wire and its response passthrough,
 *   - the explicit retry/timeout wiring (retries, exhaustion, timeout),
 *   - the typed-SDK-error → HTTP mapping table, and
 *   - the standalone server's environment guards.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	createServer as createHttpServer,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	NervlyRateLimitError,
	NervlyRetryExhaustedError,
	NervlyServerError,
} from "@nervly/sdk";

import {
	AppConfigError,
	HttpError,
	mapErrorToHttp,
	type RunningApp,
	resolveAppConfig,
	type StartAppOptions,
	startApp,
} from "../examples/node-app/app.js";
import { GuardRefusal } from "../examples/node-app/harness/errors.js";
import {
	DEFAULT_PORT,
	loadServerOptions,
	parsePort,
} from "../examples/node-app/server.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(
	ROOT,
	"node_modules",
	".bin",
	process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const SERVER_ENTRY = join(ROOT, "examples", "node-app", "server.ts");

/**
 * Synthetic API keys assembled at runtime from fragments, so secret scanners
 * never see a key-shaped literal in this file (same pattern as the harness
 * suite). The joined value has the exact `nervly_sk_<mode>_<segments>` shape.
 */
function syntheticApiKey(mode: "test" | "live", ...segments: string[]): string {
	return ["nervly", "sk", mode, ...segments].join("_");
}

const TEST_KEY = syntheticApiKey("test", "app", "stub");

// ---------------------------------------------------------------------------
// Stub gateway + helpers
// ---------------------------------------------------------------------------

interface StubRequest {
	method: string;
	url: string;
	headers: NodeJS.Dict<string | string[]>;
	body: string;
}

interface HttpStub {
	url: string;
	requests: StubRequest[];
	close: () => Promise<void>;
}

function startHttpStub(
	handler: (request: StubRequest, response: ServerResponse) => void,
): Promise<HttpStub> {
	const requests: StubRequest[] = [];
	const server = createHttpServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const captured: StubRequest = {
				method: req.method ?? "",
				url: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			};
			requests.push(captured);
			try {
				handler(captured, res);
			} catch (error) {
				res.statusCode = 500;
				res.end(String(error));
			}
		});
	});
	return new Promise((promiseResolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo;
			promiseResolve({
				url: `http://127.0.0.1:${address.port}`,
				requests,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}

function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string | string[]> = {},
): void {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

function pathOf(request: StubRequest): string {
	return new URL(request.url, "http://stub").pathname;
}

function jsonBody(request: StubRequest): Record<string, unknown> {
	return JSON.parse(request.body) as Record<string, unknown>;
}

function appOptions(
	baseUrl: string,
	overrides: Partial<StartAppOptions> = {},
): StartAppOptions {
	return {
		apiKey: TEST_KEY,
		baseUrl,
		timeoutMs: 1000,
		maxRetries: 0,
		retryBaseDelayMs: 1,
		...overrides,
	};
}

/** Start a stub gateway, then the real app against it; clean both up. */
async function withApp(
	handler: (request: StubRequest, response: ServerResponse) => void,
	run: (context: { app: RunningApp; gateway: HttpStub }) => Promise<void>,
	overrides: Partial<StartAppOptions> = {},
): Promise<void> {
	const gateway = await startHttpStub(handler);
	const app = await startApp(appOptions(gateway.url, overrides));
	try {
		await run({ app, gateway });
	} finally {
		await app.close();
		await gateway.close();
	}
}

async function fetchJson(
	url: string,
	init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
	const response = await fetch(url, init);
	const text = await response.text();
	let body: unknown = null;
	if (text !== "") {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}
	return { status: response.status, body };
}

function postJson(
	url: string,
	body: unknown,
): Promise<{ status: number; body: unknown }> {
	return fetchJson(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const TRIGGER = {
	name: "example.test.trigger",
	to: { subscriberId: "sub-app-1", email: "sub@example.local" },
	payload: { hello: "world" },
	category: "transactional",
};

function healthPayload(): Record<string, unknown> {
	return {
		status: "OK",
		service: "stub-gateway",
		version: "0.0.0",
		environment: "test",
		deployment: "stub",
		key_mode: "test",
		uptime_seconds: 1,
		nats_connected: true,
	};
}

// ---------------------------------------------------------------------------
// App configuration
// ---------------------------------------------------------------------------

describe("resolveAppConfig", () => {
	it("applies the documented retry/timeout defaults", () => {
		const config = resolveAppConfig({
			apiKey: TEST_KEY,
			baseUrl: "http://localhost:8080",
		});
		assert.deepEqual(config, {
			apiKey: TEST_KEY,
			baseUrl: "http://localhost:8080",
			timeoutMs: 10_000,
			maxRetries: 2,
			retryBaseDelayMs: 250,
		});
	});

	it("honours explicit overrides, allowing zero retries", () => {
		const config = resolveAppConfig({
			apiKey: TEST_KEY,
			baseUrl: "http://127.0.0.1:1",
			timeoutMs: 1500,
			maxRetries: 0,
			retryBaseDelayMs: 50,
		});
		assert.equal(config.timeoutMs, 1500);
		assert.equal(config.maxRetries, 0);
		assert.equal(config.retryBaseDelayMs, 50);
	});

	it("refuses malformed tuning values", () => {
		const cases: Array<Record<string, number>> = [
			{ timeoutMs: 0 },
			{ timeoutMs: Number.NaN },
			{ maxRetries: -1 },
			{ maxRetries: 1.5 },
			{ retryBaseDelayMs: 0 },
		];
		for (const overrides of cases) {
			assert.throws(
				() =>
					resolveAppConfig({
						apiKey: TEST_KEY,
						baseUrl: "http://localhost:8080",
						...overrides,
					}),
				(error: unknown) => error instanceof AppConfigError,
				`expected a refusal for ${JSON.stringify(overrides)}`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe("app routes", () => {
	it("serves GET /health from the gateway health check", async () => {
		await withApp(
			(request, response) => {
				if (pathOf(request) === "/v1/health") {
					sendJson(response, 200, healthPayload());
					return;
				}
				sendJson(response, 404, { error: "unexpected" });
			},
			async ({ app }) => {
				const health = await fetchJson(`${app.url}/health`);
				assert.equal(health.status, 200);
				assert.equal((health.body as { status: string }).status, "OK");
				assert.equal(
					(health.body as { nats_connected: boolean }).nats_connected,
					true,
				);
			},
		);
	});

	it("POST /events forwards idempotency + priority and returns the event", async () => {
		await withApp(
			(request, response) => {
				if (
					request.method === "POST" &&
					pathOf(request) === "/v1/events/trigger"
				) {
					sendJson(response, 202, {
						eventId: "evt_00000000000000000000000000000001",
						status: "QUEUED",
						priority: "HIGH",
						channel: "email",
						idempotencyKey: request.headers["idempotency-key"] ?? null,
						timestamp: new Date().toISOString(),
					});
					return;
				}
				sendJson(response, 404, { error: "unexpected" });
			},
			async ({ app, gateway }) => {
				const result = await postJson(`${app.url}/events`, {
					...TRIGGER,
					idempotencyKey: "example-run-1",
					priority: "HIGH",
				});
				assert.equal(result.status, 202);
				assert.deepEqual(result.body, {
					eventId: "evt_00000000000000000000000000000001",
					status: "QUEUED",
					priority: "HIGH",
					channel: "email",
					idempotencyKey: "example-run-1",
				});

				const trigger = gateway.requests.find(
					(request) => pathOf(request) === "/v1/events/trigger",
				);
				assert.ok(trigger);
				assert.equal(trigger.headers["idempotency-key"], "example-run-1");
				assert.equal(trigger.headers["x-priority-override"], "HIGH");
				assert.equal(trigger.headers.authorization, `Bearer ${TEST_KEY}`);
				// The options travel as headers, not in the trigger payload.
				assert.deepEqual(jsonBody(trigger), TRIGGER);
			},
		);
	});

	it("POST /events generates an Idempotency-Key when the caller sends none", async () => {
		await withApp(
			(request, response) => {
				if (
					request.method === "POST" &&
					pathOf(request) === "/v1/events/trigger"
				) {
					sendJson(response, 202, {
						eventId: "evt_00000000000000000000000000000002",
						status: "QUEUED",
						priority: "NORMAL",
						channel: "email",
						idempotencyKey: request.headers["idempotency-key"] ?? null,
						timestamp: new Date().toISOString(),
					});
					return;
				}
				sendJson(response, 404, { error: "unexpected" });
			},
			async ({ app, gateway }) => {
				const result = await postJson(`${app.url}/events`, TRIGGER);
				assert.equal(result.status, 202);
				const key = gateway.requests[0]?.headers["idempotency-key"];
				assert.equal(typeof key, "string");
				assert.match(
					String(key),
					/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
				);
				assert.equal(
					(result.body as { idempotencyKey: string }).idempotencyKey,
					key,
				);
			},
		);
	});

	it("POST /events/bulk forwards the batch and returns its result", async () => {
		await withApp(
			(request, response) => {
				if (
					request.method === "POST" &&
					pathOf(request) === "/v1/events/bulk"
				) {
					const events = jsonBody(request).events as unknown[];
					sendJson(response, 200, {
						jobId: "job_batch_1",
						status: "QUEUED",
						count: events.length,
						failedCount: 0,
						events: events.map((_event, index) => ({
							index,
							status: "QUEUED",
							eventId: `evt_bulk_${index}`,
							channel: "email",
						})),
					});
					return;
				}
				sendJson(response, 404, { error: "unexpected" });
			},
			async ({ app, gateway }) => {
				const batch = [TRIGGER, { ...TRIGGER, payload: { hello: "again" } }];
				const result = await postJson(`${app.url}/events/bulk`, {
					events: batch,
				});
				assert.equal(result.status, 202);
				assert.deepEqual(result.body, {
					jobId: "job_batch_1",
					status: "QUEUED",
					count: 2,
					failedCount: 0,
					events: [
						{
							index: 0,
							status: "QUEUED",
							eventId: "evt_bulk_0",
							channel: "email",
						},
						{
							index: 1,
							status: "QUEUED",
							eventId: "evt_bulk_1",
							channel: "email",
						},
					],
				});
				assert.deepEqual(jsonBody(gateway.requests[0] as StubRequest), {
					events: batch,
				});
			},
		);
	});

	it("GET /messages maps query filters onto the SDK wire format", async () => {
		await withApp(
			(request, response) => {
				if (pathOf(request) === "/v1/messages") {
					sendJson(response, 200, {
						messages: [{ event_id: "evt_1", status: "DELIVERED" }],
						next_cursor: "cursor-2",
					});
					return;
				}
				sendJson(response, 404, { error: "unexpected" });
			},
			async ({ app, gateway }) => {
				const result = await fetchJson(
					`${app.url}/messages?subscriberId=sub-1&status=DELIVERED&limit=5&cursor=c1`,
				);
				assert.equal(result.status, 200);
				assert.deepEqual(result.body, {
					messages: [{ event_id: "evt_1", status: "DELIVERED" }],
					next_cursor: "cursor-2",
				});
				const query = new URL(
					(gateway.requests[0] as StubRequest).url,
					"http://stub",
				).searchParams;
				assert.equal(query.get("subscriber_id"), "sub-1");
				assert.equal(query.get("status"), "DELIVERED");
				assert.equal(query.get("limit"), "5");
				assert.equal(query.get("cursor"), "c1");
			},
		);
	});

	it("GET /messages rejects a malformed limit without calling the gateway", async () => {
		await withApp(
			(_request, response) => {
				sendJson(response, 200, { messages: [] });
			},
			async ({ app, gateway }) => {
				for (const bad of ["abc", "0", "-2", "1.5"]) {
					const result = await fetchJson(`${app.url}/messages?limit=${bad}`);
					assert.equal(result.status, 400, `limit=${bad}`);
					assert.equal(
						(result.body as { error: { type: string } }).error.type,
						"INVALID_QUERY",
					);
				}
				assert.equal(gateway.requests.length, 0);
			},
		);
	});

	it("PUT /subscribers/:id/preferences updates through the SDK route", async () => {
		await withApp(
			(request, response) => {
				if (
					request.method === "PUT" &&
					pathOf(request) === "/v1/users/sub-app-1/preferences"
				) {
					sendJson(response, 200, {
						status: "UPDATED",
						subscriberId: "sub-app-1",
						updated_at: "2026-10-07T00:00:00Z",
					});
					return;
				}
				sendJson(response, 404, { error: "unexpected" });
			},
			async ({ app, gateway }) => {
				const body = { channels: { email: true, sms: false } };
				const result = await fetchJson(
					`${app.url}/subscribers/sub-app-1/preferences`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					},
				);
				assert.equal(result.status, 200);
				assert.deepEqual(result.body, {
					status: "UPDATED",
					subscriberId: "sub-app-1",
					updated_at: "2026-10-07T00:00:00Z",
				});
				assert.deepEqual(jsonBody(gateway.requests[0] as StubRequest), body);
			},
		);
	});

	it("GET /events/:eventId passes the message through", async () => {
		await withApp(
			(request, response) => {
				if (pathOf(request) === "/v1/events/evt_123") {
					sendJson(response, 200, {
						event_id: "evt_123",
						status: "DELIVERED",
						test_mode: true,
					});
					return;
				}
				sendJson(response, 404, { error: "unexpected" });
			},
			async ({ app }) => {
				const result = await fetchJson(`${app.url}/events/evt_123`);
				assert.equal(result.status, 200);
				assert.equal((result.body as { status: string }).status, "DELIVERED");
			},
		);
	});

	it("answers unknown routes and malformed bodies with machine-readable errors", async () => {
		await withApp(
			(_request, response) => {
				sendJson(response, 200, {});
			},
			async ({ app }) => {
				const unknown = await fetchJson(`${app.url}/nope`);
				assert.equal(unknown.status, 404);
				assert.equal(
					(unknown.body as { error: { type: string } }).error.type,
					"NOT_FOUND",
				);

				const badJson = await fetchJson(`${app.url}/events`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "not json",
				});
				assert.equal(badJson.status, 400);
				assert.equal(
					(badJson.body as { error: { type: string } }).error.type,
					"INVALID_JSON",
				);

				const arrayBody = await postJson(`${app.url}/events`, [1, 2]);
				assert.equal(arrayBody.status, 400);
				assert.equal(
					(arrayBody.body as { error: { type: string } }).error.type,
					"INVALID_BODY",
				);

				const bulkWithoutEvents = await postJson(`${app.url}/events/bulk`, {});
				assert.equal(bulkWithoutEvents.status, 400);
				assert.equal(
					(bulkWithoutEvents.body as { error: { type: string } }).error.type,
					"INVALID_BODY",
				);
			},
		);
	});

	it("startApp closes idempotently", async () => {
		const gateway = await startHttpStub((_request, response) =>
			sendJson(response, 200, healthPayload()),
		);
		const app = await startApp(appOptions(gateway.url));
		try {
			await app.close();
			await app.close();
			await assert.rejects(fetch(`${app.url}/health`));
		} finally {
			await gateway.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Typed error mapping (through the real client)
// ---------------------------------------------------------------------------

describe("typed error mapping", () => {
	async function mapTrigger(
		upstream: (response: ServerResponse) => void,
		overrides: Partial<StartAppOptions> = {},
	) {
		let result: { status: number; body: unknown } | null = null;
		await withApp(
			(request, response) => {
				if (
					request.method === "POST" &&
					pathOf(request) === "/v1/events/trigger"
				) {
					upstream(response);
					return;
				}
				sendJson(response, 404, { error: "unexpected" });
			},
			async ({ app }) => {
				result = await postJson(`${app.url}/events`, TRIGGER);
			},
			overrides,
		);
		return result as unknown as { status: number; body: unknown };
	}

	function errorOf(body: unknown): Record<string, unknown> {
		return (body as { error: Record<string, unknown> }).error;
	}

	it("maps 400 to VALIDATION_ERROR with the gateway message and request id", async () => {
		const result = await mapTrigger((response) =>
			sendJson(
				response,
				400,
				{ error: "BAD_REQUEST", message: "name is required", status_code: 400 },
				{ "x-request-id": "req_123" },
			),
		);
		assert.equal(result.status, 400);
		assert.equal(errorOf(result.body).type, "VALIDATION_ERROR");
		assert.equal(errorOf(result.body).message, "name is required");
		assert.equal(errorOf(result.body).request_id, "req_123");
	});

	it("maps 401 to AUTHENTICATION_ERROR", async () => {
		const result = await mapTrigger((response) =>
			sendJson(response, 401, {
				error: "UNAUTHORIZED",
				message: "Invalid API key provided",
				status_code: 401,
			}),
		);
		assert.equal(result.status, 401);
		assert.equal(errorOf(result.body).type, "AUTHENTICATION_ERROR");
	});

	it("maps 404 to NOT_FOUND", async () => {
		const result = await mapTrigger((response) =>
			sendJson(response, 404, {
				error: "NOT_FOUND",
				message: "Event not found",
				status_code: 404,
			}),
		);
		assert.equal(result.status, 404);
		assert.equal(errorOf(result.body).type, "NOT_FOUND");
	});

	it("maps 409 to IDEMPOTENCY_CONFLICT", async () => {
		const result = await mapTrigger((response) =>
			sendJson(response, 409, {
				error: "IDEMPOTENCY_CONFLICT",
				message: "already processed",
				status_code: 409,
			}),
		);
		assert.equal(result.status, 409);
		assert.equal(errorOf(result.body).type, "IDEMPOTENCY_CONFLICT");
	});

	it("maps 429 to RATE_LIMIT_EXCEEDED with the retry hint", async () => {
		const result = await mapTrigger((response) =>
			sendJson(
				response,
				429,
				{
					error: "RATE_LIMIT_EXCEEDED",
					message: "slow down",
					purpose: "trigger",
					status_code: 429,
				},
				{ "Retry-After": "2" },
			),
		);
		assert.equal(result.status, 429);
		assert.equal(errorOf(result.body).type, "RATE_LIMIT_EXCEEDED");
		assert.equal(errorOf(result.body).retry_after_ms, 2000);
		assert.equal(errorOf(result.body).purpose, "trigger");
	});

	it("maps an upstream 5xx to 502 UPSTREAM_ERROR", async () => {
		const result = await mapTrigger((response) =>
			sendJson(response, 500, {
				error: "INTERNAL",
				message: "gateway broke",
				status_code: 500,
			}),
		);
		assert.equal(result.status, 502);
		assert.equal(errorOf(result.body).type, "UPSTREAM_ERROR");
		assert.equal(errorOf(result.body).message, "gateway broke");
	});

	it("maps a plain-text 422 to VALIDATION_ERROR", async () => {
		const result = await mapTrigger((response) => {
			response.writeHead(422, { "Content-Type": "text/plain" });
			response.end("Failed to deserialize the JSON body");
		});
		assert.equal(result.status, 422);
		assert.equal(errorOf(result.body).type, "VALIDATION_ERROR");
	});

	it("passes a generic gateway error code through", async () => {
		const result = await mapTrigger((response) =>
			sendJson(response, 403, {
				error: "FORBIDDEN",
				message: "no",
				status_code: 403,
			}),
		);
		assert.equal(result.status, 403);
		assert.equal(errorOf(result.body).type, "FORBIDDEN");
	});

	it("retries transient failures up to maxRetries, then succeeds", async () => {
		let attempts = 0;
		let result: { status: number; body: unknown } | null = null;
		await withApp(
			(request, response) => {
				if (pathOf(request) !== "/v1/events/trigger") {
					sendJson(response, 404, { error: "unexpected" });
					return;
				}
				attempts += 1;
				if (attempts < 3) {
					sendJson(response, 503, {
						error: "UNAVAILABLE",
						message: "try later",
						status_code: 503,
					});
					return;
				}
				sendJson(response, 202, {
					eventId: "evt_retry_ok",
					status: "QUEUED",
					priority: "NORMAL",
					channel: "email",
				});
			},
			async ({ app }) => {
				result = await postJson(`${app.url}/events`, TRIGGER);
			},
			{ maxRetries: 2, retryBaseDelayMs: 1 },
		);
		assert.equal(attempts, 3, "two retries after the first failure");
		assert.equal((result as unknown as { status: number }).status, 202);
	});

	it("maps exhausted retries to 503 RETRY_EXHAUSTED with the attempt count", async () => {
		let attempts = 0;
		let result: { status: number; body: unknown } | null = null;
		await withApp(
			(request, response) => {
				if (pathOf(request) !== "/v1/events/trigger") {
					sendJson(response, 404, { error: "unexpected" });
					return;
				}
				attempts += 1;
				sendJson(response, 503, {
					error: "UNAVAILABLE",
					message: "still down",
					status_code: 503,
				});
			},
			async ({ app }) => {
				result = await postJson(`${app.url}/events`, TRIGGER);
			},
			{ maxRetries: 1, retryBaseDelayMs: 1 },
		);
		assert.equal(attempts, 2);
		const mapped = result as unknown as { status: number; body: unknown };
		assert.equal(mapped.status, 503);
		assert.equal(errorOf(mapped.body).type, "RETRY_EXHAUSTED");
		assert.equal(errorOf(mapped.body).attempts, 1);
	});

	it("times out per the configured request timeout", async () => {
		let result: { status: number; body: unknown } | null = null;
		await withApp(
			(_request, response) => {
				setTimeout(() => {
					try {
						if (!response.writableEnded && !response.destroyed) {
							sendJson(response, 202, {
								eventId: "evt_late",
								status: "QUEUED",
								priority: "NORMAL",
								channel: "email",
							});
						}
					} catch {
						// The client already timed out; the late write is moot.
					}
				}, 250);
			},
			async ({ app }) => {
				result = await postJson(`${app.url}/events`, TRIGGER);
			},
			{ timeoutMs: 50, maxRetries: 0 },
		);
		const mapped = result as unknown as { status: number; body: unknown };
		assert.equal(mapped.status, 503);
		assert.equal(errorOf(mapped.body).type, "NETWORK_ERROR");
		assert.match(String(errorOf(mapped.body).message), /timed out/);
	});

	it("maps an unreachable gateway to 503 NETWORK_ERROR", async () => {
		const gateway = await startHttpStub((_request, response) =>
			sendJson(response, 200, {}),
		);
		const url = gateway.url;
		await gateway.close();
		const app = await startApp(appOptions(url));
		try {
			const result = await postJson(`${app.url}/events`, TRIGGER);
			assert.equal(result.status, 503);
			assert.equal(errorOf(result.body).type, "NETWORK_ERROR");
		} finally {
			await app.close();
		}
	});

	it("maps app-level HttpErrors and unexpected failures directly", () => {
		assert.deepEqual(
			mapErrorToHttp(new HttpError(400, "INVALID_QUERY", "bad limit")),
			{
				status: 400,
				body: {
					error: {
						type: "INVALID_QUERY",
						message: "bad limit",
						status: 400,
					},
				},
			},
		);
		const rateLimit = mapErrorToHttp(
			new NervlyRateLimitError("slow down", 1500, "req_1", {
				purpose: "trigger",
			}),
		);
		assert.equal(rateLimit.status, 429);
		assert.deepEqual(rateLimit.body.error, {
			type: "RATE_LIMIT_EXCEEDED",
			message: "slow down",
			status: 429,
			request_id: "req_1",
			retry_after_ms: 1500,
			purpose: "trigger",
		});
		const exhausted = mapErrorToHttp(
			new NervlyRetryExhaustedError(3, new NervlyServerError("boom", 503)),
		);
		assert.equal(exhausted.status, 503);
		assert.equal(exhausted.body.error.type, "RETRY_EXHAUSTED");
		assert.equal(exhausted.body.error.attempts, 3);
		const unexpected = mapErrorToHttp(new Error("kaboom"));
		assert.equal(unexpected.status, 500);
		assert.equal(unexpected.body.error.type, "INTERNAL_ERROR");
		assert.equal(unexpected.body.error.message, "kaboom");
	});
});

// ---------------------------------------------------------------------------
// Standalone server
// ---------------------------------------------------------------------------

describe("server options", () => {
	it("applies the documented standalone defaults", () => {
		const options = loadServerOptions({ NERVLY_API_KEY: TEST_KEY });
		assert.equal(options.baseUrl, "http://localhost:8080");
		assert.equal(options.port, 3000);
		assert.equal(options.host, "127.0.0.1");
		assert.equal(options.timeoutMs, 10_000);
		assert.equal(options.maxRetries, 2);
		assert.equal(options.retryBaseDelayMs, 250);
	});

	it("lets NERVLY_GATEWAY_URL win and honours --port", () => {
		const options = loadServerOptions(
			{
				NERVLY_API_KEY: TEST_KEY,
				NERVLY_API_URL: "http://127.0.0.1:8080",
				NERVLY_GATEWAY_URL: "http://127.0.0.1:9090",
			},
			["--port", "0"],
		);
		assert.equal(options.baseUrl, "http://127.0.0.1:9090");
		assert.equal(options.port, 0);
		assert.equal(options.timeoutMs, 10_000);
		assert.equal(options.maxRetries, 2);
		assert.equal(options.retryBaseDelayMs, 250);
	});

	it("parses --port and rejects unknown arguments", () => {
		assert.equal(parsePort([]), DEFAULT_PORT);
		assert.equal(parsePort(["--port", "4321"]), 4321);
		assert.equal(parsePort(["--port=0"]), 0);
		for (const argv of [
			["--port"],
			["--port", "-1"],
			["--port=abc"],
			["--wat"],
		]) {
			assert.throws(
				() => parsePort(argv),
				(error: unknown) => error instanceof AppConfigError,
				`expected a refusal for ${JSON.stringify(argv)}`,
			);
		}
	});

	it("refuses a missing key, a live key, a non-local URL and a bad port flag", () => {
		assert.throws(
			() => loadServerOptions({}),
			(error: unknown) => error instanceof AppConfigError,
		);
		assert.throws(
			() =>
				loadServerOptions({ NERVLY_API_KEY: syntheticApiKey("live", "no") }),
			(error: unknown) => error instanceof GuardRefusal && error.exitCode === 3,
		);
		assert.throws(
			() =>
				loadServerOptions({
					NERVLY_API_KEY: TEST_KEY,
					NERVLY_API_URL: "https://api.nervly.io",
				}),
			(error: unknown) => error instanceof GuardRefusal && error.exitCode === 3,
		);
		assert.throws(
			() => loadServerOptions({ NERVLY_API_KEY: TEST_KEY }, ["--port", "-1"]),
			(error: unknown) => error instanceof AppConfigError,
		);
	});

	it("exits 2 without NERVLY_API_KEY and 3 with a live key", () => {
		const missing = spawnSync(TSX, [SERVER_ENTRY], {
			cwd: ROOT,
			encoding: "utf8",
			timeout: 15_000,
			env: { ...process.env, NERVLY_API_KEY: "" },
		});
		assert.equal(missing.status, 2, missing.stderr);
		assert.match(missing.stderr, /NERVLY_API_KEY is required/);

		const live = spawnSync(TSX, [SERVER_ENTRY], {
			cwd: ROOT,
			encoding: "utf8",
			timeout: 15_000,
			env: {
				...process.env,
				NERVLY_API_KEY: syntheticApiKey("live", "not", "allowed"),
			},
		});
		assert.equal(live.status, 3, live.stderr);
	});

	it("starts standalone and shuts down cleanly on SIGTERM", async () => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			NERVLY_API_KEY: syntheticApiKey("test", "spawn"),
			NERVLY_API_URL: "http://127.0.0.1:1",
		};
		delete env.NERVLY_GATEWAY_URL;
		// Run the entry with Node and tsx as a loader, not through the `tsx`
		// CLI: the CLI runs the server as a grandchild and relays SIGTERM with
		// a 30 ms acknowledgement budget, SIGKILLing the grandchild and exiting
		// 143 under load even when the server itself shuts down cleanly.
		// Delivering the signal to the server process pins its own handling.
		const child = spawn(
			process.execPath,
			["--import", "tsx", SERVER_ENTRY, "--port", "0"],
			{
				cwd: ROOT,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		let signalled = false;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			// `server.ts` prints this only after `listen()` resolved and the
			// SIGINT/SIGTERM handlers are registered, so it is a definitive
			// readiness signal. Signal exactly once; repeated SIGTERMs would
			// race the shutdown and test something else.
			if (!signalled && stdout.includes("listening on")) {
				signalled = true;
				child.kill("SIGTERM");
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const code = await new Promise<number | null>((resolveExit, reject) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(
					new Error(
						`server did not start or did not exit after SIGTERM; stdout=${stdout} stderr=${stderr}`,
					),
				);
			}, 20_000);
			child.on("exit", (exitCode) => {
				clearTimeout(timer);
				resolveExit(exitCode);
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		assert.equal(code, 0, `stdout=${stdout} stderr=${stderr}`);
		assert.match(stdout, /node-app listening on http:\/\/127\.0\.0\.1:\d+/);
		assert.match(stdout, /timeout=10000ms maxRetries=2 retryBaseDelay=250ms/);
	});
});
