import {
  NerveApiError,
  NerveAuthenticationError,
  NerveValidationError,
  NerveNotFoundError,
  NerveIdempotencyError,
  NerveRateLimitError,
  NerveServerError,
  NerveNetworkError,
  NerveRetryExhaustedError,
} from './errors.js';
import type { NerveConfig, RequestOptions, ApiErrorBody } from './types.js';
import { computeBackoffDelay } from './retry.js';
import { SDK_VERSION } from './version.js';

/**
 * Low-level HTTP transport client for the Nerve Gateway API.
 *
 * Handles authentication, retries with exponential backoff + jitter,
 * request timeouts via AbortController, and error classification.
 *
 * Uses native `fetch` — requires Node.js >= 18.
 */
export class NerveHttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelay: number;

  constructor(config: NerveConfig) {
    if (!config.apiKey) {
      throw new NerveAuthenticationError('API key is required');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl?.replace(/\/$/, '') || 'https://api.nervly.io';
    this.timeout = config.timeout || 10000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseDelay = config.retryBaseDelay || 1000;
  }

  /**
   * Convenience: GET request.
   */
  public async get<T>(path: string, headers?: Record<string, string>): Promise<T> {
    return this.request<T>({ method: 'GET', path, headers });
  }

  /**
   * Convenience: POST request.
   */
  public async post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>({ method: 'POST', path, body, headers });
  }

  /**
   * Convenience: PUT request.
   */
  public async put<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>({ method: 'PUT', path, body, headers });
  }

  /**
   * Convenience: DELETE request.
   */
  public async delete<T>(path: string, headers?: Record<string, string>): Promise<T> {
    return this.request<T>({ method: 'DELETE', path, headers });
  }

  /**
   * Execute an HTTP request with retry logic and error handling.
   *
   * Retries on 429, 500, 502, 503, 504 and network errors, with exponential
   * backoff plus jitter: `min(base * 2^attempt + jitter, 30s)`. A 429 that
   * carried a `Retry-After` waits for that instead.
   *
   * Two distinct failures reach the caller:
   *
   * - the *retryable* error itself, when the budget was never spent (a 400, a
   *   404, or a 503 on a client configured with `maxRetries: 0`) — you were
   *   only told once, so the underlying error is the honest answer;
   * - {@link NerveRetryExhaustedError} when retries actually ran and all of
   *   them failed, carrying the last error on `lastError`. Without this you
   *   could not tell "the server hiccuped once" from "we gave up", which is
   *   what the class exists to express.
   */
  public async request<T>(options: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}${options.path.startsWith('/') ? options.path : `/${options.path}`}`;

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= this.maxRetries) {
      try {
        return await this.executeRequest<T>(url, options);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (this.shouldRetry(lastError, attempt)) {
          attempt++;
          const delay = this.calculateRetryDelay(lastError, attempt);
          await this.sleep(delay);
          continue;
        }

        if (attempt > 0 && this.isRetryable(lastError)) {
          throw new NerveRetryExhaustedError(attempt, lastError);
        }

        throw lastError;
      }
    }

    throw new NerveRetryExhaustedError(attempt, lastError!);
  }

  private async executeRequest<T>(url: string, options: RequestOptions): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('User-Agent', `@nervehq/sdk/${SDK_VERSION}`);

    if (!options.skipAuth) {
      headers.set('Authorization', `Bearer ${this.apiKey}`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new NerveNetworkError(`Request timed out after ${this.timeout}ms`);
      }
      throw new NerveNetworkError(
        'Network request failed',
        error instanceof Error ? error : undefined,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    // 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    let errorBody: Partial<ApiErrorBody> = {};
    let message = `API request failed with status ${response.status}`;

    try {
      errorBody = (await response.json()) as Partial<ApiErrorBody>;
      message = errorBody.message || errorBody.error || message;
    } catch {
      // Response body might not be JSON
    }

    const errorType = errorBody.error || 'UNKNOWN_ERROR';
    const requestId = response.headers.get('x-request-id') || undefined;

    switch (response.status) {
      case 400:
        throw new NerveValidationError(message, requestId);
      case 401:
        throw new NerveAuthenticationError(message, requestId);
      case 404:
        throw new NerveNotFoundError(message, requestId);
      case 409:
        throw new NerveIdempotencyError(message, requestId);
      case 429: {
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000;
        throw new NerveRateLimitError(message, retryAfterMs, requestId);
      }
      case 500:
      case 502:
      case 503:
      case 504:
        throw new NerveServerError(message, response.status, requestId);
      default:
        throw new NerveApiError(response.status, errorType, message, requestId);
    }
  }

  /** Whether a failure is worth another attempt, budget aside. */
  private isRetryable(error: Error): boolean {
    if (error instanceof NerveNetworkError) return true;

    if (error instanceof NerveApiError) {
      return [429, 500, 502, 503, 504].includes(error.statusCode);
    }

    return false;
  }

  private shouldRetry(error: Error, attempt: number): boolean {
    return attempt < this.maxRetries && this.isRetryable(error);
  }

  private calculateRetryDelay(error: Error, attempt: number): number {
    return computeBackoffDelay({
      attempt,
      retryBaseDelay: this.retryBaseDelay,
      retryAfterMs: error instanceof NerveRateLimitError ? error.retryAfterMs : undefined,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
