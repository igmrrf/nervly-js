/**
 * Bootstrap and teardown for the walking skeleton (contract §1.2/§1.3).
 *
 * Fresh mode (default): signup → NATS-captured verification token → verify →
 * login → create a test-mode read+write API key. Seed mode (fallback): log in
 * as the dev seed user and mint/revoke one uniquely named test key. Env-first
 * (`NERVLY_API_KEY` set) skips bootstrap entirely; nothing is owned.
 */

import { randomUUID } from "node:crypto";
import type { ExampleConfig } from "./config.js";
import { ConsoleClient } from "./console.js";
import { EnvironmentFailure, type HarnessFailure } from "./errors.js";
import { NatsVerificationCapture } from "./nats.js";
import type { Transcript } from "./transcript.js";

export type BootstrapSource = "fresh" | "seed" | "env";

export interface BootstrapResult {
	source: BootstrapSource;
	apiKey: string;
	keyId: string | null;
	keyName: string | null;
	workspace: { slug: string | null; id: string | null };
	email: string | null;
	/** Authenticated console session used for teardown; null in env-first mode. */
	console: ConsoleClient | null;
	csrfToken: string | null;
}

export interface BootstrapDeps {
	/** Test seam for the control-plane transport. */
	fetchFn?: typeof fetch;
	/** Test seam for the NATS capture. */
	captureFactory?: (
		url: string,
		timeoutMs: number,
	) => Promise<NatsVerificationCapture>;
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

/**
 * State staged during a fresh attempt so a failure after signup can still
 * find (and close) the workspace that signup created.
 */
interface FreshAttempt {
	workspace: { slug: string | null; id: string | null } | null;
	session: {
		csrfToken: string;
		workspace: { slug: string | null; id: string | null };
	} | null;
	verified: boolean;
}

const STACK_HINT_PATTERN =
	/\.?\s*Is the local stack up\? Run "make up" in nervly-base\.?/g;

/**
 * Drop the "run make up" hint from a failure that provably happened after
 * signup succeeded: signup proves the control plane is reachable and the
 * capture's handshake proves NATS is reachable, so the hint would misdirect.
 * On current builds the usual cause is the platform not dispatching the mail
 * (contract §1.2).
 */
function stripStackHint(message: string): string {
	return message.replace(STACK_HINT_PATTERN, "").trim();
}

function describeWorkspace(workspace: {
	slug: string | null;
	id: string | null;
}): string {
	const slug = workspace.slug ?? "(unknown slug)";
	return workspace.id === null
		? `workspace "${slug}"`
		: `workspace "${slug}" (id ${workspace.id})`;
}

function sentence(text: string): string {
	return text.endsWith(".") ? text : `${text}.`;
}

/** Synthesize the result teardown needs from a partially completed attempt. */
function partialFresh(
	console: ConsoleClient,
	email: string,
	workspace: { slug: string | null; id: string | null },
	session: {
		csrfToken: string;
		workspace: { slug: string | null; id: string | null };
	},
): BootstrapResult {
	return {
		source: "fresh",
		apiKey: "",
		keyId: null,
		keyName: null,
		workspace: session.workspace.slug !== null ? session.workspace : workspace,
		email,
		console,
		csrfToken: session.csrfToken,
	};
}

/**
 * A fresh bootstrap failed after signup created a workspace. Attempt the
 * owner-console delete when an authenticated session exists (or the verified
 * account can be logged into again); otherwise surface the orphan slug plus
 * the documented SQL fallback, so no workspace leaks silently (contract §5).
 */
async function closeOrReportFreshWorkspace(options: {
	failure: HarnessFailure;
	console: ConsoleClient;
	email: string;
	password: string;
	workspace: { slug: string | null; id: string | null };
	session: FreshAttempt["session"];
	verified: boolean;
	keep: boolean;
	log: Transcript;
}): Promise<HarnessFailure> {
	const {
		failure,
		console,
		email,
		password,
		workspace,
		session,
		verified,
		keep,
		log,
	} = options;
	let cleaned = false;
	let cleanupReason: string;

	if (keep) {
		cleanupReason = "EXAMPLES_KEEP=1 keeps it for debugging";
	} else if (session !== null) {
		log.line(
			"→ teardown: bootstrap failed after signup; closing the workspace through the owner console",
		);
		cleaned = await teardownBootstrap(
			partialFresh(console, email, workspace, session),
			log,
		);
		cleanupReason = "the owner-console delete did not succeed";
	} else if (verified) {
		log.line(
			"→ teardown: no session was captured; retrying the owner login to close the signup workspace",
		);
		try {
			const resumed = await login(
				console,
				email,
				password,
				"cleanup login after the bootstrap failed",
			);
			cleaned = await teardownBootstrap(
				partialFresh(console, email, workspace, resumed),
				log,
			);
			cleanupReason = "the owner-console delete did not succeed";
		} catch (error) {
			cleanupReason = `the cleanup login failed: ${stripStackHint(
				error instanceof Error ? error.message : String(error),
			)}`;
		}
	} else {
		cleanupReason =
			"the account was never verified, so no console session could delete it";
	}

	const reason = stripStackHint(failure.message);
	const fallback =
		workspace.slug !== null
			? `Fallback: run the smoke-local SQL cascade delete: DELETE FROM workspaces WHERE slug = '${workspace.slug.replace(/'/g, "''")}';`
			: `Fallback: run the smoke-local SQL cascade delete for ${describeWorkspace(workspace)};`;
	const outcome = cleaned
		? `The signup ${describeWorkspace(workspace)} was created and has been cleaned up through the owner console.`
		: `The signup ${describeWorkspace(workspace)} was created and could NOT be cleaned up automatically (${cleanupReason}). ${fallback}`;
	return new EnvironmentFailure(
		`${sentence(`bootstrap (fresh) failed after signup: ${reason}`)} ${outcome}`,
		failure.check,
		{ cause: failure },
	);
}

/**
 * Fresh-signup bootstrap. The NATS capture subscribes before signup so the
 * verification mail (dispatched through the data plane during signup) is never
 * missed.
 *
 * A failure after signup does **not** abandon the workspace it created: the
 * error is reported with the orphan's slug and the documented SQL fallback,
 * and the workspace is closed through the owner console whenever a session
 * (or a retryable login) can do so — teardown must not depend on bootstrap
 * returning a result (contract §5).
 */
export async function bootstrapFresh(
	config: ExampleConfig,
	log: Transcript,
	deps: BootstrapDeps = {},
): Promise<BootstrapResult> {
	const console = new ConsoleClient(
		config.controlUrl,
		deps.fetchFn ?? fetch,
		config.bootstrapTimeoutMs,
	);
	const email = `examples+${config.runId}@example.local`;
	const password = `Ex-${config.runId}-${randomUUID()}!`;
	const captureFactory =
		deps.captureFactory ??
		((url: string, timeoutMs: number) =>
			NatsVerificationCapture.connect(url, {
				connectTimeoutMs: Math.min(timeoutMs, 10_000),
			}));

	log.line(`→ bootstrap (fresh): signup as ${email}`);
	const capture = await captureFactory(
		config.natsUrl,
		config.bootstrapTimeoutMs,
	);
	const attempt: FreshAttempt = {
		workspace: null,
		session: null,
		verified: false,
	};
	try {
		const signup = await console.request("POST", "/auth/signup", {
			body: {
				email,
				password,
				workspace_name: `Example node-app ${config.runId}`,
			},
		});
		expectStatus(signup, 201, "signup");
		const workspace = {
			slug: stringField(field(signup.body, "workspace"), "slug"),
			id: stringField(field(signup.body, "workspace"), "id"),
		};
		attempt.workspace = workspace;
		if (stringField(signup.body, "status") !== "verification_required") {
			throw new EnvironmentFailure(
				`signup did not return verification_required: ${describe(signup.body)}`,
			);
		}
		log.line(`  signup accepted (workspace ${workspace.slug ?? "?"})`);

		const token = await capture.waitForToken(config.bootstrapTimeoutMs);
		log.line("  captured the verification token from NATS notify.>");

		const verify = await console.request("POST", "/auth/verify-email", {
			body: { token },
		});
		expectStatus(verify, 200, "email verification");
		attempt.verified = true;

		const session = await login(
			console,
			email,
			password,
			"login after verification",
		);
		attempt.session = session;
		log.line("  login accepted (session cookie + CSRF token captured)");

		const key = await createTestKey(console, config, session.csrfToken);
		log.line(`  minted test-mode key ${key.keyName} (id ${key.keyId ?? "?"})`);

		return {
			source: "fresh",
			apiKey: key.apiKey,
			keyId: key.keyId,
			keyName: key.keyName,
			workspace,
			email,
			console,
			csrfToken: session.csrfToken,
		};
	} catch (error) {
		const failure =
			error instanceof EnvironmentFailure
				? error
				: new EnvironmentFailure(
						`bootstrap (fresh) failed unexpectedly: ${
							error instanceof Error ? error.message : String(error)
						}`,
						undefined,
						{ cause: error },
					);
		if (attempt.workspace === null) throw failure;
		throw await closeOrReportFreshWorkspace({
			failure,
			console,
			email,
			password,
			workspace: attempt.workspace,
			session: attempt.session,
			verified: attempt.verified,
			keep: config.keep,
			log,
		});
	} finally {
		capture.close();
	}
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
		email: SEED_EMAIL,
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
		email: null,
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
		if (bootstrap.source === "fresh") {
			if (bootstrap.workspace.slug === null) {
				log.line("→ teardown: no workspace slug captured; skipping delete");
				return false;
			}
			log.line(`→ teardown: deleting workspace ${bootstrap.workspace.slug}`);
			const response = await bootstrap.console.request(
				"DELETE",
				"/console/workspace",
				{
					csrf: bootstrap.csrfToken ?? undefined,
					body: { confirm: bootstrap.workspace.slug },
				},
			);
			if (response.status !== 200) {
				log.line(
					`  teardown failed with HTTP ${response.status}: ${describe(response.body)}`,
				);
				return false;
			}
			log.line("  workspace closed");
			return true;
		}

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
