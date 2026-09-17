/**
 * Structured error hierarchy for `@nervehq/sdk`.
 *
 * Every failure the SDK raises is an instance of {@link NerveError}, so a
 * single `instanceof NerveError` catch is enough to distinguish SDK errors from
 * your own. Below that root the hierarchy is split by *where* the failure came
 * from — HTTP response (`NerveApiError` and its status-specific subclasses) or
 * the transport itself (`NerveNetworkError`, `NerveRetryExhaustedError`).
 *
 * Each status-specific subclass also has a short alias (`AuthenticationError`
 * for `NerveAuthenticationError`, and so on). Both names are exported and both
 * refer to the same class, so `instanceof` works whichever you import. New code
 * should prefer the short aliases; the longer names are kept because they are
 * already in the published API surface.
 */

/**
 * Base class for all errors raised by the SDK.
 */
export class NerveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NerveError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Base class for errors that came from an HTTP response.
 *
 * Carries the numeric `statusCode` and the machine-readable `errorType` the
 * gateway returned, plus the `requestId` when the response supplied one.
 */
export class NerveApiError extends NerveError {
  public readonly statusCode: number;
  public readonly errorType: string;
  public readonly requestId?: string;

  constructor(statusCode: number, errorType: string, message: string, requestId?: string) {
    super(message);
    this.name = 'NerveApiError';
    this.statusCode = statusCode;
    this.errorType = errorType;
    this.requestId = requestId;
  }
}

/**
 * 401 Unauthorized — missing, malformed, or revoked API key.
 */
export class NerveAuthenticationError extends NerveApiError {
  constructor(message: string = 'Invalid or missing API key', requestId?: string) {
    super(401, 'UNAUTHORIZED', message, requestId);
    this.name = 'NerveAuthenticationError';
  }
}

/**
 * 400 Bad Request — the request body or query failed validation.
 */
export class NerveValidationError extends NerveApiError {
  constructor(message: string, requestId?: string) {
    super(400, 'BAD_REQUEST', message, requestId);
    this.name = 'NerveValidationError';
  }
}

/**
 * 404 Not Found — the event or subscriber does not exist.
 */
export class NerveNotFoundError extends NerveApiError {
  constructor(message: string = 'Resource not found', requestId?: string) {
    super(404, 'NOT_FOUND', message, requestId);
    this.name = 'NerveNotFoundError';
  }
}

/**
 * 409 Conflict — the idempotency key has already been used.
 */
export class NerveIdempotencyError extends NerveApiError {
  constructor(
    message: string = 'Idempotency key conflict — this request was already processed',
    requestId?: string,
  ) {
    super(409, 'IDEMPOTENCY_CONFLICT', message, requestId);
    this.name = 'NerveIdempotencyError';
  }
}

/**
 * 429 Too Many Requests — the per-subscriber rate limit was exceeded.
 *
 * `retryAfterMs` carries the `Retry-After` header, in milliseconds, when the
 * gateway sent one.
 */
export class NerveRateLimitError extends NerveApiError {
  public readonly retryAfterMs: number;

  constructor(
    message: string = 'Rate limit exceeded',
    retryAfterMs: number = 1000,
    requestId?: string,
  ) {
    super(429, 'RATE_LIMIT_EXCEEDED', message, requestId);
    this.name = 'NerveRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * 5xx Server Error — the gateway failed to process an otherwise valid request.
 */
export class NerveServerError extends NerveApiError {
  constructor(message: string = 'Nerve server error', statusCode: number = 500, requestId?: string) {
    super(statusCode, 'SERVER_ERROR', message, requestId);
    this.name = 'NerveServerError';
  }
}

/**
 * Network-level failure — DNS, connection refused, TLS, or a timeout.
 *
 * The original `fetch` failure is preserved on `cause`.
 */
export class NerveNetworkError extends NerveError {
  public readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'NerveNetworkError';
    this.cause = cause;
  }
}

/**
 * Every retry attempt was used up; the SDK stopped rather than looping.
 */
export class NerveRetryExhaustedError extends NerveError {
  public readonly attempts: number;
  public readonly lastError: Error;

  constructor(attempts: number, lastError: Error) {
    super(`All ${attempts} retry attempts exhausted. Last error: ${lastError.message}`);
    this.name = 'NerveRetryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

// --- Short aliases ---------------------------------------------------------
//
// The same class object under a shorter name, so `instanceof` behaves
// identically through either import.

/** Alias of {@link NerveError}. */
export { NerveError as NerveSdkError };

/** Alias of {@link NerveApiError}. */
export { NerveApiError as ApiError };

/** Alias of {@link NerveAuthenticationError}. */
export { NerveAuthenticationError as AuthenticationError };

/** Alias of {@link NerveValidationError}. */
export { NerveValidationError as ValidationError };

/** Alias of {@link NerveNotFoundError}. */
export { NerveNotFoundError as NotFoundError };

/** Alias of {@link NerveIdempotencyError}. */
export { NerveIdempotencyError as IdempotencyError };

/** Alias of {@link NerveRateLimitError}. */
export { NerveRateLimitError as RateLimitError };

/** Alias of {@link NerveServerError}. */
export { NerveServerError as ServerError };

/** Alias of {@link NerveNetworkError}. */
export { NerveNetworkError as NetworkError };

/** Alias of {@link NerveRetryExhaustedError}. */
export { NerveRetryExhaustedError as RetryExhaustedError };
