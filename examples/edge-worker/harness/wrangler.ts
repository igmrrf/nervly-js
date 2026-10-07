/**
 * `wrangler dev` process management (contract §5: bounded waits, trap-based
 * teardown).
 *
 * The harness starts the local workerd server on an ephemeral port, waits a
 * bounded time for it to answer, streams its output (redacted) to
 * `artifacts/edge-worker/wrangler.log`, and always tears it down: on success,
 * assertion failure, environment failure and SIGINT/SIGTERM. The process is
 * spawned detached so a single `SIGTERM` to its process group also stops the
 * workerd child.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvironmentFailure } from "./errors.js";
import { redact } from "./redact.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `examples/edge-worker` — where the wrangler config and `.dev.vars` live. */
export const EXAMPLE_DIR = resolve(HERE, "..");

/** Repo root (three levels above `examples/edge-worker/harness`). */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

/** The repo-local wrangler binary pinned in `devDependencies`. */
export const WRANGLER_BIN = join(
	REPO_ROOT,
	"node_modules",
	".bin",
	process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

export interface WranglerArgsOptions {
	configPath: string;
	port: number;
	inspectorPort: number;
	persistDir: string;
}

/**
 * The exact `wrangler dev` invocation. It intentionally carries no secret:
 * bindings arrive through the git-ignored `.dev.vars` file next to the config.
 */
export function buildWranglerArgs(options: WranglerArgsOptions): string[] {
	return [
		"dev",
		"--config",
		options.configPath,
		"--ip",
		"127.0.0.1",
		"--port",
		String(options.port),
		"--inspector-port",
		String(options.inspectorPort),
		"--persist-to",
		options.persistDir,
		"--show-interactive-dev-session=false",
		"--log-level",
		"info",
	];
}

/** Bind an ephemeral port and release it, returning the chosen number. */
export function findFreePort(host = "127.0.0.1"): Promise<number> {
	return new Promise((promiseResolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, host, () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close(() => reject(new Error("could not allocate a port")));
				return;
			}
			const port = address.port;
			server.close(() => promiseResolve(port));
		});
	});
}

export interface WranglerStartOptions extends WranglerArgsOptions {
	/** Directory wrangler runs in (holds `.dev.vars`). */
	cwd: string;
	/** Redacted wrangler output is appended here. */
	logPath: string;
	/** Upper bound on "started and answering" (first run may fetch the runtime). */
	readyTimeoutMs: number;
	/** Test seam: override the executable / argument list. */
	command?: string;
	args?: string[];
	readyPollMs?: number;
	stopTimeoutMs?: number;
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export interface RunningWrangler {
	url: string;
	port: number;
	/** Idempotent: stopping twice, or after a crash, is a no-op. */
	stop(): Promise<void>;
}

const TAIL_LINES = 20;

/** Keep complete lines per stream so redaction never spans a chunk boundary. */
class LineLog {
	private readonly partials = new Map<string, string>();
	private readonly tail: string[] = [];

	constructor(private readonly logPath: string) {
		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(logPath, "", "utf8");
	}

	push(stream: "stdout" | "stderr", chunk: Buffer): void {
		const combined = (this.partials.get(stream) ?? "") + chunk.toString("utf8");
		const lines = combined.split("\n");
		const partial = lines.pop() ?? "";
		this.partials.set(stream, partial);
		for (const line of lines) this.record(line);
	}

	flush(): void {
		for (const [stream, partial] of this.partials) {
			if (partial !== "") this.record(partial);
			this.partials.delete(stream);
		}
	}

	private record(line: string): void {
		const clean = redact(line);
		appendFileSync(this.logPath, `${clean}\n`, "utf8");
		this.tail.push(clean);
		if (this.tail.length > TAIL_LINES) this.tail.shift();
	}

	/** Last lines of output, for an error message (already redacted). */
	tailText(): string {
		return this.tail.join("\n");
	}
}

/**
 * Start the local runtime and wait until it answers HTTP. Throws
 * {@link EnvironmentFailure} (exit 2) when the process cannot start, exits
 * early or does not become ready inside `readyTimeoutMs`; in every failure case
 * the process is stopped first.
 */
export async function startWrangler(
	options: WranglerStartOptions,
): Promise<RunningWrangler> {
	const command = options.command ?? WRANGLER_BIN;
	const args = options.args ?? buildWranglerArgs(options);
	const pollMs = options.readyPollMs ?? 250;
	const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
	const fetchFn = options.fetchFn ?? fetch;
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = options.now ?? (() => Date.now());
	const url = `http://127.0.0.1:${options.port}`;
	const log = new LineLog(options.logPath);

	let exited = false;
	let spawnError: Error | null = null;
	let exitText = "has not exited";
	const exitWaiters: Array<() => void> = [];

	const child: ChildProcess = spawn(command, args, {
		cwd: options.cwd,
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});

	child.stdout?.on("data", (chunk: Buffer) => log.push("stdout", chunk));
	child.stderr?.on("data", (chunk: Buffer) => log.push("stderr", chunk));
	child.once("error", (error) => {
		spawnError = error;
		exited = true;
		for (const waiter of exitWaiters.splice(0)) waiter();
	});
	child.once("exit", (code, signal) => {
		exited = true;
		log.flush();
		exitText = `exited with code=${code ?? "null"} signal=${signal ?? "null"}`;
		for (const waiter of exitWaiters.splice(0)) waiter();
	});

	const waitForExit = async (timeoutMs: number): Promise<boolean> => {
		if (exited) return true;
		return await new Promise<boolean>((promiseResolve) => {
			const timer = setTimeout(() => promiseResolve(false), timeoutMs);
			exitWaiters.push(() => {
				clearTimeout(timer);
				promiseResolve(true);
			});
		});
	};

	let stopped = false;
	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		if (exited) return;
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
		} catch {
			// Already gone (ESRCH) or never started: nothing to signal.
		}
		if (await waitForExit(stopTimeoutMs)) return;
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
		await waitForExit(1_000);
	};

	const fail = async (message: string): Promise<never> => {
		await stop();
		throw new EnvironmentFailure(message);
	};

	const deadline = now() + options.readyTimeoutMs;
	for (;;) {
		// The cast drops TypeScript's closure-unaware narrowing (`spawnError` is
		// only ever set from the child's `error` listener above).
		const startFailure = spawnError as Error | null;
		if (startFailure !== null) {
			await fail(
				`failed to start ${command}: ${startFailure.message} (is "npm install" up to date?)`,
			);
		}
		if (exited) {
			await fail(
				`${command} ${exitText} before it became ready.\n${log.tailText()}`,
			);
		}
		try {
			await fetchFn(`${url}/`, { signal: AbortSignal.timeout(2_000) });
			return { url, port: options.port, stop };
		} catch {
			// Not answering yet; keep polling until the deadline.
		}
		if (now() >= deadline) {
			await fail(
				`${command} did not become ready within ${options.readyTimeoutMs}ms.\n${log.tailText()}`,
			);
		}
		await sleep(pollMs);
	}
}
