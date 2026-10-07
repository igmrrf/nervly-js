/**
 * Harness-contract tests for the mcp-agent example.
 *
 * These pin the invariants the contract promises — guard refusals and their
 * exit codes, redaction, the summary schema, seed bootstrap/teardown, the
 * optional LLM variant's key-optional gate, and the end-to-end `runExample`
 * flow (asserted test-mode DELIVERED) — against a scripted control plane and
 * MCP gateway. The live leg is the documented `npm run example -- mcp-agent`
 * run against the local stack; this suite is deterministic and never skips.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	type BootstrapResult,
	bootstrapFromEnv,
	bootstrapSeed,
	teardownBootstrap,
} from "../examples/mcp-agent/harness/bootstrap.js";
import {
	DEFAULTS,
	type ExampleConfig,
	loadConfig,
} from "../examples/mcp-agent/harness/config.js";
import { ConsoleClient } from "../examples/mcp-agent/harness/console.js";
import {
	EnvironmentFailure,
	GuardRefusal,
} from "../examples/mcp-agent/harness/errors.js";
import {
	assertSupportedBootstrapMode,
	guardConfig,
	isLocalHost,
} from "../examples/mcp-agent/harness/guards.js";
import { redact, redactValue } from "../examples/mcp-agent/harness/redact.js";
import {
	isValidRunId,
	newRunId,
} from "../examples/mcp-agent/harness/run-id.js";
import {
	buildSummary,
	type RunSummary,
	writeSummary,
} from "../examples/mcp-agent/harness/summary.js";
import { Transcript } from "../examples/mcp-agent/harness/transcript.js";
import {
	EXAMPLE_NAME,
	parseArgs,
	runExample,
} from "../examples/mcp-agent/main.js";
import {
	type CapturedRequest,
	jsonResponse,
	withFetch,
} from "./helpers/http.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ID = "20261007T084712Z-cafe";
const EVENT_ID = "evt_0123456789abcdef0123456789abcdef";
const SUBSCRIBER = `sub-example-${RUN_ID.toLowerCase()}`;

/**
 * Synthetic API keys assembled at runtime from fragments so secret scanners
 * (gitleaks) never see a key-shaped literal in this file.
 */
function syntheticApiKey(mode: "test" | "live", ...segments: string[]): string {
	return ["nervly", "sk", mode, ...segments].join("_");
}

const TEST_KEY = syntheticApiKey("test", "mcp", "harness", "secret");

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function collectingTranscript(dir: string): {
	log: Transcript;
	lines: string[];
} {
	const lines: string[] = [];
	const log = new Transcript({
		artifactsDir: dir,
		stdout: (line) => lines.push(line),
	});
	return { log, lines };
}

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		NERVLY_TARGET: "local",
		NERVLY_API_URL: "http://localhost:8080",
		NERVLY_CONTROL_URL: "http://localhost:8081",
		NERVLY_NATS_URL: "nats://localhost:4222",
		...overrides,
	};
}

function stubConfig(overrides: Partial<ExampleConfig> = {}): ExampleConfig {
	return {
		...loadConfig(baseEnv(), {
			now: new Date("2026-10-07T00:00:00Z"),
			random: () => 0.5,
		}),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Scripted control plane + MCP gateway
// ---------------------------------------------------------------------------

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

function deliveredResult(overrides: Record<string, unknown> = {}) {
	return {
		event_id: EVENT_ID,
		event_name: "example.mcp_agent.trigger",
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

interface StackOptions {
	/** One entry per check_delivery_status call; the last repeats. */
	delivery?: Array<Record<string, unknown>>;
	tools?: unknown[];
	loginStatus?: number;
	networkError?: Error;
}

interface ScriptedStack {
	fetchFn: typeof fetch;
	requests: CapturedRequest[];
}

/** A scripted control plane and gateway, routed by URL path. */
function scriptedStack(options: StackOptions = {}): ScriptedStack {
	const requests: CapturedRequest[] = [];
	let deliveryCalls = 0;
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		if (options.networkError) throw options.networkError;
		const url = new URL(String(input));
		requests.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: init?.body === undefined ? undefined : String(init.body),
			signal: init?.signal,
		});
		const body =
			init?.body === undefined || init.body === null
				? undefined
				: (JSON.parse(String(init.body)) as Record<string, unknown>);

		if (url.pathname === "/auth/login") {
			if (options.loginStatus !== undefined && options.loginStatus !== 200) {
				return jsonResponse(options.loginStatus, { error: "login failed" });
			}
			return new Response(
				JSON.stringify({
					status: "ok",
					workspace: { id: "ws-seed", slug: "dev-local" },
					csrf_token: "csrf-seed",
				}),
				{
					status: 200,
					headers: [
						["content-type", "application/json"],
						["set-cookie", "nervly_session=sess-seed; Path=/; HttpOnly"],
						["set-cookie", "nervly_csrf=csrf-seed; Path=/"],
					],
				},
			);
		}
		if (url.pathname === "/console/api-keys" && init?.method === "POST") {
			if (requests.at(-1)?.headers.get("x-csrf-token") !== "csrf-seed") {
				return jsonResponse(403, { error: "forbidden" });
			}
			return jsonResponse(201, {
				id: "key-seed",
				name: (body as { name?: string })?.name,
				mode: "test",
				scopes: ["read", "write"],
				token: TEST_KEY,
			});
		}
		if (
			url.pathname === "/console/api-keys/key-seed" &&
			init?.method === "DELETE"
		) {
			return jsonResponse(200, { status: "revoked" });
		}
		if (url.pathname === "/v1/messages") {
			return jsonResponse(200, {
				messages: [
					{
						event_id: EVENT_ID,
						event_name: "example.mcp_agent.trigger",
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
					},
				],
			});
		}
		if (url.pathname !== "/v1/mcp" || body === undefined) {
			return jsonResponse(404, { error: "unexpected", path: url.pathname });
		}
		const method = body.method;
		const params = body.params as
			| { name?: string; arguments?: Record<string, unknown> }
			| undefined;
		if (method === "tools/list") {
			return jsonResponse(200, {
				jsonrpc: "2.0",
				id: 1,
				result: { tools: options.tools ?? CATALOG },
			});
		}
		if (method === "tools/call" && params?.name === "gateway_status") {
			return jsonResponse(200, {
				jsonrpc: "2.0",
				id: 1,
				result: {
					service: "nervly-gateway",
					uptime: 42,
					nats_status: "CONNECTED",
				},
			});
		}
		if (method === "tools/call" && params?.name === "send_notification") {
			if (params.arguments?.live === true) {
				return jsonResponse(200, {
					jsonrpc: "2.0",
					id: 1,
					result: {
						eventId: EVENT_ID,
						status: "QUEUED",
						priority: "NORMAL",
						channel: "email",
						idempotencyKey: params.arguments.idempotencyKey,
						timestamp: "2026-10-07T08:47:12Z",
					},
				});
			}
			return jsonResponse(200, {
				jsonrpc: "2.0",
				id: 1,
				result: {
					sandbox: true,
					dispatched: false,
					would_dispatch: true,
					would_deliver: true,
					event_name: params.arguments?.name,
					subscriber_id: SUBSCRIBER,
					priority: "NORMAL",
					channel: "email",
					subject: "example.mcp_agent.trigger",
					stream_class: "transactional",
					eligible_channels: ["email"],
					compliance: {},
					reason: null,
				},
			});
		}
		if (method === "tools/call" && params?.name === "check_delivery_status") {
			deliveryCalls += 1;
			const script = options.delivery ?? [deliveredResult()];
			const entry = script[Math.min(deliveryCalls - 1, script.length - 1)];
			return jsonResponse(200, { jsonrpc: "2.0", id: 1, result: entry });
		}
		return jsonResponse(200, {
			jsonrpc: "2.0",
			id: 1,
			error: {
				code: -32602,
				message: `Unknown tool: ${params?.name}`,
				data: { tool: params?.name },
			},
		});
	}) as typeof fetch;
	return { fetchFn, requests };
}

function providerStub(): { fetchFn: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const fetchFn = (async (input: string | URL | Request) => {
		calls.push(String(input));
		if (calls.length === 1) {
			return jsonResponse(200, {
				choices: [
					{
						message: {
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: { name: "gateway_status", arguments: "{}" },
								},
							],
						},
					},
				],
			});
		}
		return jsonResponse(200, {
			choices: [{ message: { content: "The gateway is live." } }],
		});
	}) as typeof fetch;
	return { fetchFn, calls };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("redact", () => {
	it("scrubs test and live API keys entirely, prefix included", () => {
		const output = redact(
			`key=${syntheticApiKey("test", "abc", "def")} live=${syntheticApiKey("live", "fff")}`,
		);
		assert.equal(output.includes("nervly_sk_test_"), false);
		assert.equal(output.includes("nervly_sk_live_"), false);
		assert.match(output, /\[REDACTED_API_KEY\]/);
	});

	it("scrubs session, CSRF, verification-token and JSON secret shapes", () => {
		const output = redact(
			[
				"Cookie: nervly_session=sess_secret; nervly_csrf=csrf_secret",
				`http://localhost:3000/verify-email?token=${"a".repeat(64)}`,
				'{"password":"hunter2","csrf_token":"csrf-json","api_key":"kv"}',
			].join("\n"),
		);
		assert.equal(output.includes("sess_secret"), false);
		assert.equal(output.includes("csrf_secret"), false);
		assert.equal(output.includes("a".repeat(64)), false);
		assert.equal(output.includes("hunter2"), false);
		assert.equal(output.includes("csrf-json"), false);
	});

	it("leaves ordinary transcript text untouched", () => {
		const text = "mcp-agent finished: PASS (run 20261007T084712Z-cafe)";
		assert.equal(redact(text), text);
	});

	it("redactValue scrubs a bootstrap-shaped payload without changing keys", () => {
		const scrubbed = redactValue({
			runId: RUN_ID,
			apiKey: TEST_KEY,
			nested: { token: "shown-nowhere", password: "p" },
		});
		assert.equal(scrubbed.runId, RUN_ID);
		assert.equal(scrubbed.apiKey.includes("nervly_sk_test_"), false);
		assert.match(scrubbed.apiKey, /REDACTED/);
		assert.deepEqual(Object.keys(scrubbed.nested), ["token", "password"]);
		assert.equal(scrubbed.nested.token, "[REDACTED]");
	});
});

// ---------------------------------------------------------------------------
// Run ids
// ---------------------------------------------------------------------------

describe("run ids", () => {
	it("generates the documented YYYYMMDDTHHMMSSZ-xxxx format", () => {
		const runId = newRunId(new Date("2026-10-07T08:47:12.345Z"), () => 0.25);
		assert.equal(runId, "20261007T084712Z-4000");
		assert.equal(isValidRunId(runId), true);
	});

	it("rejects ids that are unsafe inside slugs and key names", () => {
		for (const bad of ["", "has space", "slash/yes", "x".repeat(65)]) {
			assert.equal(isValidRunId(bad), false, `${bad} must be rejected`);
		}
	});
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("config", () => {
	it("applies every documented default, including the seed default", () => {
		const config = loadConfig({}, { now: new Date("2026-10-07T08:47:12Z") });
		assert.equal(config.target, "local");
		assert.equal(config.apiUrl, DEFAULTS.apiUrl);
		assert.equal(config.gatewayUrl, DEFAULTS.apiUrl);
		assert.equal(config.controlUrl, DEFAULTS.controlUrl);
		assert.equal(config.natsUrl, DEFAULTS.natsUrl);
		assert.equal(config.bootstrapMode, "seed");
		assert.equal(config.apiKey, null);
		assert.equal(config.keep, false);
		assert.equal(config.bootstrapTimeoutMs, 60_000);
		assert.equal(config.checkTimeoutMs, 30_000);
	});

	it("reads overrides and lets NERVLY_GATEWAY_URL win over NERVLY_API_URL", () => {
		const config = loadConfig(
			baseEnv({
				NERVLY_GATEWAY_URL: "http://127.0.0.1:9090",
				NERVLY_RUN_ID: RUN_ID,
				NERVLY_API_KEY: "nervly_sk_test_x",
				NERVLY_WORKSPACE_SLUG: "ex-mcp",
				EXAMPLES_BOOTSTRAP: "fresh",
				EXAMPLES_KEEP: "1",
				EXAMPLES_BOOTSTRAP_TIMEOUT_MS: "1000",
				EXAMPLES_CHECK_TIMEOUT_MS: "2000",
			}),
		);
		assert.equal(config.gatewayUrl, "http://127.0.0.1:9090");
		assert.equal(config.apiUrl, "http://localhost:8080");
		assert.equal(config.runId, RUN_ID);
		assert.equal(config.workspaceSlug, "ex-mcp");
		assert.equal(config.bootstrapMode, "fresh");
		assert.equal(config.keep, true);
		assert.equal(config.bootstrapTimeoutMs, 1000);
		assert.equal(config.checkTimeoutMs, 2000);
	});

	it("refuses a malformed run id, unknown bootstrap mode and bad timeouts", () => {
		for (const env of [
			baseEnv({ NERVLY_RUN_ID: "bad run id" }),
			baseEnv({ EXAMPLES_BOOTSTRAP: "yolo" }),
			baseEnv({ EXAMPLES_BOOTSTRAP_TIMEOUT_MS: "-5" }),
			baseEnv({ EXAMPLES_CHECK_TIMEOUT_MS: "soon" }),
		]) {
			assert.throws(
				() => loadConfig(env),
				(error: unknown) =>
					error instanceof GuardRefusal && error.exitCode === 3,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe("guards", () => {
	it("refuses non-local API, gateway, control and NATS hosts with exit 3", () => {
		const cases: Array<Partial<ExampleConfig>> = [
			{ apiUrl: "https://api.nervly.io", gatewayUrl: "https://api.nervly.io" },
			{ gatewayUrl: "http://10.0.0.5:8080" },
			{ controlUrl: "https://console.nervly.io" },
			{ natsUrl: "nats://nats.prod.example:4222" },
		];
		for (const overrides of cases) {
			assert.throws(
				() => guardConfig(stubConfig(overrides)),
				(error: unknown) =>
					error instanceof GuardRefusal && error.exitCode === 3,
				`expected refusal for ${JSON.stringify(overrides)}`,
			);
		}
	});

	it("accepts localhost, 127.0.0.1 and ::1", () => {
		assert.equal(isLocalHost("localhost"), true);
		assert.equal(isLocalHost("127.0.0.1"), true);
		assert.equal(isLocalHost("[::1]"), true);
		assert.equal(isLocalHost("nervly.io"), false);
		assert.doesNotThrow(() => guardConfig(stubConfig()));
	});

	it("refuses live or malformed keys and unsupported targets", () => {
		for (const apiKey of [
			syntheticApiKey("live", "abc", "def"),
			"not-a-key",
			"nv_test_1",
		]) {
			assert.throws(
				() => guardConfig(stubConfig({ apiKey })),
				(error: unknown) =>
					error instanceof GuardRefusal &&
					error.exitCode === 3 &&
					error.message.includes("test key"),
			);
		}
		assert.doesNotThrow(() =>
			guardConfig(stubConfig({ apiKey: "nervly_sk_test_ok" })),
		);
		assert.throws(
			() => guardConfig(stubConfig({ target: "sandbox" })),
			(error: unknown) => error instanceof GuardRefusal && error.exitCode === 3,
		);
	});

	it("refuses EXAMPLES_BOOTSTRAP=fresh before any work", () => {
		assert.doesNotThrow(() =>
			assertSupportedBootstrapMode(
				stubConfig({ bootstrapMode: "fresh", apiKey: "nervly_sk_test_ok" }),
			),
		);
		assert.throws(
			() =>
				assertSupportedBootstrapMode(stubConfig({ bootstrapMode: "fresh" })),
			(error: unknown) =>
				error instanceof GuardRefusal &&
				error.exitCode === 3 &&
				error.message.includes("fresh"),
		);
	});
});

// ---------------------------------------------------------------------------
// Summary + transcript
// ---------------------------------------------------------------------------

describe("summary", () => {
	it("builds exactly the contract fields, redacting check details", () => {
		const summary = buildSummary({
			example: EXAMPLE_NAME,
			target: "local",
			runId: RUN_ID,
			startedAt: new Date("2026-10-07T08:47:12.000Z"),
			durationMs: 41230.7,
			status: "pass",
			workspace: { slug: "dev-local", id: "ws-seed" },
			checks: [
				{
					name: "mcp check_delivery_status",
					status: "pass",
					detail: `event ${EVENT_ID} DELIVERED with ${TEST_KEY}`,
				},
			],
			artifacts: ["transcript.log", "bootstrap.json"],
		});
		assert.deepEqual(Object.keys(summary).sort(), [
			"artifacts",
			"checks",
			"durationMs",
			"example",
			"harnessVersion",
			"runId",
			"startedAt",
			"status",
			"target",
			"workspace",
		]);
		assert.equal(summary.example, "mcp-agent");
		assert.equal(summary.harnessVersion, "1");
		assert.equal(summary.durationMs, 41231);
		assert.equal(summary.checks[0]?.detail.includes("nervly_sk_test_"), false);
	});

	it("clamps a negative duration and keeps null workspace fields", () => {
		const summary = buildSummary({
			example: EXAMPLE_NAME,
			target: "local",
			runId: "r",
			startedAt: new Date("2026-10-07T08:47:12.000Z"),
			durationMs: -5,
			status: "refused",
			workspace: { slug: null, id: null },
			checks: [],
			artifacts: [],
		});
		assert.equal(summary.durationMs, 0);
		assert.deepEqual(summary.workspace, { slug: null, id: null });
	});

	it("writes summary.json and round-trips it", () => {
		const dir = makeTempDir("mcp-summary-");
		const summary = buildSummary({
			example: EXAMPLE_NAME,
			target: "local",
			runId: RUN_ID,
			startedAt: new Date("2026-10-07T08:47:12.000Z"),
			durationMs: 10,
			status: "pass",
			workspace: { slug: "s", id: "i" },
			checks: [],
			artifacts: ["transcript.log"],
		});
		const path = writeSummary(join(dir, "artifacts"), summary);
		assert.deepEqual(
			JSON.parse(readFileSync(path, "utf8")) as RunSummary,
			summary,
		);
	});
});

describe("transcript", () => {
	it("writes redacted lines to stdout and transcript.log", () => {
		const dir = makeTempDir("mcp-transcript-");
		const { log, lines } = collectingTranscript(dir);
		log.line(`key ${TEST_KEY}`);
		log.line("plain line");
		const file = readFileSync(log.transcriptPath, "utf8");
		assert.equal(file.includes("nervly_sk_test_"), false);
		assert.match(file, /\[REDACTED_API_KEY\]/);
		assert.match(file, /plain line/);
		assert.equal(lines.length, 2);
	});

	it("keeps stdout silent in --json mode but still logs to file", () => {
		const dir = makeTempDir("mcp-transcript-json-");
		const lines: string[] = [];
		const log = new Transcript({
			artifactsDir: dir,
			jsonMode: true,
			stdout: (line) => lines.push(line),
		});
		log.line("human-only line");
		assert.deepEqual(lines, []);
		assert.match(readFileSync(log.transcriptPath, "utf8"), /human-only line/);
	});

	it("starts each run's transcript fresh", () => {
		const dir = makeTempDir("mcp-transcript-fresh-");
		new Transcript({ artifactsDir: dir, stdout: () => {} }).line("previous");
		const second = new Transcript({ artifactsDir: dir, stdout: () => {} });
		second.line("current");
		const text = readFileSync(second.transcriptPath, "utf8");
		assert.equal(text.includes("previous"), false);
		assert.match(text, /current/);
	});
});

// ---------------------------------------------------------------------------
// Control-plane client
// ---------------------------------------------------------------------------

describe("ConsoleClient", () => {
	it("absorbs cookies, applies the CSRF header, and parses JSON", async () => {
		const stack = scriptedStack();
		await withFetch(stack.fetchFn, async () => {
			const client = new ConsoleClient("http://localhost:8081");
			await client.request("POST", "/auth/login", { body: { email: "x" } });
			const second = await client.request("POST", "/console/api-keys", {
				csrf: "csrf-seed",
				body: { name: "n" },
			});
			assert.equal(second.status, 201);
			assert.equal(client.getCookie("nervly_session"), "sess-seed");
			assert.equal(
				client.cookieHeader(),
				"nervly_session=sess-seed; nervly_csrf=csrf-seed",
			);
		});
	});

	it("maps connection failures to an environment failure naming make up", async () => {
		await assert.rejects(
			() =>
				withFetch(
					() => {
						throw new Error("connection refused");
					},
					async () => {
						await new ConsoleClient("http://localhost:8081").request(
							"GET",
							"/x",
						);
					},
				),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("make up"),
		);
	});
});

// ---------------------------------------------------------------------------
// Bootstrap and teardown
// ---------------------------------------------------------------------------

describe("bootstrap", () => {
	it("seed mode logs in, mints a test key, and revokes it on teardown", async () => {
		const stack = scriptedStack();
		const dir = makeTempDir("mcp-seed-");
		const { log } = collectingTranscript(dir);
		await withFetch(stack.fetchFn, async () => {
			const config = stubConfig({ runId: RUN_ID });
			const bootstrap = await bootstrapSeed(config, log);
			assert.equal(bootstrap.source, "seed");
			assert.equal(bootstrap.apiKey, TEST_KEY);
			assert.equal(bootstrap.keyId, "key-seed");
			assert.deepEqual(bootstrap.workspace, {
				slug: "dev-local",
				id: "ws-seed",
			});

			const keyRequest = stack.requests.find(
				(request) => new URL(request.url).pathname === "/console/api-keys",
			);
			assert.ok(keyRequest);
			assert.deepEqual(JSON.parse(keyRequest.body ?? "{}"), {
				name: `examples-${RUN_ID}`,
				mode: "test",
				scopes: ["read", "write"],
			});

			assert.equal(await teardownBootstrap(bootstrap, log), true);
		});
		const deleteRequest = stack.requests.find(
			(request) => request.method === "DELETE",
		);
		assert.ok(deleteRequest);
		assert.match(deleteRequest.url, /\/console\/api-keys\/key-seed$/);
		assert.equal(deleteRequest.headers.get("x-csrf-token"), "csrf-seed");
		assert.match(
			String(deleteRequest.headers.get("cookie") ?? ""),
			/nervly_session=sess-seed/,
		);
	});

	it("surfaces a failed seed login as an environment failure", async () => {
		const stack = scriptedStack({ loginStatus: 500 });
		const dir = makeTempDir("mcp-seed-fail-");
		const { log } = collectingTranscript(dir);
		await withFetch(stack.fetchFn, async () => {
			await assert.rejects(
				() => bootstrapSeed(stubConfig(), log),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.exitCode === 2 &&
					error.message.includes("seed login failed with HTTP 500"),
			);
		});
	});

	it("refuses a non-test token from the control plane", async () => {
		const liveStack = scriptedStack();
		const dir = makeTempDir("mcp-seed-live-");
		const { log } = collectingTranscript(dir);
		await withFetch(
			async (url, init) => {
				if (new URL(String(url)).pathname === "/console/api-keys") {
					return jsonResponse(201, {
						id: "key-live",
						token: syntheticApiKey("live", "should", "refuse"),
					});
				}
				return liveStack.fetchFn(url, init);
			},
			async () => {
				await assert.rejects(
					() => bootstrapSeed(stubConfig(), log),
					(error: unknown) =>
						error instanceof EnvironmentFailure &&
						error.message.includes("no test-mode token"),
				);
			},
		);
	});

	it("env-first uses the supplied key and tears down nothing", async () => {
		const dir = makeTempDir("mcp-env-");
		const { log } = collectingTranscript(dir);
		const bootstrap = bootstrapFromEnv(
			stubConfig({ apiKey: "nervly_sk_test_env", workspaceSlug: "env-ws" }),
		);
		assert.equal(bootstrap.source, "env");
		assert.equal(bootstrap.workspace.slug, "env-ws");
		assert.equal(await teardownBootstrap(bootstrap, log), true);
	});

	it("teardown reports false when the control plane refuses", async () => {
		const dir = makeTempDir("mcp-teardown-fail-");
		const { log } = collectingTranscript(dir);
		await withFetch(
			() => jsonResponse(500, { error: "boom" }),
			async () => {
				const result: BootstrapResult = {
					source: "seed",
					apiKey: "nervly_sk_test_x",
					keyId: "key-seed",
					keyName: "examples-x",
					workspace: { slug: "dev-local", id: "ws-seed" },
					console: new ConsoleClient("http://localhost:8081"),
					csrfToken: "c",
				};
				assert.equal(await teardownBootstrap(result, log), false);
			},
		);
	});
});

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
	it("parses --json, --llm and --help and refuses unknown flags", () => {
		assert.deepEqual(parseArgs([]), { json: false, help: false, llm: false });
		assert.deepEqual(parseArgs(["--json", "--llm"]), {
			json: true,
			help: false,
			llm: true,
		});
		assert.deepEqual(parseArgs(["--help"]), {
			json: false,
			help: true,
			llm: false,
		});
		assert.throws(
			() => parseArgs(["--bogus"]),
			(error: unknown) => error instanceof EnvironmentFailure,
		);
	});
});

// ---------------------------------------------------------------------------
// main: guard refusals, the LLM gate, and a stubbed end-to-end run
// ---------------------------------------------------------------------------

describe("main runExample", () => {
	it("refuses a non-local API URL with exit 3 before any request", async () => {
		const dir = makeTempDir("mcp-refuse-");
		const stdout: string[] = [];
		const stack = scriptedStack();
		const requests = await withFetch(stack.fetchFn, async () => {
			const exit = await runExample({
				argv: ["--json"],
				env: baseEnv({
					NERVLY_API_URL: "http://192.0.2.1:9",
					NERVLY_API_KEY: syntheticApiKey("test", "wouldbe", "ok"),
				}),
				cwd: dir,
				stdout: (line) => stdout.push(line),
			});
			assert.equal(exit, 3);
		});
		assert.equal(requests.length, 0);
		const summary = JSON.parse(stdout.join("")) as RunSummary;
		assert.equal(summary.status, "refused");
		assert.equal(summary.checks.length, 0);
		assert.equal(summary.example, "mcp-agent");
	});

	it("refuses a live key with exit 3 and leaves no key-shaped text in artifacts", async () => {
		const dir = makeTempDir("mcp-refuse-key-");
		const exit = await runExample({
			argv: ["--json"],
			env: baseEnv({ NERVLY_API_KEY: syntheticApiKey("live", "real", "key") }),
			cwd: dir,
			stdout: () => {},
		});
		assert.equal(exit, 3);
		for (const name of ["summary.json", "transcript.log"]) {
			assert.equal(
				readFileSync(
					join(dir, "artifacts", "mcp-agent", name),
					"utf8",
				).includes("nervly_sk_test_"),
				false,
				`${name} must not contain the test-key prefix`,
			);
		}
	});

	it("--help prints usage and exits 0 without touching the stack", async () => {
		const dir = makeTempDir("mcp-help-");
		let output = "";
		const exit = await runExample({
			argv: ["--help"],
			env: baseEnv({ NERVLY_API_URL: "http://192.0.2.1:9" }),
			cwd: dir,
			stdout: (line) => {
				output += line;
			},
		});
		assert.equal(exit, 0);
		assert.match(output, /Usage:/);
		assert.match(output, /--llm/);
		assert.equal(existsSync(join(dir, "artifacts")), false);
	});

	it("--llm without a provider key exits 2 before any network work", async () => {
		const dir = makeTempDir("mcp-llm-nokey-");
		const stdout: string[] = [];
		const stack = scriptedStack();
		const requests = await withFetch(stack.fetchFn, async () => {
			const exit = await runExample({
				argv: ["--json", "--llm"],
				env: baseEnv(),
				cwd: dir,
				stdout: (line) => stdout.push(line),
			});
			assert.equal(exit, 2);
		});
		assert.equal(
			requests.length,
			0,
			"no key may be minted without a provider key",
		);
		const summary = JSON.parse(stdout.join("")) as RunSummary;
		assert.equal(summary.status, "error");
		assert.equal(summary.checks.length, 0);
		assert.match(
			readFileSync(
				join(dir, "artifacts", "mcp-agent", "transcript.log"),
				"utf8",
			),
			/OPENAI_API_KEY/,
		);
	});

	it("--llm with NERVLY_LLM_PROVIDER=anthropic names ANTHROPIC_API_KEY", async () => {
		const dir = makeTempDir("mcp-llm-anthropic-nokey-");
		const exit = await runExample({
			argv: ["--json", "--llm"],
			env: baseEnv({ NERVLY_LLM_PROVIDER: "anthropic" }),
			cwd: dir,
			stdout: () => {},
		});
		assert.equal(exit, 2);
		assert.match(
			readFileSync(
				join(dir, "artifacts", "mcp-agent", "transcript.log"),
				"utf8",
			),
			/ANTHROPIC_API_KEY/,
		);
	});

	it("runs the seed flow green against a stubbed stack", async () => {
		const stack = scriptedStack();
		const dir = makeTempDir("mcp-e2e-");
		const stdout: string[] = [];
		let exit = 0;
		await withFetch(stack.fetchFn, async () => {
			exit = await runExample({
				argv: ["--json"],
				env: baseEnv({
					NERVLY_RUN_ID: RUN_ID,
					EXAMPLES_CHECK_TIMEOUT_MS: "2000",
				}),
				cwd: dir,
				stdout: (line) => stdout.push(line),
			});
		});
		assert.equal(exit, 0);
		const summary = JSON.parse(stdout.join("")) as RunSummary;
		assert.equal(summary.example, "mcp-agent");
		assert.equal(summary.target, "local");
		assert.equal(summary.harnessVersion, "1");
		assert.equal(summary.status, "pass");
		assert.equal(summary.runId, RUN_ID);
		assert.deepEqual(summary.workspace, { slug: "dev-local", id: "ws-seed" });
		assert.deepEqual(
			summary.checks.map((check) => [check.name, check.status]),
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
		const delivered = summary.checks.find(
			(check) => check.name === "mcp check_delivery_status",
		);
		assert.match(delivered?.detail ?? "", /DELIVERED/);
		assert.match(delivered?.detail ?? "", /test_mode=true/);
		assert.deepEqual(summary.artifacts, ["transcript.log", "bootstrap.json"]);

		// Artifact invariants: no key material anywhere, and 0600 bootstrap.
		const artifactsDir = join(dir, "artifacts", "mcp-agent");
		for (const name of readdirSync(artifactsDir)) {
			const text = readFileSync(join(artifactsDir, name), "utf8");
			assert.equal(
				text.includes("nervly_sk_test_"),
				false,
				`${name} must not contain a key`,
			);
		}
		if (process.platform !== "win32") {
			assert.equal(
				statSync(join(artifactsDir, "bootstrap.json")).mode & 0o777,
				0o600,
			);
		}
		const bootstrapArtifact = JSON.parse(
			readFileSync(join(artifactsDir, "bootstrap.json"), "utf8"),
		) as { mode: string; apiKey: { mode: string } };
		assert.equal(bootstrapArtifact.mode, "seed");
		assert.equal(bootstrapArtifact.apiKey.mode, "test");

		// The transcript names the MCP method/tool per check.
		const transcript = readFileSync(
			join(artifactsDir, "transcript.log"),
			"utf8",
		);
		for (const fragment of [
			"tools/list",
			"tools/call gateway_status",
			"send_notification (sandboxed preview)",
			"send_notification (live: true)",
			"check_delivery_status",
			"messages.list",
			"unknown tool",
		]) {
			assert.match(
				transcript,
				new RegExp(fragment.replace(/[()]/g, "\\$&")),
				`transcript must name ${fragment}`,
			);
		}

		// Teardown revoked the minted key with the seed session's CSRF token.
		const deletes = stack.requests.filter(
			(request) => request.method === "DELETE",
		);
		assert.equal(deletes.length, 1);
		assert.match(deletes[0]?.url ?? "", /\/console\/api-keys\/key-seed$/);
		assert.equal(deletes[0]?.headers.get("x-csrf-token"), "csrf-seed");
	});

	it("exits 1 and writes a failing summary when delivery is never observed", async () => {
		const stack = scriptedStack({
			delivery: [
				deliveredResult({ status: "TRIGGERED", normalized_code: "in_transit" }),
			],
		});
		const dir = makeTempDir("mcp-e2e-fail-");
		const stdout: string[] = [];
		let exit = 0;
		await withFetch(stack.fetchFn, async () => {
			exit = await runExample({
				argv: ["--json"],
				env: baseEnv({
					NERVLY_RUN_ID: RUN_ID,
					EXAMPLES_CHECK_TIMEOUT_MS: "50",
				}),
				cwd: dir,
				stdout: (line) => stdout.push(line),
			});
		});
		assert.equal(exit, 1);
		const summary = JSON.parse(stdout.join("")) as RunSummary;
		assert.equal(summary.status, "fail");
		const delivered = summary.checks.find(
			(check) => check.name === "mcp check_delivery_status",
		);
		assert.equal(delivered?.status, "fail");
		assert.match(delivered?.detail ?? "", /TRIGGERED/);
		// Cleanup still ran on the failing path.
		assert.equal(
			stack.requests.some((request) => request.method === "DELETE"),
			true,
		);
	});

	it("fails with exit 2 naming make up when the stack is down", async () => {
		const stack = scriptedStack({
			networkError: new Error("connect ECONNREFUSED"),
		});
		const dir = makeTempDir("mcp-e2e-down-");
		const stdout: string[] = [];
		let exit = 0;
		await withFetch(stack.fetchFn, async () => {
			exit = await runExample({
				argv: ["--json"],
				env: baseEnv({ EXAMPLES_BOOTSTRAP_TIMEOUT_MS: "1000" }),
				cwd: dir,
				stdout: (line) => stdout.push(line),
			});
		});
		assert.equal(exit, 2);
		const summary = JSON.parse(stdout.join("")) as RunSummary;
		assert.equal(summary.status, "error");
		assert.match(
			readFileSync(
				join(dir, "artifacts", "mcp-agent", "transcript.log"),
				"utf8",
			),
			/make up/,
		);
	});

	it("runs the optional LLM variant when a provider key is present", async () => {
		const stack = scriptedStack();
		const provider = providerStub();
		const dir = makeTempDir("mcp-e2e-llm-");
		const stdout: string[] = [];
		let exit = 0;
		await withFetch(stack.fetchFn, async () => {
			exit = await runExample({
				argv: ["--json", "--llm"],
				env: baseEnv({
					NERVLY_RUN_ID: RUN_ID,
					OPENAI_API_KEY: "sk-provider-test",
				}),
				cwd: dir,
				stdout: (line) => stdout.push(line),
				fetchFn: provider.fetchFn,
			});
		});
		assert.equal(exit, 0);
		assert.equal(provider.calls.length, 2);
		const summary = JSON.parse(stdout.join("")) as RunSummary;
		const llmCheck = summary.checks.find(
			(check) => check.name === "llm variant",
		);
		assert.equal(llmCheck?.status, "pass");
		assert.match(llmCheck?.detail ?? "", /provider=openai/);
		assert.match(llmCheck?.detail ?? "", /The gateway is live\./);
		assert.equal(summary.status, "pass");
	});
});

// ---------------------------------------------------------------------------
// Entrypoint wiring (child processes)
// ---------------------------------------------------------------------------

describe("entrypoint", () => {
	it("exits 3 from the real main.ts with a non-local URL, before any work", () => {
		const dir = makeTempDir("mcp-child-");
		const result = spawnSync(
			join(ROOT, "node_modules", ".bin", "tsx"),
			[join(ROOT, "examples/mcp-agent/main.ts"), "--json"],
			{
				cwd: dir,
				encoding: "utf8",
				timeout: 15_000,
				env: {
					...process.env,
					NERVLY_API_URL: "http://192.0.2.1:9",
					NERVLY_API_KEY: "nervly_sk_test_ok",
				},
			},
		);
		assert.equal(result.status, 3, result.stderr);
		const summary = JSON.parse(result.stdout) as RunSummary;
		assert.equal(summary.status, "refused");
		assert.equal(summary.example, "mcp-agent");
	});

	it("dispatcher resolves mcp-agent and honours --help", () => {
		const dispatcher = join(ROOT, "scripts", "example.mjs");
		const wired = spawnSync(
			process.execPath,
			[dispatcher, "mcp-agent", "--help"],
			{
				encoding: "utf8",
				timeout: 20_000,
			},
		);
		assert.equal(wired.status, 0, wired.stderr);
		assert.match(wired.stdout, /Usage:/);
	});
});
