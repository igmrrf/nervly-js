/**
 * Deterministic MCP agent-loop tests.
 *
 * `runChecks` is the only path to exit 0 for the mcp-agent example: these
 * tests pin the exact MCP call sequence (`tools/list` → `tools/call`
 * `gateway_status` → toolkit wiring → `send_notification` preview and
 * `live: true` → `check_delivery_status` until DELIVERED → `messages.list`
 * cross-check → unknown-tool error), the JSON-RPC-vs-HTTP failure taxonomy,
 * and every asserted end state — against a scripted gateway over the real SDK
 * client, so the wire bodies the SDK sends are asserted too.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Nervly, { type NervlyAiToolkit, NervlyHttpClient } from "@nervly/sdk";

import {
	EVENT_NAME,
	isTerminalFailure,
	normalizeEventId,
	REQUIRED_TOOLS,
	runChecks,
} from "../examples/mcp-agent/harness/checks.js";
import {
	AssertionFailure,
	EnvironmentFailure,
} from "../examples/mcp-agent/harness/errors.js";
import { Transcript } from "../examples/mcp-agent/harness/transcript.js";
import {
	type CapturedRequest,
	jsonResponse,
	withFetch,
} from "./helpers/http.js";

const RUN_ID = "20261007T084712Z-cafe";
const SUBSCRIBER = `sub-example-${RUN_ID.toLowerCase()}`;
const EVENT_ID = "evt_0123456789abcdef0123456789abcdef";
const BASE_URL = "http://localhost:8080";

const tempDirs: string[] = [];
function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mcp-checks-"));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function collectingTranscript(): { log: Transcript; lines: string[] } {
	const lines: string[] = [];
	return {
		log: new Transcript({
			artifactsDir: makeTempDir(),
			stdout: (line) => lines.push(line),
		}),
		lines,
	};
}

// ---------------------------------------------------------------------------
// Scripted gateway
// ---------------------------------------------------------------------------

/** The gateway's catalog, as `tools/list` advertises it (required subset). */
const CATALOG = [
	{
		name: "gateway_status",
		description: "Inspect real-time edge gateway status.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "send_notification",
		description: "Trigger a notification; sandboxed unless live:true.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
				to: { type: "object" },
				live: { type: "boolean" },
			},
			required: ["name", "to"],
			additionalProperties: false,
		},
	},
	{
		name: "check_delivery_status",
		description: "Look up one message's delivery state.",
		inputSchema: {
			type: "object",
			properties: { eventId: { type: "string" } },
			required: ["eventId"],
			additionalProperties: false,
		},
	},
];

const STATUS_RESULT = {
	service: "nervly-gateway",
	uptime: 42,
	nats_status: "CONNECTED",
};

const PREVIEW_RESULT = {
	sandbox: true,
	dispatched: false,
	would_dispatch: true,
	would_deliver: true,
	event_name: EVENT_NAME,
	subscriber_id: SUBSCRIBER,
	priority: "NORMAL",
	channel: "email",
	subject: "example.mcp_agent.trigger",
	stream_class: "transactional",
	eligible_channels: ["email"],
	compliance: {},
	reason: null,
};

const LIVE_RESULT = {
	eventId: EVENT_ID,
	status: "QUEUED",
	priority: "NORMAL",
	channel: "email",
	idempotencyKey: `example-mcp-${RUN_ID}`,
	timestamp: "2026-10-07T08:47:12Z",
};

function deliveredResult(overrides: Record<string, unknown> = {}) {
	return {
		event_id: EVENT_ID,
		event_name: EVENT_NAME,
		subscriber_id: SUBSCRIBER,
		channel: "email",
		priority: 3,
		status: "DELIVERED",
		normalized_code: "delivered",
		provider: "mock",
		provider_message_id: "msg-stub",
		attempts: 1,
		cost_micro_usd: 0,
		test_mode: true,
		variables_keys: ["runId"],
		error_code: null,
		error_detail: null,
		created_at: "2026-10-07T08:47:12Z",
		updated_at: "2026-10-07T08:47:13Z",
		events: [],
		...overrides,
	};
}

function messagesPage(overrides: Record<string, unknown> = {}) {
	return {
		messages: [
			{
				event_id: EVENT_ID,
				event_name: EVENT_NAME,
				subscriber_id: SUBSCRIBER,
				priority: 3,
				status: "DELIVERED",
				channel: "email",
				attempts: 1,
				cost_micro_usd: 0,
				test_mode: true,
				variables_keys: ["runId"],
				created_at: "2026-10-07T08:47:12Z",
				updated_at: "2026-10-07T08:47:13Z",
				...overrides,
			},
		],
	};
}

type DeliveryScriptEntry = Record<string, unknown>;

interface ScriptedOptions {
	tools?: unknown[];
	toolsListError?: { code: number; message: string };
	statusResult?: unknown;
	previewResult?: unknown;
	liveResult?: unknown;
	/** One entry per `check_delivery_status` call; the last entry repeats. */
	delivery?: DeliveryScriptEntry[];
	messagesBody?: unknown;
	unknownToolError?: { code: number; message: string };
	/** When set, an unknown tool answers success instead of the error path. */
	unknownToolResult?: unknown;
	/** Every request fails with this HTTP status/body instead. */
	httpFailure?: { status: number; body: unknown };
	/** Every request fails at the transport layer instead. */
	networkError?: Error;
}

interface ScriptedGateway {
	fetchFn: typeof fetch;
	deliveryCalls: () => number;
}

/**
 * A fetch stub for `POST /v1/mcp` and `GET /v1/messages`. Defaults describe the
 * happy path; each option swaps one piece so a test can pin a single failure.
 */
function scriptedGateway(options: ScriptedOptions = {}): ScriptedGateway {
	let deliveryCalls = 0;
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		if (options.networkError) throw options.networkError;
		if (options.httpFailure) {
			return jsonResponse(options.httpFailure.status, options.httpFailure.body);
		}
		const url = new URL(String(input));
		const body =
			init?.body === undefined || init.body === null
				? undefined
				: (JSON.parse(String(init.body)) as {
						method?: string;
						params?: { name?: string; arguments?: Record<string, unknown> };
					});
		if (url.pathname === "/v1/messages") {
			return jsonResponse(200, options.messagesBody ?? messagesPage());
		}
		if (url.pathname !== "/v1/mcp" || body === undefined) {
			return jsonResponse(404, { error: "unexpected", path: url.pathname });
		}
		if (body.method === "tools/list") {
			if (options.toolsListError) {
				return jsonResponse(200, {
					jsonrpc: "2.0",
					id: 1,
					error: options.toolsListError,
				});
			}
			return jsonResponse(200, {
				jsonrpc: "2.0",
				id: 1,
				result: { tools: options.tools ?? CATALOG },
			});
		}
		if (body.method !== "tools/call") {
			return jsonResponse(200, {
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32601, message: "Method not found" },
			});
		}
		const name = body.params?.name ?? "";
		const args = body.params?.arguments ?? {};
		if (name === "gateway_status") {
			return jsonResponse(200, {
				jsonrpc: "2.0",
				id: 1,
				result: options.statusResult ?? STATUS_RESULT,
			});
		}
		if (name === "send_notification") {
			return jsonResponse(200, {
				jsonrpc: "2.0",
				id: 1,
				result:
					args.live === true
						? (options.liveResult ?? LIVE_RESULT)
						: (options.previewResult ?? PREVIEW_RESULT),
			});
		}
		if (name === "check_delivery_status") {
			deliveryCalls += 1;
			const script: DeliveryScriptEntry[] = options.delivery ?? [
				deliveredResult(),
			];
			const entry = script[Math.min(deliveryCalls - 1, script.length - 1)];
			if (typeof entry.error === "object" && entry.error !== null) {
				return jsonResponse(200, { jsonrpc: "2.0", id: 1, error: entry.error });
			}
			return jsonResponse(200, { jsonrpc: "2.0", id: 1, result: entry });
		}
		if (options.unknownToolResult !== undefined) {
			return jsonResponse(200, {
				jsonrpc: "2.0",
				id: 1,
				result: options.unknownToolResult,
			});
		}
		return jsonResponse(200, {
			jsonrpc: "2.0",
			id: 1,
			error: options.unknownToolError ?? {
				code: -32602,
				message: `Unknown tool: ${name}`,
				data: { tool: name },
			},
		});
	}) as typeof fetch;
	return { fetchFn, deliveryCalls: () => deliveryCalls };
}

function sdkConfig() {
	return {
		apiKey: "nervly_sk_test_mcp_agent",
		baseUrl: BASE_URL,
		timeout: 2000,
		maxRetries: 0,
	} as const;
}

async function runAgainst(
	options: ScriptedOptions & {
		timeoutMs?: number;
		toolkitFactory?: (client: NervlyHttpClient) => NervlyAiToolkit;
	},
): Promise<{
	result: Awaited<ReturnType<typeof runChecks>>;
	requests: CapturedRequest[];
	lines: string[];
	deliveryCalls: number;
}> {
	const gateway = scriptedGateway(options);
	const { log, lines } = collectingTranscript();
	const config = sdkConfig();
	let result: Awaited<ReturnType<typeof runChecks>> | undefined;
	const requests = await withFetch(gateway.fetchFn, async () => {
		result = await runChecks({
			client: new Nervly(config),
			httpClient: new NervlyHttpClient(config),
			runId: RUN_ID,
			timeoutMs: options.timeoutMs ?? 500,
			log,
			toolkitFactory: options.toolkitFactory,
		});
	});
	if (result === undefined) throw new Error("runChecks did not run");
	return {
		result,
		requests,
		lines,
		deliveryCalls: gateway.deliveryCalls(),
	};
}

function rpcCalls(requests: CapturedRequest[]): Array<{
	method: string;
	name?: string;
	arguments?: Record<string, unknown>;
	body: Record<string, unknown>;
}> {
	return requests
		.filter((request) => new URL(request.url).pathname === "/v1/mcp")
		.map((request) => {
			const body = JSON.parse(request.body ?? "{}") as {
				method?: string;
				params?: { name?: string; arguments?: Record<string, unknown> };
			};
			return {
				method: body.method ?? "",
				name: body.params?.name,
				arguments: body.params?.arguments,
				body: body as Record<string, unknown>,
			};
		});
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("mcp-agent check helpers", () => {
	it("normalizes evt_-prefixed and bare ids and recognises terminal statuses", () => {
		assert.equal(normalizeEventId(EVENT_ID), EVENT_ID.replace(/^evt_/, ""));
		assert.equal(normalizeEventId("ABCDEF"), "abcdef");
		assert.equal(isTerminalFailure("FAILED"), true);
		assert.equal(isTerminalFailure("Bounced"), true);
		assert.equal(isTerminalFailure("TRIGGERED"), false);
		assert.equal(isTerminalFailure("DELIVERED"), false);
	});

	it("requires the three ticket-mandated tools", () => {
		assert.deepEqual(
			[...REQUIRED_TOOLS],
			["gateway_status", "send_notification", "check_delivery_status"],
		);
	});
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runChecks — deterministic agent loop", () => {
	it("walks tools/list → status → toolkit → preview → live → DELIVERED → messages.list → unknown tool", async () => {
		const { result, requests, lines, deliveryCalls } = await runAgainst({});

		assert.deepEqual(
			result.checks.map((check) => [check.name, check.status]),
			[
				["mcp tools/list", "pass"],
				["mcp gateway_status", "pass"],
				["mcp toolkit wiring", "pass"],
				["mcp send_notification preview", "pass"],
				["mcp send_notification live", "pass"],
				["mcp check_delivery_status", "pass"],
				["mcp messages.list", "pass"],
				["mcp unknown tool error", "pass"],
			],
		);
		const detailOf = (name: string) =>
			result.checks.find((check) => check.name === name)?.detail ?? "";
		assert.match(detailOf("mcp tools/list"), /catalog 3 tools/);
		assert.match(
			detailOf("mcp gateway_status"),
			/uptime=42s nats_status=CONNECTED/,
		);
		assert.match(
			detailOf("mcp send_notification preview"),
			/sandbox=true dispatched=false/,
		);
		assert.match(detailOf("mcp send_notification live"), new RegExp(EVENT_ID));
		assert.match(
			detailOf("mcp check_delivery_status"),
			/DELIVERED \(normalized_code=delivered, test_mode=true/,
		);
		assert.match(detailOf("mcp messages.list"), /test_mode=true/);
		assert.match(detailOf("mcp unknown tool error"), /-32602/);
		assert.equal(result.eventId, EVENT_ID);
		assert.equal(result.subscriberId, SUBSCRIBER);
		assert.equal(deliveryCalls, 1);

		// The transcript names the MCP method/tool per check.
		const transcript = lines.join("\n");
		for (const fragment of [
			"MCP tools/list",
			"MCP tools/call gateway_status",
			"SDK toolkit wiring",
			"send_notification (sandboxed preview)",
			"send_notification (live: true)",
			"check_delivery_status",
			"messages.list",
			"unknown tool",
		]) {
			assert.match(transcript, new RegExp(fragment.replace(/[()]/g, "\\$&")));
		}

		// The wire bodies the SDK actually sent: list, direct gateway_status,
		// the toolkit's gateway_status, preview, live, delivery, unknown tool.
		const calls = rpcCalls(requests);
		assert.deepEqual(
			calls.map((call) => call.method),
			[
				"tools/list",
				"tools/call",
				"tools/call",
				"tools/call",
				"tools/call",
				"tools/call",
				"tools/call",
			],
		);
		assert.deepEqual(calls[0]?.body, { method: "tools/list", params: null });
		assert.equal(calls[1]?.name, "gateway_status");
		assert.deepEqual(calls[1]?.arguments, {});
		assert.equal(calls[2]?.name, "gateway_status");
		assert.equal(calls[3]?.name, "send_notification");
		assert.equal("live" in (calls[3]?.arguments ?? {}), false);
		assert.equal(calls[4]?.name, "send_notification");
		assert.equal(calls[4]?.arguments?.live, true);
		assert.equal(calls[4]?.arguments?.idempotencyKey, `example-mcp-${RUN_ID}`);
		assert.equal(calls[5]?.name, "check_delivery_status");
		assert.deepEqual(calls[5]?.arguments, { eventId: EVENT_ID });
		assert.equal(calls[6]?.name, "definitely_not_a_nervly_tool");
		// The toolkit's execute() is a tools/call too, not a separate surface.
		assert.equal(
			calls.filter((call) => call.name === "gateway_status").length,
			2,
		);

		// Every request carried the minted test key as a bearer token.
		for (const request of requests) {
			assert.equal(
				request.headers.get("authorization"),
				"Bearer nervly_sk_test_mcp_agent",
			);
		}

		// The messages cross-check used the SDK's snake_case query parameter.
		const messagesRequest = requests.find(
			(request) => new URL(request.url).pathname === "/v1/messages",
		);
		assert.ok(messagesRequest);
		assert.match(
			messagesRequest.url,
			/subscriber_id=sub-example-20261007t084712z-cafe/,
		);
		assert.match(messagesRequest.url, /limit=20/);
	});

	it("polls through JSON-RPC -32004 until the message is visible", async () => {
		const { result, deliveryCalls } = await runAgainst({
			delivery: [
				{ error: { code: -32004, message: "Event not found" } },
				deliveredResult(),
			],
		});
		assert.equal(deliveryCalls, 2);
		assert.equal(
			result.checks.find((check) => check.name === "mcp check_delivery_status")
				?.status,
			"pass",
		);
	});
});

// ---------------------------------------------------------------------------
// Failure taxonomy and asserted end states
// ---------------------------------------------------------------------------

describe("runChecks — failures", () => {
	it("fails the tools/list check when a required tool is missing", async () => {
		await assert.rejects(
			() =>
				runAgainst({
					tools: CATALOG.filter((tool) => tool.name !== "send_notification"),
				}),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.exitCode === 1 &&
				error.message.includes("send_notification") &&
				error.check?.name === "mcp tools/list",
		);
	});

	it("fails when send_notification's schema drops the live opt-in", async () => {
		await assert.rejects(
			() =>
				runAgainst({
					tools: [
						CATALOG[0],
						{
							...CATALOG[1],
							inputSchema: {
								type: "object",
								properties: {
									name: { type: "string" },
									to: { type: "object" },
								},
								required: ["name", "to"],
								additionalProperties: false,
							},
						},
						CATALOG[2],
					],
				}),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.message.includes("send_notification input schema"),
		);
	});

	it("fails when the gateway answers tools/list with a JSON-RPC error", async () => {
		await assert.rejects(
			() =>
				runAgainst({
					toolsListError: { code: -32603, message: "catalog unavailable" },
				}),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.exitCode === 1 &&
				error.message.includes("-32603") &&
				error.message.includes("catalog unavailable"),
		);
	});

	it("treats a disconnected NATS as an environment failure, not a green status", async () => {
		await assert.rejects(
			() =>
				runAgainst({
					statusResult: { ...STATUS_RESULT, nats_status: "FALLBACK_BUFFER" },
				}),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("NATS disconnected") &&
				error.check?.name === "mcp gateway_status",
		);
	});

	it("fails the preview check when the sandbox labels are missing", async () => {
		await assert.rejects(
			() =>
				runAgainst({
					previewResult: { ...PREVIEW_RESULT, sandbox: undefined },
				}),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.message.includes("must be a sandbox preview") &&
				error.check?.name === "mcp send_notification preview",
		);
	});

	it("fails the live check when the dispatch returns no eventId", async () => {
		await assert.rejects(
			() => runAgainst({ liveResult: { status: "QUEUED" } }),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.message.includes("no eventId") &&
				error.check?.name === "mcp send_notification live",
		);
	});

	it("fails fast on a terminal status instead of polling again", async () => {
		// The second delivery entry is DELIVERED: if the loop did not fail fast,
		// it would poll again and the run would pass instead of rejecting.
		await assert.rejects(
			() =>
				runAgainst({
					delivery: [
						deliveredResult({ status: "FAILED", normalized_code: "failed" }),
						deliveredResult(),
					],
				}),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.exitCode === 1 &&
				error.message.includes("terminal status FAILED") &&
				error.check?.name === "mcp check_delivery_status",
		);
	});

	it("refuses a message delivered outside test mode", async () => {
		await assert.rejects(
			() => runAgainst({ delivery: [deliveredResult({ test_mode: false })] }),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.message.includes("outside test mode") &&
				error.check?.name === "mcp check_delivery_status",
		);
	});

	it("rejects a delivery read-back for a different event id", async () => {
		await assert.rejects(
			() =>
				runAgainst({
					delivery: [
						deliveredResult({
							event_id: "evt_ffffffffffffffffffffffffffffffff",
						}),
					],
				}),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.message.includes("returned evt_ffffffff") &&
				error.check?.name === "mcp check_delivery_status",
		);
	});

	it("times out bounded when the message never reaches DELIVERED", async () => {
		await assert.rejects(
			() =>
				runAgainst({
					timeoutMs: 25,
					delivery: [{ error: { code: -32004, message: "Event not found" } }],
				}),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.exitCode === 1 &&
				error.message.includes("timed out") &&
				error.message.includes("message not found") &&
				error.check?.name === "mcp check_delivery_status",
		);
	});

	it("fails the messages.list cross-check when the event is absent", async () => {
		await assert.rejects(
			() => runAgainst({ messagesBody: { messages: [] } }),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.message.includes("messages.list did not return") &&
				error.check?.name === "mcp messages.list",
		);
	});

	it("fails the unknown-tool check when the gateway returns success instead", async () => {
		await assert.rejects(
			() =>
				runAgainst({
					unknownToolResult: { service: "nervly-gateway" },
				}),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.message.includes("must surface JSON-RPC -32602") &&
				error.check?.name === "mcp unknown tool error",
		);
	});

	it("maps an HTTP 5xx to an environment failure naming make up", async () => {
		await assert.rejects(
			() =>
				runAgainst({
					httpFailure: {
						status: 503,
						body: { error: "Service Unavailable" },
					},
				}),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("make up"),
		);
	});

	it("maps a transport failure to an environment failure naming make up", async () => {
		await assert.rejects(
			() => runAgainst({ networkError: new Error("socket hang up") }),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("Network request failed") &&
				error.message.includes("make up"),
		);
	});

	it("fails the toolkit check when the toolkit does not expose the tools", async () => {
		await assert.rejects(
			() =>
				runAgainst({
					toolkitFactory: () => ({
						definitions: [],
						execute: async () => {
							throw new Error("unused");
						},
						openai: () => [],
						anthropic: () => [],
						vercel: () => ({}),
					}),
				}),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.message.includes("toolkit is missing gateway_status") &&
				error.check?.name === "mcp toolkit wiring",
		);
	});

	it("fails the toolkit check when execute() throws", async () => {
		const failing: NervlyAiToolkit = {
			definitions: [],
			execute: async () => {
				throw new Error("Nervly MCP tool gateway_status failed");
			},
			openai: () => [
				{
					type: "function",
					function: {
						name: "gateway_status",
						description: "stub",
						parameters: { type: "object", properties: {} },
					},
				},
				{
					type: "function",
					function: {
						name: "send_notification",
						description: "stub",
						parameters: { type: "object", properties: {} },
					},
				},
				{
					type: "function",
					function: {
						name: "check_delivery_status",
						description: "stub",
						parameters: { type: "object", properties: {} },
					},
				},
			],
			anthropic: () => [
				{
					name: "gateway_status",
					description: "stub",
					input_schema: { type: "object", properties: {} },
				},
				{
					name: "send_notification",
					description: "stub",
					input_schema: { type: "object", properties: {} },
				},
				{
					name: "check_delivery_status",
					description: "stub",
					input_schema: { type: "object", properties: {} },
				},
			],
			vercel: () => ({}),
		};
		await assert.rejects(
			() => runAgainst({ toolkitFactory: () => failing }),
			(error: unknown) =>
				error instanceof AssertionFailure &&
				error.message.includes("toolkit.execute(gateway_status)") &&
				error.check?.name === "mcp toolkit wiring",
		);
	});
});
