/**
 * Base error class for all Nerve SDK errors.
 */
export class NerveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NerveError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an API request returns an error response.
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
 * 401 Unauthorized — invalid or missing API key.
 */
export class NerveAuthenticationError extends NerveApiError {
  constructor(message: string = 'Invalid or missing API key') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'NerveAuthenticationError';
  }
}

/**
 * 400 Bad Request — validation failure.
 */
export class NerveValidationError extends NerveApiError {
  constructor(message: string) {
    super(400, 'BAD_REQUEST', message);
    this.name = 'NerveValidationError';
  }
}

/**
 * 409 Conflict — idempotency key collision.
 */
export class NerveIdempotencyError extends NerveApiError {
  constructor(message: string = 'Idempotency key conflict — this request was already processed') {
    super(409, 'IDEMPOTENCY_CONFLICT', message);
    this.name = 'NerveIdempotencyError';
  }
}

/**
 * 429 Too Many Requests — rate limit exceeded.
 */
export class NerveRateLimitError extends NerveApiError {
  public readonly retryAfterMs: number;

  constructor(message: string = 'Rate limit exceeded', retryAfterMs: number = 1000) {
    super(429, 'RATE_LIMIT_EXCEEDED', message);
    this.name = 'NerveRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Network-level error (timeout, connection refused, DNS failure).
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
 * Thrown when max retries are exhausted.
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
