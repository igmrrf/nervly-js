/**
 * A dependency-free NATS text-protocol client, used only to capture the email
 * verification token the signup flow publishes over core NATS.
 *
 * The local stack's mailer dispatches the verification email through the
 * gateway's data plane (`notify.>`). On a stack that publishes the variables in
 * plaintext, the raw protobuf payload embeds the variables JSON, so the token is
 * recoverable with the same `token=([a-f0-9]{64})` scan
 * `nervly-worker/e2e/stranger_test.go` uses — no protobuf runtime and no `nats`
 * CLI are required. (Current gateway builds seal the variables under `KEK_V1`
 * and clear `variables_json`; see the harness contract §1.2 for what that means
 * for the fresh bootstrap.)
 */

import { connect, type Socket } from "node:net";
import { EnvironmentFailure } from "./errors.js";

export interface NatsFrame {
	subject: string;
	payload: Buffer;
}

const MARKERS = ["auth.email_verification", "transactional-email"];
const TOKEN_PATTERN = /token=([a-f0-9]{64})/i;

/**
 * Scan one raw NATS payload for the verification token. Returns `null` for any
 * payload that is not the verification email (the event-name marker filters
 * other `notify.>` traffic).
 */
export function scanForVerificationToken(
	payload: Buffer | string,
): string | null {
	const text = typeof payload === "string" ? payload : payload.toString("utf8");
	if (!MARKERS.some((marker) => text.includes(marker))) return null;
	const match = TOKEN_PATTERN.exec(text);
	return match?.[1] ?? null;
}

/**
 * Incremental parser for the NATS wire protocol: control lines are collected
 * (the caller answers `PING`), and `MSG` payloads are emitted as complete
 * frames. Handles partial chunks and several frames per chunk.
 */
export class NatsFrameParser {
	private buffer = Buffer.alloc(0);
	private pendingBytes: number | null = null;
	private pendingSubject = "";
	private readonly controlLines: string[] = [];

	/** Feed bytes; returns every complete `MSG` payload decoded so far. */
	push(chunk: Buffer): NatsFrame[] {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const frames: NatsFrame[] = [];

		for (;;) {
			if (this.pendingBytes !== null) {
				if (this.buffer.length < this.pendingBytes + 2) break;
				const payload = Buffer.from(this.buffer.subarray(0, this.pendingBytes));
				this.buffer = this.buffer.subarray(this.pendingBytes + 2);
				frames.push({ subject: this.pendingSubject, payload });
				this.pendingBytes = null;
				this.pendingSubject = "";
				continue;
			}

			const lineEnd = this.buffer.indexOf("\r\n");
			if (lineEnd < 0) break;
			const line = this.buffer.subarray(0, lineEnd).toString("utf8");
			this.buffer = this.buffer.subarray(lineEnd + 2);
			this.controlLines.push(line);

			const parts = line.split(/\s+/);
			if (parts[0] === "MSG" && parts.length >= 4) {
				const size = Number(parts[parts.length - 1]);
				if (Number.isInteger(size) && size >= 0) {
					this.pendingSubject = parts[1];
					this.pendingBytes = size;
				}
			}
		}

		return frames;
	}

	/** Control lines seen since the last call (INFO, PING, PONG, +OK, -ERR…). */
	takeControlLines(): string[] {
		return this.controlLines.splice(0, this.controlLines.length);
	}
}

export interface NatsCaptureOptions {
	connectTimeoutMs?: number;
}

function withStackHint(message: string): string {
	return `${message}. Is the local stack up? Run "make up" in nervly-base.`;
}

export class NatsVerificationCapture {
	private readonly parser = new NatsFrameParser();
	private readonly waiters = new Set<{
		resolve: (token: string) => void;
		reject: (error: Error) => void;
	}>();
	private capturedToken: string | null = null;
	private closed = false;
	private handshaken = false;
	private resolveHandshake: (() => void) | null = null;
	private rejectHandshake: ((error: Error) => void) | null = null;
	private readonly handshake = new Promise<void>((resolve, reject) => {
		this.resolveHandshake = resolve;
		this.rejectHandshake = reject;
	});

	private constructor(private readonly socket: Socket) {}

	/**
	 * Connect to `nats://host:port` (a bare `host:port` is accepted), subscribe
	 * to `notify.>` and resolve once the broker acknowledged the subscription
	 * (`PONG` to our `PING`). Waiting for the acknowledgement means a caller can
	 * trigger the event immediately after `connect` without racing the `SUB`.
	 */
	static async connect(
		rawUrl: string,
		options: NatsCaptureOptions = {},
	): Promise<NatsVerificationCapture> {
		const url = new URL(rawUrl.includes("://") ? rawUrl : `nats://${rawUrl}`);
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const port = url.port === "" ? 4222 : Number(url.port);
		const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;

		const socket = connect({ host, port });
		const capture = new NatsVerificationCapture(socket);
		capture.attach();

		const timer = setTimeout(() => {
			capture.failHandshake(
				new EnvironmentFailure(
					withStackHint(`NATS connect to ${rawUrl} timed out`),
				),
			);
		}, connectTimeoutMs);

		socket.once("connect", () => {
			socket.write(
				`CONNECT ${JSON.stringify({
					verbose: false,
					pedantic: false,
					tls_required: false,
					name: "nervly-node-app",
					lang: "node",
					version: "1.0.0",
				})}\r\n`,
			);
			socket.write("SUB notify.> 1\r\n");
			socket.write("PING\r\n");
		});

		try {
			await capture.handshake;
		} finally {
			clearTimeout(timer);
		}
		return capture;
	}

	private finishHandshake(error: Error | null): void {
		if (this.handshaken) return;
		this.handshaken = true;
		if (error === null) {
			this.resolveHandshake?.();
		} else {
			this.rejectHandshake?.(error);
		}
		this.resolveHandshake = null;
		this.rejectHandshake = null;
	}

	private failHandshake(error: Error): void {
		this.finishHandshake(error);
		this.failWaiters(error);
		this.closed = true;
		this.socket.destroy();
	}

	private attach(): void {
		this.socket.on("data", (chunk: Buffer) => {
			for (const frame of this.parser.push(chunk)) {
				this.deliver(frame);
			}
			for (const line of this.parser.takeControlLines()) {
				if (line === "PING") {
					this.socket.write("PONG\r\n");
				} else if (line === "PONG" || line === "+OK") {
					this.finishHandshake(null);
				} else if (line.startsWith("-ERR")) {
					const error = new EnvironmentFailure(
						withStackHint(`NATS error: ${line}`),
					);
					if (!this.handshaken) this.failHandshake(error);
					else this.failWaiters(error);
				}
			}
		});
		this.socket.on("error", (error) => {
			const failure = new EnvironmentFailure(
				withStackHint(`NATS connection error: ${error.message}`),
				undefined,
				{ cause: error },
			);
			if (!this.handshaken) this.failHandshake(failure);
			else this.failWaiters(failure);
		});
		this.socket.on("close", () => {
			this.closed = true;
			const failure = new EnvironmentFailure(
				withStackHint("NATS connection closed before the token arrived"),
			);
			if (!this.handshaken) this.failHandshake(failure);
			else this.failWaiters(failure);
		});
		this.socket.unref();
	}

	private deliver(frame: NatsFrame): void {
		if (this.capturedToken !== null) return;
		const token = scanForVerificationToken(frame.payload);
		if (token === null) return;
		this.capturedToken = token;
		for (const waiter of this.waiters) {
			waiter.resolve(token);
		}
		this.waiters.clear();
	}

	private failWaiters(error: Error): void {
		for (const waiter of this.waiters) {
			waiter.reject(error);
		}
		this.waiters.clear();
	}

	/**
	 * Resolve with the verification token, or reject with an
	 * {@link EnvironmentFailure} after `timeoutMs`.
	 */
	waitForToken(
		timeoutMs: number,
		description = "email verification token",
	): Promise<string> {
		if (this.capturedToken !== null) {
			return Promise.resolve(this.capturedToken);
		}
		if (this.closed) {
			return Promise.reject(
				new EnvironmentFailure(
					withStackHint("NATS connection is closed; cannot capture the token"),
				),
			);
		}

		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(entry);
				reject(
					new EnvironmentFailure(
						withStackHint(
							`timed out after ${timeoutMs}ms waiting for the ${description}`,
						),
					),
				);
			}, timeoutMs);
			const entry = {
				resolve: (token: string) => {
					clearTimeout(timer);
					resolve(token);
				},
				reject: (error: Error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
			this.waiters.add(entry);
		});
	}

	close(): void {
		this.closed = true;
		this.socket.destroy();
	}
}
