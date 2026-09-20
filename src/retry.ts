/**
 * Retry delay arithmetic, kept pure so the exponential-backoff boundary
 * conditions (attempt growth, jitter span, the 30s ceiling, and a provider
 * `Retry-After` that overrides the exponential curve) can be asserted exactly
 * without sleeping through them.
 */

/** The delay never exceeds this, no matter how many attempts have run. */
export const MAX_BACKOFF_MS = 30_000;

/** Jitter is drawn uniformly from `[0, JITTER_SPAN_MS)`. */
export const JITTER_SPAN_MS = 200;

export interface BackoffOptions {
	/** Zero-based retry attempt; the first retry passes `1`, matching `2^1`. */
	attempt: number;
	/** The configured `retryBaseDelay`, in milliseconds. */
	retryBaseDelay: number;
	/** Jitter in `[0, 1)`. Defaults to `Math.random()`. */
	jitter?: number;
	/**
	 * A provider-supplied delay (e.g. a 429 `Retry-After`, already in ms). When
	 * truthy it wins outright and is *not* capped by `maxDelayMs`.
	 */
	retryAfterMs?: number;
	/** Ceiling for the exponential curve. Defaults to {@link MAX_BACKOFF_MS}. */
	maxDelayMs?: number;
	/** Jitter span in milliseconds. Defaults to {@link JITTER_SPAN_MS}. */
	jitterSpanMs?: number;
}

/**
 * `min(base * 2^attempt + jitter, maxDelay)`, unless the provider told us how
 * long to wait.
 */
export function computeBackoffDelay(options: BackoffOptions): number {
	const {
		attempt,
		retryBaseDelay,
		jitter = Math.random(),
		retryAfterMs,
		maxDelayMs = MAX_BACKOFF_MS,
		jitterSpanMs = JITTER_SPAN_MS,
	} = options;

	if (retryAfterMs) {
		return retryAfterMs;
	}

	return Math.min(
		retryBaseDelay * 2 ** attempt + jitter * jitterSpanMs,
		maxDelayMs,
	);
}
