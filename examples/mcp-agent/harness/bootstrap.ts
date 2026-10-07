/**
 * Bootstrap and teardown for the mcp-agent example (contract §1.3 + §1.4).
 *
 * Seed mode: log in as the dev seed user and mint one uniquely named
 * test-mode read+write key; teardown revokes it. Env-first (`NERVLY_API_KEY`
 * set) skips bootstrap entirely; nothing is owned and nothing is torn down.
 * `fresh` is refused by the guards before bootstrap starts (contract §1.2).
 */

import type { ExampleConfig } from "./config.js";
import { ConsoleClient } from "./console.js";
import { EnvironmentFailure } from "./errors.js";
import type { Transcript } from "./transcript.js";

export type BootstrapSource = "seed" | "env";

export interface BootstrapResult {
	source: BootstrapSource;
	apiKey: string;
	keyId: string | null;
	keyName: string | null;
	workspace: { slug: string | null; id: string | null };
	/** Authenticated console session used for teardown; null in env-first mode. */
	console: ConsoleClient | null;
	csrfToken: string | null;
}

export interface BootstrapDeps {
	/** Test seam for the control-plane transport. */
	fetchFn?: typeof fetch;
}

function field(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | null {
	const found = field(value, key);
	return typeof found === "string" && found !== "" ? found : null;
}

function describe(body: unknown): string {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	if (text === undefined || text === "") return "(no body)";
	return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function expectStatus(
	response: { status: number; body: unknown },
	expected: number,
	step: string,
): void {
	if (response.status !== expected) {
		throw new EnvironmentFailure(
			`${step} failed with HTTP ${response.status}: ${describe(response.body)}`,
		);
	}
}

async function login(
	console: ConsoleClient,
	email: string,
	password: string,
	step: string,
): Promise<{
	csrfToken: string;
	workspace: { slug: string | null; id: string | null };
}> {
	const response = await console.request("POST", "/auth/login", {
		body: { email, password },
	});
	expectStatus(response, 200, step);
	const csrfToken = stringField(response.body, "csrf_token");
	if (csrfToken === null) {
		throw new EnvironmentFailure(`${step} returned no csrf_token`);
	}
	const workspace = field(response.body, "workspace");
	return {
		csrfToken,
		workspace: {
			slug: stringField(workspace, "slug"),
			id: stringField(workspace, "id"),
		},
	};
}

async function createTestKey(
	console: ConsoleClient,
	config: ExampleConfig,
	csrfToken: string,
): Promise<{ apiKey: string; keyId: string | null; keyName: string }> {
	const keyName = `examples-${config.runId}`;
	const response = await console.request("POST", "/console/api-keys", {
		csrf: csrfToken,
		body: { name: keyName, mode: "test", scopes: ["read", "write"] },
	});
	expectStatus(response, 201, "creating the test API key");
	const apiKey = stringField(response.body, "token");
	if (apiKey === null || !apiKey.startsWith("nervly_sk_test_")) {
		throw new EnvironmentFailure(
			"creating the test API key returned no test-mode token",
		);
	}
	return { apiKey, keyId: stringField(response.body, "id"), keyName };
}

const SEED_EMAIL = "dev@nervly.local";
const SEED_PASSWORD = "DevPassword123!";

/** Seed-mode bootstrap: login as the dev seed user, mint one test key. */
export async function bootstrapSeed(
	config: ExampleConfig,
	log: Transcript,
	deps: BootstrapDeps = {},
): Promise<BootstrapResult> {
	const console = new ConsoleClient(
		config.controlUrl,
		deps.fetchFn ?? fetch,
		config.bootstrapTimeoutMs,
	);
	log.line(`→ bootstrap (seed): login as ${SEED_EMAIL}`);
	const session = await login(console, SEED_EMAIL, SEED_PASSWORD, "seed login");
	const key = await createTestKey(console, config, session.csrfToken);
	log.line(`  minted test-mode key ${key.keyName} (id ${key.keyId ?? "?"})`);
	return {
		source: "seed",
		apiKey: key.apiKey,
		keyId: key.keyId,
		keyName: key.keyName,
		workspace: session.workspace,
		console,
		csrfToken: session.csrfToken,
	};
}

/** Env-first: the caller supplied a test key; nothing is provisioned. */
export function bootstrapFromEnv(config: ExampleConfig): BootstrapResult {
	return {
		source: "env",
		apiKey: config.apiKey ?? "",
		keyId: null,
		keyName: null,
		workspace: { slug: config.workspaceSlug, id: null },
		console: null,
		csrfToken: null,
	};
}

/**
 * Attempt teardown of everything the run created. Idempotent; returns false
 * when the control plane refused or could not be reached (the caller turns
 * that into an environment failure).
 */
export async function teardownBootstrap(
	bootstrap: BootstrapResult,
	log: Transcript,
): Promise<boolean> {
	if (bootstrap.source === "env") {
		log.line("→ teardown: env-first run owns nothing; skipping");
		return true;
	}

	if (bootstrap.console === null) {
		log.line("→ teardown: no session was captured; nothing can be torn down");
		return false;
	}

	try {
		if (bootstrap.keyId === null) {
			log.line("→ teardown: no key id captured; skipping revoke");
			return false;
		}
		log.line(
			`→ teardown: revoking API key ${bootstrap.keyName ?? bootstrap.keyId}`,
		);
		const response = await bootstrap.console.request(
			"DELETE",
			`/console/api-keys/${encodeURIComponent(bootstrap.keyId)}`,
			{ csrf: bootstrap.csrfToken ?? undefined },
		);
		if (response.status !== 200 && response.status !== 204) {
			log.line(
				`  teardown failed with HTTP ${response.status}: ${describe(response.body)}`,
			);
			return false;
		}
		log.line("  API key revoked");
		return true;
	} catch (error) {
		// Teardown is best effort by contract; the caller decides the exit code.
		log.line(
			`  teardown error: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}
