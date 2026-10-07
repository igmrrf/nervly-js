/**
 * A minimal control-plane client for bootstrap and teardown: JSON in, JSON out,
 * with the double-submit cookie/CSRF chain the console requires. It is separate
 * from the SDK on purpose — bootstrap happens before an API key exists.
 */

import { EnvironmentFailure } from "./errors.js";

export interface ConsoleRequestOptions {
	body?: unknown;
	/** Value for `X-CSRF-Token`; required by the console chain on writes. */
	csrf?: string;
	headers?: Record<string, string>;
}

export interface ConsoleResponse {
	status: number;
	body: unknown;
	setCookies: string[];
}

function networkFailure(baseUrl: string, path: string, error: unknown) {
	return new EnvironmentFailure(
		`control plane unreachable at ${baseUrl} (${path}): ${error instanceof Error ? error.message : String(error)}. Is the local stack up? Run "make up" in nervly-base.`,
		undefined,
		{ cause: error },
	);
}

async function parseBody(response: Response): Promise<unknown> {
	const text = await response.text();
	if (text === "") return null;
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	return text;
}

export class ConsoleClient {
	private readonly cookies = new Map<string, string>();

	constructor(
		readonly baseUrl: string,
		private readonly fetchFn: typeof fetch = fetch,
		private readonly timeoutMs = 10_000,
	) {}

	async request(
		method: string,
		path: string,
		options: ConsoleRequestOptions = {},
	): Promise<ConsoleResponse> {
		const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
		const headers: Record<string, string> = { ...options.headers };
		if (options.body !== undefined) {
			headers["Content-Type"] ??= "application/json";
		}
		const cookie = this.cookieHeader();
		if (cookie !== "") {
			headers.Cookie = cookie;
		}
		if (options.csrf !== undefined) {
			headers["X-CSRF-Token"] = options.csrf;
		}

		let response: Response;
		try {
			response = await this.fetchFn(url, {
				method,
				headers,
				body:
					options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			// AbortError (timeout) and connection errors are both "stack down".
			throw networkFailure(this.baseUrl, path, error);
		}

		const setCookies = response.headers.getSetCookie();
		for (const raw of setCookies) {
			const [pair] = raw.split(";");
			const separator = pair.indexOf("=");
			if (separator > 0) {
				this.cookies.set(
					pair.slice(0, separator).trim(),
					pair.slice(separator + 1),
				);
			}
		}

		return {
			status: response.status,
			body: await parseBody(response),
			setCookies,
		};
	}

	cookieHeader(): string {
		return [...this.cookies.entries()]
			.map(([name, value]) => `${name}=${value}`)
			.join("; ");
	}

	getCookie(name: string): string | undefined {
		return this.cookies.get(name);
	}
}
