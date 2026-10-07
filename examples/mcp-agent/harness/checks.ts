/**
 * The deterministic MCP agent loop (contract §3.3).
 *
 * This is the CI-runnable core: it drives the gateway's `POST /v1/mcp`
 * endpoint through the SDK's MCP methods exactly the way an AI agent would —
 * `tools/list`, then `tools/call` for `gateway_status` and `send_notification`
 * (sandboxed preview, then the explicit `live: true` dispatch) — and only goes
 * green when the dispatched test-mode message reads back `DELIVERED` through
 * `check_delivery_status` (with `messages.list` as a second surface). It also
 * exercises the unknown-tool JSON-RPC error path and the SDK agent toolkit
 * (`createNervlyAiToolkit` + `toOpenAITools`/`toAnthropicTools`), with no model
 * or provider key involved.
 *
 * Failure taxonomy: a JSON-RPC `error` object inside HTTP 200 is classified by
 * the error object (never the HTTP status), transport/5xx failures are
 * environment failures (exit 2), and a well-formed response that violates an
 * expected end state is an assertion failure (exit 1).
 */

import type { Nervly, NervlyHttpClient } from "@nervly/sdk";
import {
	createNervlyAiToolkit,
	type McpResponse,
	type MessageDto,
	type NervlyAiToolkit,
	NervlyApiError,
	NervlyNetworkError,
	NervlyRetryExhaustedError,
} from "@nervly/sdk";
import { AssertionFailure, EnvironmentFailure } from "./errors.js";
import type { CheckResult } from "./summary.js";
import type { Transcript } from "./transcript.js";

/** Statuses that will never become DELIVERED; fail fast when one is seen. */
const TERMINAL_FAILURES = new Set([
	"FAILED",
	"BOUNCED",
	"SUPPRESSED",
	"CANCELLED",
	"REJECTED",
	"DLQ",
]);

/** The gateway's JSON-RPC code for "the requested row is not visible (yet)". */
const RESOURCE_NOT_FOUND = -32004;

/** The tools the deterministic core requires in the advertised catalog. */
export const REQUIRED_TOOLS = [
	"gateway_status",
	"send_notification",
	"check_delivery_status",
] as const;

/** The event name the example triggers. */
export const EVENT_NAME = "example.mcp_agent.trigger";

/** `evt_<hex>` and `<hex>` name the same event; compare one normalized form. */
export function normalizeEventId(eventId: string): string {
	return eventId.replace(/^evt[_-]?/i, "").toLowerCase();
}

export function isTerminalFailure(status: string): boolean {
	return TERMINAL_FAILURES.has(status.toUpperCase());
}

export interface RunChecksOptions {
	/** SDK client bound to the minted test key and the local gateway. */
	client: Nervly;
	/**
	 * The low-level HTTP client `createNervlyAiToolkit` binds to (the toolkit's
	 * documented constructor argument; `Nervly` wraps this internally).
	 */
	httpClient: NervlyHttpClient;
	runId: string;
	timeoutMs: number;
	log: Transcript;
	/** Test seams. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	toolkitFactory?: (client: NervlyHttpClient) => NervlyAiToolkit;
}

export interface RunChecksResult {
	checks: CheckResult[];
	eventId: string;
	/** The subscriber this run triggered for (also the read-back key). */
	subscriberId: string;
}

const STACK_HINT = ' Is the local stack up? Run "make up" in nervly-base.';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
	if (!isRecord(value)) return null;
	const found = value[key];
	return typeof found === "string" && found !== "" ? found : null;
}

function numberField(value: unknown, key: string): number | null {
	if (!isRecord(value)) return null;
	const found = value[key];
	return typeof found === "number" ? found : null;
}

function describe(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text === undefined || text === "") return "(no body)";
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Classify a thrown SDK failure. Transport errors, 5xx responses, auth and
 * rate-limit rejections mean the stack could not complete the call
 * (environment, exit 2); a validation/not-found rejection means the call
 * itself was wrong or an expected state was missing (assertion, exit 1).
 * Never returns.
 */
function throwCallFailure(
	error: unknown,
	context: string,
	checkName: string,
): never {
	const message = error instanceof Error ? error.message : String(error);
	const statusCode =
		error instanceof NervlyApiError ? error.statusCode : undefined;
	const detail =
		statusCode === undefined ? message : `HTTP ${statusCode}: ${message}`;
	const environmentFailure =
		error instanceof NervlyNetworkError ||
		error instanceof NervlyRetryExhaustedError ||
		(statusCode !== undefined &&
			(statusCode >= 500 || statusCode === 401 || statusCode === 429));
	if (environmentFailure) {
		throw new EnvironmentFailure(
			`${context} failed at the stack level: ${detail}${STACK_HINT}`,
			{ name: checkName, status: "fail", detail },
			{ cause: error },
		);
	}
	throw new AssertionFailure(`${context} failed: ${detail}`, {
		name: checkName,
		status: "fail",
		detail,
	});
}

/** Run one MCP call, classifying transport/HTTP failures. */
async function callGateway(
	call: () => Promise<McpResponse>,
	context: string,
	checkName: string,
): Promise<McpResponse> {
	try {
		return await call();
	} catch (error) {
		throwCallFailure(error, context, checkName);
	}
}

/**
 * The successful result of an MCP call. A JSON-RPC `error` object (carried in
 * HTTP 200, as the protocol requires) is an assertion failure: the deterministic
 * core only calls tools with valid arguments.
 */
function expectResult(
	response: McpResponse,
	context: string,
	checkName: string,
): unknown {
	if (response.error) {
		throw new AssertionFailure(
			`${context} returned JSON-RPC ${response.error.code}: ${response.error.message}`,
			{
				name: checkName,
				status: "fail",
				detail: `JSON-RPC ${response.error.code}: ${response.error.message}`,
			},
		);
	}
	return response.result;
}

function inputSchemaOf(tool: Record<string, unknown>): unknown {
	return tool.inputSchema;
}

/**
 * Run the deterministic agent loop in order. Throws {@link EnvironmentFailure}
 * when the stack itself is unusable and {@link AssertionFailure} when an
 * observed end state does not hold; the failing check travels on the error.
 */
export async function runChecks(
	options: RunChecksOptions,
): Promise<RunChecksResult> {
	const { client, httpClient, runId, timeoutMs, log } = options;
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = options.now ?? (() => Date.now());
	const toolkitFactory = options.toolkitFactory ?? createNervlyAiToolkit;
	const checks: CheckResult[] = [];
	const subscriberId = `sub-example-${runId.toLowerCase()}`;
	const email = `subscriber+${runId}@example.local`;

	// 1. tools/list — the advertised catalog and its input schemas.
	log.line("→ checks: MCP tools/list");
	const listResponse = await callGateway(
		() => client.mcp.listTools(),
		"MCP tools/list",
		"mcp tools/list",
	);
	const listResult = expectResult(
		listResponse,
		"MCP tools/list",
		"mcp tools/list",
	);
	const tools =
		isRecord(listResult) && Array.isArray(listResult.tools)
			? listResult.tools.filter(isRecord)
			: null;
	if (tools === null) {
		throw new AssertionFailure(
			`tools/list returned no tools array: ${describe(listResult)}`,
			{
				name: "mcp tools/list",
				status: "fail",
				detail: describe(listResult),
			},
		);
	}
	const byName = new Map(tools.map((tool) => [String(tool.name), tool]));
	const requireTool = (name: string): Record<string, unknown> => {
		const tool = byName.get(name);
		if (tool === undefined) {
			throw new AssertionFailure(
				`tools/list did not advertise ${name}: ${describe(listResult)}`,
				{
					name: "mcp tools/list",
					status: "fail",
					detail: `catalog missing ${name}`,
				},
			);
		}
		return tool;
	};
	for (const name of REQUIRED_TOOLS) requireTool(name);
	const statusSchema = inputSchemaOf(requireTool("gateway_status"));
	const sendSchema = inputSchemaOf(requireTool("send_notification"));
	const deliverySchema = inputSchemaOf(requireTool("check_delivery_status"));
	if (
		!isRecord(statusSchema) ||
		statusSchema.type !== "object" ||
		!isRecord(statusSchema.properties) ||
		Object.keys(statusSchema.properties).length !== 0 ||
		statusSchema.additionalProperties !== false
	) {
		throw new AssertionFailure(
			`gateway_status input schema is not the declared no-argument object: ${describe(statusSchema)}`,
			{
				name: "mcp tools/list",
				status: "fail",
				detail: `gateway_status schema ${describe(statusSchema)}`,
			},
		);
	}
	if (
		!isRecord(sendSchema) ||
		sendSchema.type !== "object" ||
		!Array.isArray(sendSchema.required) ||
		!["name", "to"].every((key) =>
			(sendSchema.required as unknown[]).includes(key),
		) ||
		!isRecord(sendSchema.properties) ||
		!isRecord((sendSchema.properties as Record<string, unknown>).live) ||
		(
			(sendSchema.properties as Record<string, unknown>).live as Record<
				string,
				unknown
			>
		).type !== "boolean"
	) {
		throw new AssertionFailure(
			`send_notification input schema is not the declared {name, to, live} object: ${describe(sendSchema)}`,
			{
				name: "mcp tools/list",
				status: "fail",
				detail: `send_notification schema ${describe(sendSchema)}`,
			},
		);
	}
	if (
		!isRecord(deliverySchema) ||
		deliverySchema.type !== "object" ||
		!Array.isArray(deliverySchema.required) ||
		!(deliverySchema.required as unknown[]).includes("eventId")
	) {
		throw new AssertionFailure(
			`check_delivery_status input schema does not require eventId: ${describe(deliverySchema)}`,
			{
				name: "mcp tools/list",
				status: "fail",
				detail: `check_delivery_status schema ${describe(deliverySchema)}`,
			},
		);
	}
	checks.push({
		name: "mcp tools/list",
		status: "pass",
		detail: `catalog ${tools.length} tools; ${REQUIRED_TOOLS.join(", ")} schemas verified`,
	});
	log.line(
		`  catalog has ${tools.length} tools; required schemas verified (${REQUIRED_TOOLS.join(", ")})`,
	);

	// 2. gateway_status — a live status result.
	log.line("→ checks: MCP tools/call gateway_status");
	const statusResponse = await callGateway(
		() => client.mcp.callTool({ name: "gateway_status", arguments: {} }),
		"MCP tools/call gateway_status",
		"mcp gateway_status",
	);
	const statusResult = expectResult(
		statusResponse,
		"MCP tools/call gateway_status",
		"mcp gateway_status",
	);
	const uptime = numberField(statusResult, "uptime");
	const natsStatus = stringField(statusResult, "nats_status");
	if (
		stringField(statusResult, "service") !== "nervly-gateway" ||
		uptime === null ||
		uptime < 0 ||
		(natsStatus !== "CONNECTED" && natsStatus !== "FALLBACK_BUFFER")
	) {
		throw new AssertionFailure(
			`gateway_status returned an unexpected result: ${describe(statusResult)}`,
			{
				name: "mcp gateway_status",
				status: "fail",
				detail: describe(statusResult),
			},
		);
	}
	if (natsStatus !== "CONNECTED") {
		throw new EnvironmentFailure(
			"gateway reports NATS disconnected; delivery cannot flow",
			{
				name: "mcp gateway_status",
				status: "fail",
				detail: `nats_status=${natsStatus}`,
			},
		);
	}
	checks.push({
		name: "mcp gateway_status",
		status: "pass",
		detail: `service=nervly-gateway uptime=${uptime}s nats_status=${natsStatus}`,
	});
	log.line(`  gateway live (uptime=${uptime}s, nats_status=${natsStatus})`);

	// 3. The SDK agent toolkit: provider-neutral definitions plus the typed
	//    execute helper, exercised without a model.
	log.line("→ checks: SDK toolkit wiring (createNervlyAiToolkit, no model)");
	const toolkit = toolkitFactory(httpClient);
	const openaiTools = toolkit.openai();
	const anthropicTools = toolkit.anthropic();
	const openaiNames = new Set(openaiTools.map((tool) => tool.function.name));
	const anthropicNames = new Set(anthropicTools.map((tool) => tool.name));
	for (const name of REQUIRED_TOOLS) {
		if (!openaiNames.has(name) || !anthropicNames.has(name)) {
			throw new AssertionFailure(
				`the toolkit is missing ${name} (openai=${openaiNames.size} anthropic=${anthropicNames.size} definitions)`,
				{
					name: "mcp toolkit wiring",
					status: "fail",
					detail: `missing ${name} in toOpenAITools()/toAnthropicTools()`,
				},
			);
		}
	}
	let toolkitStatus: unknown;
	try {
		toolkitStatus = await toolkit.execute("gateway_status");
	} catch (error) {
		throwCallFailure(
			error,
			"toolkit.execute(gateway_status)",
			"mcp toolkit wiring",
		);
	}
	if (
		stringField(toolkitStatus, "service") !== "nervly-gateway" ||
		numberField(toolkitStatus, "uptime") === null
	) {
		throw new AssertionFailure(
			`toolkit.execute(gateway_status) returned an unexpected result: ${describe(toolkitStatus)}`,
			{
				name: "mcp toolkit wiring",
				status: "fail",
				detail: describe(toolkitStatus),
			},
		);
	}
	checks.push({
		name: "mcp toolkit wiring",
		status: "pass",
		detail: `openai=${openaiTools.length} anthropic=${anthropicTools.length} definitions; toolkit.execute(gateway_status) returned service=nervly-gateway`,
	});
	log.line(
		`  toolkit exposes ${openaiTools.length} OpenAI / ${anthropicTools.length} Anthropic definitions; execute(gateway_status) worked`,
	);

	// 4. send_notification, sandboxed default: a preview that dispatches nothing.
	log.line("→ checks: MCP tools/call send_notification (sandboxed preview)");
	const previewResponse = await callGateway(
		() =>
			client.mcp.callTool({
				name: "send_notification",
				arguments: {
					name: EVENT_NAME,
					to: { subscriberId, email },
					payload: { runId, source: "nervly-js/examples/mcp-agent" },
					category: "transactional",
				},
			}),
		"MCP tools/call send_notification (preview)",
		"mcp send_notification preview",
	);
	const previewResult = expectResult(
		previewResponse,
		"MCP tools/call send_notification (preview)",
		"mcp send_notification preview",
	);
	if (
		!isRecord(previewResult) ||
		previewResult.sandbox !== true ||
		previewResult.dispatched !== false ||
		previewResult.would_dispatch !== true ||
		previewResult.subscriber_id !== subscriberId ||
		previewResult.event_name !== EVENT_NAME ||
		previewResult.eventId !== undefined
	) {
		throw new AssertionFailure(
			`send_notification without live:true must be a sandbox preview: ${describe(previewResult)}`,
			{
				name: "mcp send_notification preview",
				status: "fail",
				detail: describe(previewResult),
			},
		);
	}
	checks.push({
		name: "mcp send_notification preview",
		status: "pass",
		detail: `sandbox=true dispatched=false would_dispatch=true channel=${stringField(previewResult, "channel") ?? "?"} event=${EVENT_NAME}`,
	});
	log.line(
		`  preview only: sandbox=true dispatched=false would_dispatch=true (channel=${stringField(previewResult, "channel") ?? "?"})`,
	);

	// 5. send_notification with the explicit live opt-in.
	log.line("→ checks: MCP tools/call send_notification (live: true)");
	const idempotencyKey = `example-mcp-${runId}`;
	const liveResponse = await callGateway(
		() =>
			client.mcp.callTool({
				name: "send_notification",
				arguments: {
					name: EVENT_NAME,
					to: { subscriberId, email },
					payload: { runId, source: "nervly-js/examples/mcp-agent" },
					category: "transactional",
					priority: "NORMAL",
					idempotencyKey,
					live: true,
				},
			}),
		"MCP tools/call send_notification (live)",
		"mcp send_notification live",
	);
	const liveResult = expectResult(
		liveResponse,
		"MCP tools/call send_notification (live)",
		"mcp send_notification live",
	);
	const eventId = stringField(liveResult, "eventId");
	if (
		eventId === null ||
		(isRecord(liveResult) && liveResult.sandbox === true)
	) {
		throw new AssertionFailure(
			`the live dispatch returned no eventId (or a sandbox label): ${describe(liveResult)}`,
			{
				name: "mcp send_notification live",
				status: "fail",
				detail: describe(liveResult),
			},
		);
	}
	checks.push({
		name: "mcp send_notification live",
		status: "pass",
		detail: `event ${eventId} accepted (idempotency-key=${idempotencyKey}, status=${stringField(liveResult, "status") ?? "?"})`,
	});
	log.line(`  live dispatch accepted (event ${eventId})`);

	// 6. Asserted end state: the dispatched test-mode message reads back
	//    DELIVERED through check_delivery_status. Before the worker persists
	//    the row, the tool answers JSON-RPC -32004 (not found); that is a
	//    "not visible yet" signal, not a failure.
	log.line(
		`→ checks: MCP tools/call check_delivery_status for ${eventId} (bound ${timeoutMs}ms)`,
	);
	const deadline = now() + timeoutMs;
	const wanted = normalizeEventId(eventId);
	let lastStatus: string | null = null;
	for (;;) {
		const deliveryResponse = await callGateway(
			() =>
				client.mcp.callTool({
					name: "check_delivery_status",
					arguments: { eventId },
				}),
			"MCP tools/call check_delivery_status",
			"mcp check_delivery_status",
		);
		if (deliveryResponse.error) {
			if (deliveryResponse.error.code !== RESOURCE_NOT_FOUND) {
				throw new AssertionFailure(
					`check_delivery_status returned JSON-RPC ${deliveryResponse.error.code}: ${deliveryResponse.error.message}`,
					{
						name: "mcp check_delivery_status",
						status: "fail",
						detail: `JSON-RPC ${deliveryResponse.error.code}: ${deliveryResponse.error.message}`,
					},
				);
			}
		} else {
			const delivery = deliveryResponse.result;
			const returnedId = stringField(delivery, "event_id");
			if (returnedId !== null && normalizeEventId(returnedId) !== wanted) {
				throw new AssertionFailure(
					`check_delivery_status returned ${returnedId} for ${eventId}`,
					{
						name: "mcp check_delivery_status",
						status: "fail",
						detail: `returned ${returnedId}, expected ${eventId}`,
					},
				);
			}
			const status = stringField(delivery, "status");
			lastStatus = status;
			if (status === "DELIVERED") {
				if (!isRecord(delivery) || delivery.test_mode !== true) {
					throw new AssertionFailure(
						"message was delivered outside test mode; examples only run test keys",
						{
							name: "mcp check_delivery_status",
							status: "fail",
							detail: `event ${eventId} DELIVERED with test_mode=${describe(isRecord(delivery) ? delivery.test_mode : undefined)}`,
						},
					);
				}
				if (delivery.normalized_code !== "delivered") {
					throw new AssertionFailure(
						`DELIVERED must map to normalized_code=delivered; got ${describe(delivery.normalized_code)}`,
						{
							name: "mcp check_delivery_status",
							status: "fail",
							detail: `normalized_code=${describe(delivery.normalized_code)}`,
						},
					);
				}
				checks.push({
					name: "mcp check_delivery_status",
					status: "pass",
					detail: `event ${eventId} status DELIVERED (normalized_code=delivered, test_mode=true, channel=${
						stringField(delivery, "channel") ?? "?"
					}, attempts=${numberField(delivery, "attempts") ?? "?"})`,
				});
				log.line(
					`  asserted end state: ${eventId} is DELIVERED in test mode (normalized_code=delivered)`,
				);
				break;
			}
			if (status !== null && isTerminalFailure(status)) {
				throw new AssertionFailure(
					`message reached terminal status ${status}, not DELIVERED`,
					{
						name: "mcp check_delivery_status",
						status: "fail",
						detail: `event ${eventId} status ${status}`,
					},
				);
			}
		}

		if (now() >= deadline) {
			throw new AssertionFailure(
				`timed out after ${timeoutMs}ms waiting for DELIVERED (last observed status: ${lastStatus ?? "message not found"})`,
				{
					name: "mcp check_delivery_status",
					status: "fail",
					detail: `event ${eventId} last status ${lastStatus ?? "not found"} after ${timeoutMs}ms`,
				},
			);
		}
		await sleep(Math.min(500, Math.max(25, Math.floor(timeoutMs / 20))));
	}

	// 7. Cross-check the same message through messages.list.
	log.line(
		"→ checks: SDK messages.list read-back (same message, second surface)",
	);
	let page: { messages?: MessageDto[] };
	try {
		page = await client.messages.list({ subscriberId, limit: 20 });
	} catch (error) {
		throwCallFailure(error, "messages.list", "mcp messages.list");
	}
	const messages = Array.isArray(page.messages) ? page.messages : [];
	const message = messages.find(
		(candidate) =>
			normalizeEventId(String(candidate.event_id ?? "")) === wanted,
	);
	if (message === undefined) {
		throw new AssertionFailure(
			`messages.list did not return event ${eventId} for subscriber ${subscriberId}`,
			{
				name: "mcp messages.list",
				status: "fail",
				detail: `${messages.length} messages listed, none for ${eventId}`,
			},
		);
	}
	if (String(message.status) !== "DELIVERED" || message.test_mode !== true) {
		throw new AssertionFailure(
			`messages.list shows the wrong state for ${eventId}: ${describe(message)}`,
			{
				name: "mcp messages.list",
				status: "fail",
				detail: describe(message),
			},
		);
	}
	checks.push({
		name: "mcp messages.list",
		status: "pass",
		detail: `event ${eventId} present via messages.list (status DELIVERED, test_mode=true, channel=${
			message.channel ?? "?"
		})`,
	});
	log.line(
		`  ${eventId} present via messages.list (DELIVERED, test_mode=true)`,
	);

	// 8. Unknown tool: the gateway answers HTTP 200 carrying a JSON-RPC error,
	//    so the failure must be classified by the error object, never a thrown
	//    HTTP failure.
	log.line("→ checks: MCP tools/call unknown tool (JSON-RPC error path)");
	const bogusTool = "definitely_not_a_nervly_tool";
	const unknownResponse = await callGateway(
		() => client.mcp.callTool({ name: bogusTool, arguments: {} }),
		`MCP tools/call ${bogusTool}`,
		"mcp unknown tool error",
	);
	if (
		!unknownResponse.error ||
		unknownResponse.error.code !== -32602 ||
		!unknownResponse.error.message.includes("Unknown tool") ||
		!unknownResponse.error.message.includes(bogusTool)
	) {
		throw new AssertionFailure(
			`an unknown tool must surface JSON-RPC -32602 "Unknown tool"; got ${describe(unknownResponse)}`,
			{
				name: "mcp unknown tool error",
				status: "fail",
				detail: describe(unknownResponse),
			},
		);
	}
	checks.push({
		name: "mcp unknown tool error",
		status: "pass",
		detail: `HTTP 200 with JSON-RPC ${unknownResponse.error.code}: ${unknownResponse.error.message} (no thrown HTTP failure)`,
	});
	log.line(
		`  unknown tool answered JSON-RPC ${unknownResponse.error.code} "${unknownResponse.error.message}" inside HTTP 200`,
	);

	return { checks, eventId, subscriberId };
}
