import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HealthResource } from "../src/resources/health.js";
import { McpResource } from "../src/resources/mcp.js";
import { MessagesResource } from "../src/resources/messages.js";
import { SubscribersResource } from "../src/resources/subscribers.js";
import { UsersResource } from "../src/resources/users.js";
import type {
	ListMessagesResponse,
	SubscriberErasureResponse,
	UserPreferencesRequest,
	UserPreferencesResponse,
} from "../src/types.js";
import { mockClient, recorder } from "./helpers/mock-client.js";

describe("MessagesResource", () => {
	it("should call list without a query string when no params are given", async () => {
		const captured = recorder<string>();

		const response: ListMessagesResponse = { messages: [], next_cursor: null };

		const messages = new MessagesResource(
			mockClient({
				get: (path) => {
					captured.push(path);
					return response;
				},
			}),
		);

		const result = await messages.list();

		assert.equal(captured.last, "/v1/messages");
		assert.deepEqual(result.messages, []);
	});

	it("should serialize query parameters correctly in list", async () => {
		const captured = recorder<string>();

		const response: ListMessagesResponse = {
			messages: [
				{
					event_id: "evt_1",
					event_name: "test",
					subscriber_id: "sub_42",
					status: "SENT",
					priority: 1,
					attempts: 1,
					cost_micro_usd: 0,
					test_mode: false,
					variables_keys: [],
					created_at: "2026-09-11T00:00:00Z",
					updated_at: "2026-09-11T00:00:01Z",
				},
			],
			next_cursor: "cur_next_123",
		};

		const messages = new MessagesResource(
			mockClient({
				get: (path) => {
					captured.push(path);
					return response;
				},
			}),
		);

		const result = await messages.list({
			status: "SENT",
			channel: "sms",
			subscriberId: "sub_42",
			limit: 25,
		});

		// The spec's query parameter is snake_case (`subscriber_id`), and the
		// request must use exactly that spelling.
		assert.equal(
			captured.last,
			"/v1/messages?status=SENT&channel=sms&subscriber_id=sub_42&limit=25",
		);
		assert.equal(result.messages.length, 1);
		assert.equal(result.next_cursor, "cur_next_123");
	});
});

describe("SubscribersResource", () => {
	it("should call delete on /v1/subscribers/:subscriberId", async () => {
		const captured = recorder<string>();

		const response: SubscriberErasureResponse = {
			status: "accepted",
			subscriberId: "sub_999",
			message: "Subscriber erasure initiated and completed",
		};

		const subscribers = new SubscribersResource(
			mockClient({
				delete: (path) => {
					captured.push(path);
					return response;
				},
			}),
		);

		const result = await subscribers.delete("sub_999");

		assert.equal(captured.last, "/v1/subscribers/sub_999");
		assert.equal(result.status, "accepted");
		assert.equal(result.subscriberId, "sub_999");
	});

	it("should encode a subscriber id that contains reserved characters", async () => {
		const captured = recorder<string>();

		const subscribers = new SubscribersResource(
			mockClient({
				delete: (path) => {
					captured.push(path);
					return {
						status: "accepted",
						subscriberId: "a/b c",
						message: "erased",
					} satisfies SubscriberErasureResponse;
				},
			}),
		);

		await subscribers.delete("a/b c");

		assert.equal(captured.last, "/v1/subscribers/a%2Fb%20c");
	});

	it("should call updatePreferences on /v1/users/:subscriberId/preferences", async () => {
		const captured = recorder<{ path: string; body: UserPreferencesRequest }>();

		const response: UserPreferencesResponse = {
			status: "UPDATED",
			subscriberId: "sub_777",
			updated_at: "2026-09-11T00:00:00Z",
		};

		const subscribers = new SubscribersResource(
			mockClient({
				put: (path, body) => {
					captured.push({ path, body: body as UserPreferencesRequest });
					return response;
				},
			}),
		);

		const result = await subscribers.updatePreferences("sub_777", {
			channels: { email: false, sms: true },
		});

		assert.equal(captured.last?.path, "/v1/users/sub_777/preferences");
		assert.deepEqual(captured.last?.body.channels, { email: false, sms: true });
		assert.equal(result.status, "UPDATED");
		// The wire field is snake_case; `updatedAt` is not a field the gateway sends.
		assert.equal(result.updated_at, "2026-09-11T00:00:00Z");
	});
});

describe("UsersResource", () => {
	it("should call updatePreferences on /v1/users/:subscriberId/preferences", async () => {
		const captured = recorder<{ path: string; body: UserPreferencesRequest }>();

		const users = new UsersResource(
			mockClient({
				put: (path, body) => {
					captured.push({ path, body: body as UserPreferencesRequest });
					return {
						status: "UPDATED",
						subscriberId: "sub_1",
						updated_at: "2026-09-11T00:00:00Z",
					} satisfies UserPreferencesResponse;
				},
			}),
		);

		const result = await users.updatePreferences("sub_1", {
			categories: { marketing: { email: false } },
		});

		assert.equal(captured.last?.path, "/v1/users/sub_1/preferences");
		assert.deepEqual(captured.last?.body.categories, {
			marketing: { email: false },
		});
		assert.equal(result.subscriberId, "sub_1");
	});
});

describe("HealthResource", () => {
	it("should send an unauthenticated GET /v1/health", async () => {
		const captured = recorder<{
			method: string;
			path: string;
			skipAuth?: boolean;
		}>();

		const health = new HealthResource(
			mockClient({
				request: (options) => {
					captured.push(options);
					return {
						status: "OK",
						service: "nervly-gateway",
						version: "0.1.0",
						environment: "ci",
						uptime_seconds: 12,
						nats_connected: true,
					};
				},
			}),
		);

		const result = await health.check();

		assert.equal(captured.last?.method, "GET");
		assert.equal(captured.last?.path, "/v1/health");
		assert.equal(captured.last?.skipAuth, true);
		assert.equal(result.nats_connected, true);
	});
});

describe("McpResource", () => {
	it("should POST /v1/mcp with the documented method names", async () => {
		const captured = recorder<{
			path: string;
			body: Record<string, unknown>;
		}>();

		const mcp = new McpResource(
			mockClient({
				post: (path, body) => {
					captured.push({ path, body: body as Record<string, unknown> });
					return { jsonrpc: "2.0", id: 1, result: {} };
				},
			}),
		);

		await mcp.listTools();
		assert.equal(captured.last?.path, "/v1/mcp");
		assert.equal(captured.last?.body.method, "tools/list");

		await mcp.callTool({ name: "gateway_status" });
		assert.equal(captured.last?.body.method, "tools/call");
		assert.deepEqual(captured.last?.body.params, { name: "gateway_status" });
	});
});
