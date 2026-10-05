import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Nervly } from "../src/index.js";
import { EventsResource } from "../src/resources/events.js";
import type {
	BulkTriggerRequest,
	BulkTriggerResponse,
	MessageDto,
	TriggerEventRequest,
	TriggerEventResponse,
} from "../src/types.js";
import { jsonResponse, withFetch } from "./helpers/http.js";
import { mockClient, recorder } from "./helpers/mock-client.js";

describe("EventsResource", () => {
	it("should expose the methods the gateway spec documents", () => {
		const events = new EventsResource(mockClient());
		assert.equal(typeof events.trigger, "function");
		assert.equal(typeof events.triggerEmail, "function");
		assert.equal(typeof events.bulkTrigger, "function");
		assert.equal(typeof events.get, "function");
	});

	it("should POST /v1/events/trigger with the idempotency and priority headers", async () => {
		const captured = recorder<{
			path: string;
			body: TriggerEventRequest;
			headers: Record<string, string>;
		}>();

		const response: TriggerEventResponse = {
			eventId: "evt_abc123",
			status: "QUEUED",
			idempotencyKey: "idem-key-1",
			priority: "CRITICAL",
			channel: "email",
			timestamp: "2026-08-03T00:00:00Z",
		};

		const events = new EventsResource(
			mockClient({
				post: (path, body, headers) => {
					captured.push({
						path,
						body: body as TriggerEventRequest,
						headers: headers ?? {},
					});
					return response;
				},
			}),
		);

		const result = await events.trigger(
			{
				name: "test_event",
				to: { subscriberId: "usr_001", email: "test@test.com" },
				payload: { key: "value" },
			},
			{
				idempotencyKey: "idem-key-1",
				priority: "CRITICAL",
			},
		);

		assert.equal(captured.last?.path, "/v1/events/trigger");
		assert.equal(captured.last?.body.name, "test_event");
		assert.equal(captured.last?.headers["Idempotency-Key"], "idem-key-1");
		assert.equal(captured.last?.headers["X-Priority-Override"], "CRITICAL");
		assert.deepEqual(result, response);
	});

	it("should auto-generate an Idempotency-Key and omit priority when no options are given", async () => {
		const captured = recorder<Record<string, string>>();

		const events = new EventsResource(
			mockClient({
				post: (_path, _body, headers) => {
					captured.push(headers ?? {});
					return {
						eventId: "evt_1",
						status: "QUEUED",
						priority: "NORMAL",
						channel: "sms",
						timestamp: "2026-08-03T00:00:00Z",
					} satisfies TriggerEventResponse;
				},
			}),
		);

		await events.trigger({
			name: "test_event",
			to: { subscriberId: "usr_001" },
		});

		assert.match(
			captured.last?.["Idempotency-Key"] ?? "",
			/^[0-9a-f-]{36}$/,
			"a UUID key is generated for the caller",
		);
		assert.equal(captured.last?.["X-Priority-Override"], undefined);
	});

	it("should treat an empty explicit Idempotency-Key as absent and let a non-empty one win", async () => {
		const captured = recorder<Record<string, string>>();

		const events = new EventsResource(
			mockClient({
				post: (_path, _body, headers) => {
					captured.push(headers ?? {});
					return {
						eventId: "evt_1",
						status: "QUEUED",
						priority: "NORMAL",
						channel: "sms",
						timestamp: "2026-08-03T00:00:00Z",
					} satisfies TriggerEventResponse;
				},
			}),
		);

		await events.trigger(
			{ name: "empty_key", to: { subscriberId: "usr_001" } },
			{ idempotencyKey: "" },
		);
		await events.trigger(
			{ name: "explicit_key", to: { subscriberId: "usr_001" } },
			{ idempotencyKey: "caller-key-verbatim" },
		);

		assert.match(
			captured.calls[0]?.["Idempotency-Key"] ?? "",
			/^[0-9a-f-]{36}$/,
			"an empty key is treated as absent and replaced by a generated UUID",
		);
		assert.equal(
			captured.calls[1]?.["Idempotency-Key"],
			"caller-key-verbatim",
			"a non-empty explicit key is sent verbatim",
		);
	});

	it("should generate a distinct key per logical call", async () => {
		const captured = recorder<Record<string, string>>();

		const events = new EventsResource(
			mockClient({
				post: (_path, _body, headers) => {
					captured.push(headers ?? {});
					return {
						eventId: "evt_1",
						status: "QUEUED",
						priority: "NORMAL",
						channel: "sms",
						timestamp: "2026-08-03T00:00:00Z",
					} satisfies TriggerEventResponse;
				},
			}),
		);

		await events.trigger({ name: "a", to: { subscriberId: "usr_001" } });
		await events.trigger({ name: "b", to: { subscriberId: "usr_001" } });

		assert.notEqual(
			captured.calls[0]?.["Idempotency-Key"],
			captured.calls[1]?.["Idempotency-Key"],
		);
	});

	it("should reuse one generated Idempotency-Key across internal retries", async () => {
		const keys: Array<string | null> = [];
		const response: TriggerEventResponse = {
			eventId: "evt_retried",
			status: "QUEUED",
			priority: "NORMAL",
			channel: "sms",
			timestamp: "2026-08-03T00:00:00Z",
		};

		await withFetch(
			(_url, init) => {
				keys.push(new Headers(init?.headers).get("Idempotency-Key"));
				return keys.length === 1
					? jsonResponse(503, {
							error: "UNAVAILABLE",
							message: "try later",
							status_code: 503,
						})
					: jsonResponse(200, response);
			},
			async () => {
				const nervly = new Nervly({
					apiKey: "k",
					baseUrl: "https://test.example",
					maxRetries: 1,
					retryBaseDelay: 1,
				});
				const result = await nervly.events.trigger({
					name: "retried",
					to: { subscriberId: "usr_001" },
				});
				assert.deepEqual(result, response);
			},
		);

		assert.equal(keys.length, 2, "the 503 was retried once");
		assert.match(keys[0] ?? "", /^[0-9a-f-]{36}$/);
		assert.equal(keys[1], keys[0], "the same key rides both attempts");
	});

	it("should call bulkTrigger with events array", async () => {
		const captured = recorder<{ path: string; body: BulkTriggerRequest }>();

		const response: BulkTriggerResponse = {
			jobId: "job_batch_test",
			status: "QUEUED",
			count: 2,
			failedCount: 0,
			events: [
				{ index: 0, status: "QUEUED", eventId: "evt_1", channel: "sms" },
				{ index: 1, status: "QUEUED", eventId: "evt_2", channel: "email" },
			],
		};

		const events = new EventsResource(
			mockClient({
				post: (path, body) => {
					captured.push({ path, body: body as BulkTriggerRequest });
					return response;
				},
			}),
		);

		const result = await events.bulkTrigger({
			events: [
				{ name: "evt1", to: { subscriberId: "usr_1" } },
				{ name: "evt2", to: { subscriberId: "usr_2" } },
			],
		});

		assert.equal(captured.last?.path, "/v1/events/bulk");
		assert.equal(captured.last?.body.events.length, 2);
		assert.equal(result.count, 2);
		assert.equal(result.jobId, "job_batch_test");
	});

	it("should call get with eventId", async () => {
		const captured = recorder<string>();

		const response: MessageDto = {
			event_id: "evt_12345",
			event_name: "test.event",
			subscriber_id: "sub_1",
			status: "DELIVERED",
			priority: 2,
			attempts: 1,
			cost_micro_usd: 5000,
			test_mode: false,
			variables_keys: ["orderId"],
			created_at: "2026-08-03T00:00:00Z",
			updated_at: "2026-08-03T00:00:01Z",
		};

		const events = new EventsResource(
			mockClient({
				get: (path) => {
					captured.push(path);
					return response;
				},
			}),
		);

		const result = await events.get("evt_12345");

		assert.equal(captured.last, "/v1/events/evt_12345");
		assert.equal(result.event_id, "evt_12345");
		assert.equal(result.status, "DELIVERED");
	});
});
