import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createNervlyAiToolkit,
	NERVLY_AI_TOOL_DEFINITIONS,
	toAnthropicTools,
	toOpenAITools,
} from "../src/ai/tools.js";
import { NervlyHttpClient } from "../src/client.js";
import type { TriggerEventResponse } from "../src/types.js";
import { jsonResponse, withFetch } from "./helpers/http.js";

/** The gateway's advertised catalog, as `tools/list` returns it. */
const EXPECTED_TOOLS = [
	"gateway_status",
	"idempotency_inspect",
	"send_notification",
	"check_delivery_status",
	"list_templates",
	"verify_subscriber_channel",
] as const;

function definition(name: string) {
	const tool = NERVLY_AI_TOOL_DEFINITIONS.find((entry) => entry.name === name);
	assert.ok(tool, `missing tool definition for ${name}`);
	return tool;
}

/**
 * Asserts one JSON Schema node obeys OpenAI Structured Outputs strict mode:
 * every object declares `additionalProperties: false` and lists *all* of its
 * properties in `required`. Recurses through nested objects and array items so
 * a nested `to` object cannot slip past on its own.
 */
function assertStrictCompliant(node: unknown, path: string) {
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		node.forEach((item, index) => {
			assertStrictCompliant(item, `${path}[${index}]`);
		});
		return;
	}
	const schema = node as Record<string, unknown>;
	const unsupported = [
		"allOf",
		"not",
		"oneOf",
		"minLength",
		"maxLength",
		"pattern",
		"format",
		"minimum",
		"maximum",
		"multipleOf",
		"minItems",
		"maxItems",
		"uniqueItems",
		"minProperties",
		"maxProperties",
		"patternProperties",
		"unevaluatedProperties",
		"propertyNames",
		"default",
	].filter((keyword) => keyword in schema);
	assert.deepEqual(
		unsupported,
		[],
		`${path} carries keywords OpenAI strict mode rejects`,
	);

	const isObject =
		schema.type === "object" ||
		(Array.isArray(schema.type) && schema.type.includes("object"));
	if (isObject) {
		assert.ok(
			schema.properties !== undefined,
			`${path} must declare properties under strict mode`,
		);
		assert.equal(
			schema.additionalProperties,
			false,
			`${path} must set additionalProperties:false`,
		);
		const propertyNames = Object.keys(
			schema.properties as Record<string, unknown>,
		).sort();
		assert.deepEqual(
			[...((schema.required as string[] | undefined) ?? [])].sort(),
			propertyNames,
			`${path} must list every property in required`,
		);
		for (const [key, value] of Object.entries(
			schema.properties as Record<string, unknown>,
		)) {
			assertStrictCompliant(value, `${path}.${key}`);
		}
	}
	if (schema.items !== undefined) {
		assertStrictCompliant(schema.items, `${path}[]`);
	}
}

describe("Nervly AI tool definitions", () => {
	it("advertises exactly the gateway's MCP catalog", () => {
		assert.deepEqual(
			NERVLY_AI_TOOL_DEFINITIONS.map((tool) => tool.name),
			[...EXPECTED_TOOLS],
		);
	});

	it("declares the required parameters the server enforces", () => {
		assert.deepEqual(definition("send_notification").parameters.required, [
			"name",
			"to",
		]);
		assert.deepEqual(definition("check_delivery_status").parameters.required, [
			"eventId",
		]);
		assert.deepEqual(
			definition("verify_subscriber_channel").parameters.required,
			["subscriberId"],
		);
		assert.deepEqual(definition("idempotency_inspect").parameters.required, [
			"idempotencyKey",
		]);
		for (const tool of NERVLY_AI_TOOL_DEFINITIONS) {
			assert.equal(
				tool.parameters.additionalProperties,
				false,
				`${tool.name} must reject unknown parameters`,
			);
		}

		// The gateway's catalog accepts an `eventName` on both listing and
		// verification tools; the SDK mirror must not lag it.
		assert.deepEqual(
			Object.keys(definition("list_templates").parameters.properties).sort(),
			["channel", "eventName"],
		);
		assert.deepEqual(
			Object.keys(
				definition("verify_subscriber_channel").parameters.properties,
			).sort(),
			["category", "channel", "eventName", "subscriberId"],
		);
	});

	it("keeps the send_notification recipient contract identical to RecipientDto", () => {
		const to = definition("send_notification").parameters.properties.to as {
			required: string[];
			properties: Record<string, unknown>;
		};
		assert.deepEqual(to.required, ["subscriberId"]);
		assert.deepEqual(Object.keys(to.properties).sort(), [
			"deviceTokens",
			"email",
			"phone",
			"subscriberId",
		]);
	});
});

describe("OpenAI and Anthropic conversions", () => {
	it("wraps every tool as an OpenAI function definition", () => {
		const tools = toOpenAITools();
		assert.equal(tools.length, EXPECTED_TOOLS.length);
		for (const tool of tools) {
			assert.equal(tool.type, "function");
			assert.match(tool.function.name, /^[a-z_]+$/);
			assert.equal(tool.function.parameters.type, "object");
		}
	});

	it("only claims OpenAI strict mode when the schema satisfies strict-mode rules", () => {
		const tools = toOpenAITools();

		// At least one tool must genuinely exercise strict mode, otherwise this
		// test would pass by never checking anything.
		const strictTools = tools.filter((tool) => tool.function.strict === true);
		assert.ok(
			strictTools.length > 0,
			"no tool advertises strict mode; the transform is not being exercised",
		);

		for (const tool of strictTools) {
			assertStrictCompliant(
				tool.function.parameters,
				`${tool.function.name}.parameters`,
			);
		}

		// `send_notification` carries free-form `payload`/`overrides`, which
		// Structured Outputs cannot express, so it must not claim strict mode.
		const send = tools.find(
			(tool) => tool.function.name === "send_notification",
		);
		assert.ok(send);
		assert.notEqual(send.function.strict, true);
		assert.deepEqual(
			(send.function.parameters.properties.payload as { type: unknown }).type,
			["object", "null"],
		);
	});

	it("keeps strict-mode schemas faithful to the provider-neutral catalog", () => {
		for (const tool of toOpenAITools()) {
			const neutral = definition(tool.function.name);
			if (tool.function.strict === true) {
				assert.deepEqual(
					Object.keys(tool.function.parameters.properties).sort(),
					Object.keys(neutral.parameters.properties).sort(),
					`${tool.function.name} strict schema must not drop or invent parameters`,
				);
			} else {
				assert.deepEqual(tool.function.parameters, neutral.parameters);
			}
		}
	});

	it("wraps every tool as an Anthropic tool definition", () => {
		const tools = toAnthropicTools();
		assert.equal(tools.length, EXPECTED_TOOLS.length);
		for (const tool of tools) {
			assert.equal(typeof tool.description, "string");
			assert.equal(tool.input_schema.type, "object");
		}
	});
});

describe("Nervly AI toolkit execution", () => {
	it("calls the MCP endpoint with the tool name and arguments, and unwraps the result", async () => {
		const bound = createNervlyAiToolkit(
			new NervlyHttpClient({ apiKey: "nv_live_ai_test" }),
		);

		const response: TriggerEventResponse = {
			eventId: "evt_0123456789abcdef0123456789abcdef",
			status: "QUEUED",
			idempotencyKey: null,
			priority: "NORMAL",
			channel: "sms",
			timestamp: "2026-09-21T00:00:00Z",
		};

		const requests = await withFetch(
			() => jsonResponse(200, { jsonrpc: "2.0", result: response, id: 1 }),
			async () => {
				const result = await bound.execute<TriggerEventResponse>(
					"send_notification",
					{
						name: "otp",
						to: { subscriberId: "sub-1", phone: "+2348012345678" },
					},
				);
				assert.deepEqual(result, response);
			},
		);

		const sent = requests[0];
		assert.equal(sent.method, "POST");
		assert.match(sent.url, /\/v1\/mcp$/);
		assert.equal(sent.headers.get("Authorization"), "Bearer nv_live_ai_test");
		assert.deepEqual(JSON.parse(sent.body ?? "{}"), {
			method: "tools/call",
			params: {
				name: "send_notification",
				arguments: {
					name: "otp",
					to: { subscriberId: "sub-1", phone: "+2348012345678" },
				},
			},
		});
	});

	it("exposes a Vercel AI SDK-compatible map whose execute routes through MCP", async () => {
		const bound = createNervlyAiToolkit(
			new NervlyHttpClient({ apiKey: "nv_test_vercel" }),
		);
		const tools = bound.vercel();

		assert.deepEqual(Object.keys(tools).sort(), [...EXPECTED_TOOLS].sort());

		// The Vercel AI SDK Core `tool({ description, parameters, execute })`
		// shape, exactly — no `type`/`function`/`input_schema` leakage from the
		// OpenAI or Anthropic views, and `parameters` is the neutral JSON Schema.
		for (const name of EXPECTED_TOOLS) {
			const tool = tools[name];
			assert.deepEqual(
				Object.keys(tool).sort(),
				["description", "execute", "parameters"],
				`${name} must be exactly a Vercel AI SDK tool`,
			);
			assert.equal(typeof tool.description, "string");
			assert.equal(typeof tool.execute, "function");
			assert.deepEqual(tool.parameters, definition(name).parameters);
			assert.equal(tool.parameters.type, "object");
		}

		const requests = await withFetch(
			() =>
				jsonResponse(200, {
					jsonrpc: "2.0",
					result: {
						service: "nervly-gateway",
						uptime: 12,
						nats_status: "CONNECTED",
					},
					id: 1,
				}),
			async () => {
				const result = await tools.gateway_status.execute({});
				assert.deepEqual(result, {
					service: "nervly-gateway",
					uptime: 12,
					nats_status: "CONNECTED",
				});
			},
		);
		assert.equal(requests[0].method, "POST");
		assert.match(requests[0].url, /\/v1\/mcp$/);
	});

	it("raises the JSON-RPC error instead of returning a silent no-op", async () => {
		const bound = createNervlyAiToolkit(
			new NervlyHttpClient({ apiKey: "nv_test_error" }),
		);

		await withFetch(
			() =>
				jsonResponse(200, {
					jsonrpc: "2.0",
					error: {
						code: -32602,
						message: "Invalid arguments for check_delivery_status",
						data: { tool: "check_delivery_status" },
					},
					id: 1,
				}),
			async () => {
				await assert.rejects(
					() => bound.execute("check_delivery_status", {}),
					/failed \(-32602\): Invalid arguments for check_delivery_status/,
				);
			},
		);
	});
});
