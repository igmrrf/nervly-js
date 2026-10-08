/**
 * Harness-contract tests for the node-app walking skeleton.
 *
 * These tests pin the invariants the contract promises — guard refusals and
 * their exit codes, redaction, the summary schema, bootstrap request shapes,
 * the asserted `DELIVERED` read-back, and cleanup — against stubbed control
 * plane / gateway / NATS services. `tests/live-contract.test.ts`-style live
 * coverage is the documented `npm run example` run against the local stack;
 * this suite is deterministic and never skips.
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
import {
	createServer as createHttpServer,
	type ServerResponse,
} from "node:http";
import {
	type AddressInfo,
	createServer as createNetServer,
	type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	type BootstrapResult,
	bootstrapFresh,
	bootstrapFromEnv,
	bootstrapSeed,
	teardownBootstrap,
} from "../examples/node-app/harness/bootstrap.js";
import { runChecks } from "../examples/node-app/harness/checks.js";
import {
	DEFAULTS,
	type ExampleConfig,
	loadConfig,
} from "../examples/node-app/harness/config.js";
import { ConsoleClient } from "../examples/node-app/harness/console.js";
import {
	EnvironmentFailure,
	GuardRefusal,
} from "../examples/node-app/harness/errors.js";
import {
	guardConfig,
	isLocalHost,
	isProductionHost,
} from "../examples/node-app/harness/guards.js";
import {
	NatsFrameParser,
	NatsVerificationCapture,
	scanForVerificationToken,
} from "../examples/node-app/harness/nats.js";
import { redact, redactValue } from "../examples/node-app/harness/redact.js";
import { isValidRunId, newRunId } from "../examples/node-app/harness/run-id.js";
import {
	buildSummary,
	type RunSummary,
	writeSummary,
} from "../examples/node-app/harness/summary.js";
import { Transcript } from "../examples/node-app/harness/transcript.js";
import { runExample } from "../examples/node-app/main.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "b".repeat(64);

/**
 * Synthetic API keys for the stub stack, assembled at runtime from fragments
 * so secret scanners (gitleaks) never see a key-shaped literal in this file.
 * The joined value is exactly the `nervly_sk_<mode>_<segments>` shape the
 * guards and redaction code must recognise.
 */
function syntheticApiKey(mode: "test" | "live", ...segments: string[]): string {
	return ["nervly", "sk", mode, ...segments].join("_");
}

// ---------------------------------------------------------------------------
// Stub services
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

interface NatsBroker {
	url: string;
	publish: (payload: Buffer) => void;
	close: () => Promise<void>;
}

async function startNatsBroker(): Promise<NatsBroker> {
	const sockets = new Set<Socket>();
	const server = createNetServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => sockets.delete(socket));
		socket.on("data", (chunk: Buffer) => {
			if (chunk.toString("utf8").includes("PING")) {
				socket.write("PONG\r\n");
			}
		});
	});
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	const address = server.address() as AddressInfo;
	return {
		url: `nats://127.0.0.1:${address.port}`,
		publish(payload: Buffer) {
			const frame = Buffer.concat([
				Buffer.from(
					`MSG notify.bulk.email 1 _INBOX.stub 1 ${payload.length}\r\n`,
				),
				payload,
				Buffer.from("\r\n"),
			]);
			for (const socket of sockets) socket.write(frame);
		},
		close: () =>
			new Promise<void>((done) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => done());
			}),
	};
}

function verificationPayload(token: string): Buffer {
	return Buffer.concat([
		Buffer.from("auth.email_verification\0"),
		Buffer.from(
			`{"action_url":"http://localhost:3000/verify-email?token=${token}"}`,
		),
	]);
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A full stubbed stack: control plane, gateway and NATS broker. */
async function startStubStack(
	options: { delivered?: boolean; verificationToken?: boolean } = {},
) {
	const state: { eventId: string | null; email: string | null } = {
		eventId: null,
		email: null,
	};
	const broker = await startNatsBroker();

	const consoleStub = await startHttpStub((request, response) => {
		const route = `${request.method} ${pathOf(request)}`;
		switch (route) {
			case "POST /auth/signup": {
				const body = jsonBody(request);
				state.email = String(body.email);
				if (options.verificationToken !== false) {
					broker.publish(verificationPayload(TOKEN));
				}
				sendJson(response, 201, {
					status: "verification_required",
					message: "check your email",
					user: { id: "user-e2e", email: body.email },
					workspace: {
						id: "ws-e2e",
						name: body.workspace_name,
						slug: "ex-node-e2e",
					},
				});
				return;
			}
			case "POST /auth/verify-email": {
				const body = jsonBody(request);
				if (body.token !== TOKEN) {
					sendJson(response, 400, { error: "bad_request" });
					return;
				}
				sendJson(response, 200, { status: "verified" });
				return;
			}
			case "POST /auth/login":
				sendJson(
					response,
					200,
					{
						status: "ok",
						user: { id: "user-e2e", email: state.email },
						workspace: { id: "ws-e2e", name: "Example", slug: "ex-node-e2e" },
						csrf_token: "csrf-e2e",
					},
					{
						"Set-Cookie": [
							"nervly_session=sess-e2e; Path=/; HttpOnly",
							"nervly_csrf=csrf-e2e; Path=/",
						],
					},
				);
				return;
			case "POST /console/api-keys":
				if (request.headers["x-csrf-token"] !== "csrf-e2e") {
					sendJson(response, 403, { error: "forbidden" });
					return;
				}
				sendJson(response, 201, {
					id: "key-e2e",
					name: jsonBody(request).name,
					mode: "test",
					scopes: ["read", "write"],
					masked_key: "nervly_sk_test_key-e2e…",
					token: syntheticApiKey("test", "e2e_secret_value"),
				});
				return;
			case "DELETE /console/workspace": {
				const body = jsonBody(request);
				if (body.confirm !== "ex-node-e2e") {
					sendJson(response, 400, { error: "confirmation_required" });
					return;
				}
				sendJson(response, 200, { status: "closed" });
				return;
			}
			default:
				sendJson(response, 404, { error: "unexpected", route });
		}
	});

	const gatewayStub = await startHttpStub((request, response) => {
		const route = `${request.method} ${pathOf(request)}`;
		switch (route) {
			case "GET /v1/health":
				sendJson(response, 200, {
					status: "OK",
					service: "stub-gateway",
					version: "0.0.0",
					environment: "test",
					deployment: "stub",
					key_mode: "test",
					uptime_seconds: 1,
					nats_connected: true,
				});
				return;
			case "POST /v1/events/trigger":
				state.eventId = "evt_0123456789abcdef0123456789abcdef";
				sendJson(response, 202, {
					eventId: state.eventId,
					status: "QUEUED",
					priority: "NORMAL",
					channel: "email",
					idempotencyKey: request.headers["idempotency-key"] ?? null,
					timestamp: new Date().toISOString(),
				});
				return;
			case "POST /v1/events/bulk": {
				const events = Array.isArray(jsonBody(request).events)
					? (jsonBody(request).events as unknown[])
					: [];
				if (events.length === 0) {
					sendJson(response, 400, {
						error: "BAD_REQUEST",
						message: "Events array cannot be empty",
						status_code: 400,
					});
					return;
				}
				sendJson(response, 200, {
					jobId: "job_batch_stub",
					status: "QUEUED",
					count: events.length,
					failedCount: 0,
					events: events.map((_event, index) => ({
						index,
						eventId: `evt_bulk_${index}_0123456789abcdef`,
						status: "QUEUED",
						channel: "email",
					})),
				});
				return;
			}
			case "GET /v1/messages": {
				const delivered = options.delivered !== false;
				sendJson(response, 200, {
					messages: state.eventId
						? [
								{
									event_id: state.eventId,
									event_name: "example.node_app.trigger",
									subscriber_id: "sub-example",
									priority: 3,
									status: delivered ? "DELIVERED" : "TRIGGERED",
									channel: "email",
									provider: "mock",
									provider_message_id: "msg-e2e",
									attempts: 1,
									cost_micro_usd: 0,
									test_mode: true,
									category: "transactional",
									variables_keys: ["runId"],
									created_at: new Date().toISOString(),
									updated_at: new Date().toISOString(),
								},
							]
						: [],
				});
				return;
			}
			case `GET /v1/events/evt_${"0".repeat(32)}`:
				sendJson(response, 404, {
					error: "NOT_FOUND",
					message: "Event not found",
					status_code: 404,
				});
				return;
			case "GET /v1/events/evt_0123456789abcdef0123456789abcdef":
				sendJson(response, 200, {
					event_id: state.eventId,
					event_name: "example.node_app.trigger",
					subscriber_id: "sub-example",
					priority: 3,
					status: "DELIVERED",
					channel: "email",
					attempts: 1,
					cost_micro_usd: 0,
					test_mode: true,
					category: "transactional",
					variables_keys: ["runId"],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				});
				return;
			default:
				if (
					request.method === "PUT" &&
					/^\/v1\/users\/[^/]+\/preferences$/.test(pathOf(request))
				) {
					const subscriberId = decodeURIComponent(
						pathOf(request)
							.replace(/^\/v1\/users\//, "")
							.replace(/\/preferences$/, ""),
					);
					sendJson(response, 200, {
						status: "UPDATED",
						subscriberId,
						updated_at: new Date().toISOString(),
					});
					return;
				}
				sendJson(response, 404, { error: "unexpected", route });
		}
	});

	return {
		console: consoleStub,
		gateway: gatewayStub,
		broker,
		state,
		close: async () => {
			await Promise.all([
				consoleStub.close(),
				gatewayStub.close(),
				broker.close(),
			]);
		},
	};
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

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("redact", () => {
	it("scrubs test and live API keys entirely, prefix included", () => {
		const testKey = syntheticApiKey("test", "abc123", "def456");
		const liveKey = syntheticApiKey("live", "fff", "999");
		const output = redact(`key=${testKey} and live=${liveKey}`);
		assert.equal(output.includes("nervly_sk_test_"), false);
		assert.equal(output.includes("nervly_sk_live_"), false);
		assert.equal(output.includes("abc123"), false);
		assert.equal(output.includes("[REDACTED_API_KEY]"), true);
	});

	it("scrubs session, CSRF, verification-token and JSON secret shapes", () => {
		const output = redact(
			[
				"Cookie: nervly_session=sess_secret_value; nervly_csrf=csrf_secret_value",
				`http://localhost:3000/verify-email?token=${"a".repeat(64)}`,
				'{"password":"hunter2","csrf_token":"csrf-json","api_key":"kv"}',
			].join("\n"),
		);
		assert.equal(output.includes("sess_secret_value"), false);
		assert.equal(output.includes("csrf_secret_value"), false);
		assert.equal(output.includes("a".repeat(64)), false);
		assert.equal(output.includes("hunter2"), false);
		assert.equal(output.includes("csrf-json"), false);
	});

	it("leaves ordinary transcript text untouched", () => {
		const text = "node-app finished: PASS (run 20261007T084712Z-ab12)";
		assert.equal(redact(text), text);
	});

	it("redactValue scrubs a bootstrap-shaped payload without changing its keys", () => {
		const scrubbed = redactValue({
			runId: "20261007T084712Z-ab12",
			apiKey: syntheticApiKey("test", "deadbeef", "secret"),
			nested: { token: "shown-nowhere", password: "p" },
		});
		assert.equal(scrubbed.runId, "20261007T084712Z-ab12");
		assert.equal(scrubbed.apiKey.includes("nervly_sk_test_"), false);
		assert.equal(scrubbed.apiKey.includes("deadbeef"), false);
		assert.match(scrubbed.apiKey, /REDACTED/);
		assert.deepEqual(Object.keys(scrubbed.nested), ["token", "password"]);
		assert.equal(scrubbed.nested.token, "[REDACTED]");
		assert.equal(scrubbed.nested.password, "[REDACTED]");
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

	it("rejects ids that are unsafe inside emails, slugs and key names", () => {
		for (const bad of ["", "has space", "slash/yes", "x".repeat(65)]) {
			assert.equal(isValidRunId(bad), false, `${bad} must be rejected`);
		}
	});
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("config", () => {
	it("applies every documented default, including the current seed default", () => {
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
				NERVLY_RUN_ID: "20261007T084712Z-cafe",
				NERVLY_API_KEY: "nervly_sk_test_x",
				NERVLY_WORKSPACE_SLUG: "ex-node",
				EXAMPLES_BOOTSTRAP: "fresh",
				EXAMPLES_KEEP: "1",
				EXAMPLES_BOOTSTRAP_TIMEOUT_MS: "1000",
				EXAMPLES_CHECK_TIMEOUT_MS: "2000",
			}),
		);
		assert.equal(config.gatewayUrl, "http://127.0.0.1:9090");
		assert.equal(config.apiUrl, "http://localhost:8080");
		assert.equal(config.runId, "20261007T084712Z-cafe");
		assert.equal(config.workspaceSlug, "ex-node");
		assert.equal(config.bootstrapMode, "fresh");
		assert.equal(config.keep, true);
		assert.equal(config.bootstrapTimeoutMs, 1000);
		assert.equal(config.checkTimeoutMs, 2000);
	});

	it("resolves sandbox default URLs when NERVLY_TARGET=sandbox", () => {
		const config = loadConfig({ NERVLY_TARGET: "sandbox" });
		assert.equal(config.target, "sandbox");
		assert.equal(config.apiUrl, "https://sandbox-api.nervly.io");
		assert.equal(config.gatewayUrl, "https://sandbox-api.nervly.io");
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

	it("detects production hosts and allows sandbox host", () => {
		assert.equal(isProductionHost("api.nervly.io"), true);
		assert.equal(isProductionHost("console.nervly.io"), true);
		assert.equal(isProductionHost("control.nervly.io"), true);
		assert.equal(isProductionHost("nervly.io"), true);
		assert.equal(isProductionHost("sandbox-api.nervly.io"), false);
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
			() => guardConfig(stubConfig({ target: "production" })),
			(error: unknown) => error instanceof GuardRefusal && error.exitCode === 3,
		);
	});

	it("accepts sandbox target with test key and sandbox URLs", () => {
		const testKey = syntheticApiKey("test", "sandbox", "ok");
		assert.doesNotThrow(() =>
			guardConfig(
				stubConfig({
					target: "sandbox",
					apiKey: testKey,
					apiUrl: "https://sandbox-api.nervly.io",
					gatewayUrl: "https://sandbox-api.nervly.io",
					controlUrl: "https://sandbox-api.nervly.io",
				}),
			),
		);
	});

	it("refuses sandbox target when apiKey is null", () => {
		assert.throws(
			() =>
				guardConfig(
					stubConfig({
						target: "sandbox",
						apiKey: null,
						apiUrl: "https://sandbox-api.nervly.io",
						gatewayUrl: "https://sandbox-api.nervly.io",
					}),
				),
			(error: unknown) =>
				error instanceof GuardRefusal &&
				error.exitCode === 3 &&
				error.message.includes("NERVLY_API_KEY is required"),
		);
	});

	it("refuses sandbox target when URL points to production host", () => {
		const testKey = syntheticApiKey("test", "sandbox", "ok");
		for (const prodHost of [
			"https://api.nervly.io",
			"https://console.nervly.io",
			"https://control.nervly.io",
			"https://nervly.io",
		]) {
			assert.throws(
				() =>
					guardConfig(
						stubConfig({
							target: "sandbox",
							apiKey: testKey,
							apiUrl: prodHost,
							gatewayUrl: prodHost,
						}),
					),
				(error: unknown) =>
					error instanceof GuardRefusal &&
					error.exitCode === 3 &&
					error.message.includes("production host"),
				`expected refusal for ${prodHost}`,
			);
		}
	});

	it("refuses unknown target with GuardRefusal exit 3", () => {
		assert.throws(
			() => guardConfig(stubConfig({ target: "unknown" })),
			(error: unknown) =>
				error instanceof GuardRefusal &&
				error.exitCode === 3 &&
				error.message.includes("is not supported"),
		);
	});
});

// ---------------------------------------------------------------------------
// Summary + transcript
// ---------------------------------------------------------------------------

describe("summary", () => {
	it("builds exactly the contract fields, redacting check details", () => {
		const summary = buildSummary({
			example: "node-app",
			target: "local",
			runId: "20261007T084712Z-ab12",
			startedAt: new Date("2026-10-07T08:47:12.000Z"),
			durationMs: 41230.7,
			status: "pass",
			workspace: { slug: "ex-node", id: "ws-1" },
			checks: [
				{
					name: "trigger delivered",
					status: "pass",
					detail: `event evt_1 DELIVERED with nervly_sk_test_secret`,
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
		assert.equal(summary.harnessVersion, "1");
		assert.equal(summary.startedAt, "2026-10-07T08:47:12.000Z");
		assert.equal(summary.durationMs, 41231);
		assert.equal(summary.checks[0]?.detail.includes("nervly_sk_test_"), false);
	});

	it("clamps a negative duration and keeps null workspace fields", () => {
		const summary = buildSummary({
			example: "node-app",
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

	it("writes artifacts/summary.json and round-trips it", () => {
		const dir = makeTempDir("node-app-summary-");
		const summary = buildSummary({
			example: "node-app",
			target: "local",
			runId: "20261007T084712Z-ab12",
			startedAt: new Date("2026-10-07T08:47:12.000Z"),
			durationMs: 10,
			status: "pass",
			workspace: { slug: "s", id: "i" },
			checks: [],
			artifacts: ["transcript.log"],
		});
		const path = writeSummary(join(dir, "artifacts"), summary);
		const parsed = JSON.parse(readFileSync(path, "utf8")) as RunSummary;
		assert.deepEqual(parsed, summary);
	});
});

describe("transcript", () => {
	it("writes redacted lines to stdout and transcript.log", () => {
		const dir = makeTempDir("node-app-transcript-");
		const { log, lines } = collectingTranscript(dir);
		log.line("key nervly_sk_test_secret_value");
		log.line("plain line");
		const file = readFileSync(log.transcriptPath, "utf8");
		assert.equal(file.includes("nervly_sk_test_"), false);
		assert.match(file, /\[REDACTED_API_KEY\]/);
		assert.match(file, /plain line/);
		assert.equal(lines.length, 2);
		assert.equal(lines[0]?.includes("nervly_sk_test_"), false);
	});

	it("keeps stdout silent in --json mode but still logs to file", () => {
		const dir = makeTempDir("node-app-transcript-json-");
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

	it("starts each run's transcript fresh instead of appending to the last", () => {
		const dir = makeTempDir("node-app-transcript-fresh-");
		const first = new Transcript({ artifactsDir: dir, stdout: () => {} });
		first.line("from the previous run");
		const second = new Transcript({ artifactsDir: dir, stdout: () => {} });
		second.line("current run");
		const text = readFileSync(second.transcriptPath, "utf8");
		assert.equal(text.includes("from the previous run"), false);
		assert.match(text, /current run/);
	});
});

// ---------------------------------------------------------------------------
// NATS parsing and capture
// ---------------------------------------------------------------------------

describe("NATS frame parsing", () => {
	it("parses frames split across chunks and several frames per chunk", () => {
		const parser = new NatsFrameParser();
		const first = Buffer.from("MSG notify.bulk.email 1 5\r\nhello\r\n");
		const second = Buffer.from(
			"INFO {}\r\nMSG notify.bulk.sms 2 _INBOX.reply 5\r\nworld\r\n",
		);
		assert.deepEqual(parser.push(first.subarray(0, 12)), []);
		const frames = parser.push(Buffer.concat([first.subarray(12), second]));
		assert.deepEqual(
			frames.map((frame) => frame.payload.toString()),
			["hello", "world"],
		);
		assert.deepEqual(
			frames.map((frame) => frame.subject),
			["notify.bulk.email", "notify.bulk.sms"],
		);
		assert.deepEqual(parser.takeControlLines(), [
			"MSG notify.bulk.email 1 5",
			"INFO {}",
			"MSG notify.bulk.sms 2 _INBOX.reply 5",
		]);
		assert.deepEqual(parser.takeControlLines(), []);
	});

	it("scans only verification-email payloads for 64-hex tokens", () => {
		assert.equal(scanForVerificationToken(verificationPayload(TOKEN)), TOKEN);
		assert.equal(
			scanForVerificationToken(`auth.email_verification token=short`),
			null,
		);
		assert.equal(
			scanForVerificationToken(`transactional-email no token here`),
			null,
		);
		assert.equal(
			scanForVerificationToken(verificationPayload(TOKEN).subarray(0, 5)),
			null,
		);
	});
});

describe("NATS capture against a stub broker", () => {
	it("resolves the token published after the handshake", async () => {
		const broker = await startNatsBroker();
		try {
			const capture = await NatsVerificationCapture.connect(broker.url, {
				connectTimeoutMs: 2000,
			});
			broker.publish(verificationPayload(TOKEN));
			assert.equal(await capture.waitForToken(2000), TOKEN);
			// Already captured: a second wait resolves immediately.
			assert.equal(await capture.waitForToken(2000), TOKEN);
			capture.close();
		} finally {
			await broker.close();
		}
	});

	it("times out with an environment failure naming make up", async () => {
		const broker = await startNatsBroker();
		try {
			const capture = await NatsVerificationCapture.connect(broker.url, {
				connectTimeoutMs: 2000,
			});
			await assert.rejects(
				() => capture.waitForToken(50),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.exitCode === 2 &&
					error.message.includes("make up"),
			);
			capture.close();
		} finally {
			await broker.close();
		}
	});

	it("fails the connect when nothing is listening", async () => {
		const broker = await startNatsBroker();
		const url = broker.url;
		await broker.close();
		await assert.rejects(
			() =>
				NatsVerificationCapture.connect(url, {
					connectTimeoutMs: 2000,
				}),
			(error: unknown) =>
				error instanceof EnvironmentFailure && error.exitCode === 2,
		);
	});
});

// ---------------------------------------------------------------------------
// Control-plane client
// ---------------------------------------------------------------------------

describe("ConsoleClient", () => {
	it("absorbs cookies, applies the CSRF header, and parses JSON", async () => {
		const stub = await startHttpStub((request, response) => {
			if (pathOf(request) === "/login") {
				sendJson(
					response,
					200,
					{ status: "ok" },
					{
						"Set-Cookie": [
							"nervly_session=sess-1; Path=/; HttpOnly",
							"nervly_csrf=csrf-1; Path=/",
						],
					},
				);
				return;
			}
			sendJson(response, 200, {
				cookie: request.headers.cookie,
				csrf: request.headers["x-csrf-token"],
			});
		});
		try {
			const client = new ConsoleClient(stub.url);
			await client.request("POST", "/login", { body: { email: "x" } });
			const second = await client.request("POST", "/next", { csrf: "csrf-1" });
			const body = second.body as { cookie: string; csrf: string };
			assert.match(body.cookie, /nervly_session=sess-1/);
			assert.match(body.cookie, /nervly_csrf=csrf-1/);
			assert.equal(body.csrf, "csrf-1");
			assert.equal(client.getCookie("nervly_session"), "sess-1");
			assert.equal(
				client.cookieHeader(),
				"nervly_session=sess-1; nervly_csrf=csrf-1",
			);
		} finally {
			await stub.close();
		}
	});

	it("maps connection failures to an environment failure naming make up", async () => {
		const stub = await startHttpStub((_request, response) => {
			sendJson(response, 200, {});
		});
		const url = stub.url;
		await stub.close();
		await assert.rejects(
			() => new ConsoleClient(url).request("GET", "/anything"),
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
		const revoked: string[] = [];
		const stub = await startHttpStub((request, response) => {
			const route = `${request.method} ${pathOf(request)}`;
			if (route === "POST /auth/login") {
				sendJson(
					response,
					200,
					{
						status: "ok",
						workspace: { id: "ws-seed", slug: "dev-local" },
						csrf_token: "csrf-seed",
					},
					{
						"Set-Cookie": [
							"nervly_session=sess-seed; Path=/; HttpOnly",
							"nervly_csrf=csrf-seed; Path=/",
						],
					},
				);
				return;
			}
			if (route === "POST /console/api-keys") {
				if (request.headers["x-csrf-token"] !== "csrf-seed") {
					sendJson(response, 403, { error: "forbidden" });
					return;
				}
				sendJson(response, 201, {
					id: "key-seed",
					name: jsonBody(request).name,
					token: "nervly_sk_test_seed_secret",
				});
				return;
			}
			if (route === "DELETE /console/api-keys/key-seed") {
				if (request.headers["x-csrf-token"] !== "csrf-seed") {
					sendJson(response, 403, { error: "forbidden" });
					return;
				}
				revoked.push("key-seed");
				sendJson(response, 200, { status: "revoked" });
				return;
			}
			sendJson(response, 404, { error: "unexpected", route });
		});
		const dir = makeTempDir("node-app-seed-");
		const { log } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: stub.url,
				runId: "20261007T084712Z-cafe",
			});
			const bootstrap = await bootstrapSeed(config, log);
			assert.equal(bootstrap.source, "seed");
			assert.equal(bootstrap.apiKey, "nervly_sk_test_seed_secret");
			assert.equal(bootstrap.keyId, "key-seed");
			assert.deepEqual(bootstrap.workspace, {
				slug: "dev-local",
				id: "ws-seed",
			});

			const keyRequest = stub.requests.find(
				(request) => pathOf(request) === "/console/api-keys",
			);
			assert.ok(keyRequest);
			assert.deepEqual(jsonBody(keyRequest), {
				name: "examples-20261007T084712Z-cafe",
				mode: "test",
				scopes: ["read", "write"],
			});

			assert.equal(await teardownBootstrap(bootstrap, log), true);
			assert.deepEqual(revoked, ["key-seed"]);
		} finally {
			await stub.close();
		}
	});

	it("fresh mode performs signup → token → verify → login → key in order", async () => {
		const broker = await startNatsBroker();
		const routes: string[] = [];
		const stub = await startHttpStub((request, response) => {
			const route = `${request.method} ${pathOf(request)}`;
			routes.push(route);
			if (route === "POST /auth/signup") {
				broker.publish(verificationPayload(TOKEN));
				sendJson(response, 201, {
					status: "verification_required",
					user: { id: "u1", email: jsonBody(request).email },
					workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
				});
				return;
			}
			if (route === "POST /auth/verify-email") {
				assert.equal(jsonBody(request).token, TOKEN);
				sendJson(response, 200, { status: "verified" });
				return;
			}
			if (route === "POST /auth/login") {
				sendJson(
					response,
					200,
					{
						status: "ok",
						workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
						csrf_token: "csrf-fresh",
					},
					{
						"Set-Cookie": [
							"nervly_session=sess-fresh; Path=/; HttpOnly",
							"nervly_csrf=csrf-fresh; Path=/",
						],
					},
				);
				return;
			}
			if (route === "POST /console/api-keys") {
				sendJson(response, 201, {
					id: "key-fresh",
					token: "nervly_sk_test_fresh_secret",
				});
				return;
			}
			if (route === "DELETE /console/workspace") {
				assert.equal(jsonBody(request).confirm, "ex-node-fresh");
				sendJson(response, 200, { status: "closed" });
				return;
			}
			sendJson(response, 404, { error: "unexpected", route });
		});
		const dir = makeTempDir("node-app-fresh-");
		const { log } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: stub.url,
				natsUrl: broker.url,
				runId: "20261007T084712Z-f00d",
				bootstrapTimeoutMs: 3000,
			});
			const bootstrap = await bootstrapFresh(config, log);
			assert.equal(bootstrap.source, "fresh");
			assert.equal(bootstrap.apiKey, "nervly_sk_test_fresh_secret");
			assert.equal(
				bootstrap.email,
				"examples+20261007T084712Z-f00d@example.local",
			);
			assert.deepEqual(bootstrap.workspace, {
				slug: "ex-node-fresh",
				id: "ws-fresh",
			});
			assert.deepEqual(routes, [
				"POST /auth/signup",
				"POST /auth/verify-email",
				"POST /auth/login",
				"POST /console/api-keys",
			]);
			assert.equal(await teardownBootstrap(bootstrap, log), true);
		} finally {
			await stub.close();
			await broker.close();
		}
	});

	it("fresh mode closes the signup workspace via the owner console when key creation fails", async () => {
		const broker = await startNatsBroker();
		const deletes: StubRequest[] = [];
		const stub = await startHttpStub((request, response) => {
			const route = `${request.method} ${pathOf(request)}`;
			if (route === "POST /auth/signup") {
				broker.publish(verificationPayload(TOKEN));
				sendJson(response, 201, {
					status: "verification_required",
					workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
				});
				return;
			}
			if (route === "POST /auth/verify-email") {
				sendJson(response, 200, { status: "verified" });
				return;
			}
			if (route === "POST /auth/login") {
				sendJson(
					response,
					200,
					{
						status: "ok",
						workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
						csrf_token: "csrf-fresh",
					},
					{
						"Set-Cookie": [
							"nervly_session=sess-fresh; Path=/; HttpOnly",
							"nervly_csrf=csrf-fresh; Path=/",
						],
					},
				);
				return;
			}
			if (route === "POST /console/api-keys") {
				sendJson(response, 500, { error: "key backend down" });
				return;
			}
			if (route === "DELETE /console/workspace") {
				deletes.push(request);
				sendJson(response, 200, { status: "closed" });
				return;
			}
			sendJson(response, 404, { error: "unexpected", route });
		});
		const dir = makeTempDir("node-app-fresh-cleanup-");
		const { log } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: stub.url,
				natsUrl: broker.url,
				runId: "20261007T084712Z-c1ea",
				bootstrapTimeoutMs: 3000,
			});
			await assert.rejects(
				() => bootstrapFresh(config, log),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.exitCode === 2 &&
					error.message.includes("creating the test API key failed") &&
					error.message.includes('workspace "ex-node-fresh" (id ws-fresh)') &&
					error.message.includes(
						"has been cleaned up through the owner console",
					) &&
					!error.message.includes("could NOT be cleaned up") &&
					!error.message.includes("make up"),
			);
			// The delete used the signup owner's session and CSRF token.
			assert.equal(deletes.length, 1);
			assert.equal(
				jsonBody(deletes[0] as StubRequest).confirm,
				"ex-node-fresh",
			);
			assert.match(
				String(deletes[0]?.headers.cookie ?? ""),
				/nervly_session=sess-fresh/,
			);
			assert.equal(deletes[0]?.headers["x-csrf-token"], "csrf-fresh");
		} finally {
			await stub.close();
			await broker.close();
		}
	});

	it("fresh mode retries the owner login to clean up when login failed after verification", async () => {
		const broker = await startNatsBroker();
		const logins: StubRequest[] = [];
		const deletes: StubRequest[] = [];
		const stub = await startHttpStub((request, response) => {
			const route = `${request.method} ${pathOf(request)}`;
			if (route === "POST /auth/signup") {
				broker.publish(verificationPayload(TOKEN));
				sendJson(response, 201, {
					status: "verification_required",
					workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
				});
				return;
			}
			if (route === "POST /auth/verify-email") {
				sendJson(response, 200, { status: "verified" });
				return;
			}
			if (route === "POST /auth/login") {
				logins.push(request);
				if (logins.length === 1) {
					sendJson(response, 500, { error: "login backend down" });
					return;
				}
				sendJson(
					response,
					200,
					{
						status: "ok",
						workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
						csrf_token: "csrf-retry",
					},
					{
						"Set-Cookie": [
							"nervly_session=sess-retry; Path=/; HttpOnly",
							"nervly_csrf=csrf-retry; Path=/",
						],
					},
				);
				return;
			}
			if (route === "DELETE /console/workspace") {
				deletes.push(request);
				sendJson(response, 200, { status: "closed" });
				return;
			}
			sendJson(response, 404, { error: "unexpected", route });
		});
		const dir = makeTempDir("node-app-fresh-retry-");
		const { log } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: stub.url,
				natsUrl: broker.url,
				runId: "20261007T084712Z-re7y",
				bootstrapTimeoutMs: 3000,
			});
			await assert.rejects(
				() => bootstrapFresh(config, log),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.exitCode === 2 &&
					error.message.includes(
						"login after verification failed with HTTP 500",
					) &&
					error.message.includes(
						"has been cleaned up through the owner console",
					) &&
					!error.message.includes("make up"),
			);
			assert.equal(logins.length, 2);
			assert.equal(
				jsonBody(logins[1] as StubRequest).password,
				jsonBody(logins[0] as StubRequest).password,
			);
			assert.equal(deletes.length, 1);
			assert.equal(
				jsonBody(deletes[0] as StubRequest).confirm,
				"ex-node-fresh",
			);
			assert.match(
				String(deletes[0]?.headers.cookie ?? ""),
				/nervly_session=sess-retry/,
			);
		} finally {
			await stub.close();
			await broker.close();
		}
	});

	it("fresh mode reports the orphan, not a false cleanup, when the owner-console delete fails", async () => {
		const broker = await startNatsBroker();
		const stub = await startHttpStub((request, response) => {
			const route = `${request.method} ${pathOf(request)}`;
			if (route === "POST /auth/signup") {
				broker.publish(verificationPayload(TOKEN));
				sendJson(response, 201, {
					status: "verification_required",
					workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
				});
				return;
			}
			if (route === "POST /auth/verify-email") {
				sendJson(response, 200, { status: "verified" });
				return;
			}
			if (route === "POST /auth/login") {
				sendJson(
					response,
					200,
					{
						status: "ok",
						workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
						csrf_token: "csrf-fresh",
					},
					{
						"Set-Cookie": ["nervly_session=sess-fresh; Path=/; HttpOnly"],
					},
				);
				return;
			}
			if (route === "POST /console/api-keys") {
				sendJson(response, 500, { error: "key backend down" });
				return;
			}
			if (route === "DELETE /console/workspace") {
				sendJson(response, 500, { error: "delete backend down" });
				return;
			}
			sendJson(response, 404, { error: "unexpected", route });
		});
		const dir = makeTempDir("node-app-fresh-delete-fail-");
		const { log } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: stub.url,
				natsUrl: broker.url,
				runId: "20261007T084712Z-d3l3",
				bootstrapTimeoutMs: 3000,
			});
			await assert.rejects(
				() => bootstrapFresh(config, log),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.exitCode === 2 &&
					error.message.includes("could NOT be cleaned up") &&
					error.message.includes("the owner-console delete did not succeed") &&
					error.message.includes(
						"DELETE FROM workspaces WHERE slug = 'ex-node-fresh';",
					) &&
					!error.message.includes("make up"),
			);
			assert.equal(
				stub.requests.filter(
					(request) => pathOf(request) === "/console/workspace",
				).length,
				1,
			);
		} finally {
			await stub.close();
			await broker.close();
		}
	});

	it("fresh mode falls back to the orphan report when the cleanup login fails too", async () => {
		const broker = await startNatsBroker();
		const logins: StubRequest[] = [];
		const stub = await startHttpStub((request, response) => {
			const route = `${request.method} ${pathOf(request)}`;
			if (route === "POST /auth/signup") {
				broker.publish(verificationPayload(TOKEN));
				sendJson(response, 201, {
					status: "verification_required",
					workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
				});
				return;
			}
			if (route === "POST /auth/verify-email") {
				sendJson(response, 200, { status: "verified" });
				return;
			}
			if (route === "POST /auth/login") {
				logins.push(request);
				sendJson(response, 500, { error: "login backend down" });
				return;
			}
			if (route === "DELETE /console/workspace") {
				sendJson(response, 200, { status: "closed" });
				return;
			}
			sendJson(response, 404, { error: "unexpected", route });
		});
		const dir = makeTempDir("node-app-fresh-retry-fail-");
		const { log } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: stub.url,
				natsUrl: broker.url,
				runId: "20261007T084712Z-re7f",
				bootstrapTimeoutMs: 3000,
			});
			await assert.rejects(
				() => bootstrapFresh(config, log),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.exitCode === 2 &&
					error.message.includes("could NOT be cleaned up") &&
					error.message.includes("the cleanup login failed") &&
					error.message.includes(
						"DELETE FROM workspaces WHERE slug = 'ex-node-fresh';",
					) &&
					!error.message.includes("make up"),
			);
			assert.equal(logins.length, 2);
			assert.equal(
				stub.requests.some((request) => request.method === "DELETE"),
				false,
			);
		} finally {
			await stub.close();
			await broker.close();
		}
	});

	it("fresh mode honours EXAMPLES_KEEP=1 when a verified bootstrap fails", async () => {
		const broker = await startNatsBroker();
		const stub = await startHttpStub((request, response) => {
			const route = `${request.method} ${pathOf(request)}`;
			if (route === "POST /auth/signup") {
				broker.publish(verificationPayload(TOKEN));
				sendJson(response, 201, {
					status: "verification_required",
					workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
				});
				return;
			}
			if (route === "POST /auth/verify-email") {
				sendJson(response, 200, { status: "verified" });
				return;
			}
			if (route === "POST /auth/login") {
				sendJson(
					response,
					200,
					{
						status: "ok",
						workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
						csrf_token: "csrf-fresh",
					},
					{
						"Set-Cookie": ["nervly_session=sess-fresh; Path=/; HttpOnly"],
					},
				);
				return;
			}
			if (route === "POST /console/api-keys") {
				sendJson(response, 500, { error: "key backend down" });
				return;
			}
			if (route === "DELETE /console/workspace") {
				sendJson(response, 200, { status: "closed" });
				return;
			}
			sendJson(response, 404, { error: "unexpected", route });
		});
		const dir = makeTempDir("node-app-fresh-keep-");
		const { log } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: stub.url,
				natsUrl: broker.url,
				runId: "20261007T084712Z-k33p",
				bootstrapTimeoutMs: 3000,
				keep: true,
			});
			await assert.rejects(
				() => bootstrapFresh(config, log),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.exitCode === 2 &&
					error.message.includes("EXAMPLES_KEEP=1 keeps it for debugging") &&
					error.message.includes("could NOT be cleaned up") &&
					error.message.includes(
						"DELETE FROM workspaces WHERE slug = 'ex-node-fresh';",
					) &&
					!error.message.includes("make up"),
			);
			assert.equal(
				stub.requests.some((request) => request.method === "DELETE"),
				false,
				"EXAMPLES_KEEP=1 must skip teardown",
			);
		} finally {
			await stub.close();
			await broker.close();
		}
	});

	it("fresh mode strips the make-up hint from a transport failure after signup", async () => {
		const broker = await startNatsBroker();
		const stub = await startHttpStub((request, response) => {
			if (request.method === "POST" && pathOf(request) === "/auth/signup") {
				broker.publish(verificationPayload(TOKEN));
				sendJson(response, 201, {
					status: "verification_required",
					workspace: { id: "ws-fresh", slug: "ex-node-fresh" },
				});
				return;
			}
			sendJson(response, 404, { error: "unexpected" });
		});
		let calls = 0;
		const fetchFn: typeof fetch = (input, init) => {
			calls += 1;
			// The first request (signup) really reaches the stub; every later
			// request fails at the transport layer, as a mid-run outage would.
			return calls === 1
				? fetch(input, init)
				: Promise.reject(new Error("socket hang up"));
		};
		const dir = makeTempDir("node-app-fresh-transport-");
		const { log } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: stub.url,
				natsUrl: broker.url,
				runId: "20261007T084712Z-h1nt",
				bootstrapTimeoutMs: 3000,
			});
			await assert.rejects(
				() => bootstrapFresh(config, log, { fetchFn }),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.exitCode === 2 &&
					error.message.includes("control plane unreachable") &&
					error.message.includes('workspace "ex-node-fresh" (id ws-fresh)') &&
					error.message.includes(
						"DELETE FROM workspaces WHERE slug = 'ex-node-fresh';",
					) &&
					!error.message.includes("make up"),
			);
			assert.equal(calls, 2, "signup, then the failed verify-email attempt");
		} finally {
			await stub.close();
			await broker.close();
		}
	});

	it("fresh mode keeps the make-up hint when signup itself cannot reach the control plane", async () => {
		const broker = await startNatsBroker();
		const stub = await startHttpStub((_request, response) => {
			sendJson(response, 200, {});
		});
		const url = stub.url;
		await stub.close();
		const dir = makeTempDir("node-app-fresh-down-");
		const { log } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: url,
				natsUrl: broker.url,
				runId: "20261007T084712Z-d0wn",
				bootstrapTimeoutMs: 1000,
			});
			await assert.rejects(
				() => bootstrapFresh(config, log),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.exitCode === 2 &&
					error.message.includes("control plane unreachable") &&
					error.message.includes("make up") &&
					!error.message.includes("could NOT be cleaned up"),
			);
		} finally {
			await broker.close();
		}
	});

	it("fresh mode surfaces a failed verification as an environment failure", async () => {
		const broker = await startNatsBroker();
		const stub = await startHttpStub((request, response) => {
			const route = `${request.method} ${pathOf(request)}`;
			if (route === "POST /auth/signup") {
				broker.publish(verificationPayload(TOKEN));
				sendJson(response, 201, {
					status: "verification_required",
					workspace: { slug: "ex-node-fresh" },
				});
				return;
			}
			if (route === "POST /auth/verify-email") {
				sendJson(response, 400, { error: "bad_request" });
				return;
			}
			sendJson(response, 404, { error: "unexpected", route });
		});
		const dir = makeTempDir("node-app-fresh-fail-");
		const { log } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: stub.url,
				natsUrl: broker.url,
				runId: "20261007T084712Z-fa11",
				bootstrapTimeoutMs: 2000,
			});
			await assert.rejects(
				() => bootstrapFresh(config, log),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.exitCode === 2 &&
					error.message.includes("email verification") &&
					error.message.includes('workspace "ex-node-fresh"') &&
					error.message.includes(
						"DELETE FROM workspaces WHERE slug = 'ex-node-fresh';",
					) &&
					error.message.includes("could NOT be cleaned up") &&
					!error.message.includes("make up"),
			);
			assert.equal(
				stub.requests.some(
					(request) => pathOf(request) === "/console/api-keys",
				),
				false,
				"a failed verification must not mint a key",
			);
		} finally {
			await stub.close();
			await broker.close();
		}
	});

	it("fresh mode times out when the token never arrives, reporting the orphan without the make-up hint", async () => {
		const broker = await startNatsBroker();
		const stub = await startHttpStub((request, response) => {
			if (pathOf(request) === "/auth/signup") {
				sendJson(response, 201, {
					status: "verification_required",
					workspace: { slug: "ex-node-fresh" },
				});
				return;
			}
			sendJson(response, 404, { error: "unexpected" });
		});
		const dir = makeTempDir("node-app-fresh-timeout-");
		const { log, lines } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: stub.url,
				natsUrl: broker.url,
				runId: "20261007T084712Z-t1me",
				bootstrapTimeoutMs: 150,
			});
			await assert.rejects(
				() => bootstrapFresh(config, log),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.exitCode === 2 &&
					error.message.includes("timed out") &&
					error.message.includes('workspace "ex-node-fresh"') &&
					error.message.includes(
						"DELETE FROM workspaces WHERE slug = 'ex-node-fresh';",
					) &&
					error.message.includes("could NOT be cleaned up") &&
					!error.message.includes("make up"),
			);
			// Unverified account: no console session exists, so no delete can
			// be attempted and the transcript must not claim the stack is down.
			assert.equal(
				stub.requests.some((request) => request.method === "DELETE"),
				false,
			);
			assert.equal(lines.join("\n").includes("make up"), false);
		} finally {
			await stub.close();
			await broker.close();
		}
	});

	it("env-first uses the supplied key and tears down nothing", async () => {
		const dir = makeTempDir("node-app-env-");
		const { log } = collectingTranscript(dir);
		const bootstrap = bootstrapFromEnv(
			stubConfig({
				apiKey: "nervly_sk_test_env",
				workspaceSlug: "env-ws",
			}),
		);
		assert.equal(bootstrap.source, "env");
		assert.equal(bootstrap.workspace.slug, "env-ws");
		assert.equal(await teardownBootstrap(bootstrap, log), true);
	});

	it("teardown reports false when the control plane refuses", async () => {
		const stub = await startHttpStub((_request, response) => {
			sendJson(response, 500, { error: "boom" });
		});
		const dir = makeTempDir("node-app-teardown-fail-");
		const { log } = collectingTranscript(dir);
		try {
			const result: BootstrapResult = {
				source: "fresh",
				apiKey: "nervly_sk_test_x",
				keyId: null,
				keyName: null,
				workspace: { slug: "ex-node", id: "ws-1" },
				email: null,
				console: new ConsoleClient(stub.url),
				csrfToken: "c",
			};
			assert.equal(await teardownBootstrap(result, log), false);
		} finally {
			await stub.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

describe("checks", () => {
	/** The message DTO the app stub serves from `GET /messages` and lookups. */
	function messageDto(
		eventId: string,
		options: { status?: string; testMode?: boolean },
	): Record<string, unknown> {
		return {
			event_id: eventId,
			event_name: "example.node_app.trigger",
			subscriber_id: "sub-example",
			priority: 3,
			status: options.status ?? "DELIVERED",
			channel: "email",
			attempts: 1,
			cost_micro_usd: 0,
			test_mode: options.testMode !== false,
			variables_keys: [],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
	}

	/**
	 * A stub of the node-app server: `runChecks` drives the app over HTTP, so
	 * these tests pin the check logic against the app's contract without a
	 * gateway. The real app is exercised in `tests/node-app-app.test.ts`.
	 */
	async function runAgainstStub(
		options: {
			status?: string;
			testMode?: boolean;
			natsConnected?: boolean;
			timeoutMs?: number;
			healthStatus?: number;
			validationStatus?: number;
			validationType?: string;
			intercept?: (request: StubRequest, response: ServerResponse) => boolean;
		} = {},
	) {
		const state = { eventId: "evt_abcdef0123456789abcdef0123456789" };
		const stub = await startHttpStub((request, response) => {
			if (options.intercept?.(request, response)) return;
			const route = `${request.method} ${pathOf(request)}`;
			if (route === "GET /health") {
				if (options.healthStatus && options.healthStatus !== 200) {
					sendJson(response, options.healthStatus, {
						error: {
							type: "NETWORK_ERROR",
							message: "gateway unreachable",
							status: options.healthStatus,
						},
					});
					return;
				}
				sendJson(response, 200, {
					status: "OK",
					service: "stub-app",
					version: "0",
					environment: "test",
					deployment: "stub",
					key_mode: "test",
					uptime_seconds: 1,
					nats_connected: options.natsConnected !== false,
				});
				return;
			}
			if (route === "POST /events") {
				sendJson(response, 202, {
					eventId: state.eventId,
					status: "QUEUED",
					priority: "NORMAL",
					channel: "email",
					idempotencyKey: jsonBody(request).idempotencyKey ?? null,
				});
				return;
			}
			if (route === "POST /events/bulk") {
				const events = Array.isArray(jsonBody(request).events)
					? (jsonBody(request).events as unknown[])
					: [];
				if (events.length === 0) {
					sendJson(response, options.validationStatus ?? 400, {
						error: {
							type: options.validationType ?? "VALIDATION_ERROR",
							message: "Events array cannot be empty",
							status: 400,
						},
					});
					return;
				}
				sendJson(response, 202, {
					jobId: "job-stub",
					status: "QUEUED",
					count: events.length,
					failedCount: 0,
					events: events.map((_event, index) => ({
						index,
						status: "QUEUED",
						eventId: `evt_bulk_${index}_0123456789abcdef`,
						channel: "email",
					})),
				});
				return;
			}
			if (route.startsWith("PUT /subscribers/")) {
				const subscriberId = decodeURIComponent(
					route
						.replace(/^PUT \/subscribers\//, "")
						.replace(/\/preferences$/, ""),
				);
				sendJson(response, 200, {
					status: "UPDATED",
					subscriberId,
					updated_at: new Date().toISOString(),
				});
				return;
			}
			if (route === `GET /events/evt_${"0".repeat(32)}`) {
				sendJson(response, 404, {
					error: { type: "NOT_FOUND", message: "Event not found", status: 404 },
				});
				return;
			}
			if (route === `GET /events/${state.eventId}`) {
				sendJson(response, 200, messageDto(state.eventId, options));
				return;
			}
			if (route === "GET /messages") {
				sendJson(response, 200, {
					messages: [messageDto(state.eventId, options)],
				});
				return;
			}
			sendJson(response, 404, {
				error: {
					type: "NOT_FOUND",
					message: `no route for ${route}`,
					status: 404,
				},
			});
		});
		const dir = makeTempDir("node-app-checks-");
		const { log } = collectingTranscript(dir);
		try {
			const result = await runChecks({
				appUrl: stub.url,
				runId: "20261007T084712Z-cafe",
				timeoutMs: options.timeoutMs ?? 500,
				log,
			});
			return { result, stub };
		} finally {
			await stub.close();
		}
	}

	it("requires an observed DELIVERED message, then reports every check passing", async () => {
		const { result } = await runAgainstStub();
		assert.deepEqual(
			result.checks.map((check) => [check.name, check.status]),
			[
				["gateway health", "pass"],
				["trigger accepted", "pass"],
				["event lookup", "pass"],
				["bulk trigger", "pass"],
				["preferences updated", "pass"],
				["typed error: validation", "pass"],
				["typed error: not found", "pass"],
				["trigger delivered", "pass"],
				["idempotent replay", "pass"],
			],
		);
		const delivered = result.checks.find(
			(check) => check.name === "trigger delivered",
		);
		assert.match(delivered?.detail ?? "", /status DELIVERED/);
		assert.match(delivered?.detail ?? "", /test_mode=true/);
		const replay = result.checks.find(
			(check) => check.name === "idempotent replay",
		);
		assert.match(replay?.detail ?? "", /1 message observed/);
	});

	it("fails the assertion when the message never reaches DELIVERED", async () => {
		await assert.rejects(
			() =>
				runAgainstStub({
					status: "TRIGGERED",
					timeoutMs: 100,
				}),
			(error: unknown) =>
				error instanceof Error &&
				(error as { kind?: string }).kind === "fail" &&
				(error as { exitCode?: number }).exitCode === 1 &&
				error.message.includes("timed out") &&
				(error as { check?: { detail?: string } }).check?.detail?.includes(
					"TRIGGERED",
				) === true,
		);
	});

	it("fails fast on a terminal failure status", async () => {
		await assert.rejects(
			() => runAgainstStub({ status: "FAILED" }),
			(error: unknown) =>
				error instanceof Error &&
				(error as { exitCode?: number }).exitCode === 1 &&
				error.message.includes("FAILED"),
		);
	});

	it("refuses a message delivered outside test mode", async () => {
		await assert.rejects(
			() => runAgainstStub({ testMode: false }),
			(error: unknown) =>
				error instanceof Error &&
				(error as { exitCode?: number }).exitCode === 1 &&
				error.message.includes("test mode"),
		);
	});

	it("treats a disconnected NATS as an environment failure", async () => {
		await assert.rejects(
			() => runAgainstStub({ natsConnected: false }),
			(error: unknown) =>
				error instanceof Error &&
				(error as { exitCode?: number }).exitCode === 2,
		);
	});

	it("matches evt_-prefixed and bare event ids as the same event", async () => {
		const { result } = await runAgainstStub({
			intercept: (request, response) => {
				if (pathOf(request) !== "/messages") return false;
				// The gateway may return the bare UUID without the evt_ prefix.
				sendJson(response, 200, {
					messages: [
						{
							event_id: "ABCDEF0123456789ABCDEF0123456789",
							event_name: "example.node_app.trigger",
							subscriber_id: "sub-example",
							priority: 3,
							status: "DELIVERED",
							attempts: 1,
							cost_micro_usd: 0,
							test_mode: true,
							variables_keys: [],
							created_at: new Date().toISOString(),
							updated_at: new Date().toISOString(),
						},
					],
				});
				return true;
			},
		});
		assert.equal(
			result.checks.find((check) => check.name === "trigger delivered")?.status,
			"pass",
		);
	});

	it("maps a dead gateway to an environment failure naming make up", async () => {
		await assert.rejects(
			() => runAgainstStub({ healthStatus: 503 }),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("make up"),
		);
	});

	it("treats an unreachable app as an environment failure", async () => {
		const stub = await startHttpStub((_request, response) =>
			sendJson(response, 200, {}),
		);
		const url = stub.url;
		await stub.close();
		const dir = makeTempDir("node-app-checks-app-down-");
		const { log } = collectingTranscript(dir);
		await assert.rejects(
			() => runChecks({ appUrl: url, runId: "r", timeoutMs: 100, log }),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("the app did not answer"),
		);
	});

	it("treats a 5xx typed-error response as an environment failure", async () => {
		await assert.rejects(
			() => runAgainstStub({ validationStatus: 503 }),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("make up"),
		);
	});

	it("fails the validation check when the app returns the wrong error type", async () => {
		await assert.rejects(
			() => runAgainstStub({ validationType: "INTERNAL_ERROR" }),
			(error: unknown) =>
				error instanceof Error &&
				(error as { exitCode?: number }).exitCode === 1 &&
				error.message.includes("VALIDATION_ERROR"),
		);
	});

	it("fails the replay check when the replay returns a different event id", async () => {
		let triggers = 0;
		await assert.rejects(
			() =>
				runAgainstStub({
					intercept: (request, response) => {
						if (request.method !== "POST" || pathOf(request) !== "/events") {
							return false;
						}
						triggers += 1;
						if (triggers !== 2) return false;
						sendJson(response, 202, {
							eventId: "evt_ffffffffffffffffffffffffffffffff",
							status: "QUEUED",
							priority: "NORMAL",
							channel: "email",
						});
						return true;
					},
				}),
			(error: unknown) =>
				error instanceof Error &&
				(error as { exitCode?: number }).exitCode === 1 &&
				error.message.includes("idempotent replay") &&
				error.message.includes("instead of"),
		);
	});

	it("fails the replay check when two messages exist for the replayed event", async () => {
		await assert.rejects(
			() =>
				runAgainstStub({
					intercept: (request, response) => {
						if (pathOf(request) !== "/messages") return false;
						const message = messageDto(
							"evt_abcdef0123456789abcdef0123456789",
							{},
						);
						sendJson(response, 200, { messages: [message, message] });
						return true;
					},
				}),
			(error: unknown) =>
				error instanceof Error &&
				(error as { exitCode?: number }).exitCode === 1 &&
				error.message.includes("idempotent replay produced 2 messages"),
		);
	});

	it("fails the bulk check when the app does not accept both events", async () => {
		await assert.rejects(
			() =>
				runAgainstStub({
					intercept: (request, response) => {
						if (pathOf(request) !== "/events/bulk") return false;
						sendJson(response, 202, {
							jobId: "job-stub",
							status: "QUEUED",
							count: 1,
							failedCount: 1,
							events: [{ index: 0, status: "QUEUED", eventId: "evt_only_one" }],
						});
						return true;
					},
				}),
			(error: unknown) =>
				error instanceof Error &&
				(error as { exitCode?: number }).exitCode === 1 &&
				error.message.includes("bulk trigger"),
		);
	});

	it("fails the preferences check when the app echoes another subscriber", async () => {
		await assert.rejects(
			() =>
				runAgainstStub({
					intercept: (request, response) => {
						if (!pathOf(request).endsWith("/preferences")) return false;
						sendJson(response, 200, {
							status: "UPDATED",
							subscriberId: "someone-else",
							updated_at: new Date().toISOString(),
						});
						return true;
					},
				}),
			(error: unknown) =>
				error instanceof Error &&
				(error as { exitCode?: number }).exitCode === 1 &&
				error.message.includes("preferences"),
		);
	});

	it("fails the event lookup check when the app returns another event", async () => {
		await assert.rejects(
			() =>
				runAgainstStub({
					intercept: (request, response) => {
						if (!pathOf(request).startsWith("/events/")) return false;
						sendJson(response, 200, {
							event_id: "evt_11111111111111111111111111111111",
							status: "QUEUED",
						});
						return true;
					},
				}),
			(error: unknown) =>
				error instanceof Error &&
				(error as { exitCode?: number }).exitCode === 1 &&
				error.message.includes("event lookup"),
		);
	});
});

// ---------------------------------------------------------------------------
// main: guard refusal, --help, and a stubbed end-to-end run
// ---------------------------------------------------------------------------

describe("main runExample", () => {
	it("refuses a non-local API URL with exit 3 before any request", async () => {
		const dir = makeTempDir("node-app-refuse-");
		const stdout: string[] = [];
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
		const summary = JSON.parse(stdout.join("")) as RunSummary;
		assert.equal(summary.status, "refused");
		assert.equal(summary.checks.length, 0);
		assert.equal(
			readFileSync(join(dir, "artifacts", "summary.json"), "utf8").includes(
				"refused",
			),
			true,
		);
	});

	it("refuses a live key with exit 3 and leaves no key-shaped text in artifacts", async () => {
		const dir = makeTempDir("node-app-refuse-key-");
		const exit = await runExample({
			argv: ["--json"],
			env: baseEnv({ NERVLY_API_KEY: "nervly_sk_live_real_key" }),
			cwd: dir,
			stdout: () => {},
		});
		assert.equal(exit, 3);
		for (const name of ["summary.json", "transcript.log"]) {
			assert.equal(
				readFileSync(join(dir, "artifacts", name), "utf8").includes(
					"nervly_sk_test_",
				),
				false,
				`${name} must not contain the test-key prefix`,
			);
		}
	});

	it("--help prints usage and exits 0 without touching the stack", async () => {
		const dir = makeTempDir("node-app-help-");
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
		assert.equal(existsSync(join(dir, "artifacts")), false);
	});

	it("runs the fresh flow green against a fully stubbed stack", async () => {
		const stack = await startStubStack();
		const dir = makeTempDir("node-app-e2e-");
		const stdout: string[] = [];
		try {
			const exit = await runExample({
				argv: ["--json"],
				env: {
					NERVLY_API_URL: stack.gateway.url,
					NERVLY_CONTROL_URL: stack.console.url,
					NERVLY_NATS_URL: stack.broker.url,
					EXAMPLES_BOOTSTRAP: "fresh",
					EXAMPLES_BOOTSTRAP_TIMEOUT_MS: "5000",
					EXAMPLES_CHECK_TIMEOUT_MS: "2000",
				},
				cwd: dir,
				stdout: (line) => stdout.push(line),
			});
			assert.equal(exit, 0);
			const summary = JSON.parse(stdout.join("")) as RunSummary;
			assert.equal(summary.status, "pass");
			assert.equal(summary.example, "node-app");
			assert.equal(summary.harnessVersion, "1");
			assert.deepEqual(summary.workspace, {
				slug: "ex-node-e2e",
				id: "ws-e2e",
			});
			assert.deepEqual(
				summary.checks.map((check) => check.name),
				[
					"gateway health",
					"trigger accepted",
					"event lookup",
					"bulk trigger",
					"preferences updated",
					"typed error: validation",
					"typed error: not found",
					"trigger delivered",
					"idempotent replay",
				],
			);
			assert.equal(
				summary.checks.every((check) => check.status === "pass"),
				true,
			);
			assert.deepEqual(summary.artifacts, ["transcript.log", "bootstrap.json"]);

			// Artifact invariants: no key material anywhere, and 0600 bootstrap.
			const artifactsDir = join(dir, "artifacts");
			for (const name of readdirSync(artifactsDir)) {
				const text = readFileSync(join(artifactsDir, name), "utf8");
				assert.equal(
					text.includes("nervly_sk_test_"),
					false,
					`${name} must not contain a key`,
				);
			}
			if (process.platform !== "win32") {
				const mode =
					statSync(join(artifactsDir, "bootstrap.json")).mode & 0o777;
				assert.equal(mode, 0o600);
			}

			// Teardown closed the workspace with the signup owner's session.
			const deletes = stack.console.requests.filter(
				(request) =>
					request.method === "DELETE" &&
					pathOf(request) === "/console/workspace",
			);
			assert.equal(deletes.length, 1);
			assert.equal(jsonBody(deletes[0] as StubRequest).confirm, "ex-node-e2e");
			assert.match(
				String(deletes[0]?.headers.cookie ?? ""),
				/nervly_session=sess-e2e/,
			);
			assert.equal(deletes[0]?.headers["x-csrf-token"], "csrf-e2e");
		} finally {
			await stack.close();
		}
	});

	it("emits the orphan slug and SQL fallback, not make up, when fresh capture times out", async () => {
		const stack = await startStubStack({ verificationToken: false });
		const dir = makeTempDir("node-app-e2e-orphan-");
		const stdout: string[] = [];
		try {
			const exit = await runExample({
				argv: ["--json"],
				env: {
					NERVLY_API_URL: stack.gateway.url,
					NERVLY_CONTROL_URL: stack.console.url,
					NERVLY_NATS_URL: stack.broker.url,
					EXAMPLES_BOOTSTRAP: "fresh",
					EXAMPLES_BOOTSTRAP_TIMEOUT_MS: "300",
					EXAMPLES_CHECK_TIMEOUT_MS: "2000",
				},
				cwd: dir,
				stdout: (line) => stdout.push(line),
			});
			assert.equal(exit, 2);
			const summary = JSON.parse(stdout.join("")) as RunSummary;
			assert.equal(summary.status, "error");
			const transcript = readFileSync(
				join(dir, "artifacts", "transcript.log"),
				"utf8",
			);
			assert.match(transcript, /workspace "ex-node-e2e" \(id ws-e2e\)/);
			assert.match(
				transcript,
				/DELETE FROM workspaces WHERE slug = 'ex-node-e2e';/,
			);
			assert.equal(
				transcript.includes("make up"),
				false,
				"a reachable stack that never delivered the mail must not name make up",
			);
			// Unverified signup: no console session exists, so no delete can
			// be attempted; the SQL fallback is the documented remedy.
			assert.equal(
				stack.console.requests.some((request) => request.method === "DELETE"),
				false,
			);
		} finally {
			await stack.close();
		}
	});

	it("exits 1 and writes a failing summary when delivery is never observed", async () => {
		const stack = await startStubStack({ delivered: false });
		const dir = makeTempDir("node-app-e2e-fail-");
		const stdout: string[] = [];
		try {
			const exit = await runExample({
				argv: ["--json"],
				env: {
					NERVLY_API_URL: stack.gateway.url,
					NERVLY_CONTROL_URL: stack.console.url,
					NERVLY_NATS_URL: stack.broker.url,
					EXAMPLES_BOOTSTRAP: "fresh",
					EXAMPLES_BOOTSTRAP_TIMEOUT_MS: "5000",
					EXAMPLES_CHECK_TIMEOUT_MS: "150",
				},
				cwd: dir,
				stdout: (line) => stdout.push(line),
			});
			assert.equal(exit, 1);
			const summary = JSON.parse(stdout.join("")) as RunSummary;
			assert.equal(summary.status, "fail");
			const delivered = summary.checks.find(
				(check) => check.name === "trigger delivered",
			);
			assert.equal(delivered?.status, "fail");
			assert.match(delivered?.detail ?? "", /TRIGGERED/);
			// Cleanup still ran on the failing path.
			assert.equal(
				stack.console.requests.some((request) => request.method === "DELETE"),
				true,
			);
		} finally {
			await stack.close();
		}
	});

	it("fails with exit 2 naming make up when the stack is down", async () => {
		const dir = makeTempDir("node-app-e2e-down-");
		const stdout: string[] = [];
		const exit = await runExample({
			argv: ["--json"],
			env: baseEnv({
				// A port nothing listens on, on a local host (so the guard passes).
				NERVLY_CONTROL_URL: "http://127.0.0.1:1",
				EXAMPLES_BOOTSTRAP_TIMEOUT_MS: "1000",
			}),
			cwd: dir,
			stdout: (line) => stdout.push(line),
		});
		assert.equal(exit, 2);
		const summary = JSON.parse(stdout.join("")) as RunSummary;
		assert.equal(summary.status, "error");
		assert.equal(
			readFileSync(join(dir, "artifacts", "transcript.log"), "utf8").includes(
				"make up",
			),
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// Entrypoint wiring (child processes)
// ---------------------------------------------------------------------------

describe("entrypoint", () => {
	it("exits 3 from the real main.ts with a non-local URL, before any work", () => {
		const dir = makeTempDir("node-app-child-");
		const result = spawnSync(
			join(ROOT, "node_modules", ".bin", "tsx"),
			[join(ROOT, "examples/node-app/main.ts"), "--json"],
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
	});

	it("exits 3 from the real main.ts with a live key", () => {
		const dir = makeTempDir("node-app-child-key-");
		const result = spawnSync(
			join(ROOT, "node_modules", ".bin", "tsx"),
			[join(ROOT, "examples/node-app/main.ts"), "--json"],
			{
				cwd: dir,
				encoding: "utf8",
				timeout: 15_000,
				env: {
					...process.env,
					NERVLY_API_KEY: syntheticApiKey("live", "not", "allowed"),
				},
			},
		);
		assert.equal(result.status, 3, result.stderr);
	});

	it("dispatcher resolves node-app, rejects unknown names, and honours --help", () => {
		const dispatcher = join(ROOT, "scripts", "example.mjs");
		const help = spawnSync(process.execPath, [dispatcher, "--help"], {
			encoding: "utf8",
		});
		assert.equal(help.status, 0);
		assert.match(help.stdout, /npm run example/);

		const unknown = spawnSync(
			process.execPath,
			[dispatcher, "not-an-example"],
			{
				encoding: "utf8",
			},
		);
		assert.equal(unknown.status, 2);
		assert.match(unknown.stderr, /unknown example/);

		const wired = spawnSync(
			process.execPath,
			[dispatcher, "node-app", "--help"],
			{
				encoding: "utf8",
				timeout: 20_000,
			},
		);
		assert.equal(wired.status, 0, wired.stderr);
		assert.match(wired.stdout, /Usage:/);
	});
});
