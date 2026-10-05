/**
 * Structured error hierarchy for `@nervly/sdk`.
 *
 * Every failure the SDK raises is an instance of {@link NervlyError}, so a
 * single `instanceof NervlyError` catch is enough to distinguish SDK errors from
 * your own. Below that root the hierarchy is split by *where* the failure came
 * from — HTTP response (`NervlyApiError` and its status-specific subclasses) or
 * the transport itself (`NervlyNetworkError`, `NervlyRetryExhaustedError`).
 *
 * Each status-specific subclass also has a short alias (`AuthenticationError`
 * for `NervlyAuthenticationError`, and so on). Both names are exported and both
 * refer to the same class, so `instanceof` works whichever you import. New code
 * should prefer the short aliases; the longer names are kept because they are
 * already in the published API surface.
 */

/**
 * Base class for all errors raised by the SDK.
 */
export class NervlyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NervlyError";
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/**
 * Base class for errors that came from an HTTP response.
 *
 * Carries the numeric `statusCode` and the machine-readable `errorType` the
 * gateway returned, plus the `requestId` when the response supplied one.
 */
export class NervlyApiError extends NervlyError {
	public readonly statusCode: number;
	public readonly errorType: string;
	public readonly requestId?: string;

	constructor(
		statusCode: number,
		errorType: string,
		message: string,
		requestId?: string,
	) {
		super(message);
		this.name = "NervlyApiError";
		this.statusCode = statusCode;
		this.errorType = errorType;
		this.requestId = requestId;
	}
}

/**
 * 401 Unauthorized — missing, malformed, or revoked API key.
 */
export class NervlyAuthenticationError extends NervlyApiError {
	constructor(
		message: string = "Invalid or missing API key",
		requestId?: string,
	) {
		super(401, "UNAUTHORIZED", message, requestId);
		this.name = "NervlyAuthenticationError";
	}
}

/**
 * 400 Bad Request — the request body or query failed validation.
 */
export class NervlyValidationError extends NervlyApiError {
	constructor(message: string, requestId?: string) {
		super(400, "BAD_REQUEST", message, requestId);
		this.name = "NervlyValidationError";
	}
}

/**
 * 404 Not Found — the event or subscriber does not exist.
 */
export class NervlyNotFoundError extends NervlyApiError {
	constructor(message: string = "Resource not found", requestId?: string) {
		super(404, "NOT_FOUND", message, requestId);
		this.name = "NervlyNotFoundError";
	}
}

/**
 * 409 Conflict — the idempotency key has already been used.
 */
export class NervlyIdempotencyError extends NervlyApiError {
	constructor(
		message: string = "Idempotency key conflict — this request was already processed",
		requestId?: string,
	) {
		super(409, "IDEMPOTENCY_CONFLICT", message, requestId);
		this.name = "NervlyIdempotencyError";
	}
}

/**
 * Structured fields a {@link NervlyRateLimitError} parses from the response.
 */
export interface RateLimitErrorDetails {
	/** Which limit was hit — the body's `purpose` on a `429`. */
	purpose?: string;
	/**
	 * Advisory remaining budget from the draft-11 `RateLimit` header. Never a
	 * reason to gate a request: the counter is fixed-window and not atomic with
	 * the response.
	 */
	remaining?: number;
	/** Advisory quota from the draft-11 `RateLimit-Policy` header. */
	limit?: number;
}

/**
 * 429 Too Many Requests — a rate limit was exceeded.
 *
 * `retryAfterMs` is derived from the `Retry-After` header, the body's
 * `retry_after_seconds`, or the 1000 ms default, in that order. `purpose`
 * names *which* limit was hit; `remaining`/`limit` are the advisory budget from
 * the draft-11 `RateLimit`/`RateLimit-Policy` headers when the origin sends
 * them.
 */
export class NervlyRateLimitError extends NervlyApiError {
	public readonly retryAfterMs: number;
	public readonly purpose?: string;
	public readonly remaining?: number;
	public readonly limit?: number;

	constructor(
		message: string = "Rate limit exceeded",
		retryAfterMs: number = 1000,
		requestId?: string,
		details?: RateLimitErrorDetails,
	) {
		super(429, "RATE_LIMIT_EXCEEDED", message, requestId);
		this.name = "NervlyRateLimitError";
		this.retryAfterMs = retryAfterMs;
		this.purpose = details?.purpose;
		this.remaining = details?.remaining;
		this.limit = details?.limit;
	}
}

/**
 * 5xx Server Error — the gateway failed to process an otherwise valid request.
 */
export class NervlyServerError extends NervlyApiError {
	constructor(
		message: string = "Nervly server error",
		statusCode: number = 500,
		requestId?: string,
	) {
		super(statusCode, "SERVER_ERROR", message, requestId);
		this.name = "NervlyServerError";
	}
}

/**
 * Network-level failure — DNS, connection refused, TLS, or a timeout.
 *
 * The original `fetch` failure is preserved on `cause`.
 */
export class NervlyNetworkError extends NervlyError {
	public readonly cause?: Error;

	constructor(message: string, cause?: Error) {
		super(message);
		this.name = "NervlyNetworkError";
		this.cause = cause;
	}
}

/**
 * A webhook signature did not verify.
 *
 * `provider` names the source the caller was verifying, so a multi-provider
 * endpoint can log which integration failed without re-deriving it.
 */
export class NervlyWebhookSignatureError extends NervlyError {
	public readonly provider: string;

	constructor(provider: string) {
		super(`Invalid webhook signature from provider: ${provider}`);
		this.name = "NervlyWebhookSignatureError";
		this.provider = provider;
	}
}

/**
 * Every retry attempt was used up; the SDK stopped rather than looping.
 */
export class NervlyRetryExhaustedError extends NervlyError {
	public readonly attempts: number;
	public readonly lastError: Error;

	constructor(attempts: number, lastError: Error) {
		super(
			`All ${attempts} retry attempts exhausted. Last error: ${lastError.message}`,
		);
		this.name = "NervlyRetryExhaustedError";
		this.attempts = attempts;
		this.lastError = lastError;
	}
}

// --- Short aliases ---------------------------------------------------------
//
// The same class object under a shorter name, so `instanceof` behaves
// identically through either import.

/** Alias of {@link NervlyError}. */
/** Alias of {@link NervlyApiError}. */
/** Alias of {@link NervlyAuthenticationError}. */
/** Alias of {@link NervlyValidationError}. */
/** Alias of {@link NervlyNotFoundError}. */
/** Alias of {@link NervlyIdempotencyError}. */
/** Alias of {@link NervlyRateLimitError}. */
/** Alias of {@link NervlyServerError}. */
/** Alias of {@link NervlyNetworkError}. */
/** Alias of {@link NervlyRetryExhaustedError}. */
/** Alias of {@link NervlyWebhookSignatureError}. */
export {
	NervlyApiError as ApiError,
	NervlyAuthenticationError as AuthenticationError,
	NervlyError as NervlySdkError,
	NervlyIdempotencyError as IdempotencyError,
	NervlyNetworkError as NetworkError,
	NervlyNotFoundError as NotFoundError,
	NervlyRateLimitError as RateLimitError,
	NervlyRetryExhaustedError as RetryExhaustedError,
	NervlyServerError as ServerError,
	NervlyValidationError as ValidationError,
	NervlyWebhookSignatureError as WebhookSignatureError,
};
