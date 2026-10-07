/**
 * Optional LLM variant tests (`npm run example -- mcp-agent --llm`).
 *
 * No provider is ever contacted: the provider transport is a scripted `fetch`
 * and the gateway is a scripted MCP stub, so these tests pin the variant's
 * wiring — provider/model resolution, the OpenAI and Anthropic request shapes,
 * tool execution through the SDK toolkit, the agentic error feedback, and the
 * bounded turn loop — without a provider key existing in CI.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { NervlyHttpClient } from "@nervly/sdk";

import { EnvironmentFailure } from "../examples/mcp-agent/harness/errors.js";
import {
	LLM_DEFAULTS,
	LLM_PROMPT,
	type LlmConfig,
	type LlmVariantResult,
	resolveLlmConfig,
	runLlmVariant,
} from "../examples/mcp-agent/harness/llm.js";
import { Transcript } from "../examples/mcp-agent/harness/transcript.js";
import { jsonResponse, withFetch } from "./helpers/http.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mcp-llm-"));
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

const STATUS_RESULT = {
	service: "nervly-gateway",
	uptime: 42,
	nats_status: "CONNECTED",
};

interface ProviderCall {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

/** A scripted provider transport; the last response repeats. */
function scriptedProvider(responses: Response[]) {
	const calls: ProviderCall[] = [];
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		});
		const response =
			responses[Math.min(calls.length - 1, responses.length - 1)];
		if (response === undefined) throw new Error("provider stub exhausted");
		// A repeated response must be readable again on every call.
		return response.clone();
	}) as typeof fetch;
	return { fetchFn, calls };
}

/** A scripted gateway MCP endpoint for the toolkit's execute() calls. */
function scriptedGateway(
	options: {
		statusResult?: unknown;
		statusError?: { code: number; message: string };
	} = {},
) {
	const calls: ProviderCall[] = [];
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = new URL(String(input));
		if (url.pathname !== "/v1/mcp") {
			return jsonResponse(404, { error: "unexpected", path: url.pathname });
		}
		const body = JSON.parse(String(init?.body)) as {
			params?: { name?: string };
		};
		calls.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body: body as Record<string, unknown>,
		});
		if (body.params?.name === "gateway_status") {
			if (options.statusError) {
				return jsonResponse(200, {
					jsonrpc: "2.0",
					id: 1,
					error: options.statusError,
				});
			}
			return jsonResponse(200, {
				jsonrpc: "2.0",
				id: 1,
				result: options.statusResult ?? STATUS_RESULT,
			});
		}
		return jsonResponse(200, {
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32602, message: `Unknown tool: ${body.params?.name}` },
		});
	}) as typeof fetch;
	return { fetchFn, calls };
}

function sdkConfig() {
	return {
		apiKey: "nervly_sk_test_llm_variant",
		baseUrl: "http://localhost:8080",
		timeout: 2000,
		maxRetries: 0,
	} as const;
}

async function runVariant(options: {
	responses: Response[];
	llm?: LlmConfig;
	env?: NodeJS.ProcessEnv;
	maxTurns?: number;
	gateway?: ReturnType<typeof scriptedGateway>;
}): Promise<{
	result: LlmVariantResult;
	providerCalls: ProviderCall[];
	gatewayCalls: ProviderCall[];
	lines: string[];
}> {
	const provider = scriptedProvider(options.responses);
	const gateway = options.gateway ?? scriptedGateway();
	const { log, lines } = collectingTranscript();
	let result: LlmVariantResult | undefined;
	await withFetch(gateway.fetchFn, async () => {
		result = await runLlmVariant({
			httpClient: new NervlyHttpClient(sdkConfig()),
			log,
			llm: options.llm,
			env: options.env,
			fetchFn: provider.fetchFn,
			maxTurns: options.maxTurns,
		});
	});
	if (result === undefined) throw new Error("runLlmVariant did not run");
	return {
		result,
		providerCalls: provider.calls,
		gatewayCalls: gateway.calls,
		lines,
	};
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

describe("resolveLlmConfig", () => {
	it("defaults to OpenAI and the documented model, reading only the provider key", () => {
		const config = resolveLlmConfig({ OPENAI_API_KEY: "sk-openai-test" });
		assert.deepEqual(config, {
			provider: "openai",
			apiKey: "sk-openai-test",
			model: LLM_DEFAULTS.openaiModel,
		});
	});

	it("selects Anthropic and honours the model override", () => {
		const config = resolveLlmConfig({
			NERVLY_LLM_PROVIDER: "Anthropic",
			ANTHROPIC_API_KEY: "sk-ant-test",
			NERVLY_LLM_MODEL: "claude-custom",
		});
		assert.deepEqual(config, {
			provider: "anthropic",
			apiKey: "sk-ant-test",
			model: "claude-custom",
		});
	});

	it("fails naming the variable when the provider key is absent", () => {
		assert.throws(
			() => resolveLlmConfig({}),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("OPENAI_API_KEY") &&
				error.message.includes("deterministic"),
		);
		assert.throws(
			() => resolveLlmConfig({ NERVLY_LLM_PROVIDER: "anthropic" }),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.message.includes("ANTHROPIC_API_KEY"),
		);
	});

	it("refuses an unknown provider", () => {
		assert.throws(
			() =>
				resolveLlmConfig({
					NERVLY_LLM_PROVIDER: "gemini",
					OPENAI_API_KEY: "sk-test",
				}),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.message.includes("NERVLY_LLM_PROVIDER=gemini is not supported"),
		);
	});
});

// ---------------------------------------------------------------------------
// OpenAI loop
// ---------------------------------------------------------------------------

describe("runLlmVariant — OpenAI", () => {
	it("sends the toolkit definitions, executes the model's tool call, and returns the final text", async () => {
		const { result, providerCalls, gatewayCalls, lines } = await runVariant({
			llm: { provider: "openai", apiKey: "sk-openai-test", model: "gpt-test" },
			responses: [
				jsonResponse(200, {
					choices: [
						{
							message: {
								role: "assistant",
								content: null,
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
				}),
				jsonResponse(200, {
					choices: [
						{
							message: {
								role: "assistant",
								content: "The gateway is live with 42s uptime.",
							},
						},
					],
				}),
			],
		});

		assert.equal(result.provider, "openai");
		assert.equal(result.model, "gpt-test");
		assert.deepEqual(result.toolCalls, ["gateway_status"]);
		assert.equal(result.finalText, "The gateway is live with 42s uptime.");

		// Provider request shape: the toolkit's OpenAI definitions and the key.
		assert.equal(providerCalls.length, 2);
		const first = providerCalls[0];
		assert.ok(first);
		assert.equal(first.url, "https://api.openai.com/v1/chat/completions");
		assert.equal(first.headers.get("authorization"), "Bearer sk-openai-test");
		assert.equal(first.body.model, "gpt-test");
		assert.equal(first.body.tool_choice, "auto");
		const tools = first.body.tools as Array<{
			type: string;
			function: { name: string };
		}>;
		assert.equal(tools.length, 6);
		assert.equal(
			tools.some((tool) => tool.function.name === "send_notification"),
			true,
		);
		const messages = first.body.messages as Array<{ role: string }>;
		assert.deepEqual(messages, [{ role: "user", content: LLM_PROMPT }]);

		// The second turn carries the assistant tool call and its result.
		const second = providerCalls[1];
		assert.ok(second);
		const secondMessages = second.body.messages as Array<{
			role: string;
			tool_call_id?: string;
			content?: unknown;
		}>;
		assert.equal(secondMessages[1]?.role, "assistant");
		const toolMessage = secondMessages.find(
			(message) => message.role === "tool",
		);
		assert.equal(toolMessage?.tool_call_id, "call_1");
		assert.match(String(toolMessage?.content), /nervly-gateway/);

		// The tool actually executed through the SDK toolkit against the gateway.
		assert.equal(gatewayCalls.length, 1);
		const rpc = gatewayCalls[0]?.body as {
			method?: string;
			params?: { name?: string; arguments?: unknown };
		};
		assert.equal(rpc.method, "tools/call");
		assert.equal(rpc.params?.name, "gateway_status");
		assert.equal(
			gatewayCalls[0]?.headers.get("authorization"),
			"Bearer nervly_sk_test_llm_variant",
		);
		assert.match(lines.join("\n"), /tool gateway_status\(no arguments\)/);
	});

	it("feeds a tool error back to the model instead of ending the run", async () => {
		const gateway = scriptedGateway({
			statusError: {
				code: -32003,
				message: "This API key lacks the 'read' scope",
			},
		});
		const { result, providerCalls } = await runVariant({
			llm: { provider: "openai", apiKey: "sk-test", model: "gpt-test" },
			gateway,
			responses: [
				jsonResponse(200, {
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
				}),
				jsonResponse(200, {
					choices: [
						{
							message: {
								content: "I could not read the gateway status.",
							},
						},
					],
				}),
			],
		});
		assert.equal(result.finalText, "I could not read the gateway status.");
		const secondMessages = providerCalls[1]?.body.messages as Array<{
			role: string;
			content?: unknown;
		}>;
		const toolMessage = secondMessages.find(
			(message) => message.role === "tool",
		);
		assert.match(String(toolMessage?.content), /lacks the 'read' scope/);
	});
});

// ---------------------------------------------------------------------------
// Anthropic loop
// ---------------------------------------------------------------------------

describe("runLlmVariant — Anthropic", () => {
	it("sends input_schema tools and returns the tool_result as a user turn", async () => {
		const { result, providerCalls } = await runVariant({
			llm: {
				provider: "anthropic",
				apiKey: "sk-ant-test",
				model: "claude-test",
			},
			responses: [
				jsonResponse(200, {
					content: [
						{
							type: "tool_use",
							id: "toolu_1",
							name: "gateway_status",
							input: {},
						},
					],
				}),
				jsonResponse(200, {
					content: [{ type: "text", text: "NATS is connected." }],
				}),
			],
		});

		assert.equal(result.provider, "anthropic");
		assert.deepEqual(result.toolCalls, ["gateway_status"]);
		assert.equal(result.finalText, "NATS is connected.");

		const first = providerCalls[0];
		assert.ok(first);
		assert.equal(first.url, "https://api.anthropic.com/v1/messages");
		assert.equal(first.headers.get("x-api-key"), "sk-ant-test");
		assert.equal(first.headers.get("anthropic-version"), "2023-06-01");
		const tools = first.body.tools as Array<{
			name: string;
			input_schema: { type: string };
		}>;
		assert.equal(tools.length, 6);
		assert.equal(tools[0]?.input_schema.type, "object");

		const secondMessages = providerCalls[1]?.body.messages as Array<{
			role: string;
			content: unknown;
		}>;
		assert.equal(secondMessages[1]?.role, "assistant");
		const last = secondMessages[secondMessages.length - 1];
		assert.equal(last?.role, "user");
		const blocks = last?.content as Array<{
			type: string;
			tool_use_id?: string;
			content?: unknown;
		}>;
		assert.equal(blocks[0]?.type, "tool_result");
		assert.equal(blocks[0]?.tool_use_id, "toolu_1");
		assert.match(String(blocks[0]?.content), /nervly-gateway/);
	});
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("runLlmVariant — failures", () => {
	it("resolves the provider from the environment when no config is passed", async () => {
		const { result, providerCalls } = await runVariant({
			env: { OPENAI_API_KEY: "sk-from-env" },
			responses: [
				jsonResponse(200, {
					choices: [{ message: { content: "done" } }],
				}),
			],
		});
		assert.equal(result.model, LLM_DEFAULTS.openaiModel);
		assert.equal(
			providerCalls[0]?.headers.get("authorization"),
			"Bearer sk-from-env",
		);
	});

	it("maps a provider HTTP failure to an environment failure", async () => {
		await assert.rejects(
			() =>
				runVariant({
					llm: { provider: "openai", apiKey: "sk-test", model: "gpt-test" },
					responses: [jsonResponse(500, { error: "provider down" })],
				}),
			(error: unknown) =>
				error instanceof EnvironmentFailure &&
				error.exitCode === 2 &&
				error.message.includes("HTTP 500"),
		);
	});

	it("bounds the loop when the model never stops calling tools", async () => {
		const alwaysToolCalls = jsonResponse(200, {
			choices: [
				{
					message: {
						tool_calls: [
							{
								id: "call_x",
								type: "function",
								function: { name: "gateway_status", arguments: "{}" },
							},
						],
					},
				},
			],
		});
		const provider = scriptedProvider([alwaysToolCalls]);
		const gateway = scriptedGateway();
		const { log } = collectingTranscript();
		await withFetch(gateway.fetchFn, async () => {
			await assert.rejects(
				() =>
					runLlmVariant({
						httpClient: new NervlyHttpClient(sdkConfig()),
						log,
						llm: { provider: "openai", apiKey: "sk-test", model: "gpt-test" },
						fetchFn: provider.fetchFn,
						maxTurns: 2,
					}),
				(error: unknown) =>
					error instanceof EnvironmentFailure &&
					error.message.includes("within 2 turns"),
			);
		});
		assert.equal(provider.calls.length, 2);
	});
});
