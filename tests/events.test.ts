import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventsResource } from '../src/resources/events.js';
import type {
  BulkTriggerRequest,
  BulkTriggerResponse,
  MessageDto,
  TriggerEventRequest,
  TriggerEventResponse,
} from '../src/types.js';
import { mockClient, recorder } from './helpers/mock-client.js';

describe('EventsResource', () => {
  it('should expose the methods the gateway spec documents', () => {
    const events = new EventsResource(mockClient());
    assert.equal(typeof events.trigger, 'function');
    assert.equal(typeof events.triggerEmail, 'function');
    assert.equal(typeof events.bulkTrigger, 'function');
    assert.equal(typeof events.get, 'function');
  });

  it('should POST /v1/events/trigger with the idempotency and priority headers', async () => {
    const captured = recorder<{
      path: string;
      body: TriggerEventRequest;
      headers: Record<string, string>;
    }>();

    const response: TriggerEventResponse = {
      eventId: 'evt_abc123',
      status: 'QUEUED',
      idempotencyKey: 'idem-key-1',
      priority: 'CRITICAL',
      channel: 'email',
      timestamp: '2026-08-03T00:00:00Z',
    };

    const events = new EventsResource(
      mockClient({
        post: (path, body, headers) => {
          captured.push({
            path,
            body: body as TriggerEventRequest,
            headers: headers ?? {},
          });
          return response;
        },
      }),
    );

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

    assert.equal(captured.last?.path, '/v1/events/trigger');
    assert.equal(captured.last?.body.name, 'test_event');
    assert.equal(captured.last?.headers['Idempotency-Key'], 'idem-key-1');
    assert.equal(captured.last?.headers['X-Priority-Override'], 'CRITICAL');
    assert.deepEqual(result, response);
  });

  it('should omit both headers when no options are given', async () => {
    const captured = recorder<Record<string, string>>();

    const events = new EventsResource(
      mockClient({
        post: (_path, _body, headers) => {
          captured.push(headers ?? {});
          return {
            eventId: 'evt_1',
            status: 'QUEUED',
            priority: 'NORMAL',
            channel: 'sms',
            timestamp: '2026-08-03T00:00:00Z',
          } satisfies TriggerEventResponse;
        },
      }),
    );

    await events.trigger({ name: 'test_event', to: { subscriberId: 'usr_001' } });

    assert.deepEqual(captured.last, {});
  });

  it('should call bulkTrigger with events array', async () => {
    const captured = recorder<{ path: string; body: BulkTriggerRequest }>();

    const response: BulkTriggerResponse = {
      jobId: 'job_batch_test',
      status: 'QUEUED',
      count: 2,
      failedCount: 0,
      events: [
        { index: 0, status: 'QUEUED', eventId: 'evt_1', channel: 'sms' },
        { index: 1, status: 'QUEUED', eventId: 'evt_2', channel: 'email' },
      ],
    };

    const events = new EventsResource(
      mockClient({
        post: (path, body) => {
          captured.push({ path, body: body as BulkTriggerRequest });
          return response;
        },
      }),
    );

    const result = await events.bulkTrigger({
      events: [
        { name: 'evt1', to: { subscriberId: 'usr_1' } },
        { name: 'evt2', to: { subscriberId: 'usr_2' } },
      ],
    });

    assert.equal(captured.last?.path, '/v1/events/bulk');
    assert.equal(captured.last?.body.events.length, 2);
    assert.equal(result.count, 2);
    assert.equal(result.jobId, 'job_batch_test');
  });

  it('should call get with eventId', async () => {
    const captured = recorder<string>();

    const response: MessageDto = {
      event_id: 'evt_12345',
      event_name: 'test.event',
      subscriber_id: 'sub_1',
      status: 'DELIVERED',
      priority: 2,
      attempts: 1,
      cost_micro_usd: 5000,
      test_mode: false,
      variables_keys: ['orderId'],
      created_at: '2026-08-03T00:00:00Z',
      updated_at: '2026-08-03T00:00:01Z',
    };

    const events = new EventsResource(
      mockClient({
        get: (path) => {
          captured.push(path);
          return response;
        },
      }),
    );

    const result = await events.get('evt_12345');

    assert.equal(captured.last, '/v1/events/evt_12345');
    assert.equal(result.event_id, 'evt_12345');
    assert.equal(result.status, 'DELIVERED');
  });
});
