/**
 * The optional LLM variant: the same MCP tools, but through the SDK's agent
 * toolkit (`createNervlyAiToolkit` → `toOpenAITools()` / `toAnthropicTools()`)
 * wired to a real model provider.
 *
 * It is **not** part of the deterministic core and never runs under
 * `npm run example -- mcp-agent`; it is a documented separate invocation:
 *
 *   npm run example -- mcp-agent --llm
 *
 * That invocation requires a provider key (`OPENAI_API_KEY` or
 * `ANTHROPIC_API_KEY`, chosen by `NERVLY_LLM_PROVIDER`, default `openai`) and
 * exits 2 with a message naming the variable when the key is absent. The
 * default deterministic command never reads any of these variables, so a
 * missing provider key can never fail it.
 *
 * No provider SDK is imported: the requests are plain `fetch` calls against the
 * providers' HTTP APIs, so the example keeps the SDK's zero-dependency story.
 */

import type { NervlyHttpClient } from "@nervly/sdk";
import { createNervlyAiToolkit, type NervlyAiToolkit } from "@nervly/sdk";
import { EnvironmentFailure } from "./errors.js";
import type { Transcript } from "./transcript.js";

export type LlmProvider = "openai" | "anthropic";

export interface LlmConfig {
	provider: LlmProvider;
	apiKey: string;
	model: string;
}

export const LLM_DEFAULTS = {
	provider: "openai" as LlmProvider,
	openaiModel: "gpt-4o-mini",
	anthropicModel: "claude-3-5-haiku-latest",
	/** Upper bound on model turns; keeps the variant bounded like every check. */
	maxTurns: 5,
	requestTimeoutMs: 60_000,
} as const;

/** The instruction the model is given for the demonstration. */
export const LLM_PROMPT =
	"Use the available Nervly tools to check the gateway status, then answer in one short sentence naming the service, its uptime and whether NATS is connected.";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text === undefined || text === "") return "(no body)";
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Resolve the variant's provider configuration. A missing provider key is an
 * environment failure (exit 2) that names the variable to set; the
 * deterministic core is unaffected because it never calls this.
 */
export function resolveLlmConfig(
	env: NodeJS.ProcessEnv = process.env,
): LlmConfig {
	const raw =
		env.NERVLY_LLM_PROVIDER?.trim().toLowerCase() || LLM_DEFAULTS.provider;
	if (raw !== "openai" && raw !== "anthropic") {
		throw new EnvironmentFailure(
			`NERVLY_LLM_PROVIDER=${raw} is not supported; use "openai" or "anthropic"`,
		);
	}
	const provider: LlmProvider = raw;
	const keyName =
		provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
	const apiKey = env[keyName]?.trim();
	if (!apiKey) {
		throw new EnvironmentFailure(
			`the optional LLM variant requires a provider key: set ${keyName} (run "npm run example -- mcp-agent --llm"); the default deterministic run needs no provider key`,
		);
	}
	const model =
		env.NERVLY_LLM_MODEL?.trim() ||
		(provider === "openai"
			? LLM_DEFAULTS.openaiModel
			: LLM_DEFAULTS.anthropicModel);
	return { provider, apiKey, model };
}

export interface LlmVariantOptions {
	/**
	 * The low-level HTTP client `createNervlyAiToolkit` binds to (the toolkit's
	 * documented constructor argument; `Nervly` wraps this internally).
	 */
	httpClient: NervlyHttpClient;
	log: Transcript;
	/** Resolved provider config; when omitted, resolved from `env`. */
	llm?: LlmConfig;
	env?: NodeJS.ProcessEnv;
	/** Test seam for the provider transport. */
	fetchFn?: typeof fetch;
	maxTurns?: number;
}

export interface LlmVariantResult {
	provider: LlmProvider;
	model: string;
	/** The tools the model chose to call, in order. */
	toolCalls: string[];
	finalText: string;
}

/** POST JSON to a provider and parse a JSON object back. */
async function postProviderJson(
	fetchFn: typeof fetch,
	url: string,
	headers: Record<string, string>,
	body: unknown,
	context: string,
): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetchFn(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(LLM_DEFAULTS.requestTimeoutMs),
		});
	} catch (error) {
		throw new EnvironmentFailure(
			`${context} request failed: ${error instanceof Error ? error.message : String(error)}`,
			undefined,
			{ cause: error },
		);
	}
	const text = await response.text();
	if (!response.ok) {
		throw new EnvironmentFailure(
			`${context} returned HTTP ${response.status}: ${describe(text)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new EnvironmentFailure(
			`${context} returned a non-JSON body: ${describe(text)}`,
			undefined,
			{ cause: error },
		);
	}
	if (!isRecord(parsed)) {
		throw new EnvironmentFailure(
			`${context} returned an unexpected body: ${describe(parsed)}`,
		);
	}
	return parsed;
}

/**
 * Execute one model-chosen tool through the toolkit. A tool error is returned
 * to the model as the tool's result (the agentic contract) rather than ending
 * the run: the model can decide what to do next.
 */
async function executeTool(
	toolkit: NervlyAiToolkit,
	name: string,
	args: Record<string, unknown>,
	log: Transcript,
): Promise<unknown> {
	log.line(
		`  → tool ${name}(${Object.keys(args).join(", ") || "no arguments"})`,
	);
	try {
		const result = await toolkit.execute(name, args);
		log.line(`    ${describe(result)}`);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.line(`    tool failed: ${message}`);
		return { error: message };
	}
}

function parseArguments(raw: unknown): Record<string, unknown> {
	if (isRecord(raw)) return raw;
	if (typeof raw === "string" && raw.trim() !== "") {
		try {
			const parsed = JSON.parse(raw);
			return isRecord(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}
	return {};
}

/**
 * Run the model-driven variant to completion and return the transcript of what
 * happened. Bounded by `maxTurns`; throws {@link EnvironmentFailure} when the
 * provider or the model loop fails.
 */
export async function runLlmVariant(
	options: LlmVariantOptions,
): Promise<LlmVariantResult> {
	const { httpClient, log } = options;
	const llm = options.llm ?? resolveLlmConfig(options.env);
	const fetchFn = options.fetchFn ?? fetch;
	const maxTurns = options.maxTurns ?? LLM_DEFAULTS.maxTurns;
	const toolkit = createNervlyAiToolkit(httpClient);
	const toolCalls: string[] = [];

	log.line(
		`→ llm variant: provider=${llm.provider} model=${llm.model} (requires a provider key; not part of the deterministic core)`,
	);

	if (llm.provider === "openai") {
		const messages: Array<Record<string, unknown>> = [
			{ role: "user", content: LLM_PROMPT },
		];
		for (let turn = 0; turn < maxTurns; turn++) {
			const data = await postProviderJson(
				fetchFn,
				OPENAI_URL,
				{ authorization: `Bearer ${llm.apiKey}` },
				{
					model: llm.model,
					messages,
					tools: toolkit.openai(),
					tool_choice: "auto",
				},
				"OpenAI chat completion",
			);
			const choices = Array.isArray(data.choices) ? data.choices : [];
			const first = choices.find(isRecord);
			const message = isRecord(first?.message) ? first.message : null;
			if (message === null) {
				throw new EnvironmentFailure(
					`OpenAI returned no message: ${describe(data)}`,
				);
			}
			const calls = Array.isArray(message.tool_calls)
				? message.tool_calls.filter(isRecord)
				: [];
			if (calls.length === 0) {
				const finalText =
					typeof message.content === "string" ? message.content : "";
				return {
					provider: llm.provider,
					model: llm.model,
					toolCalls,
					finalText,
				};
			}
			messages.push(message);
			for (const call of calls) {
				const fn = isRecord(call.function) ? call.function : {};
				const name = typeof fn.name === "string" ? fn.name : "";
				const args = parseArguments(fn.arguments);
				const result = await executeTool(toolkit, name, args, log);
				toolCalls.push(name);
				messages.push({
					role: "tool",
					tool_call_id: typeof call.id === "string" ? call.id : "",
					content: JSON.stringify(result ?? null),
				});
			}
		}
	} else {
		const messages: Array<Record<string, unknown>> = [
			{ role: "user", content: LLM_PROMPT },
		];
		for (let turn = 0; turn < maxTurns; turn++) {
			const data = await postProviderJson(
				fetchFn,
				ANTHROPIC_URL,
				{
					"x-api-key": llm.apiKey,
					"anthropic-version": "2023-06-01",
				},
				{
					model: llm.model,
					max_tokens: 1024,
					messages,
					tools: toolkit.anthropic(),
				},
				"Anthropic messages",
			);
			const content = Array.isArray(data.content)
				? data.content.filter(isRecord)
				: [];
			const toolUses = content.filter((block) => block.type === "tool_use");
			if (toolUses.length === 0) {
				const finalText = content
					.filter((block) => block.type === "text")
					.map((block) => (typeof block.text === "string" ? block.text : ""))
					.join("\n")
					.trim();
				return {
					provider: llm.provider,
					model: llm.model,
					toolCalls,
					finalText,
				};
			}
			messages.push({ role: "assistant", content });
			const results: Array<Record<string, unknown>> = [];
			for (const block of toolUses) {
				const name = typeof block.name === "string" ? block.name : "";
				const args = isRecord(block.input) ? block.input : {};
				const result = await executeTool(toolkit, name, args, log);
				toolCalls.push(name);
				results.push({
					type: "tool_result",
					tool_use_id: typeof block.id === "string" ? block.id : "",
					content: JSON.stringify(result ?? null),
				});
			}
			messages.push({ role: "user", content: results });
		}
	}

	throw new EnvironmentFailure(
		`the model did not produce a final answer within ${maxTurns} turns`,
	);
}
