/**
 * Wire-level pin for `examples/basic-usage.ts` — the runnable example the §1.8
 * SDK docs point developers at (matrix row `1.8-sdk-examples-run-as-documented`).
 *
 * `check:types` only proves the example compiles. This suite boots a real
 * `node:http` server, points the example's own {@link runBasicUsage} operations
 * at it, and inspects the bytes the SDK actually sent. It is deliberately
 * deterministic and never skips, so a regression the type-checker cannot see —
 * `callTool` reverting to `params: null`, or the `verifySignature` `await`
 * being dropped — fails in the normal `npm test` run rather than only against
 * a booted gateway. The live leg in `tests/live-contract.test.ts` re-proves the
 * same call against the real gateway when its env is present.
 *
 * The example is imported for its exported operations, not executed on import:
 * its auto-run is guarded so importing it neither fires requests nor exits.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { after, describe, it } from "node:test";
import {
	GATEWAY_STATUS_TOOL_CALL,
	runBasicUsage,
} from "../examples/basic-usage.js";
import { Nervly } from "../src/index.js";

interface CapturedRequest {
	method: string;
	url: string;
	body: string;
}

interface Stub {
	url: string;
	requests: CapturedRequest[];
	close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => resolve(raw));
	});
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(payload));
}

/**
 * A minimal stand-in for the gateway: it answers every endpoint the example
 * touches with the shape the SDK expects, and records each request so the test
 * can assert on the wire body. `failToolsCall` swaps the MCP `tools/call`
 * answer for a JSON-RPC error inside an HTTP 200 (the gateway's real
 * failure mode).
 */
async function startStub(
	options: { failToolsCall?: boolean } = {},
): Promise<Stub> {
	const requests: CapturedRequest[] = [];

	const server = createServer((req, res) => {
		void readBody(req).then((body) => {
			const method = req.method ?? "";
			const url = req.url ?? "";
			const path = url.split("?")[0] ?? url;
			requests.push({ method, url, body });

			if (method === "GET" && path === "/v1/health") {
				return sendJson(res, 200, {
					status: "ok",
					service: "nervly-gateway",
					version: "0.1.0",
					environment: "test",
					uptime_seconds: 1,
					nats_connected: true,
				});
			}

			if (method === "POST" && path === "/v1/events/trigger") {
				return sendJson(res, 202, {
					eventId: "evt_stub_1",
					status: "QUEUED",
					priority: "CRITICAL",
					channel: "email",
					timestamp: "2026-09-23T00:00:00Z",
				});
			}

			if (method === "POST" && path === "/v1/events/bulk") {
				return sendJson(res, 202, {
					jobId: "job_stub_1",
					status: "QUEUED",
					count: 2,
					failedCount: 0,
					events: [],
				});
			}

			if (method === "PUT" && path.endsWith("/preferences")) {
				return sendJson(res, 200, {
					status: "updated",
					subscriberId: "usr_9983j2",
					updated_at: "2026-09-23T00:00:00Z",
				});
			}

			if (method === "POST" && path === "/v1/mcp") {
				const rpc = JSON.parse(body) as { method?: string };
				if (rpc.method === "tools/list") {
					return sendJson(res, 200, {
						jsonrpc: "2.0",
						id: 1,
						result: {
							tools: [
								{
									name: "gateway_status",
									description: "Inspect gateway status",
									inputSchema: { type: "object", properties: {} },
								},
							],
						},
					});
				}
				if (rpc.method === "tools/call") {
					if (options.failToolsCall) {
						return sendJson(res, 200, {
							jsonrpc: "2.0",
							id: 1,
							error: { code: -32602, message: "Invalid tools/call parameters" },
						});
					}
					return sendJson(res, 200, {
						jsonrpc: "2.0",
						id: 1,
						result: { service: "nervly-gateway", status: "ok" },
					});
				}
			}

			sendJson(res, 404, { error: "unexpected request", path });
		});
	});

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

function stubClient(stub: Stub): Nervly {
	return new Nervly({
		apiKey: "nv_test_example_wire",
		baseUrl: stub.url,
		timeout: 5000,
		maxRetries: 0,
	});
}

/**
 * The example is chatty by design. Under `node --test` the child process's
 * stdout is the test runner's serialized event channel, so the example's logs
 * are swallowed here rather than risk corrupting it; the assertions read the
 * captured wire bytes, not the console.
 */
async function withSilencedConsole<T>(run: () => Promise<T>): Promise<T> {
	const original = console.log;
	console.log = () => {};
	try {
		return await run();
	} finally {
		console.log = original;
	}
}

describe("examples/basic-usage.ts — wire pin", () => {
	const stubs: Stub[] = [];

	after(async () => {
		await Promise.all(stubs.map((stub) => stub.close()));
	});

	it("sends the gateway_status tools/call params on the wire and a real boolean signature result", async () => {
		const stub = await startStub();
		stubs.push(stub);

		const result = await withSilencedConsole(() =>
			runBasicUsage(stubClient(stub)),
		);

		const toolsCall = stub.requests.find(
			(request) =>
				request.method === "POST" &&
				request.url === "/v1/mcp" &&
				(JSON.parse(request.body) as { method?: string }).method ===
					"tools/call",
		);
		assert.ok(
			toolsCall,
			"the example must POST a tools/call request to /v1/mcp",
		);

		const rpc = JSON.parse(toolsCall.body) as {
			method: string;
			params: unknown;
		};
		assert.notEqual(
			rpc.params,
			null,
			"callTool must not send params:null — the gateway rejects it with -32602",
		);
		assert.deepEqual(
			rpc.params,
			GATEWAY_STATUS_TOOL_CALL,
			"the tools/call params must be the example's gateway_status object",
		);
		assert.deepEqual(rpc.params, { name: "gateway_status", arguments: {} });

		// If the `await` on `verifySignature` is dropped, `signatureValid`
		// is a pending Promise, not a boolean — and this fails.
		assert.equal(
			typeof result.signatureValid,
			"boolean",
			"verifySignature must be awaited so the example logs a boolean",
		);
		assert.equal(
			result.signatureValid,
			true,
			"the example's HMAC matches, so the awaited result must be true",
		);
	});

	it("surfaces a JSON-RPC error inside HTTP 200 instead of printing success", async () => {
		const stub = await startStub({ failToolsCall: true });
		stubs.push(stub);

		await assert.rejects(
			() => withSilencedConsole(() => runBasicUsage(stubClient(stub))),
			(error: unknown) => {
				assert.ok(
					error instanceof Error,
					`expected an Error, got ${String(error)}`,
				);
				assert.match(error.message, /-32602/);
				assert.match(error.message, /Invalid tools\/call parameters/);
				return true;
			},
		);
	});
});
