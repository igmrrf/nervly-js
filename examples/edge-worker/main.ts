/**
 * Edge SDK example (edge-worker) — the harness entry point.
 *
 * Flow (contract `nervly-base/docs/examples/harness-contract.md`):
 * guard → seed bootstrap (mint a unique test-mode read+write key) → verify the
 * built SDK entry → hand the key to workerd through a git-ignored `.dev.vars`
 * → `wrangler dev` on a free port → drive the worker's HTTP routes → assert the
 * test-mode message reads back `DELIVERED` → `artifacts/edge-worker/summary.json`
 * + redacted transcript → stop wrangler → revoke the key.
 *
 * Exit codes: 0 pass / 1 assertion / 2 environment / 3 guard refusal.
 * Run through the repo entrypoint: `npm run example -- edge-worker`.
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type BootstrapDeps,
	type BootstrapResult,
	bootstrapFromEnv,
	bootstrapSeed,
	teardownBootstrap,
} from "./harness/bootstrap.js";
import { runChecks } from "./harness/checks.js";
import { DEFAULTS, type ExampleConfig, loadConfig } from "./harness/config.js";
import { removeDevVars, writeDevVars } from "./harness/dev-vars.js";
import { EnvironmentFailure, HarnessFailure } from "./harness/errors.js";
import { assertSupportedBootstrapMode, guardConfig } from "./harness/guards.js";
import { redact, redactValue } from "./harness/redact.js";
import { newRunId } from "./harness/run-id.js";
import { assertSdkDist } from "./harness/sdk-dist.js";
import {
	buildSummary,
	type CheckResult,
	type SummaryWorkspace,
	writeSummary,
} from "./harness/summary.js";
import { Transcript } from "./harness/transcript.js";
import {
	EXAMPLE_DIR,
	findFreePort,
	REPO_ROOT,
	type RunningWrangler,
	startWrangler,
} from "./harness/wrangler.js";

export const EXAMPLE_NAME = "edge-worker";

/**
 * Upper bound on "wrangler dev is up and answering". The first run in a fresh
 * checkout may download the workerd runtime; everything after that starts in
 * seconds. Bounded per contract §5 (no unbounded poll loops).
 */
export const WRANGLER_READY_TIMEOUT_MS = 120_000;

export interface RunOptions {
	argv?: string[];
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	stdout?: (line: string) => void;
	now?: () => Date;
	bootstrapDeps?: BootstrapDeps;
	/** Test seam for the wrangler process manager. */
	startWranglerFn?: typeof startWrangler;
	/** Test seam for the worker checks transport. */
	fetchFn?: typeof fetch;
}

interface CliFlags {
	json: boolean;
	help: boolean;
}

const USAGE = `Edge SDK example (edge-worker) — workerd via wrangler dev

Usage:
  npm run example -- edge-worker           run with the human transcript
  npm run example -- edge-worker --json    write artifacts and print summary.json
  npm run example -- edge-worker --help    show this message

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
 * Trap-based teardown: on SIGINT/SIGTERM the run stops wrangler, removes
 * `.dev.vars` and revokes the minted key before exiting (contract §5). Returns
 * a disposer that removes the handlers.
 */
function installSignalTeardown(teardown: () => Promise<void>): () => void {
	let handling = false;
	const handler = (signal: NodeJS.Signals) => {
		if (handling) {
			process.exit(signal === "SIGINT" ? 130 : 143);
		}
		handling = true;
		const force = setTimeout(() => process.exit(130), 10_000);
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
	const startWranglerFn = options.startWranglerFn ?? startWrangler;

	const startedAt = now();
	const artifactsDir = join(cwd, "artifacts", "edge-worker");
	let config: ExampleConfig | null = null;
	let runId = newRunId(startedAt);
	let failure: HarnessFailure | null = null;
	let bootstrap: BootstrapResult | null = null;
	let wrangler: RunningWrangler | null = null;
	let removeSignals: (() => void) | null = null;
	let devVarsPath: string | null = null;
	const checks: CheckResult[] = [];
	let jsonMode = false;
	let transcript: Transcript | null = null;

	/** Best-effort local cleanup; safe to call more than once. */
	const stopRuntime = async (): Promise<void> => {
		if (wrangler !== null) {
			const running = wrangler;
			wrangler = null;
			try {
				await running.stop();
			} catch {
				// stop() never throws in practice; keep teardown moving.
			}
		}
		if (devVarsPath !== null) {
			removeDevVars(devVarsPath);
		}
	};

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
		transcript.line(`edge-worker run ${runId} (target=${config.target})`);

		// Guards and preconditions before any network work.
		guardConfig(config);
		assertSupportedBootstrapMode(config);
		transcript.line("→ check: SDK dist present and fresh");
		assertSdkDist(REPO_ROOT);

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

		if (!config.keep) {
			removeSignals = installSignalTeardown(async () => {
				await stopRuntime();
				if (bootstrap !== null && transcript !== null) {
					await teardownBootstrap(bootstrap, transcript);
				}
			});
		}

		// The secret goes to workerd through the git-ignored `.dev.vars` only.
		devVarsPath = join(EXAMPLE_DIR, ".dev.vars");
		writeDevVars(devVarsPath, {
			NERVLY_API_KEY: bootstrap.apiKey,
			NERVLY_API_URL: config.gatewayUrl,
		});

		const port = await findFreePort();
		const inspectorPort = await findFreePort();
		transcript.line(`→ wrangler: starting local workerd on port ${port}`);
		wrangler = await startWranglerFn({
			cwd: EXAMPLE_DIR,
			configPath: join(EXAMPLE_DIR, "wrangler.jsonc"),
			port,
			inspectorPort,
			persistDir: join(artifactsDir, "wrangler-state"),
			logPath: join(artifactsDir, "wrangler.log"),
			readyTimeoutMs: WRANGLER_READY_TIMEOUT_MS,
		});
		transcript.line(`  worker ready at ${wrangler.url}`);

		const result = await runChecks({
			workerUrl: wrangler.url,
			runId: config.runId,
			timeoutMs: config.checkTimeoutMs,
			log: transcript,
			fetchFn: options.fetchFn,
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
	await stopRuntime();
	if (devVarsPath !== null && existsSync(devVarsPath) && failure === null) {
		failure = new EnvironmentFailure(
			`could not remove the local secret file at ${devVarsPath}; delete it before committing`,
		);
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

	const artifacts = ["transcript.log", "bootstrap.json", "wrangler.log"].filter(
		(name) => existsSync(join(artifactsDir, name)),
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
			`failed to write artifacts/edge-worker/summary.json: ${
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
				? `edge-worker finished: PASS (run ${runId})`
				: `edge-worker finished: ${status.toUpperCase()} (run ${runId})`,
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
