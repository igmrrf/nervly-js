/**
 * Wire-level contract for the `senders` resource (ticket 23/24).
 *
 * The resource runs on a second, management-plane client. These tests drive
 * the real `NervlyHttpClient` against a scripted `fetch`, so they assert the
 * origin actually used (managementUrl, never baseUrl), the method, path and
 * query encoding, the JSON body, the Authorization header, and the error
 * classes each control-plane status maps onto.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MANAGEMENT_URL } from "../src/client.js";
import {
	NervlyApiError,
	NervlyAuthenticationError,
	NervlyIdempotencyError,
	NervlyNotFoundError,
	NervlyServerError,
	NervlyValidationError,
} from "../src/errors.js";
import { Nervly, SendersResource } from "../src/index.js";
import type {
	CreateBindingInput,
	CreateSenderInput,
	CreateSenderResponse,
	SenderBinding,
	SenderIdentity,
	VerifyBindingResponse,
} from "../src/types.js";
import { jsonResponse, withFetch } from "./helpers/http.js";

const API_KEY = "nervly_sk_live_testkey_secret";
const MANAGEMENT_URL = "https://management.test";
const GATEWAY_URL = "https://gateway.test";

const SENDER: SenderIdentity = {
	identity_id: "b3f00000-0000-4000-8000-000000000001",
	channel: "email",
	sender_value: "hello@acme.com",
	display_name: "Acme",
	created_at: "2026-09-30T12:00:00Z",
	updated_at: "2026-09-30T12:00:00Z",
	bindings: [],
};

const BINDING: SenderBinding = {
	provider: "resend",
	channel: "email",
	identity_unit: "domain",
	unit_value: "acme.com",
	verification_source: "byo",
	verification_state: "self_declared",
	verified_at: null,
	last_checked_at: null,
	failure_reason: null,
};

const CREATE_RESPONSE: CreateSenderResponse = {
	sender: { ...SENDER, bindings: [BINDING] },
	binding: BINDING,
	dns: [{ type: "TXT", name: "_resend.acme.com", value: "re-8f2" }],
};

const VERIFY_RESPONSE: VerifyBindingResponse = {
	binding: { ...BINDING, verification_state: "verified" },
	dns: [],
};

const createInput: CreateSenderInput = {
	provider: "resend",
	value: "hello@acme.com",
	display_name: "Acme",
	identity_unit: "domain",
	channel: "email",
	verify_with: "provider",
};

const bindingInput: CreateBindingInput = {
	provider: "postmark",
	identity_unit: "address",
	verify_with: "provider",
};

function managementNervly(
	config: { managementUrl?: string; maxRetries?: number } = {},
) {
	return new Nervly({
		apiKey: API_KEY,
		baseUrl: GATEWAY_URL,
		managementUrl: config.managementUrl ?? MANAGEMENT_URL,
		maxRetries: config.maxRetries,
	});
}

interface Operation {
	name: string;
	method: string;
	path: string;
	expectedBody?: unknown;
	response: unknown;
	status?: number;
	run: (nervly: Nervly) => Promise<unknown>;
}

const operations: Operation[] = [
	{
		name: "senders.list (no params)",
		method: "GET",
		path: "/v1/senders",
		response: { senders: [SENDER], next_cursor: null },
		run: (nervly) => nervly.senders.list(),
	},
	{
		name: "senders.list (query encoding)",
		method: "GET",
		path: "/v1/senders?limit=5&cursor=cur%2F1&channel=email&provider=resend",
		response: { senders: [SENDER], next_cursor: "cur/2" },
		run: (nervly) =>
			nervly.senders.list({
				limit: 5,
				cursor: "cur/1",
				channel: "email",
				provider: "resend",
			}),
	},
	{
		name: "senders.get (URL-encodes the id)",
		method: "GET",
		path: "/v1/senders/id%2F1%202",
		response: SENDER,
		run: (nervly) => nervly.senders.get("id/1 2"),
	},
	{
		name: "senders.create",
		method: "POST",
		path: "/v1/senders",
		expectedBody: createInput,
		status: 201,
		response: CREATE_RESPONSE,
		run: (nervly) => nervly.senders.create(createInput),
	},
	{
		name: "senders.addBinding (URL-encodes the id)",
		method: "POST",
		path: "/v1/senders/id%2F1/bindings",
		expectedBody: bindingInput,
		status: 201,
		response: CREATE_RESPONSE,
		run: (nervly) => nervly.senders.addBinding("id/1", bindingInput),
	},
	{
		name: "senders.verifyBinding (URL-encodes every segment)",
		method: "POST",
		path: "/v1/senders/id%2F1/bindings/re%2Fsend/domain/verify",
		response: VERIFY_RESPONSE,
		run: (nervly) => nervly.senders.verifyBinding("id/1", "re/send", "domain"),
	},
	{
		name: "senders.removeBinding",
		method: "DELETE",
		path: "/v1/senders/id%2F1/bindings/resend/sender_id",
		response: { status: "deleted" },
		run: (nervly) =>
			nervly.senders.removeBinding("id/1", "resend", "sender_id"),
	},
	{
		name: "senders.remove",
		method: "DELETE",
		path: "/v1/senders/id%2F1",
		response: { status: "deleted" },
		run: (nervly) => nervly.senders.remove("id/1"),
	},
];

describe("SendersResource wire contract", () => {
	for (const operation of operations) {
		it(`${operation.name} sends ${operation.method} ${operation.path}`, async () => {
			const nervly = managementNervly();
			const requests = await withFetch(
				() => jsonResponse(operation.status ?? 200, operation.response),
				async () => {
					await operation.run(nervly);
				},
			);

			assert.equal(requests.length, 1);
			const request = requests[0]!;
			assert.equal(request.url, `${MANAGEMENT_URL}${operation.path}`);
			assert.equal(request.method, operation.method);
			assert.equal(
				request.headers.get("Authorization"),
				`Bearer ${API_KEY}`,
				"the management client must carry the same key",
			);
			assert.equal(request.headers.get("Content-Type"), "application/json");
			assert.match(request.headers.get("User-Agent") ?? "", /^@nervly\/sdk\//);
			if (operation.expectedBody === undefined) {
				assert.equal(request.body, undefined);
			} else {
				assert.deepEqual(
					JSON.parse(request.body ?? "null"),
					operation.expectedBody,
				);
			}
		});
	}

	it("returns the decoded response body", async () => {
		const nervly = managementNervly();
		let received: CreateSenderResponse | undefined;
		await withFetch(
			() => jsonResponse(201, CREATE_RESPONSE),
			async () => {
				received = await nervly.senders.create(createInput);
			},
		);
		assert.deepEqual(received, CREATE_RESPONSE);
	});

	it("exposes the resource on the client under the exported class", () => {
		const nervly = managementNervly();
		assert.ok(nervly.senders instanceof SendersResource);
		assert.equal(typeof nervly.senders.list, "function");
		assert.equal(typeof nervly.senders.get, "function");
		assert.equal(typeof nervly.senders.create, "function");
		assert.equal(typeof nervly.senders.addBinding, "function");
		assert.equal(typeof nervly.senders.verifyBinding, "function");
		assert.equal(typeof nervly.senders.removeBinding, "function");
		assert.equal(typeof nervly.senders.remove, "function");
	});
});

describe("managementUrl routing", () => {
	it("defaults the senders resource to console.nervly.io without moving the gateway", async () => {
		const nervly = new Nervly({ apiKey: API_KEY });
		const requests = await withFetch(
			(url) =>
				jsonResponse(
					200,
					url.includes("/senders") ? { senders: [] } : { status: "OK" },
				),
			async () => {
				await nervly.senders.list();
				await nervly.health.check();
			},
		);

		assert.equal(requests[0]!.url, `${DEFAULT_MANAGEMENT_URL}/v1/senders`);
		assert.equal(
			requests[1]!.url,
			"https://api.nervly.io/v1/health",
			"baseUrl and its default must be untouched",
		);
	});

	it("honours an explicit managementUrl and leaves baseUrl on the gateway", async () => {
		const nervly = managementNervly();
		const requests = await withFetch(
			() => jsonResponse(200, { senders: [] }),
			async () => {
				await nervly.senders.list();
			},
		);
		assert.equal(requests[0]!.url, `${MANAGEMENT_URL}/v1/senders`);
	});

	it("shares the apiKey, timeout and retry configuration with the gateway client", async () => {
		const nervly = new Nervly({
			apiKey: API_KEY,
			baseUrl: GATEWAY_URL,
			managementUrl: MANAGEMENT_URL,
			maxRetries: 0,
		});
		const requests = await withFetch(
			() =>
				jsonResponse(503, { error: "service_unavailable", message: "down" }),
			async () => {
				await assert.rejects(
					() => nervly.senders.list(),
					(error: unknown) => error instanceof NervlyServerError,
				);
			},
		);
		assert.equal(requests.length, 1, "maxRetries: 0 must not retry");
	});
});

describe("SendersResource error mapping", () => {
	const cases: Array<{
		status: number;
		error: string;
		klass: new (...args: never[]) => NervlyApiError;
	}> = [
		{
			status: 400,
			error: "invalid_sender_value",
			klass: NervlyValidationError,
		},
		{ status: 401, error: "unauthorized", klass: NervlyAuthenticationError },
		{ status: 404, error: "not_found", klass: NervlyNotFoundError },
		{
			status: 409,
			error: "verification_source_mismatch",
			klass: NervlyIdempotencyError,
		},
		{ status: 403, error: "forbidden", klass: NervlyApiError },
		{ status: 503, error: "verification_unavailable", klass: NervlyApiError },
	];

	for (const testCase of cases) {
		it(`maps ${testCase.status} to the existing error class`, async () => {
			// No retries: the assertion is the raw status mapping, not the
			// retry-exhaustion wrapper a 503 would otherwise raise.
			const nervly = managementNervly({ maxRetries: 0 });
			await withFetch(
				() =>
					jsonResponse(testCase.status, {
						error: testCase.error,
						message: "control-plane message",
					}),
				async () => {
					const error = await nervly.senders.get("id").then(
						() => null,
						(caught: unknown) => caught,
					);
					assert.ok(
						error instanceof testCase.klass,
						`${testCase.status} must map to ${testCase.klass.name}, got ${String(error)}`,
					);
					assert.ok(error instanceof NervlyApiError);
					assert.equal(error.statusCode, testCase.status);
					assert.equal(error.message, "control-plane message");
				},
			);
		});
	}

	it("surfaces the control-plane machine code for unclassified statuses", async () => {
		const nervly = managementNervly();
		await withFetch(
			() =>
				jsonResponse(403, {
					error: "workspace_suspended",
					message: "workspace is suspended",
				}),
			async () => {
				const error = (await nervly.senders.list().then(
					() => null,
					(caught: unknown) => caught,
				)) as NervlyApiError;
				assert.equal(error.errorType, "workspace_suspended");
			},
		);
	});
});
