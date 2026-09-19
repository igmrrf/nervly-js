/**
 * Wire-level contract for every public resource method.
 *
 * The existing resource suites use a hand-rolled `mockClient`, which proves the
 * path and payload but never builds a real `Headers`/`fetch` call. This suite
 * runs the real `NervlyHttpClient` against a scripted `fetch`, so it asserts the
 * headers the SDK actually sends (`Authorization`, `Idempotency-Key`,
 * `X-Priority-Override`, `User-Agent`), URL and query encoding, body
 * serialization, and how each method behaves on 2xx, 4xx and 5xx responses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Nervly } from '../src/index.js';
import { NervlyHttpClient } from '../src/client.js';
import {
  NervlyApiError,
  NervlyAuthenticationError,
  NervlyIdempotencyError,
  NervlyNetworkError,
  NervlyNotFoundError,
  NervlyRateLimitError,
  NervlyRetryExhaustedError,
  NervlyServerError,
  NervlyValidationError,
} from '../src/errors.js';
import type {
  BulkTriggerRequest,
  BulkTriggerResponse,
  HealthStatus,
  ListMessagesResponse,
  McpResponse,
  MessageDto,
  SubscriberErasureResponse,
  TriggerEventRequest,
  TriggerEventResponse,
  UserPreferencesRequest,
  UserPreferencesResponse,
} from '../src/types.js';
import { jsonResponse, withCapturedTimeouts, withFetch } from './helpers/http.js';

const API_KEY = 'nv_test_contract_key';
const BASE_URL = 'https://contract.test';

const TRIGGER_RESPONSE: TriggerEventResponse = {
  eventId: 'evt_contract_1',
  status: 'QUEUED',
  idempotencyKey: 'idem-1',
  priority: 'HIGH',
  channel: 'email',
  timestamp: '2026-09-18T00:00:00Z',
};

const MESSAGE: MessageDto = {
  event_id: 'evt_contract_1',
  event_name: 'user.signup',
  subscriber_id: 'usr_1',
  priority: 2,
  status: 'DELIVERED',
  channel: 'email',
  attempts: 1,
  cost_micro_usd: 42,
  test_mode: false,
  variables_keys: ['code'],
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:01Z',
};

const BULK_RESPONSE: BulkTriggerResponse = {
  jobId: 'job_contract_1',
  status: 'QUEUED',
  count: 2,
  failedCount: 0,
  events: [
    { index: 0, status: 'QUEUED', eventId: 'evt_a', channel: 'email' },
    { index: 1, status: 'QUEUED', eventId: 'evt_b', channel: 'sms' },
  ],
};

const ERASURE_RESPONSE: SubscriberErasureResponse = {
  status: 'accepted',
  subscriberId: 'sub/1 2',
  message: 'Subscriber erasure initiated',
};

const PREFS_RESPONSE: UserPreferencesResponse = {
  status: 'UPDATED',
  subscriberId: 'sub/1 2',
  updated_at: '2026-09-18T00:00:00Z',
};

const HEALTH_RESPONSE: HealthStatus = {
  status: 'OK',
  service: 'nervly-gateway',
  version: '0.1.0',
  environment: 'ci',
  uptime_seconds: 12,
  nats_connected: true,
};

const MCP_RESPONSE: McpResponse = { jsonrpc: '2.0', id: 1, result: { tools: [] } };

const LIST_RESPONSE: ListMessagesResponse = { messages: [MESSAGE], next_cursor: null };

const triggerInput: TriggerEventRequest = {
  name: 'user.signup',
  to: { subscriberId: 'usr_1', email: 'u@example.com' },
  payload: { code: '7823' },
};

const bulkInput: BulkTriggerRequest = {
  events: [
    { name: 'digest', to: { subscriberId: 'usr_1' } },
    { name: 'digest', to: { subscriberId: 'usr_2' } },
  ],
};

const prefsInput: UserPreferencesRequest = { channels: { email: false, sms: true } };

interface Operation {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  authenticated: boolean;
  headers?: Record<string, string>;
  expectedBody?: unknown;
  response: unknown;
  run: (nerve: Nervly) => Promise<unknown>;
}

const operations: Operation[] = [
  {
    name: 'events.trigger',
    method: 'POST',
    path: '/v1/events/trigger',
    authenticated: true,
    headers: { 'Idempotency-Key': 'idem-1', 'X-Priority-Override': 'HIGH' },
    expectedBody: triggerInput,
    response: TRIGGER_RESPONSE,
    run: (nerve) =>
      nerve.events.trigger(triggerInput, { idempotencyKey: 'idem-1', priority: 'HIGH' }),
  },
  {
    name: 'events.triggerEmail',
    method: 'POST',
    path: '/v1/events/trigger',
    authenticated: true,
    headers: { 'Idempotency-Key': 'idem-legacy', 'X-Priority-Override': 'LOW' },
    response: TRIGGER_RESPONSE,
    run: (nerve) =>
      nerve.events.triggerEmail(
        { to: 'legacy@example.com', subject: 'Hi', text: 'body', provider: 'resend' },
        { idempotencyKey: 'idem-legacy', priority: 'LOW' },
      ),
  },
  {
    name: 'events.bulkTrigger',
    method: 'POST',
    path: '/v1/events/bulk',
    authenticated: true,
    expectedBody: bulkInput,
    response: BULK_RESPONSE,
    run: (nerve) => nerve.events.bulkTrigger(bulkInput),
  },
  {
    name: 'events.get (URL-encodes the id)',
    method: 'GET',
    path: '/v1/events/evt%2F1%202',
    authenticated: true,
    response: MESSAGE,
    run: (nerve) => nerve.events.get('evt/1 2'),
  },
  {
    name: 'email.send',
    method: 'POST',
    path: '/v1/events/trigger',
    authenticated: true,
    headers: { 'Idempotency-Key': 'idem-email', 'X-Priority-Override': 'CRITICAL' },
    response: TRIGGER_RESPONSE,
    run: (nerve) =>
      nerve.email.send(
        {
          to: 'cust@example.com',
          subject: 'Reset',
          html: '<p>reset</p>',
          provider: 'resend',
          idempotencyKey: 'idem-email',
          priority: 'CRITICAL',
        },
        {},
      ),
  },
  {
    name: 'messages.list (query encoding)',
    method: 'GET',
    path:
      '/v1/messages?status=SENT&channel=sms&subscriber_id=sub%2Fa+b' +
      '&from=2026-09-01&to=2026-09-18&limit=5&cursor=cur%2F1',
    authenticated: true,
    response: LIST_RESPONSE,
    run: (nerve) =>
      nerve.messages.list({
        status: 'SENT',
        channel: 'sms',
        subscriberId: 'sub/a b',
        from: '2026-09-01',
        to: '2026-09-18',
        limit: 5,
        cursor: 'cur/1',
      }),
  },
  {
    name: 'subscribers.delete (URL-encodes the id)',
    method: 'DELETE',
    path: '/v1/subscribers/sub%2F1%202',
    authenticated: true,
    response: ERASURE_RESPONSE,
    run: (nerve) => nerve.subscribers.delete('sub/1 2'),
  },
  {
    name: 'subscribers.updatePreferences',
    method: 'PUT',
    path: '/v1/users/sub%2F1%202/preferences',
    authenticated: true,
    expectedBody: prefsInput,
    response: PREFS_RESPONSE,
    run: (nerve) => nerve.subscribers.updatePreferences('sub/1 2', prefsInput),
  },
  {
    name: 'users.updatePreferences',
    method: 'PUT',
    path: '/v1/users/sub%2F1%202/preferences',
    authenticated: true,
    expectedBody: prefsInput,
    response: PREFS_RESPONSE,
    run: (nerve) => nerve.users.updatePreferences('sub/1 2', prefsInput),
  },
  {
    name: 'health.check (unauthenticated)',
    method: 'GET',
    path: '/v1/health',
    authenticated: false,
    response: HEALTH_RESPONSE,
    run: (nerve) => nerve.health.check(),
  },
  {
    name: 'mcp.listTools',
    method: 'POST',
    path: '/v1/mcp',
    authenticated: true,
    expectedBody: { method: 'tools/list', params: null },
    response: MCP_RESPONSE,
    run: (nerve) => nerve.mcp.listTools(),
  },
  {
    name: 'mcp.callTool',
    method: 'POST',
    path: '/v1/mcp',
    authenticated: true,
    expectedBody: { method: 'tools/call', params: { name: 'gateway_status' } },
    response: MCP_RESPONSE,
    run: (nerve) => nerve.mcp.callTool({ name: 'gateway_status' }),
  },
];

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (error: unknown) => error,
  );
}

type ErrorConstructor = new (...args: never[]) => NervlyApiError;

describe('resource methods — 2xx wire contract', () => {
  for (const op of operations) {
    it(`${op.name}: ${op.method} ${op.path}`, async () => {
      await withFetch(
        () => jsonResponse(200, op.response),
        async (requests) => {
          const nerve = new Nervly({ apiKey: API_KEY, baseUrl: BASE_URL, maxRetries: 0 });
          const result = await op.run(nerve);

          assert.deepEqual(result, op.response);
          assert.equal(requests.length, 1, 'exactly one request on success');

          const request = requests[0]!;
          assert.equal(request.url, `${BASE_URL}${op.path}`);
          assert.equal(request.method, op.method);
          assert.equal(request.headers.get('content-type'), 'application/json');
          assert.match(request.headers.get('user-agent') ?? '', /^@nervly\/sdk\/\d+\.\d+\.\d+/);

          if (op.authenticated) {
            assert.equal(request.headers.get('authorization'), `Bearer ${API_KEY}`);
          } else {
            assert.equal(request.headers.get('authorization'), null, 'skipAuth omits the header');
          }

          for (const [name, value] of Object.entries(op.headers ?? {})) {
            assert.equal(request.headers.get(name), value, `${name} header`);
          }

          if (op.expectedBody !== undefined) {
            assert.deepEqual(JSON.parse(request.body ?? 'null'), op.expectedBody);
          } else if (op.method === 'GET' || op.method === 'DELETE') {
            assert.equal(request.body, undefined, 'GET/DELETE carry no body');
          }
        },
      );
    });
  }

  it('omits Idempotency-Key and X-Priority-Override when no options are given', async () => {
    await withFetch(
      () => jsonResponse(200, TRIGGER_RESPONSE),
      async (requests) => {
        const nerve = new Nervly({ apiKey: API_KEY, baseUrl: BASE_URL });
        await nerve.events.trigger(triggerInput);
        assert.equal(requests[0]!.headers.get('idempotency-key'), null);
        assert.equal(requests[0]!.headers.get('x-priority-override'), null);
      },
    );
  });
});

describe('resource methods — 4xx and 5xx', () => {
  for (const op of operations) {
    it(`${op.name}: 400 is not retried and maps to ValidationError`, async () => {
      const body = { error: 'BAD_REQUEST', message: `${op.name} rejected`, status_code: 400 };

      await withFetch(
        () => jsonResponse(400, body),
        async (requests) => {
          const nerve = new Nervly({
            apiKey: API_KEY,
            baseUrl: BASE_URL,
            maxRetries: 3,
            retryBaseDelay: 1,
          });
          const error = await captureError(() => op.run(nerve));

          assert.ok(error instanceof NervlyValidationError, `${op.name} 400`);
          assert.equal(error.statusCode, 400);
          assert.equal(error.message, `${op.name} rejected`);
          assert.equal(requests.length, 1, 'a 400 must never be retried');
        },
      );
    });

    it(`${op.name}: 503 is retried then surfaces RetryExhaustedError`, async () => {
      const body = { error: 'UNAVAILABLE', message: `${op.name} unavailable`, status_code: 503 };

      await withCapturedTimeouts(async () => {
        await withFetch(
          () => jsonResponse(503, body),
          async (requests) => {
            const nerve = new Nervly({
              apiKey: API_KEY,
              baseUrl: BASE_URL,
              maxRetries: 1,
              retryBaseDelay: 1,
            });
            const error = await captureError(() => op.run(nerve));

            assert.ok(error instanceof NervlyRetryExhaustedError, `${op.name} 503`);
            assert.equal(error.attempts, 1);
            const last = error.lastError;
            assert.ok(last instanceof NervlyServerError);
            assert.equal(last.statusCode, 503);
            assert.equal(requests.length, 2, 'original attempt + one retry');
          },
        );
      });
    });
  }
});

describe('status-code → error classification', () => {
  const cases: Array<{ status: number; expected: ErrorConstructor; errorType: string }> = [
    { status: 400, expected: NervlyValidationError, errorType: 'BAD_REQUEST' },
    { status: 401, expected: NervlyAuthenticationError, errorType: 'UNAUTHORIZED' },
    { status: 403, expected: NervlyApiError, errorType: 'GATEWAY_CODE' },
    { status: 404, expected: NervlyNotFoundError, errorType: 'NOT_FOUND' },
    { status: 409, expected: NervlyIdempotencyError, errorType: 'IDEMPOTENCY_CONFLICT' },
    { status: 422, expected: NervlyApiError, errorType: 'GATEWAY_CODE' },
    { status: 429, expected: NervlyRateLimitError, errorType: 'RATE_LIMIT_EXCEEDED' },
    { status: 500, expected: NervlyServerError, errorType: 'SERVER_ERROR' },
    { status: 502, expected: NervlyServerError, errorType: 'SERVER_ERROR' },
    { status: 503, expected: NervlyServerError, errorType: 'SERVER_ERROR' },
    { status: 504, expected: NervlyServerError, errorType: 'SERVER_ERROR' },
    { status: 418, expected: NervlyApiError, errorType: 'GATEWAY_CODE' },
  ];

  for (const { status, expected, errorType } of cases) {
    it(`maps ${status} to ${expected.name}`, async () => {
      const body = { error: 'GATEWAY_CODE', message: `status ${status}`, status_code: status };

      await withFetch(
        () =>
          jsonResponse(status, body, {
            'x-request-id': 'req_contract_1',
          }),
        async () => {
          const client = new NervlyHttpClient({
            apiKey: 'k',
            baseUrl: BASE_URL,
            maxRetries: 0,
          });
          const error = await captureError(() => client.get('/v1/events/evt_1'));

          assert.ok(error instanceof expected, `expected ${expected.name}`);
          assert.ok(error instanceof NervlyApiError);
          assert.equal(error.constructor, expected, 'exact class, not a sibling');
          assert.equal(error.statusCode, status);
          assert.equal(error.message, body.message);
          assert.equal(error.errorType, errorType);
          assert.equal(error.requestId, 'req_contract_1');
          if (status === 429) {
            assert.equal((error as NervlyRateLimitError).retryAfterMs, 1000, 'default Retry-After');
          }
        },
      );
    });
  }

  it('uses the error field as the message when message is absent', async () => {
    await withFetch(
      () => jsonResponse(400, { error: 'ONLY_ERROR_FIELD' }),
      async () => {
        const client = new NervlyHttpClient({ apiKey: 'k', baseUrl: BASE_URL, maxRetries: 0 });
        const error = await captureError(() => client.post('/v1/events/trigger', {}));
        assert.ok(error instanceof NervlyValidationError);
        assert.equal(error.message, 'ONLY_ERROR_FIELD');
      },
    );
  });

  it('falls back to a status message and UNKNOWN_ERROR for a non-JSON body', async () => {
    await withFetch(
      () => new Response('<html>gateway blew up</html>', { status: 500 }),
      async () => {
        const client = new NervlyHttpClient({ apiKey: 'k', baseUrl: BASE_URL, maxRetries: 0 });
        const error = await captureError(() => client.get('/v1/events/evt_1'));
        assert.ok(error instanceof NervlyServerError);
        assert.equal(error.message, 'API request failed with status 500');
        assert.equal(error.errorType, 'SERVER_ERROR');
      },
    );
  });

  it('falls back to UNKNOWN_ERROR for a non-JSON body on an unmapped status', async () => {
    await withFetch(
      () => new Response('not json', { status: 418 }),
      async () => {
        const client = new NervlyHttpClient({ apiKey: 'k', baseUrl: BASE_URL, maxRetries: 0 });
        const error = await captureError(() => client.get('/v1/events/evt_1'));
        assert.ok(error instanceof NervlyApiError);
        assert.equal(error.constructor, NervlyApiError);
        assert.equal(error.statusCode, 418);
        assert.equal(error.errorType, 'UNKNOWN_ERROR');
        assert.equal(error.message, 'API request failed with status 418');
      },
    );
  });

  it('honours a numeric Retry-After on 429', async () => {
    await withFetch(
      () =>
        jsonResponse(
          429,
          { error: 'RATE_LIMIT_EXCEEDED', message: 'slow down', status_code: 429 },
          { 'Retry-After': '7' },
        ),
      async () => {
        const client = new NervlyHttpClient({ apiKey: 'k', baseUrl: BASE_URL, maxRetries: 0 });
        const error = await captureError(() => client.get('/v1/messages'));
        assert.ok(error instanceof NervlyRateLimitError);
        assert.equal(error.retryAfterMs, 7000);
      },
    );
  });
});

describe('retry policy at the boundaries', () => {
  for (const status of [401, 403, 422] as const) {
    it(`does not retry ${status} even with a full retry budget`, async () => {
      await withFetch(
        () => jsonResponse(status, { error: 'X', message: 'nope', status_code: status }),
        async (requests) => {
          const client = new NervlyHttpClient({
            apiKey: 'k',
            baseUrl: BASE_URL,
            maxRetries: 3,
            retryBaseDelay: 1,
          });
          const error = await captureError(() => client.get('/v1/events/evt_1'));
          assert.ok(error instanceof NervlyApiError);
          assert.ok(!(error instanceof NervlyRetryExhaustedError));
          assert.equal(requests.length, 1);
        },
      );
    });
  }

  it('throws the non-retryable error directly when a retry meets a 400', async () => {
    let attempts = 0;

    await withCapturedTimeouts(async () => {
      await withFetch(
        () => {
          attempts += 1;
          return attempts === 1
            ? jsonResponse(503, { error: 'UNAVAILABLE', message: 'down', status_code: 503 })
            : jsonResponse(400, { error: 'BAD_REQUEST', message: 'now bad', status_code: 400 });
        },
        async (requests) => {
          const client = new NervlyHttpClient({
            apiKey: 'k',
            baseUrl: BASE_URL,
            maxRetries: 3,
            retryBaseDelay: 1,
          });
          const error = await captureError(() => client.get('/v1/events/evt_1'));
          assert.ok(error instanceof NervlyValidationError, 'not wrapped as exhaustion');
          assert.equal(error.statusCode, 400);
          assert.equal(requests.length, 2);
        },
      );
    });
  });

  it('counts every attempt when the 503 budget is spent', async () => {
    await withCapturedTimeouts(async () => {
      await withFetch(
        () => jsonResponse(503, { error: 'UNAVAILABLE', message: 'down', status_code: 503 }),
        async (requests) => {
          const client = new NervlyHttpClient({
            apiKey: 'k',
            baseUrl: BASE_URL,
            maxRetries: 2,
            retryBaseDelay: 1,
          });
          const error = await captureError(() => client.get('/v1/health'));
          assert.ok(error instanceof NervlyRetryExhaustedError);
          assert.equal(error.attempts, 2, 'two retries after the original');
          assert.equal(requests.length, 3, 'original + two retries');
          const last = error.lastError;
          assert.ok(last instanceof NervlyServerError);
          assert.equal(last.statusCode, 503);
        },
      );
    });
  });

  it('exhausts the 429 budget and keeps the rate-limit error', async () => {
    await withCapturedTimeouts(async (delays) => {
      await withFetch(
        () =>
          jsonResponse(429, { error: 'RATE_LIMIT_EXCEEDED', message: 'slow', status_code: 429 }),
        async () => {
          const client = new NervlyHttpClient({
            apiKey: 'k',
            baseUrl: BASE_URL,
            maxRetries: 1,
            retryBaseDelay: 1,
            timeout: 10_000,
          });
          const error = await captureError(() => client.get('/v1/health'));
          assert.ok(error instanceof NervlyRetryExhaustedError);
          assert.equal(error.attempts, 1);
          const last = error.lastError;
          assert.ok(last instanceof NervlyRateLimitError);
          assert.equal(last.statusCode, 429);
          assert.equal(last.retryAfterMs, 1000);
        },
      );
      assert.ok(delays.includes(1000), 'a 429 without Retry-After waits the 1s default');
    });
  });

  it('retries a network failure and wraps the cause on exhaustion', async () => {
    const socketError = new TypeError('fetch failed');

    await withCapturedTimeouts(async () => {
      await withFetch(
        () => {
          throw socketError;
        },
        async (requests) => {
          const client = new NervlyHttpClient({
            apiKey: 'k',
            baseUrl: BASE_URL,
            maxRetries: 1,
            retryBaseDelay: 1,
          });
          const error = await captureError(() => client.get('/v1/health'));
          assert.ok(error instanceof NervlyRetryExhaustedError);
          const last = error.lastError;
          assert.ok(last instanceof NervlyNetworkError);
          assert.equal(last.cause, socketError);
          assert.equal(requests.length, 2);
        },
      );
    });
  });

  it('preserves no cause when a non-Error is thrown', async () => {
    await withFetch(
      () => {
        throw 'not-an-error';
      },
      async () => {
        const client = new NervlyHttpClient({
          apiKey: 'k',
          baseUrl: BASE_URL,
          maxRetries: 0,
        });
        const error = await captureError(() => client.get('/v1/health'));
        assert.ok(error instanceof NervlyNetworkError);
        assert.equal(error.message, 'Network request failed');
        assert.equal(error.cause, undefined);
      },
    );
  });

  it('maps a real AbortSignal timeout to a NervlyNetworkError', async () => {
    await withFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          assert.ok(init?.signal instanceof AbortSignal, 'fetch receives an AbortSignal');
          assert.equal(init.signal.aborted, false, 'signal is not aborted up front');
          init.signal.addEventListener('abort', () => {
            const abort = new Error('aborted');
            abort.name = 'AbortError';
            reject(abort);
          });
        }),
      async () => {
        const client = new NervlyHttpClient({
          apiKey: 'k',
          baseUrl: BASE_URL,
          timeout: 15,
          maxRetries: 0,
        });
        const error = await captureError(() => client.get('/v1/health'));
        assert.ok(error instanceof NervlyNetworkError);
        assert.match(error.message, /timed out after 15ms/);
        assert.ok(!(error instanceof NervlyApiError));
      },
    );
  });

  it('returns an empty object for 204 No Content', async () => {
    await withFetch(
      () => new Response(null, { status: 204 }),
      async () => {
        const client = new NervlyHttpClient({ apiKey: 'k', baseUrl: BASE_URL, maxRetries: 0 });
        const result = await client.delete<Record<string, never>>('/v1/subscribers/sub_1');
        assert.deepEqual(result, {});
      },
    );
  });

  it('honours maxRetries: 0 by failing a 503 on the first response', async () => {
    await withFetch(
      () => jsonResponse(503, { error: 'UNAVAILABLE', message: 'down', status_code: 503 }),
      async (requests) => {
        const client = new NervlyHttpClient({ apiKey: 'k', baseUrl: BASE_URL, maxRetries: 0 });
        const error = await captureError(() => client.get('/v1/health'));
        assert.ok(error instanceof NervlyServerError);
        assert.ok(!(error instanceof NervlyRetryExhaustedError));
        assert.equal(requests.length, 1);
      },
    );
  });
});
