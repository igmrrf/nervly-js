import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Nervly } from '../src/index.js';
import { Channel } from '../src/index.js';
import type { SendVoiceOptions, TriggerEventRequest, TriggerEventResponse } from '../src/types.js';
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

describe('VoiceResource & Voice helpers', () => {
  it('should expose voice.send and buildTriggerRequest, and a Channel.VOICE value', () => {
    const nervly = new Nervly({ apiKey: 'test_key' });
    assert.equal(typeof nervly.voice.send, 'function');
    assert.equal(typeof nervly.voice.buildTriggerRequest, 'function');
    assert.equal(Channel.VOICE, 'voice');
    assert.deepEqual(Object.values(Channel), [
      'sms',
      'email',
      'push',
      'whatsapp',
      'voice',
      'itsm',
    ]);
    // `Channel` is exported as a type as well as a value.
    const voiceChannel: import('../src/index.js').Channel = Channel.VOICE;
    assert.equal(voiceChannel, 'voice');
  });

  it('should build a conforming TriggerEventRequest from a string phone recipient', () => {
    const nervly = new Nervly({ apiKey: 'test_key' });
    const req: SendVoiceOptions = {
      to: '+2348012345678',
      script: 'Your verification code is 48291',
    };

    const built = nervly.voice.buildTriggerRequest(req);
    assert.equal(built.name, 'transactional-voice');
    assert.deepEqual(built.to, { subscriberId: '+2348012345678', phone: '+2348012345678' });
    assert.deepEqual(built.payload, {});
    assert.deepEqual(built.overrides, {
      voice: { script: 'Your verification code is 48291' },
    });
    assert.equal(built.category, 'transactional');
  });

  it('should emit only the voice fields the caller supplied', () => {
    const nervly = new Nervly({ apiKey: 'test_key' });

    const scriptOnly = nervly.voice.buildTriggerRequest({
      to: { subscriberId: 'sub_1', phone: '+234800' },
      script: 'Hello',
    });
    assert.deepEqual(scriptOnly.overrides?.voice, { script: 'Hello' });
    assert.equal('voice_id' in (scriptOnly.overrides?.voice ?? {}), false);
    assert.equal('language' in (scriptOnly.overrides?.voice ?? {}), false);

    const withVoiceId = nervly.voice.buildTriggerRequest({
      to: { subscriberId: 'sub_1', phone: '+234800' },
      script: 'Hello',
      voice_id: 'Ada',
    });
    assert.deepEqual(withVoiceId.overrides?.voice, { script: 'Hello', voice_id: 'Ada' });
    assert.equal('language' in (withVoiceId.overrides?.voice ?? {}), false);

    const withLanguage = nervly.voice.buildTriggerRequest({
      to: { subscriberId: 'sub_1', phone: '+234800' },
      script: 'Hello',
      language: 'en-GB',
    });
    assert.deepEqual(withLanguage.overrides?.voice, { script: 'Hello', language: 'en-GB' });
    assert.equal('voice_id' in (withLanguage.overrides?.voice ?? {}), false);
  });

  it('should coerce object recipients, merge payload and overrides, and reach defaults', () => {
    const nervly = new Nervly({ apiKey: 'test_key' });
    const built = nervly.voice.buildTriggerRequest({
      to: { subscriberId: '', phone: '+234800', email: 'e@x.test', deviceTokens: ['tok'] },
      script: 'Code {{code}}',
      voice_id: 'Ada',
      language: 'en-US',
      name: 'voice-otp',
      category: 'security',
      payload: { code: '48291' },
      overrides: {
        voice: { language: 'en_GB' },
        extraParams: { voice_primary: 'true' },
      },
    });

    assert.equal(built.to.subscriberId, '+234800');
    assert.equal(built.to.email, 'e@x.test');
    assert.deepEqual(built.to.deviceTokens, ['tok']);
    assert.deepEqual(built.payload, { code: '48291' });
    // Request-level voice_id/language win over the pre-existing override.
    assert.deepEqual(built.overrides?.voice, {
      language: 'en-US',
      script: 'Code {{code}}',
      voice_id: 'Ada',
    });
    // Non-voice overrides survive the merge.
    assert.deepEqual(built.overrides?.extraParams, { voice_primary: 'true' });
    assert.equal(built.name, 'voice-otp');
    assert.equal(built.category, 'security');
  });

  it('should fall back to `unknown` when the object recipient has no identifier', () => {
    const nervly = new Nervly({ apiKey: 'test_key' });
    const built = nervly.voice.buildTriggerRequest({
      to: { subscriberId: '' },
      script: 'Hello',
    });

    assert.equal(built.to.subscriberId, 'unknown');
    assert.equal(built.to.phone, undefined);
  });

  it('should dispatch voice.send with the correct URL, auth, idempotency key, and JSON body', async () => {
    const captured = recorder<{
      url: string;
      body: TriggerEventRequest;
      authorization: string;
      idempotencyKey: string;
      priority: string;
    }>();

    const response: TriggerEventResponse = {
      eventId: 'evt_voice_test_123',
      status: 'QUEUED',
      idempotencyKey: 'idem_voice_001',
      priority: 'CRITICAL',
      channel: 'voice',
      timestamp: '2026-09-18T00:00:00Z',
    };

    await withFetch(
      (url, init) => {
        const headers = new Headers(init?.headers);
        captured.push({
          url,
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
        const nervly = new Nervly({
          apiKey: 'nv_live_test_voice_key',
          baseUrl: 'https://test-api.nervly.io',
        });

        const result = await nervly.voice.send(
          {
            to: { subscriberId: 'sub_voice_1', phone: '+2348012345678' },
            script: 'Your verification code is 4, 8, 2, 9, 1',
            voice_id: 'Ada',
            language: 'en-US',
            payload: { code: '48291' },
          },
          { idempotencyKey: 'idem_voice_001', priority: 'CRITICAL' },
        );

        assert.deepEqual(result, response);
      },
    );

    assert.ok(captured.last?.url.endsWith('/v1/events/trigger'), `unexpected url ${captured.last?.url}`);
    assert.equal(captured.last?.authorization, 'Bearer nv_live_test_voice_key');
    assert.equal(captured.last?.idempotencyKey, 'idem_voice_001');
    assert.equal(captured.last?.priority, 'CRITICAL');
    assert.deepEqual(captured.last?.body.overrides?.voice, {
      script: 'Your verification code is 4, 8, 2, 9, 1',
      voice_id: 'Ada',
      language: 'en-US',
    });
    assert.deepEqual(captured.last?.body.payload, { code: '48291' });
    assert.equal(captured.last?.body.name, 'transactional-voice');
    assert.equal(captured.last?.body.to.phone, '+2348012345678');
  });

  it('should omit voice_id, language, payload, and non-supplied headers when not given', async () => {
    const captured = recorder<{ body: TriggerEventRequest; init?: RequestInit }>();

    await withFetch(
      (_url, init) => {
        captured.push({ body: JSON.parse(String(init?.body)) as TriggerEventRequest, init });
        return new Response(
          JSON.stringify({
            eventId: 'evt_voice_min',
            status: 'QUEUED',
            priority: 'NORMAL',
            channel: 'voice',
            timestamp: '2026-09-18T00:00:00Z',
          } satisfies TriggerEventResponse),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        );
      },
      async () => {
        const nervly = new Nervly({
          apiKey: 'nv_live_test_voice_key',
          baseUrl: 'https://test-api.nervly.io',
        });

        await nervly.voice.send({ to: '+2348012345678', script: 'Hello' });
      },
    );

    assert.deepEqual(captured.last?.body.overrides?.voice, { script: 'Hello' });
    assert.deepEqual(captured.last?.body.payload, {});
    const headers = new Headers(captured.last?.init?.headers);
    assert.equal(headers.get('Idempotency-Key'), null);
    assert.equal(headers.get('X-Priority-Override'), null);
  });

  it('should let request-level idempotency and priority fill in when options are omitted', async () => {
    const captured = recorder<Record<string, string>>();

    await withFetch(
      (_url, init) => {
        captured.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return new Response(
          JSON.stringify({
            eventId: 'evt_voice_req',
            status: 'QUEUED',
            priority: 'LOW',
            channel: 'voice',
            timestamp: '2026-09-18T00:00:00Z',
          } satisfies TriggerEventResponse),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        );
      },
      async () => {
        const nervly = new Nervly({
          apiKey: 'nv_live_test_voice_key',
          baseUrl: 'https://test-api.nervly.io',
        });

        await nervly.voice.send({
          to: '+2348012345678',
          script: 'Hello',
          idempotencyKey: 'request-idem',
          priority: 'LOW',
        });
      },
    );

    assert.equal(captured.last?.['idempotency-key'], 'request-idem');
    assert.equal(captured.last?.['x-priority-override'], 'LOW');
  });
});
