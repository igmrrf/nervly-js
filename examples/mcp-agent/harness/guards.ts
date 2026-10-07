/**
 * Pre-flight guards (contract §6): the harness refuses to run against anything
 * that is not a local stack with a test-mode key, before it touches the
 * network. Every refusal maps to exit code 3.
 */

import type { ExampleConfig } from "./config.js";
import { GuardRefusal } from "./errors.js";

/** Hostnames the local stack may use. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** True when `hostname` is a local host (`localhost`, `127.0.0.1`, `::1`). */
export function isLocalHost(hostname: string): boolean {
	const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return LOCAL_HOSTS.has(bare);
}

/** Refuse a URL whose host is not local. Throws {@link GuardRefusal}. */
export function assertLocalUrl(name: string, rawUrl: string): void {
	let hostname: string;
	try {
		hostname = new URL(rawUrl).hostname;
	} catch {
		throw new GuardRefusal(`${name}=${rawUrl} is not a valid URL`);
	}
	if (!isLocalHost(hostname)) {
		throw new GuardRefusal(
			`${name}=${rawUrl} is not a local host; this harness only runs against a local stack (sandbox support is ticket 16)`,
		);
	}
}

/** Refuse a key that is not a test key. */
export function assertTestKey(apiKey: string | null): void {
	if (apiKey === null) return;
	if (!apiKey.startsWith("nervly_sk_test_")) {
		throw new GuardRefusal(
			"NERVLY_API_KEY is not a test-mode key (the harness only accepts test keys); live keys are never used by examples",
		);
	}
}

/** Run every guard; throws {@link GuardRefusal} on the first violation. */
export function guardConfig(config: ExampleConfig): void {
	if (config.target !== "local") {
		throw new GuardRefusal(
			`NERVLY_TARGET=${config.target} is not supported; only "local" is implemented (sandbox support is ticket 16)`,
		);
	}
	assertLocalUrl("NERVLY_API_URL", config.apiUrl);
	assertLocalUrl("NERVLY_GATEWAY_URL", config.gatewayUrl);
	assertLocalUrl("NERVLY_CONTROL_URL", config.controlUrl);
	assertLocalUrl("NERVLY_NATS_URL", config.natsUrl);
	assertTestKey(config.apiKey);
}

/**
 * This example implements the seed and env-first bootstrap paths. `fresh` is
 * refused before any work because the current platform cannot expose the
 * verification token to an unprivileged harness (contract §1.2).
 */
export function assertSupportedBootstrapMode(config: ExampleConfig): void {
	if (config.bootstrapMode === "fresh" && config.apiKey === null) {
		throw new GuardRefusal(
			'EXAMPLES_BOOTSTRAP=fresh is not implemented by this example; use the default "seed" mode (contract §1.2: the current platform cannot expose the verification token)',
		);
	}
}
