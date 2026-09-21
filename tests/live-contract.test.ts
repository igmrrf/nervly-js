/**
 * Live contract suite for `@nervly/sdk` — the SDK's real `fetch` against a
 * running Nervly gateway (checklist.md Tests#05, ticket 27's option 3).
 *
 * This is deliberately NOT a recording-fetch or mocked suite: the SDK's
 * constructed requests (auth header, base-URL handling, payload encoding,
 * status→error mapping) are executed on the wire and asserted on the running
 * gateway's responses. It is falsifiable by construction — each test fails
 * when the gateway rejects what the SDK sends or answers in a shape the SDK
 * cannot honour. The invalid-key leg is the falsification probe on the wire:
 * a gateway that accepts a revoked/garbage key, or a 401 the SDK does not map
 * to `NervlyAuthenticationError`, fails here instead of in production.
 *
 * Configuration (both required; the suite skips loudly without them):
 *   NERVLY_BASE_URL  e.g. http://127.0.0.1:8080
 *   NERVLY_API_KEY   a key issued by `control-plane bootstrap-internal`
 *
 * The root CI's `sdk-live-contract` job boots the full stack (postgres, redis,
 * NATS, control plane, gateway under the mTLS posture) and always provides
 * both. This repo's own CI keeps the stubbed suite; here the legs skip with
 * the reason below rather than fail, and that CI job greps its log for the
 * skip reason so a silently-skipping suite can never read green.
 *
 * Live scope is deliberately narrow — the quickstart journey plus auth:
 *
 *   1. invalid key → the gateway's 401 mapped to `NervlyAuthenticationError`
 *   2. valid trigger → the promised `202 { eventId, status: "QUEUED" }` shape
 *   3. one status poll → `GET /v1/events/{eventId}` (`MessageDto` on the wire)
 *   4. one MCP `tools/list` call → JSON-RPC `2.0` tool catalogue
 *
 * The remaining five operations (`POST /v1/events/bulk`, `GET /v1/messages`,
 * `DELETE /v1/subscribers/{subscriberId}`, `PUT /v1/users/{subscriberId}/preferences`,
 * `POST /v1/webhooks/{provider}`) stay spec-level, covered by
 * `tests/spec-conformance.test.ts`, `tests/types/conformance.types.ts` and
 * `check:codegen`; the inbound `POST /v1/webhooks/{provider}` is a provider
 * calling us, and `webhooks.verifyAndParse` is covered against real HMAC
 * material by `tests/webhooks.test.ts`. `GET /v1/health` is exercised live
 * only as part of the CI job's boot assertions, not in this suite.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Nervly, NervlyAuthenticationError } from "../src/index.js";

const BASE_URL = process.env.NERVLY_BASE_URL;
const API_KEY = process.env.NERVLY_API_KEY;
const LIVE = Boolean(BASE_URL && API_KEY);

export const SKIP_REASON =
	"live contract suite skipped: NERVLY_BASE_URL and NERVLY_API_KEY are not set — " +
	"the wire legs proved nothing (root CI's sdk-live-contract job always provides them)";

describe("SDK live contract — real fetch against a running gateway", {
	skip: LIVE ? false : SKIP_REASON,
}, () => {
	// `maxRetries: 0` keeps a wrong-wire failure immediate: retries are the
	// stubbed suite's territory (tests/backoff.test.ts), not the live probe's.
	const nervly = new Nervly({
		apiKey: API_KEY as string,
		baseUrl: BASE_URL as string,
		timeout: 10_000,
		maxRetries: 0,
	});

	// The trigger leg hands its `eventId` to the poll leg; one accepted event
	// per run keeps the workspace's per-second quota out of the assertions.
	let eventId: string | undefined;

	it("maps the gateway's 401 for an invalid API key to NervlyAuthenticationError", async () => {
		const impostor = new Nervly({
			apiKey: "nv_live_not_a_real_key_live_contract_probe",
			baseUrl: BASE_URL as string,
			timeout: 10_000,
			maxRetries: 0,
		});

		let caught: unknown;
		try {
			await impostor.events.trigger({
				name: "live-contract-invalid-key",
				to: { subscriberId: "sub_live_contract_probe" },
			});
			assert.fail(
				"the gateway accepted an invalid API key — the auth contract is broken on the wire",
			);
		} catch (error) {
			caught = error;
		}

		assert.ok(
			caught instanceof NervlyAuthenticationError,
			`expected NervlyAuthenticationError, got ${String(caught)}`,
		);
		const authError = caught as NervlyAuthenticationError;
		assert.equal(
			authError.statusCode,
			401,
			"the mapped error must carry the gateway's 401",
		);
	});

	it("triggers an event and receives the promised 202 { eventId, status: QUEUED } shape", async () => {
		const accepted = await nervly.events.trigger({
			name: "live-contract-quickstart",
			to: {
				subscriberId: "sub_live_contract_probe",
				email: "live-contract@example.com",
			},
			payload: { source: "@nervly/sdk live contract suite" },
		});

		assert.equal(
			typeof accepted.eventId,
			"string",
			"TriggerResponse.eventId must be a string on the wire",
		);
		assert.match(
			accepted.eventId,
			/^evt_/,
			`expected an evt_ event id, got ${JSON.stringify(accepted.eventId)}`,
		);
		assert.equal(
			accepted.status,
			"QUEUED",
			`expected the promised QUEUED acknowledgement, got ${JSON.stringify(accepted.status)}`,
		);
		eventId = accepted.eventId;
	});

	it("polls GET /v1/events/{eventId} and reads the MessageDto the SDK returns", async () => {
		assert.ok(
			eventId,
			"the trigger leg did not produce an eventId; the poll leg cannot run",
		);

		const receipt = await nervly.events.get(eventId as string);

		assert.equal(
			receipt.event_id,
			eventId,
			"the polled receipt must echo the triggered event id (snake_case on the wire)",
		);
		assert.equal(
			typeof receipt.status,
			"string",
			"MessageDto.status must be a string on the wire",
		);
		assert.equal(
			typeof receipt.attempts,
			"number",
			"MessageDto.attempts must be a number on the wire",
		);
		assert.equal(
			typeof receipt.created_at,
			"string",
			"MessageDto.created_at must be a timestamp string on the wire",
		);
	});

	it("lists the gateway's MCP tool catalogue over POST /v1/mcp", async () => {
		const response = await nervly.mcp.listTools();

		assert.equal(
			response.jsonrpc,
			"2.0",
			"MCP must answer as JSON-RPC 2.0 on the wire",
		);
		assert.ok(
			response.error == null,
			`tools/list must not fail: ${JSON.stringify(response.error)}`,
		);
		const result = response.result as
			| { tools?: Array<{ name?: unknown; inputSchema?: unknown }> }
			| undefined;
		assert.ok(
			result && Array.isArray(result.tools) && result.tools.length > 0,
			`tools/list must return a non-empty tool catalogue, got ${JSON.stringify(response.result)}`,
		);
		for (const tool of result.tools as Array<Record<string, unknown>>) {
			assert.equal(
				typeof tool.name,
				"string",
				`every advertised tool must carry a string name, got ${JSON.stringify(tool)}`,
			);
			assert.ok(
				tool.inputSchema && typeof tool.inputSchema === "object",
				`tool ${String(tool.name)} must declare an input schema`,
			);
		}
	});
});
