/**
 * Standalone entry for the node-app example server.
 *
 * The app imports the published package entry (`@nervly/sdk` → built `dist`),
 * so build once before running it directly:
 *
 *   npm run build
 *   NERVLY_API_KEY=nervly_sk_test_… NERVLY_API_URL=http://localhost:8080 \
 *     npx tsx examples/node-app/server.ts --port 3000
 *
 * The same local-host/test-key guards the harness applies are applied here
 * (exit 3 on refusal, exit 2 on bad configuration), so the standalone server
 * can never point at a live key or a remote host.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	type AppClientOptions,
	AppConfigError,
	resolveAppConfig,
	startApp,
} from "./app.js";
import { GuardRefusal } from "./harness/errors.js";
import { assertLocalUrl, assertTestKey } from "./harness/guards.js";

export const DEFAULT_API_URL = "http://localhost:8080";
export const DEFAULT_PORT = 3000;

export interface ServerOptions extends AppClientOptions {
	port: number;
	host: string;
}

/**
 * `--port <n>` (or `--port=<n>`); 0 picks an ephemeral port. A flag rather
 * than an env var, so the example only reads contract-table variables.
 */
export function parsePort(argv: string[]): number {
	let port = DEFAULT_PORT;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		const raw =
			arg === "--port"
				? argv[++index]
				: arg.startsWith("--port=")
					? arg.slice("--port=".length)
					: undefined;
		if (raw === undefined) {
			throw new AppConfigError(`unknown argument: ${arg}`);
		}
		const parsed = Number(raw);
		if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
			throw new AppConfigError(
				`--port=${raw} must be an integer between 0 and 65535 (0 picks an ephemeral port)`,
			);
		}
		port = parsed;
	}
	return port;
}

/** Resolve and guard the standalone server's environment. */
export function loadServerOptions(
	env: NodeJS.ProcessEnv = process.env,
	argv: string[] = [],
): ServerOptions {
	const apiKey = env.NERVLY_API_KEY?.trim();
	if (!apiKey) {
		throw new AppConfigError(
			"NERVLY_API_KEY is required; mint a test-mode key (or run `npm run example` for the full harness flow)",
		);
	}
	const apiUrl = env.NERVLY_API_URL?.trim() || DEFAULT_API_URL;
	const gatewayOverride = env.NERVLY_GATEWAY_URL?.trim();
	assertLocalUrl("NERVLY_API_URL", apiUrl);
	if (gatewayOverride) {
		assertLocalUrl("NERVLY_GATEWAY_URL", gatewayOverride);
	}
	assertTestKey(apiKey);
	return {
		...resolveAppConfig({ apiKey, baseUrl: gatewayOverride ?? apiUrl }),
		port: parsePort(argv),
		host: "127.0.0.1",
	};
}

/** Boot the server; returns the exit code the process should end with. */
export async function main(
	argv: string[] = process.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	let options: ServerOptions;
	try {
		options = loadServerOptions(env, argv);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`node-app: ${message}\n`);
		return error instanceof GuardRefusal ? 3 : 2;
	}

	let app: Awaited<ReturnType<typeof startApp>>;
	try {
		app = await startApp(options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`node-app: could not start: ${message}\n`);
		return 2;
	}

	const shutdown = () => {
		void app.close();
	};
	// Persistent listeners (not `once`): `app.close()` is idempotent, and a
	// second SIGINT/SIGTERM arriving while a slow close is in flight must not
	// restore the default disposition and kill the process mid-shutdown
	// (which would report exit 143 instead of a clean 0).
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	process.stdout.write(`node-app listening on ${app.url}\n`);
	process.stdout.write(
		"  endpoints: GET /health, POST /events, POST /events/bulk, GET /messages, GET /events/:eventId, PUT /subscribers/:subscriberId/preferences\n",
	);
	process.stdout.write(
		`  sdk: timeout=${options.timeoutMs}ms maxRetries=${options.maxRetries} retryBaseDelay=${options.retryBaseDelayMs}ms\n`,
	);

	return 0;
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
	main().then((code) => {
		process.exitCode = code;
	});
}
