import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Nerve } from '../src/index.js';
import type { SendEmailOptions, TriggerEventRequest, TriggerEventResponse } from '../src/types.js';
import { recorder } from './helpers/mock-client.js';

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

describe('EmailResource & Email Helpers', () => {
  it('should have email.send and events.triggerEmail methods', () => {
    const nerve = new Nerve({ apiKey: 'test_key' });
    assert.equal(typeof nerve.email.send, 'function');
    assert.equal(typeof nerve.events.triggerEmail, 'function');
  });

  it('should build conforming TriggerEventRequest from string recipient', () => {
    const nerve = new Nerve({ apiKey: 'test_key' });
    const req: SendEmailOptions = {
      to: 'user@example.com',
      subject: 'Verify Your Email',
      html: '<p>Click here to verify</p>',
      provider: 'resend',
      sender: 'Nerve <notifications@nervehq.io>',
    };

    const built = nerve.email.buildTriggerRequest(req);
    assert.equal(built.name, 'transactional-email');
    assert.deepEqual(built.to, { subscriberId: 'user@example.com', email: 'user@example.com' });
    assert.equal(built.payload?.subject, 'Verify Your Email');
    assert.equal(built.payload?.html, '<p>Click here to verify</p>');
    assert.equal(built.overrides?.email?.provider, 'resend');
    assert.equal(built.overrides?.email?.sender, 'Nerve <notifications@nervehq.io>');
    assert.equal(built.category, 'transactional');
  });

  it('should build conforming TriggerEventRequest with ZeptoMail and custom headers', () => {
    const nerve = new Nerve({ apiKey: 'test_key' });
    const req: SendEmailOptions = {
      to: { subscriberId: 'sub_456', email: 'recipient@domain.com' },
      subject: 'Monthly Invoice',
      body: 'Here is your monthly invoice.',
      name: 'invoice-receipt',
      category: 'billing',
      provider: 'zeptomail',
      sender: 'Billing <billing@nervehq.io>',
      customHeaders: {
        'Reply-To': 'support@nervehq.io',
        'X-Invoice-Id': 'inv_9981',
      },
    };

    const built = nerve.email.buildTriggerRequest(req);
    assert.equal(built.name, 'invoice-receipt');
    assert.equal(built.to.subscriberId, 'sub_456');
    assert.equal(built.to.email, 'recipient@domain.com');
    assert.equal(built.payload?.subject, 'Monthly Invoice');
    assert.equal(built.payload?.body, 'Here is your monthly invoice.');
    assert.equal(built.overrides?.email?.provider, 'zeptomail');
    assert.equal(built.overrides?.email?.sender, 'Billing <billing@nervehq.io>');
    assert.deepEqual(built.overrides?.email?.customHeaders, {
      'Reply-To': 'support@nervehq.io',
      'X-Invoice-Id': 'inv_9981',
    });
    assert.equal(built.category, 'billing');
  });

  it('should correctly dispatch email.send with mock server', async () => {
    const captured = recorder<{
      body: TriggerEventRequest;
      authorization: string;
      idempotencyKey: string;
      priority: string;
    }>();

    const response: TriggerEventResponse = {
      eventId: 'evt_email_test_123',
      status: 'QUEUED',
      idempotencyKey: 'idem_email_001',
      priority: 'CRITICAL',
      channel: 'email',
      timestamp: '2026-08-03T00:00:00Z',
    };

    await withFetch(
      (url, init) => {
        assert.ok(url.endsWith('/v1/events/trigger'), `unexpected url ${url}`);
        const headers = new Headers(init?.headers);
        captured.push({
          body: JSON.parse(String(init?.body)) as TriggerEventRequest,
          authorization: headers.get('authorization') ?? '',
          idempotencyKey: headers.get('Idempotency-Key') ?? '',
          priority: headers.get('X-Priority-Override') ?? '',
        });

        return new Response(JSON.stringify(response), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      async () => {
        const nerve = new Nerve({
          apiKey: 'nv_live_test_email_key',
          baseUrl: 'https://test-api.nervehq.io',
        });

        const result = await nerve.email.send(
          {
            to: 'customer@example.com',
            subject: 'Password Reset',
            html: '<p>Reset token</p>',
            provider: 'resend',
            sender: 'Security <security@nervehq.io>',
          },
          {
            idempotencyKey: 'idem_email_001',
            priority: 'CRITICAL',
          },
        );

        assert.deepEqual(result, response);
      },
    );

    assert.equal(captured.last?.authorization, 'Bearer nv_live_test_email_key');
    assert.equal(captured.last?.idempotencyKey, 'idem_email_001');
    assert.equal(captured.last?.priority, 'CRITICAL');
    assert.equal(captured.last?.body.to.email, 'customer@example.com');
    assert.equal(captured.last?.body.overrides?.email?.provider, 'resend');
  });

  it('should correctly dispatch events.triggerEmail with mock server', async () => {
    const captured = recorder<TriggerEventRequest>();

    await withFetch(
      (_url, init) => {
        captured.push(JSON.parse(String(init?.body)) as TriggerEventRequest);
        return new Response(
          JSON.stringify({
            eventId: 'evt_events_email_999',
            status: 'QUEUED',
            idempotencyKey: null,
            priority: 'NORMAL',
            channel: 'email',
            timestamp: '2026-08-03T00:00:00Z',
          } satisfies TriggerEventResponse),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        );
      },
      async () => {
        const nerve = new Nerve({
          apiKey: 'nv_live_events_test_key',
          baseUrl: 'https://test-api.nervehq.io',
        });

        const response = await nerve.events.triggerEmail({
          to: 'staff@example.com',
          subject: 'Weekly Digest',
          text: 'Summary here...',
          provider: 'zeptomail',
        });

        assert.equal(response.eventId, 'evt_events_email_999');
      },
    );

    assert.equal(captured.last?.name, 'transactional-email');
    assert.equal(captured.last?.to.email, 'staff@example.com');
    assert.equal(captured.last?.payload?.text, 'Summary here...');
    assert.equal(captured.last?.overrides?.email?.provider, 'zeptomail');
  });
});
