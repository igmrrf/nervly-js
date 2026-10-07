/**
 * MCP agent example (mcp-agent) — the harness entry point.
 *
 * Flow (contract `nervly-base/docs/examples/harness-contract.md`):
 * guard → seed bootstrap (mint a unique test-mode read+write key) → a
 * deterministic agent loop over the SDK's MCP methods (`tools/list`,
 * `tools/call gateway_status`, the sandboxed and `live: true` `send_notification`
 * paths, `check_delivery_status` until the dispatched test-mode message reads
 * back `DELIVERED`, the unknown-tool JSON-RPC error path, and the SDK agent
 * toolkit) → `artifacts/mcp-agent/summary.json` + redacted transcript → revoke
 * the minted key.
 *
 * The optional LLM variant (`--llm`) additionally drives the same tools through
 * the SDK AI toolkit against a model provider; it requires a provider key and is
 * excluded from the deterministic command, which never reads a provider key.
 *
 * Exit codes: 0 pass / 1 assertion / 2 environment / 3 guard refusal.
 * Run through the repo entrypoint: `npm run example -- mcp-agent`.
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Nervly, { NervlyHttpClient } from "@nervly/sdk";
import {
	type BootstrapDeps,
	type BootstrapResult,
	bootstrapFromEnv,
	bootstrapSeed,
	teardownBootstrap,
} from "./harness/bootstrap.js";
import { runChecks } from "./harness/checks.js";
import { DEFAULTS, type ExampleConfig, loadConfig } from "./harness/config.js";
import { EnvironmentFailure, HarnessFailure } from "./harness/errors.js";
import { assertSupportedBootstrapMode, guardConfig } from "./harness/guards.js";
import { resolveLlmConfig, runLlmVariant } from "./harness/llm.js";
import { redact, redactValue } from "./harness/redact.js";
import { newRunId } from "./harness/run-id.js";
import {
	buildSummary,
	type CheckResult,
	type SummaryWorkspace,
	writeSummary,
} from "./harness/summary.js";
import { Transcript } from "./harness/transcript.js";

export const EXAMPLE_NAME = "mcp-agent";

/**
 * Per-request timeout for the SDK client. The deterministic loop bounds its
 * own waits with `EXAMPLES_CHECK_TIMEOUT_MS`; one MCP call is fast, and
 * retries are disabled so a failing stack is reported instead of retried.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

export interface RunOptions {
	argv?: string[];
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	stdout?: (line: string) => void;
	now?: () => Date;
	bootstrapDeps?: BootstrapDeps;
	/** Test seam for the optional LLM variant's provider transport. */
	fetchFn?: typeof fetch;
}

interface CliFlags {
	json: boolean;
	help: boolean;
	llm: boolean;
}

const USAGE = `MCP agent example (mcp-agent) — deterministic MCP tool-calling loop

Usage:
  npm run example -- mcp-agent            run the deterministic core (no model)
  npm run example -- mcp-agent --json     write artifacts and print summary.json
  npm run example -- mcp-agent --llm      also run the optional LLM variant
                                          (requires OPENAI_API_KEY or ANTHROPIC_API_KEY)
  npm run example -- mcp-agent --help     show this message

Environment: see nervly-base/docs/examples/harness-contract.md §1.1.
The optional LLM variant additionally reads NERVLY_LLM_PROVIDER (openai|anthropic),
OPENAI_API_KEY / ANTHROPIC_API_KEY and NERVLY_LLM_MODEL; it never runs otherwise.
`;

/** Parse CLI flags. Unknown flags are a usage error (exit 2). */
export function parseArgs(argv: string[]): CliFlags {
	const flags: CliFlags = { json: false, help: false, llm: false };
	for (const arg of argv) {
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--help" || arg === "-h") {
			flags.help = true;
		} else if (arg === "--llm") {
			flags.llm = true;
		} else if (arg !== "") {
			throw new EnvironmentFailure(`unknown argument: ${arg}\n\n${USAGE}`);
		}
	}
	return flags;
}

function toHarnessFailure(error: unknown): HarnessFailure {
	if (error instanceof HarnessFailure) return error;
	return new EnvironmentFailure(
		`unexpected failure: ${error instanceof Error ? error.message : String(error)}`,
		undefined,
		{ cause: error },
	);
}

/**
 * Trap-based teardown: on SIGINT/SIGTERM the run attempts cleanup before
 * exiting (contract §5). Returns a disposer that removes the handlers.
 */
function installSignalTeardown(teardown: () => Promise<void>): () => void {
	let handling = false;
	const handler = (signal: NodeJS.Signals) => {
		if (handling) {
			process.exit(signal === "SIGINT" ? 130 : 143);
		}
		handling = true;
		const force = setTimeout(() => process.exit(130), 5000);
		force.unref();
		void teardown().finally(() => {
			clearTimeout(force);
			process.exit(signal === "SIGINT" ? 130 : 143);
		});
	};
	process.once("SIGINT", handler);
	process.once("SIGTERM", handler);
	return () => {
		process.removeListener("SIGINT", handler);
		process.removeListener("SIGTERM", handler);
	};
}

function writeBootstrapArtifact(
	artifactsDir: string,
	config: ExampleConfig,
	bootstrap: BootstrapResult,
): string {
	mkdirSync(artifactsDir, { recursive: true });
	const path = join(artifactsDir, "bootstrap.json");
	const payload = redactValue({
		runId: config.runId,
		target: config.target,
		mode: bootstrap.source,
		gatewayUrl: config.gatewayUrl,
		controlUrl: config.controlUrl,
		workspace: bootstrap.workspace,
		apiKey: {
			id: bootstrap.keyId,
			name: bootstrap.keyName,
			mode: "test",
		},
		createdAt: new Date().toISOString(),
	});
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return "bootstrap.json";
}

/**
 * Run the example end to end and return the contract exit code. Never throws:
 * every failure is mapped to a status, a summary and an exit code.
 */
export async function runExample(options: RunOptions = {}): Promise<number> {
	const argv = options.argv ?? process.argv.slice(2);
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const now = options.now ?? (() => new Date());

	const startedAt = now();
	const artifactsDir = join(cwd, "artifacts", "mcp-agent");
	let config: ExampleConfig | null = null;
	let runId = newRunId(startedAt);
	let failure: HarnessFailure | null = null;
	let bootstrap: BootstrapResult | null = null;
	let removeSignals: (() => void) | null = null;
	const checks: CheckResult[] = [];
	let jsonMode = false;
	let transcript: Transcript | null = null;

	try {
		const flags = parseArgs(argv);
		jsonMode = flags.json;
		if (flags.help) {
			(options.stdout ?? ((line: string) => process.stdout.write(line)))(USAGE);
			return 0;
		}
		transcript = new Transcript({
			artifactsDir,
			jsonMode: flags.json,
			stdout: options.stdout,
		});

		config = loadConfig(env, { now: startedAt });
		runId = config.runId;
		transcript.line(`mcp-agent run ${runId} (target=${config.target})`);

		// Guards and preconditions before any network work.
		guardConfig(config);
		assertSupportedBootstrapMode(config);

		// The optional variant's provider key is checked before bootstrap: an
		// absent key must fail without minting (and having to revoke) a key.
		if (flags.llm) {
			resolveLlmConfig(env);
		}

		if (config.apiKey !== null) {
			transcript.line("→ bootstrap (env-first): using NERVLY_API_KEY");
			bootstrap = bootstrapFromEnv(config);
		} else {
			bootstrap = await bootstrapSeed(
				config,
				transcript,
				options.bootstrapDeps,
			);
		}
		transcript.line(
			`  workspace ${bootstrap.workspace.slug ?? "?"} (source=${bootstrap.source})`,
		);
		if (bootstrap.source !== "env") {
			transcript.line(
				`→ artifact: ${writeBootstrapArtifact(artifactsDir, config, bootstrap)}`,
			);
		}

		if (!config.keep && bootstrap.source !== "env") {
			removeSignals = installSignalTeardown(async () => {
				if (bootstrap !== null && transcript !== null) {
					await teardownBootstrap(bootstrap, transcript);
				}
			});
		}

		const sdkConfig = {
			apiKey: bootstrap.apiKey,
			baseUrl: config.gatewayUrl,
			timeout: REQUEST_TIMEOUT_MS,
			maxRetries: 0,
		} as const;
		const client = new Nervly(sdkConfig);
		// The toolkit binds to the low-level HTTP client (its documented
		// constructor argument), so the example constructs both from one config.
		const httpClient = new NervlyHttpClient(sdkConfig);

		const result = await runChecks({
			client,
			httpClient,
			runId: config.runId,
			timeoutMs: config.checkTimeoutMs,
			log: transcript,
		});
		checks.push(...result.checks);

		if (flags.llm) {
			const llmResult = await runLlmVariant({
				httpClient,
				log: transcript,
				env,
				fetchFn: options.fetchFn,
			});
			checks.push({
				name: "llm variant",
				status: "pass",
				detail: `provider=${llmResult.provider} model=${llmResult.model} tool calls=${
					llmResult.toolCalls.join(", ") || "none"
				}; final: ${llmResult.finalText.slice(0, 200)}`,
			});
			transcript.line(`  model: ${llmResult.finalText}`);
		}

		transcript.line("✓ all checks passed (asserted test-mode DELIVERED)");
	} catch (error) {
		failure = toHarnessFailure(error);
		if (failure.check) checks.push(failure.check);
		if (transcript) {
			transcript.line(`✗ ${failure.kind}: ${redact(failure.message)}`);
		} else {
			(options.stdout ?? ((line: string) => process.stdout.write(line)))(
				`✗ ${failure.kind}: ${redact(failure.message)}\n`,
			);
		}
	}

	// Teardown is always attempted (unless EXAMPLES_KEEP=1 or env-first).
	if (removeSignals !== null) {
		removeSignals();
		removeSignals = null;
	}
	if (bootstrap !== null && config !== null && transcript !== null) {
		if (config.keep) {
			transcript.line(
				`→ teardown: EXAMPLES_KEEP=1; keeping key ${bootstrap.keyName ?? "?"} for debugging`,
			);
		} else {
			const cleaned = await teardownBootstrap(bootstrap, transcript);
			if (!cleaned) {
				failure = new EnvironmentFailure(
					"teardown did not complete; the minted test key may remain active",
				);
			}
		}
	}

	const workspace: SummaryWorkspace = bootstrap?.workspace ?? {
		slug: config?.workspaceSlug ?? null,
		id: null,
	};
	const durationMs = now().getTime() - startedAt.getTime();
	const status = failure ? failure.kind : "pass";
	const exitCode = failure ? failure.exitCode : 0;

	const artifacts = ["transcript.log", "bootstrap.json"].filter((name) =>
		existsSync(join(artifactsDir, name)),
	);
	const summary = buildSummary({
		example: EXAMPLE_NAME,
		target: config?.target ?? DEFAULTS.target,
		runId,
		startedAt,
		durationMs,
		status,
		workspace,
		checks,
		artifacts,
	});

	try {
		const summaryPath = writeSummary(artifactsDir, summary);
		transcript?.line(`summary: ${summaryPath}`);
	} catch (error) {
		process.stderr.write(
			`failed to write artifacts/mcp-agent/summary.json: ${
				error instanceof Error ? error.message : String(error)
			}\n`,
		);
		return 2;
	}

	if (jsonMode) {
		(options.stdout ?? ((line: string) => process.stdout.write(line)))(
			`${JSON.stringify(summary, null, 2)}\n`,
		);
	} else if (transcript !== null) {
		transcript.line(
			status === "pass"
				? `mcp-agent finished: PASS (run ${runId})`
				: `mcp-agent finished: ${status.toUpperCase()} (run ${runId})`,
		);
	}

	return exitCode;
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
	runExample().then((code) => {
		process.exitCode = code;
	});
}
