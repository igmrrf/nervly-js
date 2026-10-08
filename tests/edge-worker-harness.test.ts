/**
 * Harness-contract tests for the edge-worker example.
 *
 * These tests pin the invariants the contract promises — guard refusals and
 * their exit codes, redaction, `.dev.vars` hygiene, the summary schema, the
 * seed bootstrap/teardown, the bounded wrangler process lifecycle, and the
 * `runExample` orchestration (with the wrangler and platform boundaries
 * stubbed). Live coverage is the documented `npm run example -- edge-worker`
 * run against the local stack; this suite is deterministic and never skips.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import {
	createServer as createHttpServer,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	bootstrapFromEnv,
	bootstrapSeed,
	teardownBootstrap,
} from "../examples/edge-worker/harness/bootstrap.js";
import {
	DEFAULTS,
	type ExampleConfig,
	loadConfig,
} from "../examples/edge-worker/harness/config.js";
import {
	formatDevVars,
	removeDevVars,
	writeDevVars,
} from "../examples/edge-worker/harness/dev-vars.js";
import {
	EnvironmentFailure,
	GuardRefusal,
} from "../examples/edge-worker/harness/errors.js";
import {
	assertSupportedBootstrapMode,
	guardConfig,
	isLocalHost,
	isProductionHost,
} from "../examples/edge-worker/harness/guards.js";
import { redact, redactValue } from "../examples/edge-worker/harness/redact.js";
import {
	isValidRunId,
	newRunId,
} from "../examples/edge-worker/harness/run-id.js";
import {
	assertSdkDist,
	sdkDistState,
} from "../examples/edge-worker/harness/sdk-dist.js";
import {
	buildSummary,
	type RunSummary,
	writeSummary,
} from "../examples/edge-worker/harness/summary.js";
import { Transcript } from "../examples/edge-worker/harness/transcript.js";
import {
	buildWranglerArgs,
	EXAMPLE_DIR,
	findFreePort,
	startWrangler,
} from "../examples/edge-worker/harness/wrangler.js";
import { runExample } from "../examples/edge-worker/main.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
// Temp dirs
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	// The orchestration tests exercise the real `.dev.vars` location; make sure
	// a failed assertion can never leave it behind.
	rmSync(join(EXAMPLE_DIR, ".dev.vars"), { force: true });
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Stub control plane
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

/**
 * A seeded control plane: login as the dev seed user, mint one test key,
 * revoke it. Tracks keys so tests can assert the key never leaks.
 */
async function startStubControl(options: { mintedKey?: string } = {}) {
	const mintedKey = options.mintedKey ?? syntheticApiKey("test", "stub_secret");
	const state: { revoked: string[]; createdNames: string[] } = {
		revoked: [],
		createdNames: [],
	};
	const stub = await startHttpStub((request, response) => {
		const route = `${request.method} ${pathOf(request)}`;
		switch (route) {
			case "POST /auth/login":
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
			case "POST /console/api-keys": {
				if (request.headers["x-csrf-token"] !== "csrf-seed") {
					sendJson(response, 403, { error: "forbidden" });
					return;
				}
				const name = String(jsonBody(request).name);
				state.createdNames.push(name);
				sendJson(response, 201, {
					id: "key-seed",
					name,
					mode: "test",
					scopes: ["read", "write"],
					token: mintedKey,
				});
				return;
			}
			default:
				if (route === "DELETE /console/api-keys/key-seed") {
					if (request.headers["x-csrf-token"] !== "csrf-seed") {
						sendJson(response, 403, { error: "forbidden" });
						return;
					}
					state.revoked.push("key-seed");
					sendJson(response, 200, { status: "revoked" });
					return;
				}
				sendJson(response, 404, { error: "unexpected", route });
		}
	});
	return { stub, state, mintedKey };
}

/**
 * A stub of the edge worker's HTTP surface (health / trigger / lookup /
 * messages) with a configurable final message status.
 */
async function startStubWorker(options: { delivered?: boolean } = {}) {
	const eventId = "evt_0123456789abcdef0123456789abcdef";
	const stub = await startHttpStub((request, response) => {
		const route = `${request.method} ${pathOf(request)}`;
		if (route === "GET /health") {
			sendJson(response, 200, {
				status: "OK",
				service: "stub-gateway",
				nats_connected: true,
			});
			return;
		}
		if (route === "POST /events") {
			sendJson(response, 202, {
				eventId,
				status: "QUEUED",
				priority: "NORMAL",
				channel: "email",
				idempotencyKey: request.headers["idempotency-key"] ?? null,
			});
			return;
		}
		if (route === `GET /events/${eventId}`) {
			sendJson(response, 200, {
				event_id: eventId,
				status: options.delivered === false ? "TRIGGERED" : "DELIVERED",
				test_mode: true,
				channel: "email",
			});
			return;
		}
		if (route === "GET /messages") {
			const delivered = options.delivered !== false;
			sendJson(response, 200, {
				messages: [
					{
						event_id: eventId,
						status: delivered ? "DELIVERED" : "TRIGGERED",
						test_mode: true,
						channel: "email",
						attempts: 1,
					},
				],
			});
			return;
		}
		sendJson(response, 404, { error: { type: "NOT_FOUND" } });
	});
	return { stub, eventId };
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

function readSummary(cwd: string): RunSummary {
	return JSON.parse(
		readFileSync(join(cwd, "artifacts", "edge-worker", "summary.json"), "utf8"),
	) as RunSummary;
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
		const text = "edge-worker finished: PASS (run 20261007T084712Z-ab12)";
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

	it("rejects ids that are unsafe inside slugs, key names and headers", () => {
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
				NERVLY_RUN_ID: "20261007T084712Z-cafe",
				NERVLY_API_KEY: "nervly_sk_test_x",
				NERVLY_WORKSPACE_SLUG: "ex-edge",
				EXAMPLES_BOOTSTRAP: "fresh",
				EXAMPLES_KEEP: "1",
				EXAMPLES_BOOTSTRAP_TIMEOUT_MS: "1000",
				EXAMPLES_CHECK_TIMEOUT_MS: "2000",
			}),
		);
		assert.equal(config.gatewayUrl, "http://127.0.0.1:9090");
		assert.equal(config.apiUrl, "http://localhost:8080");
		assert.equal(config.runId, "20261007T084712Z-cafe");
		assert.equal(config.workspaceSlug, "ex-edge");
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

	it("refuses fresh bootstrap when it would actually run, but not env-first", () => {
		assert.throws(
			() =>
				assertSupportedBootstrapMode(stubConfig({ bootstrapMode: "fresh" })),
			(error: unknown) =>
				error instanceof GuardRefusal &&
				error.exitCode === 3 &&
				error.message.includes("seed"),
		);
		assert.doesNotThrow(() =>
			assertSupportedBootstrapMode(stubConfig({ bootstrapMode: "seed" })),
		);
		// Env-first ignores EXAMPLES_BOOTSTRAP entirely: a key means no bootstrap.
		assert.doesNotThrow(() =>
			assertSupportedBootstrapMode(
				stubConfig({ bootstrapMode: "fresh", apiKey: "nervly_sk_test_x" }),
			),
		);
	});
});

// ---------------------------------------------------------------------------
// Summary + transcript
// ---------------------------------------------------------------------------

describe("summary", () => {
	it("builds exactly the contract fields, redacting check details", () => {
		const summary = buildSummary({
			example: "edge-worker",
			target: "local",
			runId: "20261007T084712Z-ab12",
			startedAt: new Date("2026-10-07T08:47:12.000Z"),
			durationMs: 41230.7,
			status: "pass",
			workspace: { slug: "dev-local", id: "ws-1" },
			checks: [
				{
					name: "trigger delivered",
					status: "pass",
					detail: `event evt_1 DELIVERED with nervly_sk_test_secret`,
				},
			],
			artifacts: ["transcript.log", "bootstrap.json", "wrangler.log"],
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

	it("clamps a negative duration, keeps null workspace fields, round-trips", () => {
		const dir = makeTempDir("edge-summary-");
		const summary = buildSummary({
			example: "edge-worker",
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
		const path = writeSummary(join(dir, "artifacts"), summary);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), summary);
	});
});

describe("transcript", () => {
	it("writes redacted lines to stdout and transcript.log", () => {
		const dir = makeTempDir("edge-transcript-");
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
		const dir = makeTempDir("edge-transcript-json-");
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
});

// ---------------------------------------------------------------------------
// .dev.vars hygiene
// ---------------------------------------------------------------------------

describe(".dev.vars", () => {
	it("formats, writes 0600 and removes the run's secret file", () => {
		const dir = makeTempDir("edge-dev-vars-");
		const path = join(dir, ".dev.vars");
		const key = syntheticApiKey("test", "devvars", "secret");
		const text = formatDevVars({
			NERVLY_API_KEY: key,
			NERVLY_API_URL: "http://localhost:8080",
		});
		assert.equal(
			text,
			`NERVLY_API_KEY=${key}\nNERVLY_API_URL=http://localhost:8080\n`,
		);

		writeDevVars(path, { NERVLY_API_KEY: key });
		assert.equal(readFileSync(path, "utf8"), `NERVLY_API_KEY=${key}\n`);
		assert.equal(statSync(path).mode & 0o777, 0o600);

		assert.equal(removeDevVars(path), true);
		assert.equal(existsSync(path), false);
		assert.equal(removeDevVars(path), true, "removal must be idempotent");
	});

	it("refuses values that could smuggle extra variables", () => {
		assert.throws(() => formatDevVars({ KEY: "a\nB=evil" }), /multi-line/);
		assert.throws(() => formatDevVars({ "bad name": "x" }), /malformed/);
	});

	it("is git-ignored together with the wrangler state dir", () => {
		for (const path of [
			"examples/edge-worker/.dev.vars",
			"examples/edge-worker/.wrangler/tmp/x.js",
		]) {
			const result = spawnSync("git", ["check-ignore", "-q", path], {
				cwd: ROOT,
			});
			assert.equal(result.status, 0, `${path} must be git-ignored`);
		}
	});
});

// ---------------------------------------------------------------------------
// SDK dist check
// ---------------------------------------------------------------------------

describe("SDK dist", () => {
	function makeSdkRoot(): { root: string; entry: string; srcFile: string } {
		const root = makeTempDir("edge-sdk-dist-");
		const entry = join(root, "dist", "esm", "index.js");
		const srcFile = join(root, "src", "index.ts");
		mkdirSync(dirname(entry), { recursive: true });
		mkdirSync(dirname(srcFile), { recursive: true });
		return { root, entry, srcFile };
	}

	it("refuses a missing built entry with the build remedy (exit 2)", () => {
		const { root, srcFile } = makeSdkRoot();
		writeFileSync(srcFile, "export {};\n");
		assert.deepEqual(sdkDistState(root), {
			entry: join(root, "dist", "esm", "index.js"),
			exists: false,
			stale: true,
		});
		assert.throws(
			() => assertSdkDist(root),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("npm run build"),
		);
	});

	it("refuses a built entry older than src, so a stale bundle is loud", () => {
		const { root, entry, srcFile } = makeSdkRoot();
		const now = Date.now();
		writeFileSync(entry, "export {};\n");
		writeFileSync(srcFile, "export {};\n");
		utimesSync(entry, new Date(now - 10_000), new Date(now - 10_000));
		utimesSync(srcFile, new Date(now), new Date(now));
		assert.equal(sdkDistState(root).stale, true);
		assert.throws(
			() => assertSdkDist(root),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("stale"),
		);
	});

	it("accepts a fresh built entry and the repo's real dist", () => {
		const { root, entry, srcFile } = makeSdkRoot();
		const now = Date.now();
		writeFileSync(srcFile, "export {};\n");
		writeFileSync(entry, "export {};\n");
		utimesSync(srcFile, new Date(now - 10_000), new Date(now - 10_000));
		utimesSync(entry, new Date(now), new Date(now));
		assert.doesNotThrow(() => assertSdkDist(root));
		assert.doesNotThrow(() => assertSdkDist(ROOT));
	});
});

// ---------------------------------------------------------------------------
// wrangler process management
// ---------------------------------------------------------------------------

describe("wrangler", () => {
	it("builds a local dev command with no secret on the command line", () => {
		const args = buildWranglerArgs({
			configPath: "/repo/examples/edge-worker/wrangler.jsonc",
			port: 51_234,
			inspectorPort: 51_235,
			persistDir: "/repo/artifacts/edge-worker/wrangler-state",
		});
		assert.deepEqual(args, [
			"dev",
			"--config",
			"/repo/examples/edge-worker/wrangler.jsonc",
			"--ip",
			"127.0.0.1",
			"--port",
			"51234",
			"--inspector-port",
			"51235",
			"--persist-to",
			"/repo/artifacts/edge-worker/wrangler-state",
			"--show-interactive-dev-session=false",
			"--log-level",
			"info",
		]);
		for (const arg of args) {
			assert.equal(arg.includes("nervly_sk_"), false);
		}
	});

	it("allocates a port that can be bound immediately", async () => {
		const port = await findFreePort();
		assert.ok(Number.isInteger(port) && port > 0 && port < 65_536);
		// Binding the harness's port proves findFreePort released it.
		const probe = createHttpServer();
		await new Promise<void>((ready, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", ready);
		});
		await new Promise<void>((done) => probe.close(() => done()));
	});

	it("starts a server, redacts its log, and stops the process group", async () => {
		const dir = makeTempDir("edge-wrangler-start-");
		const port = await findFreePort();
		const fakeKey = syntheticApiKey("test", "wrangler", "log", "leak");
		const script = `
			const http = require("node:http");
			const port = Number(process.argv[1]);
			const key = process.argv[2];
			const server = http.createServer((req, res) => {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { type: "NOT_FOUND" } }) + "\\n");
			});
			server.listen(port, "127.0.0.1", () => {
				process.stdout.write("local server ready with key=" + key + "\\n");
			});
		`;
		const started = await startWrangler({
			cwd: dir,
			configPath: join(dir, "wrangler.jsonc"),
			port,
			inspectorPort: port,
			persistDir: join(dir, "state"),
			logPath: join(dir, "wrangler.log"),
			readyTimeoutMs: 10_000,
			command: process.execPath,
			args: ["-e", script, String(port), fakeKey],
		});
		assert.equal(started.url, `http://127.0.0.1:${port}`);
		const response = await fetch(`${started.url}/`);
		assert.equal(response.status, 404);
		await started.stop();

		const log = readFileSync(join(dir, "wrangler.log"), "utf8");
		assert.match(log, /local server ready/);
		assert.equal(log.includes(fakeKey), false);
		assert.match(log, /\[REDACTED_API_KEY\]/);
		await assert.rejects(() => fetch(`${started.url}/`));
	});

	it("fails a bounded wait when the server never answers", async () => {
		const dir = makeTempDir("edge-wrangler-timeout-");
		const port = await findFreePort();
		await assert.rejects(
			() =>
				startWrangler({
					cwd: dir,
					configPath: join(dir, "wrangler.jsonc"),
					port,
					inspectorPort: port,
					persistDir: join(dir, "state"),
					logPath: join(dir, "wrangler.log"),
					readyTimeoutMs: 250,
					readyPollMs: 50,
					command: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000);"],
				}),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("did not become ready"),
		);
	});
});

// ---------------------------------------------------------------------------
// Bootstrap and teardown
// ---------------------------------------------------------------------------

describe("bootstrap", () => {
	it("seed mode mints one uniquely named key and revokes it on teardown", async () => {
		const { stub, state, mintedKey } = await startStubControl();
		const dir = makeTempDir("edge-seed-");
		const { log, lines } = collectingTranscript(dir);
		try {
			const config = stubConfig({
				controlUrl: stub.url,
				runId: "20261007T084712Z-cafe",
			});
			const bootstrap = await bootstrapSeed(config, log);
			assert.equal(bootstrap.source, "seed");
			assert.equal(bootstrap.apiKey, mintedKey);
			assert.equal(bootstrap.keyId, "key-seed");
			assert.deepEqual(bootstrap.workspace, {
				slug: "dev-local",
				id: "ws-seed",
			});
			assert.deepEqual(state.createdNames, ["examples-20261007T084712Z-cafe"]);

			const keyRequest = stub.requests.find(
				(request) => pathOf(request) === "/console/api-keys",
			);
			assert.ok(keyRequest);
			assert.deepEqual(jsonBody(keyRequest), {
				name: "examples-20261007T084712Z-cafe",
				mode: "test",
				scopes: ["read", "write"],
			});
			assert.equal(keyRequest.headers["x-csrf-token"], "csrf-seed");
			assert.equal(
				lines.join("\n").includes(mintedKey),
				false,
				"the minted key must never reach the transcript",
			);

			assert.equal(await teardownBootstrap(bootstrap, log), true);
			assert.deepEqual(state.revoked, ["key-seed"]);
		} finally {
			await stub.close();
		}
	});

	it("reports a login failure as an environment failure naming make up", async () => {
		const stub = await startHttpStub((_request, response) => {
			sendJson(response, 500, { error: "login backend down" });
		});
		const dir = makeTempDir("edge-seed-fail-");
		const { log } = collectingTranscript(dir);
		try {
			await assert.rejects(
				() => bootstrapSeed(stubConfig({ controlUrl: stub.url }), log),
				(error: unknown) =>
					error instanceof EnvironmentFailure && error.exitCode === 2,
			);
		} finally {
			await stub.close();
		}
	});

	it("env-first uses the supplied key and tears down nothing", async () => {
		const dir = makeTempDir("edge-env-");
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
});

// ---------------------------------------------------------------------------
// runExample: refusals and orchestration
// ---------------------------------------------------------------------------

describe("runExample refusals", () => {
	it("refuses unsafe configurations with exit 3 before any network work", async () => {
		const liveKey = syntheticApiKey("live", "never", "used");
		const cases: NodeJS.ProcessEnv[] = [
			baseEnv({ NERVLY_API_URL: "https://api.nervly.io" }),
			baseEnv({ NERVLY_API_KEY: liveKey }),
			baseEnv({ NERVLY_TARGET: "sandbox" }),
			baseEnv({ NERVLY_RUN_ID: "bad run id" }),
			baseEnv({ EXAMPLES_BOOTSTRAP: "fresh" }),
			baseEnv({ EXAMPLES_BOOTSTRAP: "yolo" }),
		];
		for (const env of cases) {
			const cwd = makeTempDir("edge-refusal-");
			const code = await runExample({
				argv: [],
				env,
				cwd,
				stdout: () => {},
				now: () => new Date("2026-10-07T08:47:12Z"),
				bootstrapDeps: {
					fetchFn: () => {
						throw new Error("network must not be touched by a refusal");
					},
				},
			});
			assert.equal(code, 3, `expected refusal for ${JSON.stringify(env)}`);
			const summary = readSummary(cwd);
			assert.equal(summary.status, "refused");
			assert.equal(summary.example, "edge-worker");
			assert.equal(summary.target, env.NERVLY_TARGET ?? "local");
			const transcript = readFileSync(
				join(cwd, "artifacts", "edge-worker", "transcript.log"),
				"utf8",
			);
			assert.equal(transcript.includes("nervly_sk_live_"), false);
			assert.equal(transcript.includes("never_used"), false);
		}
	});
});

describe("runExample orchestration", () => {
	it("seed -> .dev.vars -> worker checks -> DELIVERED -> revoke -> PASS", async () => {
		const { stub: control, state, mintedKey } = await startStubControl();
		const worker = await startStubWorker();
		const cwd = makeTempDir("edge-run-pass-");
		const devVarsPath = join(EXAMPLE_DIR, ".dev.vars");
		const stops: string[] = [];
		let observedDevVars: string | null = null;
		try {
			const code = await runExample({
				argv: [],
				env: baseEnv({
					NERVLY_CONTROL_URL: control.url,
					NERVLY_RUN_ID: "20261007T084712Z-pass",
				}),
				cwd,
				stdout: () => {},
				now: () => new Date("2026-10-07T08:47:12Z"),
				startWranglerFn: async (options) => {
					observedDevVars = readFileSync(
						join(options.cwd, ".dev.vars"),
						"utf8",
					);
					// The real manager writes the redacted wrangler log artifact.
					writeFileSync(options.logPath, "fake wrangler output\n", "utf8");
					return {
						url: worker.stub.url,
						port: options.port,
						stop: async () => {
							stops.push("stopped");
						},
					};
				},
			});
			assert.equal(code, 0);
			// The cast drops closure-unaware narrowing: `observedDevVars` is only
			// set from the injected startWranglerFn above.
			const devVarsText = observedDevVars as string | null;
			assert.ok(devVarsText?.includes(mintedKey));
			assert.match(devVarsText ?? "", /NERVLY_API_URL=http:\/\/localhost:8080/);
			assert.deepEqual(stops, ["stopped"], "wrangler must always be stopped");
			assert.equal(existsSync(devVarsPath), false, ".dev.vars must be removed");
			assert.deepEqual(state.revoked, ["key-seed"], "the key must be revoked");

			const summary = readSummary(cwd);
			assert.equal(summary.status, "pass");
			assert.equal(summary.example, "edge-worker");
			assert.equal(summary.harnessVersion, "1");
			assert.equal(summary.workspace.slug, "dev-local");
			assert.deepEqual(summary.artifacts, [
				"transcript.log",
				"bootstrap.json",
				"wrangler.log",
			]);
			const delivered = summary.checks.find(
				(check) => check.name === "trigger delivered",
			);
			assert.equal(delivered?.status, "pass");
			assert.match(delivered?.detail ?? "", /DELIVERED/);

			const transcript = readFileSync(
				join(cwd, "artifacts", "edge-worker", "transcript.log"),
				"utf8",
			);
			assert.equal(transcript.includes(mintedKey), false);
			assert.match(transcript, /asserted end state/);
			const summaryText = readFileSync(
				join(cwd, "artifacts", "edge-worker", "summary.json"),
				"utf8",
			);
			assert.equal(summaryText.includes(mintedKey), false);
		} finally {
			rmSync(devVarsPath, { force: true });
			await control.close();
			await worker.stub.close();
		}
	});

	it("fails with exit 1 when the message never reads back DELIVERED", async () => {
		const { stub: control, state } = await startStubControl();
		const worker = await startStubWorker({ delivered: false });
		const cwd = makeTempDir("edge-run-fail-");
		try {
			const code = await runExample({
				argv: [],
				env: baseEnv({
					NERVLY_CONTROL_URL: control.url,
					EXAMPLES_CHECK_TIMEOUT_MS: "150",
				}),
				cwd,
				stdout: () => {},
				now: () => new Date("2026-10-07T08:47:12Z"),
				startWranglerFn: async (options) => ({
					url: worker.stub.url,
					port: options.port,
					stop: async () => {},
				}),
			});
			assert.equal(code, 1);
			const summary = readSummary(cwd);
			assert.equal(summary.status, "fail");
			const failed = summary.checks.find(
				(check) => check.name === "trigger delivered",
			);
			assert.equal(failed?.status, "fail");
			assert.deepEqual(state.revoked, ["key-seed"], "teardown still revokes");
		} finally {
			await control.close();
			await worker.stub.close();
		}
	});

	it("EXAMPLES_KEEP=1 keeps the key but still removes .dev.vars", async () => {
		const { stub: control, state } = await startStubControl();
		const worker = await startStubWorker();
		const cwd = makeTempDir("edge-run-keep-");
		const devVarsPath = join(EXAMPLE_DIR, ".dev.vars");
		try {
			const code = await runExample({
				argv: [],
				env: baseEnv({
					NERVLY_CONTROL_URL: control.url,
					EXAMPLES_KEEP: "1",
				}),
				cwd,
				stdout: () => {},
				now: () => new Date("2026-10-07T08:47:12Z"),
				startWranglerFn: async (options) => ({
					url: worker.stub.url,
					port: options.port,
					stop: async () => {},
				}),
			});
			assert.equal(code, 0);
			assert.deepEqual(state.revoked, [], "KEEP must skip revoking the key");
			assert.equal(existsSync(devVarsPath), false);
		} finally {
			rmSync(devVarsPath, { force: true });
			await control.close();
			await worker.stub.close();
		}
	});
});
