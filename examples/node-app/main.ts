/**
 * Node SDK walking skeleton — the reference implementation of the example
 * harness contract (`nervly-base/docs/examples/harness-contract.md`).
 *
 * Flow: guard → bootstrap (fresh-signup, seed, or env-first) → SDK health +
 * trigger → asserted test-mode DELIVERED read-back → `artifacts/summary.json` +
 * transcript → honest exit code (0 pass / 1 assertion / 2 environment / 3
 * guard refusal). Secrets are redacted at every output boundary.
 *
 * Run through the repo entrypoint: `npm run example` (or `make example`).
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Nervly from "../../src/index.js";
import {
	type BootstrapDeps,
	type BootstrapResult,
	bootstrapFresh,
	bootstrapFromEnv,
	bootstrapSeed,
	teardownBootstrap,
} from "./harness/bootstrap.js";
import { runChecks } from "./harness/checks.js";
import { DEFAULTS, type ExampleConfig, loadConfig } from "./harness/config.js";
import { EnvironmentFailure, HarnessFailure } from "./harness/errors.js";
import { guardConfig } from "./harness/guards.js";
import { redact, redactValue } from "./harness/redact.js";
import { newRunId } from "./harness/run-id.js";
import {
	buildSummary,
	type CheckResult,
	type SummaryStatus,
	type SummaryWorkspace,
	writeSummary,
} from "./harness/summary.js";
import { Transcript } from "./harness/transcript.js";

export const EXAMPLE_NAME = "node-app";

export interface RunOptions {
	argv?: string[];
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	stdout?: (line: string) => void;
	now?: () => Date;
	bootstrapDeps?: BootstrapDeps;
}

interface CliFlags {
	json: boolean;
	help: boolean;
}

const USAGE = `Node SDK example (node-app) — walking skeleton

Usage:
  npm run example                 run with the human transcript
  npm run example -- --json       write artifacts and print summary.json
  npm run example -- --help       show this message

Environment: see nervly-base/docs/examples/harness-contract.md §1.1.
`;

/** Parse CLI flags. Unknown flags are a usage error (exit 2). */
export function parseArgs(argv: string[]): CliFlags {
	const flags: CliFlags = { json: false, help: false };
	for (const arg of argv) {
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--help" || arg === "-h") {
			flags.help = true;
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
		natsUrl: config.natsUrl,
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
	const artifactsDir = join(cwd, "artifacts");
	let config: ExampleConfig | null = null;
	let runId = newRunId(startedAt);
	let failure: HarnessFailure | null = null;
	let bootstrap: BootstrapResult | null = null;
	let removeSignals: (() => void) | null = null;
	const checks: CheckResult[] = [];
	const artifacts: string[] = [];
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
		transcript.line(`node-app run ${runId} (target=${config.target})`);

		// Guard before any network work.
		guardConfig(config);

		if (config.apiKey !== null) {
			transcript.line("→ bootstrap (env-first): using NERVLY_API_KEY");
			bootstrap = bootstrapFromEnv(config);
		} else if (config.bootstrapMode === "seed") {
			bootstrap = await bootstrapSeed(
				config,
				transcript,
				options.bootstrapDeps,
			);
		} else {
			bootstrap = await bootstrapFresh(
				config,
				transcript,
				options.bootstrapDeps,
			);
		}
		transcript.line(
			`  workspace ${bootstrap.workspace.slug ?? "?"} (source=${bootstrap.source})`,
		);
		if (bootstrap.source !== "env") {
			artifacts.push(writeBootstrapArtifact(artifactsDir, config, bootstrap));
		}
		if (!config.keep && bootstrap.source !== "env") {
			removeSignals = installSignalTeardown(async () => {
				if (bootstrap !== null && transcript !== null) {
					await teardownBootstrap(bootstrap, transcript);
				}
			});
		}

		const client = new Nervly({
			apiKey: bootstrap.apiKey,
			baseUrl: config.gatewayUrl,
			timeout: 10_000,
			maxRetries: 2,
		});
		const result = await runChecks({
			client,
			runId: config.runId,
			timeoutMs: config.checkTimeoutMs,
			log: transcript,
		});
		checks.push(...result.checks);
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
				`→ teardown: EXAMPLES_KEEP=1; keeping workspace ${bootstrap.workspace.slug ?? "?"}`,
			);
		} else {
			const cleaned = await teardownBootstrap(bootstrap, transcript);
			if (!cleaned) {
				failure = new EnvironmentFailure(
					"teardown did not complete; the ephemeral workspace or key may remain " +
						"(fallback: the smoke-local SQL cascade delete)",
				);
			}
		}
	}

	const workspace: SummaryWorkspace = bootstrap?.workspace ?? {
		slug: config?.workspaceSlug ?? null,
		id: null,
	};
	const durationMs = now().getTime() - startedAt.getTime();
	const status: SummaryStatus = failure ? failure.kind : "pass";
	const exitCode = failure ? failure.exitCode : 0;

	if (transcript !== null) {
		artifacts.unshift("transcript.log");
	}
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
			`failed to write artifacts/summary.json: ${error instanceof Error ? error.message : String(error)}\n`,
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
				? `node-app finished: PASS (run ${runId})`
				: `node-app finished: ${status.toUpperCase()} (run ${runId})`,
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
