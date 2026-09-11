import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventsResource } from '../src/resources/events.js';

describe('EventsResource', () => {
  it('should have trigger method', () => {
    // Create a mock client
    const mockClient = {
      post: async () => ({
        eventId: 'evt_test123',
        status: 'QUEUED',
        idempotencyKey: null,
        priority: 'NORMAL',
        timestamp: new Date().toISOString(),
      }),
      get: async () => ({}),
      put: async () => ({}),
      request: async () => ({}),
    };

    const events = new EventsResource(mockClient as any);
    assert.equal(typeof events.trigger, 'function');
    assert.equal(typeof events.bulkTrigger, 'function');
  });

  it('should call trigger with correct payload', async () => {
    let capturedPath = '';
    let capturedBody: unknown = null;
    let capturedHeaders: Record<string, string> = {};

    const mockClient = {
      post: async (path: string, body: unknown, headers?: Record<string, string>) => {
        capturedPath = path;
        capturedBody = body;
        capturedHeaders = headers || {};
        return {
          eventId: 'evt_abc123',
          status: 'QUEUED',
          idempotencyKey: 'idem-key-1',
          priority: 'CRITICAL',
          timestamp: '2026-08-03T00:00:00Z',
        };
      },
      get: async () => ({}),
      put: async () => ({}),
      request: async () => ({}),
    };

    const events = new EventsResource(mockClient as any);
    const result = await events.trigger(
      {
        name: 'test_event',
        to: { subscriberId: 'usr_001', email: 'test@test.com' },
        payload: { key: 'value' },
      },
      {
        idempotencyKey: 'idem-key-1',
        priority: 'CRITICAL',
      },
    );

    assert.equal(capturedPath, '/v1/events/trigger');
    assert.deepEqual((capturedBody as any).name, 'test_event');
    assert.equal(capturedHeaders['Idempotency-Key'], 'idem-key-1');
    assert.equal(capturedHeaders['X-Priority-Override'], 'CRITICAL');
    assert.equal(result.eventId, 'evt_abc123');
    assert.equal(result.priority, 'CRITICAL');
  });

  it('should call bulkTrigger with events array', async () => {
    let capturedPath = '';
    let capturedBody: unknown = null;

    const mockClient = {
      post: async (path: string, body: unknown) => {
        capturedPath = path;
        capturedBody = body;
        return {
          jobId: 'job_batch_test',
          status: 'QUEUED',
          count: 2,
          estimatedCompletion: '2026-08-03T01:00:00Z',
        };
      },
      get: async () => ({}),
      put: async () => ({}),
      request: async () => ({}),
    };

    const events = new EventsResource(mockClient as any);
    const result = await events.bulkTrigger({
      events: [
        { name: 'evt1', to: { subscriberId: 'usr_1' } },
        { name: 'evt2', to: { subscriberId: 'usr_2' } },
      ],
    });

    assert.equal(capturedPath, '/v1/events/bulk');
    assert.equal((capturedBody as any).events.length, 2);
    assert.equal(result.count, 2);
    assert.equal(result.jobId, 'job_batch_test');
  });

  it('should call get with eventId', async () => {
    let capturedPath = '';

    const mockClient = {
      get: async (path: string) => {
        capturedPath = path;
        return {
          event_id: 'evt_12345',
          event_name: 'test.event',
          status: 'DELIVERED',
          attempts: 1,
          cost_micro_usd: 5000,
          test_mode: false,
          variables_keys: ['orderId'],
          created_at: '2026-08-03T00:00:00Z',
          updated_at: '2026-08-03T00:00:01Z',
        };
      },
      post: async () => ({}),
      put: async () => ({}),
      request: async () => ({}),
    };

    const events = new EventsResource(mockClient as any);
    const result = await events.get('evt_12345');

    assert.equal(capturedPath, '/v1/events/evt_12345');
    assert.equal(result.event_id, 'evt_12345');
    assert.equal(result.status, 'DELIVERED');
  });
});
