import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Nerve } from '../src/index.js';
import { NerveHttpClient } from '../src/client.js';
import {
  NerveApiError,
  NerveAuthenticationError,
  NerveNotFoundError,
  NerveRateLimitError,
  NerveRetryExhaustedError,
  NerveServerError,
  NerveValidationError,
  NerveError,
} from '../src/errors.js';
import type { HealthStatus } from '../src/types.js';

/** Replaces `globalThis.fetch` for the duration of `run`, then restores it. */
async function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('Nerve Client', () => {
  it('should throw if no API key is provided', () => {
    assert.throws(() => new Nerve({ apiKey: '' }), /API key/);
  });

  it('should create client with valid config and default to https://api.nervly.io', () => {
    const nerve = new Nerve({ apiKey: 'test_key_123' });
    assert.ok(nerve);
    assert.ok(nerve.events);
    assert.ok(nerve.email);
    assert.ok(nerve.messages);
    assert.ok(nerve.subscribers);
    assert.ok(nerve.users);
    assert.ok(nerve.health);
    assert.ok(nerve.mcp);
    assert.ok(nerve.webhooks);
  });

  it('should expose all resource properties', () => {
    const nerve = new Nerve({ apiKey: 'test_key' });
    assert.equal(typeof nerve.events.trigger, 'function');
    assert.equal(typeof nerve.events.triggerEmail, 'function');
    assert.equal(typeof nerve.email.send, 'function');
    assert.equal(typeof nerve.events.bulkTrigger, 'function');
    assert.equal(typeof nerve.events.get, 'function');
    assert.equal(typeof nerve.messages.list, 'function');
    assert.equal(typeof nerve.subscribers.delete, 'function');
    assert.equal(typeof nerve.subscribers.updatePreferences, 'function');
    assert.equal(typeof nerve.users.updatePreferences, 'function');
    assert.equal(typeof nerve.health.check, 'function');
    assert.equal(typeof nerve.mcp.listTools, 'function');
    assert.equal(typeof nerve.mcp.callTool, 'function');
    assert.equal(typeof nerve.webhooks.verifySignature, 'function');
    assert.equal(typeof nerve.webhooks.parse, 'function');
  });
});

describe('NerveHttpClient — request shape', () => {
  it('should default to https://api.nervly.io and strip a trailing slash from baseUrl', async () => {
    let capturedUrl = '';

    await withFetch(
      (url) => {
        capturedUrl = url;
        return jsonResponse(200, {
          status: 'OK',
          service: 'nerve-gateway',
          version: '0.1.0',
          environment: 'ci',
          uptime_seconds: 1,
          nats_connected: true,
        } satisfies HealthStatus);
      },
      async () => {
        const slashed = new Nerve({ apiKey: 'k', baseUrl: 'https://example.test/' });
        await slashed.health.check();
        assert.equal(capturedUrl, 'https://example.test/v1/health');

        const defaulted = new Nerve({ apiKey: 'k' });
        await defaulted.health.check();
        assert.equal(capturedUrl, 'https://api.nervly.io/v1/health');
      },
    );
  });

  it('should identify the SDK version in the User-Agent', async () => {
    let capturedUserAgent = '';

    await withFetch(
      (_url, init) => {
        capturedUserAgent = new Headers(init?.headers).get('user-agent') ?? '';
        return jsonResponse(200, {});
      },
      async () => {
        const client = new NerveHttpClient({ apiKey: 'k', baseUrl: 'https://example.test' });
        await client.get('/v1/health');
      },
    );

    assert.match(capturedUserAgent, /^@nervehq\/sdk\/\d+\.\d+\.\d+/);
  });

  it('should omit the body on GET and DELETE', async () => {
    const bodies: Array<string | undefined> = [];

    await withFetch(
      (_url, init) => {
        bodies.push(init?.body === undefined ? undefined : String(init.body));
        return jsonResponse(200, {});
      },
      async () => {
        const client = new NerveHttpClient({ apiKey: 'k', baseUrl: 'https://example.test' });
        await client.get('/v1/messages');
        await client.delete('/v1/subscribers/sub_1');
      },
    );

    assert.deepEqual(bodies, [undefined, undefined]);
  });
});

describe('NerveHttpClient — error classification', () => {
  const cases: Array<{
    status: number;
    body: Record<string, unknown>;
    expected: new (...args: never[]) => NerveApiError;
    headers?: Record<string, string>;
  }> = [
    {
      status: 400,
      body: { error: 'BAD_REQUEST', message: 'recipient has no contact details', status_code: 400 },
      expected: NerveValidationError,
    },
    {
      status: 401,
      body: { error: 'UNAUTHORIZED', message: 'invalid api key', status_code: 401 },
      expected: NerveAuthenticationError,
    },
    {
      status: 404,
      body: { error: 'NOT_FOUND', message: 'event not found', status_code: 404 },
      expected: NerveNotFoundError,
    },
    {
      status: 429,
      body: { error: 'RATE_LIMIT_EXCEEDED', message: 'slow down', status_code: 429 },
      expected: NerveRateLimitError,
    },
    {
      status: 503,
      body: { error: 'DATABASE_UNAVAILABLE', message: 'db down', status_code: 503 },
      expected: NerveServerError,
    },
  ];

  for (const { status, body, expected, headers } of cases) {
    it(`should map ${status} to ${expected.name}`, async () => {
      await withFetch(
        () => jsonResponse(status, body, headers ?? {}),
        async () => {
          const client = new NerveHttpClient({
            apiKey: 'k',
            baseUrl: 'https://example.test',
            maxRetries: 0,
          });

          const error = await client.get('/v1/events/evt_1').then(
            () => null,
            (e: unknown) => e as Error,
          );

          assert.ok(error instanceof expected, `expected ${expected.name}, got ${error?.name}`);
          assert.ok(error instanceof NerveApiError);
          assert.ok(error instanceof NerveError);
          assert.equal(error.statusCode, status);
          assert.equal(error.message, body.message);
        },
      );
    });
  }

  it('should preserve the provider Retry-After on a 429', async () => {
    await withFetch(
      () => jsonResponse(429, { error: 'RATE_LIMIT_EXCEEDED', message: 'slow down', status_code: 429 }, {
        'Retry-After': '7',
      }),
      async () => {
        const client = new NerveHttpClient({
          apiKey: 'k',
          baseUrl: 'https://example.test',
          maxRetries: 0,
        });

        const error = (await client.get('/v1/messages').then(
          () => null,
          (e: unknown) => e,
        )) as NerveRateLimitError;

        assert.equal(error.retryAfterMs, 7000);
      },
    );
  });

  it('should carry the request id when the gateway sends one', async () => {
    await withFetch(
      () =>
        jsonResponse(500, { error: 'INTERNAL', message: 'boom', status_code: 500 }, {
          'x-request-id': 'req_abc123',
        }),
      async () => {
        const client = new NerveHttpClient({
          apiKey: 'k',
          baseUrl: 'https://example.test',
          maxRetries: 0,
        });

        const error = (await client.get('/v1/messages').then(
          () => null,
          (e: unknown) => e,
        )) as NerveServerError;

        assert.equal(error.requestId, 'req_abc123');
      },
    );
  });

  it('should classify a timeout as a network error, not an API error', async () => {
    await withFetch(
      () => {
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        throw abort;
      },
      async () => {
        const client = new NerveHttpClient({
          apiKey: 'k',
          baseUrl: 'https://example.test',
          timeout: 5,
          maxRetries: 0,
        });

        const error = (await client.get('/v1/messages').then(
          () => null,
          (e: unknown) => e,
        )) as Error;

        assert.equal(error.name, 'NerveNetworkError');
        assert.match(error.message, /timed out after 5ms/);
        assert.ok(!(error instanceof NerveApiError));
      },
    );
  });

  it('should retry 503 and then succeed', async () => {
    let attempts = 0;

    await withFetch(
      () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(503, { error: 'DB_UNAVAILABLE', message: 'try later', status_code: 503 })
          : jsonResponse(200, { status: 'OK' });
      },
      async () => {
        const client = new NerveHttpClient({
          apiKey: 'k',
          baseUrl: 'https://example.test',
          maxRetries: 2,
          // Keep the test fast: the backoff floor is the only thing waited on.
          retryBaseDelay: 1,
        });

        const result = await client.get<{ status: string }>('/v1/health');
        assert.equal(result.status, 'OK');
      },
    );

    assert.equal(attempts, 2);
  });

  it('should raise RetryExhaustedError when every attempt fails', async () => {
    let attempts = 0;

    await withFetch(
      () => {
        attempts += 1;
        return jsonResponse(503, { error: 'DB_UNAVAILABLE', message: 'try later', status_code: 503 });
      },
      async () => {
        const client = new NerveHttpClient({
          apiKey: 'k',
          baseUrl: 'https://example.test',
          maxRetries: 1,
          retryBaseDelay: 1,
        });

        const error = (await client.get('/v1/health').then(
          () => null,
          (e: unknown) => e,
        )) as NerveRetryExhaustedError;

        assert.equal(error.name, 'NerveRetryExhaustedError');
        assert.equal(error.attempts, 1);
        // The wrapper keeps the error that exhausted the budget, which is where
        // the status code lives.
        assert.ok(error.lastError instanceof NerveServerError);
        assert.equal(error.lastError.statusCode, 503);
      },
    );

    assert.equal(attempts, 2);
  });

  it('should not retry a 400', async () => {
    let attempts = 0;

    await withFetch(
      () => {
        attempts += 1;
        return jsonResponse(400, { error: 'BAD_REQUEST', message: 'nope', status_code: 400 });
      },
      async () => {
        const client = new NerveHttpClient({
          apiKey: 'k',
          baseUrl: 'https://example.test',
          maxRetries: 3,
          retryBaseDelay: 1,
        });

        await assert.rejects(client.get('/v1/messages'), /nope/);
      },
    );

    assert.equal(attempts, 1);
  });

  it('should require an API key at the transport layer too', () => {
    assert.throws(() => new NerveHttpClient({ apiKey: '' }), /API key is required/);
  });
});
