/**
 * Branch-completion suite for the resource helpers.
 *
 * `tests/http-contract.test.ts` proves the happy path per method; this file
 * drives the conditional branches inside `EmailResource.buildTriggerRequest`
 * and `EventsResource.triggerEmail` — recipient coercion, payload merge order,
 * override merge, and option precedence — which are otherwise only reached by
 * one shape each.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Nervly } from "../src/index.js";
import type { EmailResource } from "../src/resources/email.js";
import { EventsResource } from "../src/resources/events.js";
import { McpResource } from "../src/resources/mcp.js";
import type {
	TriggerEventRequest,
	TriggerEventResponse,
} from "../src/types.js";
import { mockClient, recorder } from "./helpers/mock-client.js";

const RESPONSE: TriggerEventResponse = {
	eventId: "evt_branch_1",
	status: "QUEUED",
	priority: "NORMAL",
	channel: "email",
	timestamp: "2026-09-18T00:00:00Z",
};

function email(): EmailResource {
	return new Nervly({ apiKey: "branch_key" }).email;
}

describe("EmailResource.buildTriggerRequest — branches", () => {
	it("forwards every recipient contact field and merges overrides", () => {
		const built = email().buildTriggerRequest({
			to: {
				subscriberId: "sub_1",
				email: "e@x.test",
				phone: "+234800",
				deviceTokens: ["tok_1"],
			},
			subject: "Subject",
			payload: { orderId: "o1" },
			html: "<p>hi</p>",
			name: "custom-name",
			category: "custom-category",
			from: "from@x.test",
			provider: "resend",
			customHeaders: { "X-Trace": "abc" },
			overrides: {
				email: { from: "original@x.test" },
				extraParams: { tenant: "t1" },
			},
		});

		assert.deepEqual(built.to, {
			subscriberId: "sub_1",
			email: "e@x.test",
			phone: "+234800",
			deviceTokens: ["tok_1"],
		});
		assert.deepEqual(built.payload, {
			subject: "Subject",
			orderId: "o1",
			html: "<p>hi</p>",
		});
		// request-level fields win over the same keys inside `overrides.email`.
		assert.deepEqual(built.overrides?.email, {
			from: "from@x.test",
			provider: "resend",
			customHeaders: { "X-Trace": "abc" },
		});
		assert.deepEqual(built.overrides?.extraParams, { tenant: "t1" });
		assert.equal(built.name, "custom-name");
		assert.equal(built.category, "custom-category");
	});

	it("falls back to the email as subscriberId and prefers text over body", () => {
		const built = email().buildTriggerRequest({
			to: { subscriberId: "", email: "only@x.test" },
			subject: "S",
			text: "plain",
			body: "ignored",
		});

		assert.equal(built.to.subscriberId, "only@x.test");
		assert.equal(built.payload?.text, "plain");
		assert.equal(
			"body" in (built.payload ?? {}),
			false,
			"body is skipped when text is present",
		);
		assert.equal(built.overrides, undefined);
		assert.equal(built.name, "transactional-email");
		assert.equal(built.category, "transactional");
	});

	it("uses `unknown` when the recipient carries no identifier and writes body as a fallback", () => {
		const built = email().buildTriggerRequest({
			to: { subscriberId: "" },
			subject: "S",
			body: "fallback-body",
		});

		assert.equal(built.to.subscriberId, "unknown");
		assert.equal(built.payload?.body, "fallback-body");
		assert.equal("html" in (built.payload ?? {}), false);
	});

	it("keeps html over body and sets both html and text when supplied", () => {
		const withHtml = email().buildTriggerRequest({
			to: { subscriberId: "s" },
			subject: "S",
			html: "<p>h</p>",
			body: "ignored",
		});
		assert.equal(withHtml.payload?.html, "<p>h</p>");
		assert.equal("body" in (withHtml.payload ?? {}), false);

		const withBoth = email().buildTriggerRequest({
			to: { subscriberId: "s" },
			subject: "S",
			html: "<p>h</p>",
			text: "t",
		});
		assert.equal(withBoth.payload?.html, "<p>h</p>");
		assert.equal(withBoth.payload?.text, "t");
	});

	it("builds an override from custom headers alone, with no pre-existing email override", () => {
		const built = email().buildTriggerRequest({
			to: { subscriberId: "s" },
			subject: "S",
			customHeaders: { "Reply-To": "r@x.test" },
		});

		assert.deepEqual(built.overrides, {
			email: { customHeaders: { "Reply-To": "r@x.test" } },
		});
	});

	it("keeps only from when that is the sole email override field", () => {
		const built = email().buildTriggerRequest({
			to: { subscriberId: "s" },
			subject: "S",
			from: "from@x.test",
		});

		assert.deepEqual(built.overrides, { email: { from: "from@x.test" } });
	});
});

describe("EventsResource.triggerEmail — branches", () => {
	it("coerces an object recipient without an id to `unknown` and reaches defaults", async () => {
		const captured = recorder<{
			body: TriggerEventRequest;
			headers: Record<string, string>;
		}>();

		const events = new EventsResource(
			mockClient({
				post: (path, body, headers) => {
					captured.push({
						body: body as TriggerEventRequest,
						headers: headers ?? {},
					});
					return {
						...RESPONSE,
						channel: "email",
					} satisfies TriggerEventResponse;
				},
			}),
		);

		await events.triggerEmail({
			to: { subscriberId: "" },
			subject: "S",
			body: "b",
		});

		assert.equal(captured.last?.body.to.subscriberId, "unknown");
		assert.equal(captured.last?.body.payload?.body, "b");
		assert.equal(captured.last?.body.name, "transactional-email");
		assert.equal(captured.last?.body.category, "transactional");
		assert.match(
			captured.last?.headers["Idempotency-Key"] ?? "",
			/^[0-9a-f-]{36}$/,
			"trigger auto-generates an idempotency key",
		);
		assert.equal(captured.last?.headers["X-Priority-Override"], undefined);
	});

	it("lets option values win over request values for headers", async () => {
		const captured = recorder<Record<string, string>>();

		const events = new EventsResource(
			mockClient({
				post: (_path, _body, headers) => {
					captured.push(headers ?? {});
					return RESPONSE;
				},
			}),
		);

		await events.triggerEmail(
			{
				to: "user@x.test",
				subject: "S",
				idempotencyKey: "request-idem",
				priority: "LOW",
			},
			{ idempotencyKey: "option-idem", priority: "CRITICAL" },
		);

		assert.equal(captured.last?.["Idempotency-Key"], "option-idem");
		assert.equal(captured.last?.["X-Priority-Override"], "CRITICAL");
	});

	it("falls back to the request values when options are omitted", async () => {
		const captured = recorder<Record<string, string>>();

		const events = new EventsResource(
			mockClient({
				post: (_path, _body, headers) => {
					captured.push(headers ?? {});
					return RESPONSE;
				},
			}),
		);

		await events.triggerEmail({
			to: "user@x.test",
			subject: "S",
			idempotencyKey: "request-idem",
			priority: "LOW",
		});

		assert.equal(captured.last?.["Idempotency-Key"], "request-idem");
		assert.equal(captured.last?.["X-Priority-Override"], "LOW");
	});
});

describe("EventsResource.trigger — header branches", () => {
	it("sets only the idempotency header when only that option is given", async () => {
		const captured = recorder<Record<string, string>>();

		const events = new EventsResource(
			mockClient({
				post: (_path, _body, headers) => {
					captured.push(headers ?? {});
					return RESPONSE;
				},
			}),
		);

		await events.trigger(
			{ name: "e", to: { subscriberId: "s" } },
			{ idempotencyKey: "idem" },
		);
		assert.deepEqual(captured.last, { "Idempotency-Key": "idem" });
	});

	it("sets the priority header and auto-generates the idempotency header when only priority is given", async () => {
		const captured = recorder<Record<string, string>>();

		const events = new EventsResource(
			mockClient({
				post: (_path, _body, headers) => {
					captured.push(headers ?? {});
					return RESPONSE;
				},
			}),
		);

		await events.trigger(
			{ name: "e", to: { subscriberId: "s" } },
			{ priority: "LOW" },
		);
		assert.equal(captured.last?.["X-Priority-Override"], "LOW");
		assert.match(captured.last?.["Idempotency-Key"] ?? "", /^[0-9a-f-]{36}$/);
	});
});

describe("McpResource.callTool — params contract", () => {
	it("forwards the caller's tool-call params rather than coercing them to null", async () => {
		const captured = recorder<Record<string, unknown>>();

		const mcp = new McpResource(
			mockClient({
				post: (_path, body) => {
					captured.push(body as Record<string, unknown>);
					return { jsonrpc: "2.0", id: 1, result: {} };
				},
			}),
		);

		await mcp.callTool({ name: "gateway_status", arguments: {} });
		assert.equal(captured.last?.method, "tools/call");
		// A null params is rejected by the gateway's tools/call handler with
		// JSON-RPC -32602, so the SDK must never synthesize one.
		assert.notEqual(captured.last?.params, null);
		assert.deepEqual(captured.last?.params, {
			name: "gateway_status",
			arguments: {},
		});
	});
});
