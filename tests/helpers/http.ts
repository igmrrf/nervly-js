/**
 * Transport-level test helpers.
 *
 * `withFetch` swaps `globalThis.fetch` for a scripted responder and records
 * every request the client actually built — url, method, headers, body and
 * `AbortSignal` — so a test can assert the wire contract instead of merely
 * that a promise resolved.
 */

export interface CapturedRequest {
	url: string;
	method: string;
	headers: Headers;
	body: string | undefined;
	signal: AbortSignal | null | undefined;
}

export function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

export async function withFetch(
	handler: (
		url: string,
		init: RequestInit | undefined,
		request: CapturedRequest,
	) => Response | Promise<Response>,
	run: (requests: CapturedRequest[]) => Promise<void>,
): Promise<CapturedRequest[]> {
	const requests: CapturedRequest[] = [];
	const original = globalThis.fetch;

	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const request: CapturedRequest = {
			url,
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body:
				init?.body === undefined || init?.body === null
					? undefined
					: String(init.body),
			signal: init?.signal,
		};
		requests.push(request);
		return handler(url, init, request);
	}) as typeof globalThis.fetch;

	try {
		await run(requests);
	} finally {
		globalThis.fetch = original;
	}

	return requests;
}

/**
 * Records every `setTimeout` delay the SDK schedules while `run` executes,
 * while shortening the real wait to `capMs` so tests never sleep through a
 * backoff or a `Retry-After`.
 *
 * The recorded (not shortened) value is the assertion target: it is the delay
 * the SDK *decided* on. Shortening is safe for the abort timer because a
 * scripted fetch settles in a microtask and `clearTimeout` wins the race.
 */
export async function withCapturedTimeouts<T>(
	run: (delays: number[]) => Promise<T>,
	capMs = 5,
): Promise<T> {
	const delays: number[] = [];
	const original = globalThis.setTimeout;

	const patched = (
		callback: (...args: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	) => {
		if (typeof ms === "number") delays.push(ms);
		const actual = typeof ms === "number" ? Math.min(ms, capMs) : ms;
		return original(callback, actual, ...args);
	};

	globalThis.setTimeout = patched as unknown as typeof globalThis.setTimeout;

	try {
		return await run(delays);
	} finally {
		globalThis.setTimeout = original;
	}
}
