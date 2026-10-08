/**
 * Harness configuration: the contract's environment variables, resolved with
 * their documented defaults. Every field here is part of the contract
 * (`nervly-base/docs/examples/harness-contract.md` §1.1).
 */

import { GuardRefusal } from "./errors.js";
import { isValidRunId, newRunId } from "./run-id.js";

export type BootstrapMode = "fresh" | "seed";

export interface ExampleConfig {
	target: string;
	/** Gateway URL actually used for data-plane calls (NERVLY_GATEWAY_URL wins). */
	gatewayUrl: string;
	/** Raw NERVLY_API_URL (or its default), kept for the host guard. */
	apiUrl: string;
	controlUrl: string;
	natsUrl: string;
	apiKey: string | null;
	workspaceSlug: string | null;
	runId: string;
	bootstrapMode: BootstrapMode;
	keep: boolean;
	bootstrapTimeoutMs: number;
	checkTimeoutMs: number;
}

export const SANDBOX_API_URL = "https://sandbox-api.nervly.io";

export const DEFAULTS = {
	target: "local",
	apiUrl: "http://localhost:8080",
	controlUrl: "http://localhost:8081",
	natsUrl: "nats://localhost:4222",
	bootstrapMode: "seed" as BootstrapMode,
	bootstrapTimeoutMs: 60_000,
	checkTimeoutMs: 30_000,
} as const;

export interface LoadConfigOptions {
	now?: Date;
	random?: () => number;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
	const value = env[name]?.trim();
	return value ? value : null;
}

function positiveInt(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
): number {
	const raw = optional(env, name);
	if (raw === null) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
		throw new GuardRefusal(
			`${name}=${raw} is not a positive integer number of milliseconds`,
		);
	}
	return parsed;
}

/**
 * Resolve the contract environment into an {@link ExampleConfig}. A malformed
 * run id or timeout is a guard refusal (exit 3): the harness must not begin
 * work it cannot finish safely.
 */
export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	options: LoadConfigOptions = {},
): ExampleConfig {
	const rawRunId = optional(env, "NERVLY_RUN_ID");
	let runId: string;
	if (rawRunId === null) {
		runId = newRunId(options.now, options.random);
	} else if (isValidRunId(rawRunId)) {
		runId = rawRunId;
	} else {
		throw new GuardRefusal(
			`NERVLY_RUN_ID=${rawRunId} is malformed; use [A-Za-z0-9._-]{1,64}`,
		);
	}

	const bootstrapRaw =
		optional(env, "EXAMPLES_BOOTSTRAP") ?? DEFAULTS.bootstrapMode;
	if (bootstrapRaw !== "fresh" && bootstrapRaw !== "seed") {
		throw new GuardRefusal(
			`EXAMPLES_BOOTSTRAP=${bootstrapRaw} is not supported; use "fresh" or "seed"`,
		);
	}

	const target = optional(env, "NERVLY_TARGET") ?? DEFAULTS.target;
	const defaultApiUrl =
		target === "sandbox" ? SANDBOX_API_URL : DEFAULTS.apiUrl;
	const apiUrl = optional(env, "NERVLY_API_URL") ?? defaultApiUrl;
	const gatewayOverride = optional(env, "NERVLY_GATEWAY_URL");

	return {
		target,
		gatewayUrl: gatewayOverride ?? apiUrl,
		apiUrl,
		controlUrl: optional(env, "NERVLY_CONTROL_URL") ?? DEFAULTS.controlUrl,
		natsUrl: optional(env, "NERVLY_NATS_URL") ?? DEFAULTS.natsUrl,
		apiKey: optional(env, "NERVLY_API_KEY"),
		workspaceSlug: optional(env, "NERVLY_WORKSPACE_SLUG"),
		runId,
		bootstrapMode: bootstrapRaw,
		keep: optional(env, "EXAMPLES_KEEP") === "1",
		bootstrapTimeoutMs: positiveInt(
			env,
			"EXAMPLES_BOOTSTRAP_TIMEOUT_MS",
			DEFAULTS.bootstrapTimeoutMs,
		),
		checkTimeoutMs: positiveInt(
			env,
			"EXAMPLES_CHECK_TIMEOUT_MS",
			DEFAULTS.checkTimeoutMs,
		),
	};
}
