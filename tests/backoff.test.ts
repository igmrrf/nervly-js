/**
 * Exponential backoff with jitter — the highest-complexity arithmetic in the
 * transport.
 *
 * The pure `computeBackoffDelay` is asserted exactly at its boundaries; the
 * second half proves the client actually *uses* it, by recording the delays it
 * schedules rather than mutating a private method.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoffDelay, JITTER_SPAN_MS, MAX_BACKOFF_MS } from '../src/retry.js';
import { NervlyHttpClient } from '../src/client.js';
import { jsonResponse, withFetch, withCapturedTimeouts } from './helpers/http.js';

describe('computeBackoffDelay', () => {
  it('doubles the base delay with each attempt (2^attempt)', () => {
    assert.equal(computeBackoffDelay({ attempt: 1, retryBaseDelay: 1000, jitter: 0 }), 2000);
    assert.equal(computeBackoffDelay({ attempt: 2, retryBaseDelay: 1000, jitter: 0 }), 4000);
    assert.equal(computeBackoffDelay({ attempt: 3, retryBaseDelay: 1000, jitter: 0 }), 8000);
  });

  it('starts the curve at the base for attempt 0', () => {
    assert.equal(computeBackoffDelay({ attempt: 0, retryBaseDelay: 750, jitter: 0 }), 750);
  });

  it('adds jitter scaled by the draw, from 0 up to the full span', () => {
    const at = (jitter: number) => computeBackoffDelay({ attempt: 1, retryBaseDelay: 1000, jitter });
    assert.equal(at(0), 2000);
    assert.equal(at(0.5), 2000 + JITTER_SPAN_MS / 2);
    assert.equal(at(1), 2000 + JITTER_SPAN_MS);
  });

  it('caps the exponential curve at 30 seconds', () => {
    assert.equal(
      computeBackoffDelay({ attempt: 10, retryBaseDelay: 1000, jitter: 0 }),
      MAX_BACKOFF_MS,
    );
    assert.equal(
      computeBackoffDelay({ attempt: 4, retryBaseDelay: 20_000, jitter: 1 }),
      MAX_BACKOFF_MS,
    );
  });

  it('lets a provider Retry-After override the curve, uncapped', () => {
    assert.equal(computeBackoffDelay({ attempt: 1, retryBaseDelay: 1, retryAfterMs: 7000 }), 7000);
    assert.equal(
      computeBackoffDelay({ attempt: 9, retryBaseDelay: 1000, jitter: 1, retryAfterMs: 90_000 }),
      90_000,
    );
  });

  it('ignores a falsy Retry-After and falls back to the curve', () => {
    assert.equal(
      computeBackoffDelay({ attempt: 1, retryBaseDelay: 1000, jitter: 0, retryAfterMs: 0 }),
      2000,
    );
    assert.equal(computeBackoffDelay({ attempt: 1, retryBaseDelay: 1000, jitter: 0 }), 2000);
  });

  it('honours explicit maxDelayMs and jitterSpanMs overrides', () => {
    assert.equal(
      computeBackoffDelay({ attempt: 2, retryBaseDelay: 1000, jitter: 1, maxDelayMs: 2500 }),
      2500,
    );
    assert.equal(
      computeBackoffDelay({ attempt: 0, retryBaseDelay: 100, jitter: 1, jitterSpanMs: 50 }),
      150,
    );
  });

  it('defaults jitter to Math.random and stays inside the span', () => {
    const delay = computeBackoffDelay({ attempt: 0, retryBaseDelay: 100 });
    assert.ok(delay >= 100 && delay <= 100 + JITTER_SPAN_MS, `delay ${delay} outside jitter span`);
  });
});

describe('NervlyHttpClient retry-delay wiring', () => {
  it('waits the computed exponential delay between attempts', async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    let attempts = 0;

    try {
      await withCapturedTimeouts(async (delays) => {
        await withFetch(
          () => {
            attempts += 1;
            return attempts < 3
              ? jsonResponse(503, { error: 'UNAVAILABLE', message: 'down', status_code: 503 })
              : jsonResponse(200, { status: 'OK' });
          },
          async () => {
            const client = new NervlyHttpClient({
              apiKey: 'k',
              baseUrl: 'https://example.test',
              maxRetries: 2,
              retryBaseDelay: 1,
              timeout: 10_000,
            });
            const result = await client.get<{ status: string }>('/v1/health');
            assert.equal(result.status, 'OK');
          },
        );

        assert.deepEqual(
          delays.filter((ms) => ms > 0 && ms < 1000),
          [2, 4],
          'attempt 1 schedules 1*2^1, attempt 2 schedules 1*2^2',
        );
      });

      assert.equal(attempts, 3, '2 failures + 1 success');
    } finally {
      Math.random = originalRandom;
    }
  });

  it('adds the jitter span when the draw is at its maximum', async () => {
    const originalRandom = Math.random;
    Math.random = () => 1;
    let attempts = 0;

    try {
      await withCapturedTimeouts(async (delays) => {
        await withFetch(
          () => {
            attempts += 1;
            return attempts === 1
              ? jsonResponse(503, { error: 'UNAVAILABLE', message: 'down', status_code: 503 })
              : jsonResponse(200, { status: 'OK' });
          },
          async () => {
            const client = new NervlyHttpClient({
              apiKey: 'k',
              baseUrl: 'https://example.test',
              maxRetries: 1,
              retryBaseDelay: 1,
              timeout: 10_000,
            });
            await client.get('/v1/health');
          },
        );

        assert.deepEqual(
          delays.filter((ms) => ms > 0 && ms < 1000),
          [202],
          '1 * 2^1 + 1 * 200',
        );
      });
    } finally {
      Math.random = originalRandom;
    }
  });

  it('uses the provider Retry-After instead of the exponential curve', async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    let attempts = 0;

    try {
      await withCapturedTimeouts(async (delays) => {
        await withFetch(
          () => {
            attempts += 1;
            return attempts === 1
              ? jsonResponse(
                  429,
                  { error: 'RATE_LIMIT_EXCEEDED', message: 'slow down', status_code: 429 },
                  { 'Retry-After': '7' },
                )
              : jsonResponse(200, { status: 'OK' });
          },
          async () => {
            const client = new NervlyHttpClient({
              apiKey: 'k',
              baseUrl: 'https://example.test',
              maxRetries: 1,
              retryBaseDelay: 1000,
              timeout: 10_000,
            });
            await client.get('/v1/health');
          },
        );

        assert.ok(
          delays.includes(7000),
          `expected a scheduled 7000ms wait, saw ${JSON.stringify(delays)}`,
        );
        assert.deepEqual(
          delays.filter((ms) => ms > 0 && ms < 1000),
          [],
          'no exponential fallback when Retry-After is present',
        );
      });

      assert.equal(attempts, 2);
    } finally {
      Math.random = originalRandom;
    }
  });
});
