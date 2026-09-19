import type { NervlyHttpClient } from '../../src/client.js';
import type { RequestOptions } from '../../src/types.js';

export interface MockHandlers {
  get?: (path: string) => unknown;
  post?: (path: string, body?: unknown, headers?: Record<string, string>) => unknown;
  put?: (path: string, body?: unknown) => unknown;
  delete?: (path: string) => unknown;
  request?: (options: RequestOptions) => unknown;
}

/**
 * A stand-in for `NervlyHttpClient` that answers from the handlers a test hands
 * it, so a resource can be exercised without a socket.
 *
 * Response bodies in tests are annotated with their real SDK type
 * (`const body: BulkTriggerResponse = ...`) so `npm run check:types` fails when
 * a fixture stops matching the contract — a blanket `as any` client would hide
 * exactly that drift.
 */
export function mockClient(handlers: MockHandlers = {}): NervlyHttpClient {
  return {
    get: async (path: string) => handlers.get?.(path),
    post: async (path: string, body?: unknown, headers?: Record<string, string>) =>
      handlers.post?.(path, body, headers),
    put: async (path: string, body?: unknown) => handlers.put?.(path, body),
    delete: async (path: string) => handlers.delete?.(path),
    request: async (options: RequestOptions) => handlers.request?.(options),
  } as unknown as NervlyHttpClient;
}

/**
 * Records what a mock handler was called with.
 *
 * A `let captured: T | null = null` assigned inside a callback reads as `null`
 * (and therefore `never` through `?.`) at the assertion site, because the
 * compiler cannot see the callback run. Collecting into an array sidesteps that
 * without weakening the type.
 */
export function recorder<T>() {
  const calls: T[] = [];
  return {
    calls,
    push(call: T): void {
      calls.push(call);
    },
    /** The most recent call, or `undefined` if the handler never ran. */
    get last(): T | undefined {
      return calls[calls.length - 1];
    },
  };
}
