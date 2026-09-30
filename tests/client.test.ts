import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NervlyHttpClient } from "../src/client.js";
import {
	NervlyApiError,
	NervlyAuthenticationError,
	NervlyError,
	NervlyNotFoundError,
	NervlyRateLimitError,
	type NervlyRetryExhaustedError,
	NervlyServerError,
	NervlyValidationError,
} from "../src/errors.js";
import { Nervly } from "../src/index.js";
import type { HealthStatus } from "../src/types.js";

/** Replaces `globalThis.fetch` for the duration of `run`, then restores it. */
async function withFetch(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
	run: () => Promise<void>,
): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
		Promise.resolve(handler(String(url), init))) as typeof globalThis.fetch;
	try {
		await run();
	} finally {
		globalThis.fetch = original;
	}
}

function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

describe("Nervly Client", () => {
	it("should throw if no API key is provided", () => {
		assert.throws(() => new Nervly({ apiKey: "" }), /API key/);
	});

	it("should create client with valid config and default to https://api.nervly.io", () => {
		const nervly = new Nervly({ apiKey: "test_key_123" });
		assert.ok(nervly);
		assert.ok(nervly.events);
		assert.ok(nervly.email);
		assert.ok(nervly.messages);
		assert.ok(nervly.subscribers);
		assert.ok(nervly.users);
		assert.ok(nervly.health);
		assert.ok(nervly.mcp);
		assert.ok(nervly.webhooks);
	});

	it("should expose all resource properties", () => {
		const nervly = new Nervly({ apiKey: "test_key" });
		assert.equal(typeof nervly.events.trigger, "function");
		assert.equal(typeof nervly.events.triggerEmail, "function");
		assert.equal(typeof nervly.email.send, "function");
		assert.equal(typeof nervly.events.bulkTrigger, "function");
		assert.equal(typeof nervly.events.get, "function");
		assert.equal(typeof nervly.messages.list, "function");
		assert.equal(typeof nervly.subscribers.delete, "function");
		assert.equal(typeof nervly.subscribers.updatePreferences, "function");
		assert.equal(typeof nervly.users.updatePreferences, "function");
		assert.equal(typeof nervly.health.check, "function");
		assert.equal(typeof nervly.mcp.listTools, "function");
		assert.equal(typeof nervly.mcp.callTool, "function");
		assert.equal(typeof nervly.webhooks.verifySignature, "function");
		assert.equal(typeof nervly.webhooks.parse, "function");
	});
});

describe("NervlyHttpClient — request shape", () => {
	it("should default to https://api.nervly.io and strip a trailing slash from baseUrl", async () => {
		let capturedUrl = "";

		await withFetch(
			(url) => {
				capturedUrl = url;
				return jsonResponse(200, {
					status: "OK",
					service: "nervly-gateway",
					version: "0.1.0",
					deployment: "sandbox",
					environment: "ci",
					key_mode: "test",
					uptime_seconds: 1,
					nats_connected: true,
				} satisfies HealthStatus);
			},
			async () => {
				const slashed = new Nervly({
					apiKey: "k",
					baseUrl: "https://example.test/",
				});
				await slashed.health.check();
				assert.equal(capturedUrl, "https://example.test/v1/health");

				const defaulted = new Nervly({ apiKey: "k" });
				await defaulted.health.check();
				assert.equal(capturedUrl, "https://api.nervly.io/v1/health");
			},
		);
	});

	it("should identify the SDK version in the User-Agent", async () => {
		let capturedUserAgent = "";

		await withFetch(
			(_url, init) => {
				capturedUserAgent = new Headers(init?.headers).get("user-agent") ?? "";
				return jsonResponse(200, {});
			},
			async () => {
				const client = new NervlyHttpClient({
					apiKey: "k",
					baseUrl: "https://example.test",
				});
				await client.get("/v1/health");
			},
		);

		assert.match(capturedUserAgent, /^@nervly\/sdk\/\d+\.\d+\.\d+/);
	});

	it("should omit the body on GET and DELETE", async () => {
		const bodies: Array<string | undefined> = [];

		await withFetch(
			(_url, init) => {
				bodies.push(init?.body === undefined ? undefined : String(init.body));
				return jsonResponse(200, {});
			},
			async () => {
				const client = new NervlyHttpClient({
					apiKey: "k",
					baseUrl: "https://example.test",
				});
				await client.get("/v1/messages");
				await client.delete("/v1/subscribers/sub_1");
			},
		);

		assert.deepEqual(bodies, [undefined, undefined]);
	});
});

describe("NervlyHttpClient — error classification", () => {
	const cases: Array<{
		status: number;
		body: Record<string, unknown>;
		expected: new (...args: never[]) => NervlyApiError;
		headers?: Record<string, string>;
	}> = [
		{
			status: 400,
			body: {
				error: "BAD_REQUEST",
				message: "recipient has no contact details",
				status_code: 400,
			},
			expected: NervlyValidationError,
		},
		{
			status: 401,
			body: {
				error: "UNAUTHORIZED",
				message: "invalid api key",
				status_code: 401,
			},
			expected: NervlyAuthenticationError,
		},
		{
			status: 404,
			body: {
				error: "NOT_FOUND",
				message: "event not found",
				status_code: 404,
			},
			expected: NervlyNotFoundError,
		},
		{
			status: 429,
			body: {
				error: "RATE_LIMIT_EXCEEDED",
				message: "slow down",
				status_code: 429,
			},
			expected: NervlyRateLimitError,
		},
		{
			status: 503,
			body: {
				error: "DATABASE_UNAVAILABLE",
				message: "db down",
				status_code: 503,
			},
			expected: NervlyServerError,
		},
	];

	for (const { status, body, expected, headers } of cases) {
		it(`should map ${status} to ${expected.name}`, async () => {
			await withFetch(
				() => jsonResponse(status, body, headers ?? {}),
				async () => {
					const client = new NervlyHttpClient({
						apiKey: "k",
						baseUrl: "https://example.test",
						maxRetries: 0,
					});

					const error = await client.get("/v1/events/evt_1").then(
						() => null,
						(e: unknown) => e as Error,
					);

					assert.ok(
						error instanceof expected,
						`expected ${expected.name}, got ${error?.name}`,
					);
					assert.ok(error instanceof NervlyApiError);
					assert.ok(error instanceof NervlyError);
					assert.equal(error.statusCode, status);
					assert.equal(error.message, body.message);
				},
			);
		});
	}

	it("should preserve the provider Retry-After on a 429", async () => {
		await withFetch(
			() =>
				jsonResponse(
					429,
					{
						error: "RATE_LIMIT_EXCEEDED",
						message: "slow down",
						status_code: 429,
					},
					{
						"Retry-After": "7",
					},
				),
			async () => {
				const client = new NervlyHttpClient({
					apiKey: "k",
					baseUrl: "https://example.test",
					maxRetries: 0,
				});

				const error = (await client.get("/v1/messages").then(
					() => null,
					(e: unknown) => e,
				)) as NervlyRateLimitError;

				assert.equal(error.retryAfterMs, 7000);
			},
		);
	});

	describe("rate-limit response contract", () => {
		/** Drives a real 429 through `handleErrorResponse` and returns the error. */
		async function rateLimitError(
			body: Record<string, unknown>,
			headers: Record<string, string> = {},
		): Promise<NervlyRateLimitError> {
			let captured: NervlyRateLimitError | undefined;

			await withFetch(
				() => jsonResponse(429, body, headers),
				async () => {
					const client = new NervlyHttpClient({
						apiKey: "k",
						baseUrl: "https://example.test",
						maxRetries: 0,
					});

					const error = await client.get("/v1/messages").then(
						() => null,
						(e: unknown) => e as Error,
					);

					assert.ok(error instanceof NervlyRateLimitError);
					captured = error;
				},
			);

			return captured as NervlyRateLimitError;
		}

		it("carries the body's purpose on a 429", async () => {
			const error = await rateLimitError({
				error: "RATE_LIMIT_EXCEEDED",
				message: "subscriber abuse cap exceeded",
				status_code: 429,
				purpose: "subscriber",
			});

			assert.equal(error.purpose, "subscriber");
		});

		it("honours a body retry_after_seconds when Retry-After is absent", async () => {
			const error = await rateLimitError({
				error: "RATE_LIMIT_EXCEEDED",
				message: "slow down",
				status_code: 429,
				purpose: "workspace",
				retry_after_seconds: 3,
			});

			assert.equal(error.retryAfterMs, 3000);
		});

		it("prefers the Retry-After header over the body's retry_after_seconds", async () => {
			const error = await rateLimitError(
				{
					error: "RATE_LIMIT_EXCEEDED",
					message: "slow down",
					status_code: 429,
					retry_after_seconds: 9,
				},
				{ "Retry-After": "5" },
			);

			assert.equal(error.retryAfterMs, 5000);
		});

		it("falls back to the 1000ms default when neither retry hint is present", async () => {
			const error = await rateLimitError({
				error: "RATE_LIMIT_EXCEEDED",
				message: "slow down",
				status_code: 429,
			});

			assert.equal(error.retryAfterMs, 1000);
		});

		it("parses the draft-11 RateLimit and RateLimit-Policy headers", async () => {
			const error = await rateLimitError(
				{
					error: "RATE_LIMIT_EXCEEDED",
					message: "slow down",
					status_code: 429,
					purpose: "workspace",
				},
				{
					RateLimit: '"workspace";r=42;t=1, "subscriber";r=3;t=1',
					"RateLimit-Policy": '"workspace";q=100;w=1, "subscriber";q=10;w=1',
				},
			);

			assert.equal(error.remaining, 42);
			assert.equal(error.limit, 100);
		});

		it("leaves remaining/limit undefined when the draft-11 headers are absent", async () => {
			const error = await rateLimitError({
				error: "RATE_LIMIT_EXCEEDED",
				message: "slow down",
				status_code: 429,
			});

			assert.equal(error.remaining, undefined);
			assert.equal(error.limit, undefined);
		});

		it("ignores malformed draft-11 header values", async () => {
			const error = await rateLimitError(
				{
					error: "RATE_LIMIT_EXCEEDED",
					message: "slow down",
					status_code: 429,
				},
				{
					RateLimit: '"workspace";r;t=1',
					"RateLimit-Policy": '"workspace";q=not-a-number',
				},
			);

			assert.equal(error.remaining, undefined);
			assert.equal(error.limit, undefined);
		});

		it("keeps a 503 RATE_LIMIT_STORE_UNAVAILABLE on the retryable-5xx branch", async () => {
			let attempts = 0;

			await withFetch(
				() => {
					attempts += 1;
					return jsonResponse(503, {
						error: "RATE_LIMIT_STORE_UNAVAILABLE",
						message: "rate limit service unavailable",
						status_code: 503,
					});
				},
				async () => {
					const client = new NervlyHttpClient({
						apiKey: "k",
						baseUrl: "https://example.test",
						maxRetries: 1,
						retryBaseDelay: 1,
					});

					const error = (await client.get("/v1/events").then(
						() => null,
						(e: unknown) => e,
					)) as NervlyRetryExhaustedError;

					assert.equal(error.name, "NervlyRetryExhaustedError");
					assert.equal(error.attempts, 1);
					assert.ok(error.lastError instanceof NervlyServerError);
					assert.equal(error.lastError.statusCode, 503);
				},
			);

			assert.equal(attempts, 2);
		});
	});

	it("should carry the request id when the gateway sends one", async () => {
		await withFetch(
			() =>
				jsonResponse(
					500,
					{ error: "INTERNAL", message: "boom", status_code: 500 },
					{
						"x-request-id": "req_abc123",
					},
				),
			async () => {
				const client = new NervlyHttpClient({
					apiKey: "k",
					baseUrl: "https://example.test",
					maxRetries: 0,
				});

				const error = (await client.get("/v1/messages").then(
					() => null,
					(e: unknown) => e,
				)) as NervlyServerError;

				assert.equal(error.requestId, "req_abc123");
			},
		);
	});

	it("should classify a timeout as a network error, not an API error", async () => {
		await withFetch(
			() => {
				const abort = new Error("aborted");
				abort.name = "AbortError";
				throw abort;
			},
			async () => {
				const client = new NervlyHttpClient({
					apiKey: "k",
					baseUrl: "https://example.test",
					timeout: 5,
					maxRetries: 0,
				});

				const error = (await client.get("/v1/messages").then(
					() => null,
					(e: unknown) => e,
				)) as Error;

				assert.equal(error.name, "NervlyNetworkError");
				assert.match(error.message, /timed out after 5ms/);
				assert.ok(!(error instanceof NervlyApiError));
			},
		);
	});

	it("should retry 503 and then succeed", async () => {
		let attempts = 0;

		await withFetch(
			() => {
				attempts += 1;
				return attempts === 1
					? jsonResponse(503, {
							error: "DB_UNAVAILABLE",
							message: "try later",
							status_code: 503,
						})
					: jsonResponse(200, { status: "OK" });
			},
			async () => {
				const client = new NervlyHttpClient({
					apiKey: "k",
					baseUrl: "https://example.test",
					maxRetries: 2,
					// Keep the test fast: the backoff floor is the only thing waited on.
					retryBaseDelay: 1,
				});

				const result = await client.get<{ status: string }>("/v1/health");
				assert.equal(result.status, "OK");
			},
		);

		assert.equal(attempts, 2);
	});

	it("should raise RetryExhaustedError when every attempt fails", async () => {
		let attempts = 0;

		await withFetch(
			() => {
				attempts += 1;
				return jsonResponse(503, {
					error: "DB_UNAVAILABLE",
					message: "try later",
					status_code: 503,
				});
			},
			async () => {
				const client = new NervlyHttpClient({
					apiKey: "k",
					baseUrl: "https://example.test",
					maxRetries: 1,
					retryBaseDelay: 1,
				});

				const error = (await client.get("/v1/health").then(
					() => null,
					(e: unknown) => e,
				)) as NervlyRetryExhaustedError;

				assert.equal(error.name, "NervlyRetryExhaustedError");
				assert.equal(error.attempts, 1);
				// The wrapper keeps the error that exhausted the budget, which is where
				// the status code lives.
				assert.ok(error.lastError instanceof NervlyServerError);
				assert.equal(error.lastError.statusCode, 503);
			},
		);

		assert.equal(attempts, 2);
	});

	it("should not retry a 400", async () => {
		let attempts = 0;

		await withFetch(
			() => {
				attempts += 1;
				return jsonResponse(400, {
					error: "BAD_REQUEST",
					message: "nope",
					status_code: 400,
				});
			},
			async () => {
				const client = new NervlyHttpClient({
					apiKey: "k",
					baseUrl: "https://example.test",
					maxRetries: 3,
					retryBaseDelay: 1,
				});

				await assert.rejects(client.get("/v1/messages"), /nope/);
			},
		);

		assert.equal(attempts, 1);
	});

	it("should require an API key at the transport layer too", () => {
		assert.throws(
			() => new NervlyHttpClient({ apiKey: "" }),
			/API key is required/,
		);
	});
});
