import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessagesResource } from '../src/resources/messages.js';
import { SubscribersResource } from '../src/resources/subscribers.js';

describe('MessagesResource', () => {
  it('should call list without query parameters when empty', async () => {
    let capturedPath = '';

    const mockClient = {
      get: async (path: string) => {
        capturedPath = path;
        return { messages: [], next_cursor: null };
      },
      post: async () => ({}),
      put: async () => ({}),
      delete: async () => ({}),
      request: async () => ({}),
    };

    const messages = new MessagesResource(mockClient as any);
    const result = await messages.list();

    assert.equal(capturedPath, '/v1/messages');
    assert.deepEqual(result.messages, []);
  });

  it('should serialize query parameters correctly in list', async () => {
    let capturedPath = '';

    const mockClient = {
      get: async (path: string) => {
        capturedPath = path;
        return {
          messages: [
            {
              event_id: 'evt_1',
              event_name: 'test',
              status: 'SENT',
              priority: 1,
              attempts: 1,
              cost_micro_usd: 0,
              test_mode: false,
              variables_keys: [],
              created_at: '2026-09-11T00:00:00Z',
              updated_at: '2026-09-11T00:00:01Z',
            },
          ],
          next_cursor: 'cur_next_123',
        };
      },
      post: async () => ({}),
      put: async () => ({}),
      delete: async () => ({}),
      request: async () => ({}),
    };

    const messages = new MessagesResource(mockClient as any);
    const result = await messages.list({
      status: 'SENT',
      channel: 'sms',
      subscriberId: 'sub_42',
      limit: 25,
    });

    assert.ok(capturedPath.startsWith('/v1/messages?'));
    assert.ok(capturedPath.includes('status=SENT'));
    assert.ok(capturedPath.includes('channel=sms'));
    assert.ok(capturedPath.includes('subscriber_id=sub_42'));
    assert.ok(capturedPath.includes('limit=25'));
    assert.equal(result.messages.length, 1);
    assert.equal(result.next_cursor, 'cur_next_123');
  });
});

describe('SubscribersResource', () => {
  it('should call delete on /v1/subscribers/:subscriberId', async () => {
    let capturedPath = '';

    const mockClient = {
      delete: async (path: string) => {
        capturedPath = path;
        return {
          status: 'accepted',
          subscriberId: 'sub_999',
          message: 'Subscriber erasure initiated and completed',
        };
      },
      get: async () => ({}),
      post: async () => ({}),
      put: async () => ({}),
      request: async () => ({}),
    };

    const subscribers = new SubscribersResource(mockClient as any);
    const result = await subscribers.delete('sub_999');

    assert.equal(capturedPath, '/v1/subscribers/sub_999');
    assert.equal(result.status, 'accepted');
    assert.equal(result.subscriberId, 'sub_999');
  });

  it('should call updatePreferences on /v1/users/:subscriberId/preferences', async () => {
    let capturedPath = '';
    let capturedBody: unknown = null;

    const mockClient = {
      put: async (path: string, body: unknown) => {
        capturedPath = path;
        capturedBody = body;
        return {
          status: 'OK',
          subscriberId: 'sub_999',
          updatedAt: '2026-09-11T00:00:00Z',
        };
      },
      get: async () => ({}),
      post: async () => ({}),
      delete: async () => ({}),
      request: async () => ({}),
    };

    const subscribers = new SubscribersResource(mockClient as any);
    const result = await subscribers.updatePreferences('sub_999', {
      channels: { email: true, sms: false },
    });

    assert.equal(capturedPath, '/v1/users/sub_999/preferences');
    assert.deepEqual(capturedBody, { channels: { email: true, sms: false } });
    assert.equal(result.status, 'OK');
  });
});
