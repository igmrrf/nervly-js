/**
 * The node-app server: a zero-dependency `node:http` application that uses the
 * published `@nervly/sdk` (package entry → built `dist`) the way a customer
 * would ship.
 *
 * One SDK client with explicit timeout/retry configuration is shared by every
 * route, and every typed SDK error is mapped to a machine-readable JSON body:
 *
 * | SDK error                    | HTTP | `error.type`           |
 * |------------------------------|------|------------------------|
 * | `NervlyValidationError`      | 400  | `VALIDATION_ERROR`     |
 * | `NervlyApiError` (422)       | 422  | `VALIDATION_ERROR`     |
 * | `NervlyAuthenticationError`  | 401  | `AUTHENTICATION_ERROR` |
 * | `NervlyNotFoundError`        | 404  | `NOT_FOUND`            |
 * | `NervlyIdempotencyError`     | 409  | `IDEMPOTENCY_CONFLICT` |
 * | `NervlyRateLimitError`       | 429  | `RATE_LIMIT_EXCEEDED`  |
 * | `NervlyServerError`          | 502  | `UPSTREAM_ERROR`       |
 * | `NervlyNetworkError`         | 503  | `NETWORK_ERROR`        |
 * | `NervlyRetryExhaustedError`  | 503  | `RETRY_EXHAUSTED`      |
 * | other `NervlyApiError`       | as-is| the gateway's code     |
 * | anything else                | 500  | `INTERNAL_ERROR`       |
 *
 * Bodies are always `{ "error": { "type", "message", "status", … } }` — see
 * `mapErrorToHttp`. The API key never appears in a response.
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type {
	ListMessagesParams,
	Priority,
	Recipient,
	TriggerEventOptions,
	TriggerEventRequest,
	UserPreferencesRequest,
} from "@nervly/sdk";
import Nervly, {
	NervlyApiError,
	NervlyAuthenticationError,
	NervlyIdempotencyError,
	NervlyNetworkError,
	NervlyNotFoundError,
	NervlyRateLimitError,
	NervlyRetryExhaustedError,
	NervlyServerError,
	NervlyValidationError,
} from "@nervly/sdk";

/** The SDK client configuration the app runs with. */
export interface AppClientOptions {
	apiKey: string;
	baseUrl: string;
	timeoutMs: number;
	maxRetries: number;
	retryBaseDelayMs: number;
}

/**
 * Documented defaults (README “Retry and timeout configuration”): a 10 s
 * request timeout, two retries and a 250 ms base backoff. The harness contract
 * pins the environment surface (§1.1), so the app does not invent tuning
 * variables; tests and embedders override these through
 * {@link resolveAppConfig}.
 */
export const APP_DEFAULTS = {
	timeoutMs: 10_000,
	maxRetries: 2,
	retryBaseDelayMs: 250,
} as const;

/** Bad app configuration (a missing key, a malformed tuning value). */
export class AppConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AppConfigError";
	}
}

function readTuning(
	name: string,
	value: number | undefined,
	fallback: number,
	minimum: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < minimum) {
		throw new AppConfigError(
			`${name}=${value} must be an integer >= ${minimum}`,
		);
	}
	return value;
}

/**
 * Resolve the SDK client configuration: the harness's minted key and gateway
 * URL, plus the documented tuning defaults unless a caller (a test, an
 * embedder) overrides them explicitly.
 */
export function resolveAppConfig(base: {
	apiKey: string;
	baseUrl: string;
	timeoutMs?: number;
	maxRetries?: number;
	retryBaseDelayMs?: number;
}): AppClientOptions {
	return {
		apiKey: base.apiKey,
		baseUrl: base.baseUrl,
		timeoutMs: readTuning(
			"timeoutMs",
			base.timeoutMs,
			APP_DEFAULTS.timeoutMs,
			1,
		),
		maxRetries: readTuning(
			"maxRetries",
			base.maxRetries,
			APP_DEFAULTS.maxRetries,
			0,
		),
		retryBaseDelayMs: readTuning(
			"retryBaseDelayMs",
			base.retryBaseDelayMs,
			APP_DEFAULTS.retryBaseDelayMs,
			1,
		),
	};
}

/** Build the one SDK client every route shares. */
export function createSdkClient(options: AppClientOptions): Nervly {
	return new Nervly({
		apiKey: options.apiKey,
		baseUrl: options.baseUrl,
		timeout: options.timeoutMs,
		maxRetries: options.maxRetries,
		retryBaseDelay: options.retryBaseDelayMs,
	});
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** An app-level request error (bad JSON, bad query, unknown route). */
export class HttpError extends Error {
	readonly status: number;
	readonly type: string;

	constructor(status: number, type: string, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.type = type;
	}
}

export interface ApiErrorBody {
	error: {
		type: string;
		message: string;
		status: number;
		request_id?: string;
		retry_after_ms?: number;
		attempts?: number;
		purpose?: string;
	};
}

export interface MappedHttpError {
	status: number;
	body: ApiErrorBody;
}

function mapped(
	status: number,
	type: string,
	message: string,
	extra: Partial<ApiErrorBody["error"]> = {},
): MappedHttpError {
	return { status, body: { error: { type, message, status, ...extra } } };
}

function requestIdExtra(error: NervlyApiError): { request_id?: string } {
	return error.requestId ? { request_id: error.requestId } : {};
}

/**
 * Map any thrown value to the HTTP status and machine-readable body the
 * caller sees. Exported so tests can pin the full mapping table, including
 * branches that need a specific upstream failure to reach through the client.
 */
export function mapErrorToHttp(error: unknown): MappedHttpError {
	if (error instanceof HttpError) {
		return mapped(error.status, error.type, error.message);
	}
	if (error instanceof NervlyRateLimitError) {
		return mapped(429, "RATE_LIMIT_EXCEEDED", error.message, {
			...requestIdExtra(error),
			retry_after_ms: error.retryAfterMs,
			...(error.purpose ? { purpose: error.purpose } : {}),
		});
	}
	if (error instanceof NervlyValidationError) {
		return mapped(
			400,
			"VALIDATION_ERROR",
			error.message,
			requestIdExtra(error),
		);
	}
	if (error instanceof NervlyAuthenticationError) {
		return mapped(
			401,
			"AUTHENTICATION_ERROR",
			error.message,
			requestIdExtra(error),
		);
	}
	if (error instanceof NervlyNotFoundError) {
		return mapped(404, "NOT_FOUND", error.message, requestIdExtra(error));
	}
	if (error instanceof NervlyIdempotencyError) {
		return mapped(
			409,
			"IDEMPOTENCY_CONFLICT",
			error.message,
			requestIdExtra(error),
		);
	}
	if (error instanceof NervlyServerError) {
		return mapped(502, "UPSTREAM_ERROR", error.message, requestIdExtra(error));
	}
	if (error instanceof NervlyRetryExhaustedError) {
		return mapped(503, "RETRY_EXHAUSTED", error.message, {
			attempts: error.attempts,
		});
	}
	if (error instanceof NervlyNetworkError) {
		return mapped(503, "NETWORK_ERROR", error.message);
	}
	if (error instanceof NervlyApiError) {
		// A non-subclassed gateway error (403, 422, …) passes through with the
		// gateway's own error code when it sent one.
		const status =
			error.statusCode >= 400 && error.statusCode <= 599
				? error.statusCode
				: 502;
		const type =
			error.statusCode === 422
				? "VALIDATION_ERROR"
				: error.errorType !== "UNKNOWN_ERROR"
					? error.errorType
					: "API_ERROR";
		return mapped(status, type, error.message, requestIdExtra(error));
	}
	const message = error instanceof Error ? error.message : String(error);
	return mapped(500, "INTERNAL_ERROR", message);
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

export type AppHandler = (req: IncomingMessage, res: ServerResponse) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PRIORITIES = new Set(["CRITICAL", "HIGH", "NORMAL", "LOW"]);

function isPriority(value: unknown): value is Priority {
	return typeof value === "string" && PRIORITIES.has(value);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") {
		throw new HttpError(
			400,
			"INVALID_JSON",
			"request body must be a JSON object",
		);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new HttpError(400, "INVALID_JSON", "request body is not valid JSON");
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) return;
	const payload = `${JSON.stringify(body)}\n`;
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function sendMappedError(res: ServerResponse, failure: MappedHttpError): void {
	sendJson(res, failure.status, failure.body);
}

async function handleRequest(
	client: Nervly,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const method = req.method ?? "GET";
	const url = new URL(req.url ?? "/", "http://node-app.local");
	const route = `${method} ${url.pathname}`;

	try {
		if (route === "GET /health") {
			const health = await client.health.check();
			sendJson(res, 200, health);
			return;
		}

		if (route === "POST /events") {
			const body = await readJsonBody(req);
			if (!isRecord(body)) {
				throw new HttpError(
					400,
					"INVALID_BODY",
					"request body must be a JSON object",
				);
			}
			const options: TriggerEventOptions = {};
			if (typeof body.idempotencyKey === "string" && body.idempotencyKey) {
				options.idempotencyKey = body.idempotencyKey;
			}
			if (isPriority(body.priority)) {
				options.priority = body.priority;
			}
			const request: TriggerEventRequest = {
				name: typeof body.name === "string" ? body.name : "",
				to: (isRecord(body.to) ? body.to : {}) as unknown as Recipient,
			};
			if (body.payload !== undefined) {
				request.payload = body.payload as Record<string, unknown> | null;
			}
			if (typeof body.category === "string") {
				request.category = body.category;
			}
			const event = await client.events.trigger(request, options);
			sendJson(res, 202, {
				eventId: event.eventId,
				status: event.status,
				priority: event.priority,
				channel: event.channel,
				idempotencyKey: event.idempotencyKey ?? options.idempotencyKey ?? null,
			});
			return;
		}

		if (route === "POST /events/bulk") {
			const body = await readJsonBody(req);
			if (!isRecord(body) || !Array.isArray(body.events)) {
				throw new HttpError(
					400,
					"INVALID_BODY",
					"request body must be { events: [...] }",
				);
			}
			const batch = await client.events.bulkTrigger({
				events: body.events as TriggerEventRequest[],
			});
			sendJson(res, 202, {
				jobId: batch.jobId,
				status: batch.status,
				count: batch.count,
				failedCount: batch.failedCount,
				events: batch.events,
			});
			return;
		}

		if (route === "GET /messages") {
			const params: ListMessagesParams = {};
			const query = url.searchParams;
			const subscriberId =
				query.get("subscriberId") ?? query.get("subscriber_id");
			if (subscriberId) params.subscriberId = subscriberId;
			if (query.get("status")) params.status = query.get("status") as string;
			if (query.get("channel")) params.channel = query.get("channel") as string;
			if (query.get("from")) params.from = query.get("from") as string;
			if (query.get("to")) params.to = query.get("to") as string;
			if (query.get("cursor")) params.cursor = query.get("cursor") as string;
			if (query.has("limit")) {
				const raw = query.get("limit") ?? "";
				const limit = Number(raw);
				if (!Number.isInteger(limit) || limit < 1) {
					throw new HttpError(
						400,
						"INVALID_QUERY",
						`limit=${raw} must be a positive integer`,
					);
				}
				params.limit = limit;
			}
			const page = await client.messages.list(params);
			sendJson(res, 200, page);
			return;
		}

		const preferences = /^PUT \/subscribers\/([^/]+)\/preferences$/.exec(route);
		if (preferences) {
			// The ticket names `subscribers.updatePreferences`; the SDK marks it
			// deprecated in favour of `users.updatePreferences` (the same route)
			// and this example pins 0.1.1, where the ticket's spelling still ships.
			const subscriberId = decodeURIComponent(preferences[1] as string);
			const body = await readJsonBody(req);
			if (!isRecord(body)) {
				throw new HttpError(
					400,
					"INVALID_BODY",
					"request body must be a JSON object",
				);
			}
			const updated = await client.subscribers.updatePreferences(
				subscriberId,
				body as UserPreferencesRequest,
			);
			sendJson(res, 200, updated);
			return;
		}

		const lookup = /^GET \/events\/([^/]+)$/.exec(route);
		if (lookup) {
			const eventId = decodeURIComponent(lookup[1] as string);
			const message = await client.events.get(eventId);
			sendJson(res, 200, message);
			return;
		}

		throw new HttpError(
			404,
			"NOT_FOUND",
			`no route for ${method} ${url.pathname}`,
		);
	} catch (error) {
		sendMappedError(res, mapErrorToHttp(error));
	}
}

/** Build the request handler around one SDK client. */
export function createHandler(client: Nervly): AppHandler {
	return (req, res) => {
		void handleRequest(client, req, res).catch((error: unknown) => {
			sendMappedError(res, mapErrorToHttp(error));
		});
	};
}

export interface StartAppOptions extends Partial<AppClientOptions> {
	apiKey: string;
	baseUrl: string;
	/** 0 (default) binds an ephemeral port. */
	port?: number;
	host?: string;
}

export interface RunningApp {
	url: string;
	port: number;
	/** Idempotent: closing twice is a no-op. */
	close(): Promise<void>;
}

function formatHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}

function listen(server: Server, port: number, host: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(port, host, () => {
			server.removeListener("error", onError);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		// fetch keeps connections alive; without this, close() would hang.
		server.closeAllConnections();
	});
}

/** Start the app on `host:port` (ephemeral port by default). */
export async function startApp(options: StartAppOptions): Promise<RunningApp> {
	const config = resolveAppConfig(options);
	const server = createServer(createHandler(createSdkClient(config)));
	const host = options.host ?? "127.0.0.1";
	await listen(server, options.port ?? 0, host);
	const address = server.address() as AddressInfo;
	let closed = false;
	return {
		url: `http://${formatHost(address.address)}:${address.port}`,
		port: address.port,
		close: async () => {
			if (closed) return;
			closed = true;
			await closeServer(server);
		},
	};
}
