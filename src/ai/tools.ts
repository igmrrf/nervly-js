/**
 * Turnkey AI tool-calling definitions for the Nervly MCP catalog.
 *
 * The gateway advertises a JSON-RPC tool catalog at `POST /v1/mcp`. This module
 * turns that catalog into ready-made definitions for the three tool-calling
 * formats an agent framework is most likely to want — OpenAI Function Calling,
 * Anthropic Tool Use, and the Vercel AI SDK Core (`ai` package) — plus a
 * typed `execute` helper that calls the gateway.
 *
 * No provider SDK is imported: every definition is a plain object with the
 * exact shape the provider expects, so the package keeps zero runtime
 * dependencies and consumers stay on whichever provider version they already
 * ship. The input/output types are pinned against the generated OpenAPI
 * contract by `tests/types/conformance.types.ts`.
 */
import type { NervlyHttpClient } from "../client.js";
import type {
	ChannelPreferences,
	DeliveryStatus,
	McpResponse,
	McpToolName,
	MessageDto,
	Priority,
	ProviderOverrides,
	Recipient,
	TriggerEventRequest,
	TriggerEventResponse,
} from "../types.js";

/** The channels the MCP tools accept. Excludes the internal `itsm` channel. */
export type MessagingChannel = "sms" | "email" | "push" | "whatsapp" | "voice";

export type NervlyGatewayStatusInput = Record<string, never>;
export interface NervlyGatewayStatusOutput {
	service: string;
	uptime: number;
	nats_status: "CONNECTED" | "FALLBACK_BUFFER";
}

export interface NervlyIdempotencyInspectInput {
	idempotencyKey: string;
}
export interface NervlyIdempotencyInspectOutput {
	key: string;
	workspace_id: string;
	cached: boolean;
	ttl_seconds: number | null;
}

/** Input for `send_notification`, pinned to the `TriggerRequest` contract. */
export interface NervlySendNotificationInput {
	name: TriggerEventRequest["name"];
	to: Recipient;
	payload?: TriggerEventRequest["payload"];
	overrides?: ProviderOverrides | null;
	category?: string | null;
	priority?: Priority | null;
	idempotencyKey?: string | null;
}
export type NervlySendNotificationOutput = TriggerEventResponse;

export interface NervlyDeliveryEvent {
	seq: number;
	status: string;
	provider?: string | null;
	detail?: unknown;
	normalized_code: DeliveryStatus | string;
	occurred_at: string;
}
export type NervlyCheckDeliveryOutput = Omit<MessageDto, "events"> & {
	normalized_code: DeliveryStatus | string;
	events: NervlyDeliveryEvent[];
};

export interface NervlyCheckDeliveryInput {
	eventId: string;
}

export interface NervlyTemplateSummary {
	event_name: string;
	channel: MessagingChannel;
	title: string;
	subject: string;
	has_body: boolean;
	variables: string[];
	updated_at: string;
}
export interface NervlyListTemplatesInput {
	eventName?: string | null;
	channel?: MessagingChannel | null;
}
export interface NervlyListTemplatesOutput {
	count: number;
	templates: NervlyTemplateSummary[];
}

export interface NervlyVerifySubscriberInput {
	subscriberId: string;
	channel?: MessagingChannel | null;
	category?: string | null;
	eventName?: string | null;
}
export interface NervlyChannelEvaluation {
	channel: MessagingChannel;
	addressable: boolean;
	opted_in: boolean;
	suppressed: boolean;
	dnd_active: boolean | null;
	available: boolean;
}
export interface NervlyVerifySubscriberOutput {
	subscriber_id: string;
	erased: boolean;
	reachable_channels: MessagingChannel[];
	/** Pinned to the `ChannelPreferences` OpenAPI schema. */
	channels: ChannelPreferences;
	categories: Record<string, Record<string, boolean>>;
	dnd_active: boolean | null;
	email_suppressed: boolean;
	channel_priority: MessagingChannel[];
	evaluated: NervlyChannelEvaluation[];
	selected_channel: MessagingChannel | null;
}

/** A JSON Schema object as both the gateway and the providers describe it. */
export interface JsonSchemaObject {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
}

/** A provider-neutral tool definition, independent of any SDK. */
export interface NervlyAiToolDefinition<
	Input = unknown,
	Output = unknown,
	Name extends McpToolName = McpToolName,
> {
	readonly name: Name;
	readonly description: string;
	readonly parameters: JsonSchemaObject;
	/** Present on the toolkit; absent on the raw catalog. */
	execute?: (input: Input) => Promise<Output>;
}

const MESSAGING_CHANNEL_ENUM = [
	"sms",
	"email",
	"push",
	"whatsapp",
	"voice",
	null,
] as const;

const MESSAGING_CHANNEL_SCHEMA = {
	type: ["string", "null"] as const,
	enum: MESSAGING_CHANNEL_ENUM,
};

/**
 * The provider-neutral catalog. Mirrors `tool_catalog()` in
 * `nervly-gate/src/handlers/mcp.rs` field for field; a divergence is a bug on
 * whichever side moved first.
 */
export const NERVLY_AI_TOOL_DEFINITIONS: ReadonlyArray<
	NervlyAiToolDefinition<never, never>
> = [
	{
		name: "gateway_status",
		description:
			"Inspect real-time edge gateway status: process uptime and whether the NATS broker connection is live or buffering.",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "idempotency_inspect",
		description:
			"Check whether an Idempotency-Key is cached for this workspace, and how long its replay window has left.",
		parameters: {
			type: "object",
			properties: {
				idempotencyKey: {
					type: "string",
					minLength: 1,
					description: "The Idempotency-Key value to inspect.",
				},
			},
			required: ["idempotencyKey"],
			additionalProperties: false,
		},
	},
	{
		name: "send_notification",
		description:
			"Trigger a multi-channel notification (SMS, voice, email, WhatsApp or push) for one subscriber. Runs the same validation, routing, rate limiting and broker publish path as POST /v1/events/trigger.",
		parameters: {
			type: "object",
			properties: {
				name: {
					type: "string",
					minLength: 1,
					description: "Workflow/event name configured in the workspace.",
				},
				to: {
					type: "object",
					properties: {
						subscriberId: { type: "string", minLength: 1 },
						email: { type: ["string", "null"] },
						phone: {
							type: ["string", "null"],
							description: "E.164 number, e.g. +2348012345678.",
						},
						deviceTokens: {
							type: ["array", "null"],
							items: { type: "string" },
						},
					},
					required: ["subscriberId"],
					additionalProperties: false,
				},
				payload: {
					type: ["object", "null"],
					description: "Template variables referenced as {{key}}.",
				},
				overrides: { type: ["object", "null"] },
				category: { type: ["string", "null"] },
				priority: {
					type: ["string", "null"],
					enum: ["CRITICAL", "HIGH", "NORMAL", "LOW", null],
				},
				idempotencyKey: { type: ["string", "null"] },
			},
			required: ["name", "to"],
			additionalProperties: false,
		},
	},
	{
		name: "check_delivery_status",
		description:
			"Look up one message's delivery state, provider dispatch details and normalized delivery code, scoped to this workspace.",
		parameters: {
			type: "object",
			properties: {
				eventId: {
					type: "string",
					minLength: 1,
					description: "evt_<hex> or UUID.",
				},
			},
			required: ["eventId"],
			additionalProperties: false,
		},
	},
	{
		name: "list_templates",
		description:
			"List the workspace's message templates with their required {{variable}} placeholders, optionally narrowed to one event name or channel.",
		parameters: {
			type: "object",
			properties: {
				eventName: { type: ["string", "null"] },
				channel: MESSAGING_CHANNEL_SCHEMA,
			},
			additionalProperties: false,
		},
	},
	{
		name: "verify_subscriber_channel",
		description:
			"Check a subscriber's opt-in status, NCC DND state and channel prioritization, and report which channel would be selected.",
		parameters: {
			type: "object",
			properties: {
				subscriberId: { type: "string", minLength: 1 },
				channel: MESSAGING_CHANNEL_SCHEMA,
				category: {
					type: ["string", "null"],
					description:
						"Category override to evaluate instead of the channel default.",
				},
				eventName: {
					type: ["string", "null"],
					description:
						"Event name the DND intent is classified from when `category` is omitted, mirroring the worker's ClassifyIntent.",
				},
			},
			required: ["subscriberId"],
			additionalProperties: false,
		},
	},
];

/** OpenAI Function Calling tool definition. */
export interface OpenAIFunctionTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: JsonSchemaObject;
		strict?: boolean;
	};
}

/** Anthropic Tool Use tool definition. */
export interface AnthropicTool {
	name: string;
	description: string;
	input_schema: JsonSchemaObject;
}

/**
 * Vercel AI SDK Core tool definition. `parameters` carries the JSON Schema;
 * pass it through `jsonSchema()` from the `ai` package when your version
 * requires a schema object rather than a plain JSON Schema literal.
 */
export interface VercelAITool {
	description: string;
	parameters: JsonSchemaObject;
	execute: (input: unknown) => Promise<unknown>;
}

/**
 * Whether every object in a schema can be expressed under OpenAI strict mode.
 *
 * Strict mode requires `additionalProperties: false` and every key listed in
 * `required`. A free-form object — one with no declared `properties`, such as
 * `send_notification`'s template `payload` or provider `overrides` — cannot be
 * represented: closing it with `additionalProperties: false` would forbid the
 * very keys the caller needs to send. A tool carrying one therefore stays a
 * plain function definition rather than claiming a mode OpenAI would reject.
 */
function isStrictCompatible(schema: unknown): boolean {
	if (Array.isArray(schema)) return schema.every(isStrictCompatible);
	if (schema === null || typeof schema !== "object") return true;

	const node = schema as Record<string, unknown>;
	const isObject =
		node.type === "object" ||
		(Array.isArray(node.type) && node.type.includes("object"));
	if (isObject) {
		if (node.properties === undefined) return false;
		if (node.additionalProperties !== false) return false;
		return Object.values(node.properties as Record<string, unknown>).every(
			isStrictCompatible,
		);
	}
	return node.items === undefined || isStrictCompatible(node.items);
}

/**
 * Validation keywords OpenAI Structured Outputs rejects. They are advisory for
 * the model and enforced by the gateway anyway, so the strict view drops them
 * rather than making the whole tool unusable.
 */
const STRICT_UNSUPPORTED_KEYWORDS = [
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
] as const;

/** Rewrites a schema into the all-required shape OpenAI strict mode demands. */
function toStrictSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(toStrictSchema);
	if (schema === null || typeof schema !== "object") return schema;

	const node: Record<string, unknown> = {
		...(schema as Record<string, unknown>),
	};
	if (node.properties !== undefined) {
		const properties = Object.fromEntries(
			Object.entries(node.properties as Record<string, unknown>).map(
				([key, value]) => [key, toStrictSchema(value)],
			),
		);
		node.properties = properties;
		node.required = Object.keys(properties);
	}
	const isObject =
		node.type === "object" ||
		(Array.isArray(node.type) && node.type.includes("object"));
	if (isObject) node.additionalProperties = false;
	if (node.items !== undefined) node.items = toStrictSchema(node.items);
	for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) delete node[keyword];
	return node;
}

/** Convert the catalog to OpenAI Function Calling definitions. */
export function toOpenAITools(): OpenAIFunctionTool[] {
	return NERVLY_AI_TOOL_DEFINITIONS.map((tool) => {
		const strict = isStrictCompatible(tool.parameters);
		return {
			type: "function" as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: (strict
					? toStrictSchema(tool.parameters)
					: tool.parameters) as JsonSchemaObject,
				...(strict ? { strict: true as const } : {}),
			},
		};
	});
}

/** Convert the catalog to Anthropic Tool Use definitions. */
export function toAnthropicTools(): AnthropicTool[] {
	return NERVLY_AI_TOOL_DEFINITIONS.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));
}

/**
 * A bound AI toolkit over a Nervly client. `execute` calls the gateway's MCP
 * endpoint and unwraps the JSON-RPC result, raising the error object as an
 * `Error` so an agent loop sees a real exception rather than a silent no-op.
 */
export interface NervlyAiToolkit {
	definitions: ReadonlyArray<NervlyAiToolDefinition<never, never>>;
	execute<Output = unknown>(
		name: McpToolName | string,
		args?: Record<string, unknown>,
	): Promise<Output>;
	openai(): OpenAIFunctionTool[];
	anthropic(): AnthropicTool[];
	vercel(): Record<string, VercelAITool>;
}

/** Builds a tool-calling toolkit bound to a Nervly client. */
export function createNervlyAiToolkit(
	client: NervlyHttpClient,
): NervlyAiToolkit {
	const execute = async <Output = unknown>(
		name: McpToolName | string,
		args: Record<string, unknown> = {},
	): Promise<Output> => {
		const response = await client.post<McpResponse>("/v1/mcp", {
			method: "tools/call",
			params: { name, arguments: args },
		});
		if (response.error) {
			throw new Error(
				`Nervly MCP tool "${name}" failed (${response.error.code}): ${response.error.message}`,
			);
		}
		return response.result as Output;
	};

	return {
		definitions: NERVLY_AI_TOOL_DEFINITIONS,
		execute,
		openai: toOpenAITools,
		anthropic: toAnthropicTools,
		vercel: () => {
			const tools: Record<string, VercelAITool> = {};
			for (const definition of NERVLY_AI_TOOL_DEFINITIONS) {
				tools[definition.name] = {
					description: definition.description,
					parameters: definition.parameters,
					execute: (input) =>
						execute(definition.name, (input as Record<string, unknown>) ?? {}),
				};
			}
			return tools;
		},
	};
}
