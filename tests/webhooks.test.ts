import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WebhooksResource } from '../src/resources/webhooks.js';

describe('WebhooksResource', () => {
  const webhooks = new WebhooksResource();

  describe('verifySignature', () => {
    it('should return true for a valid HMAC-SHA256 signature', async () => {
      const secret = 'test_webhook_secret';
      const payload = JSON.stringify({ message_id: 'msg_123', status: 'DELIVERED' });
      const signature = createHmac('sha256', secret).update(payload).digest('hex');

      const result = await webhooks.verifySignature({
        provider: 'termii',
        payload,
        signature,
        secret,
      });

      assert.equal(result, true);
    });

    it('should return false for an invalid signature', async () => {
      const result = await webhooks.verifySignature({
        provider: 'termii',
        payload: '{"test": true}',
        signature: 'invalid_signature_hex',
        secret: 'secret',
      });

      assert.equal(result, false);
    });

    it('should return false for a tampered payload', async () => {
      const secret = 'test_secret';
      const originalPayload = '{"status": "DELIVERED"}';
      const signature = createHmac('sha256', secret).update(originalPayload).digest('hex');

      const result = await webhooks.verifySignature({
        provider: 'termii',
        payload: '{"status": "FAILED"}',  // tampered
        signature,
        secret,
      });

      assert.equal(result, false);
    });
  });

  describe('parse', () => {
    it('should parse a valid webhook payload', () => {
      const raw = JSON.stringify({
        message_id: 'msg_456',
        recipient: '+2348012345678',
        status: 'delivered',
        channel: 'sms',
        latency_ms: 120,
        cost: 0.005,
      });

      const result = webhooks.parse(raw);
      assert.equal(result.message_id, 'msg_456');
      assert.equal(result.status, 'DELIVERED');  // normalized to uppercase
      assert.equal(result.channel, 'sms');
    });

    it('should parse Buffer payloads', () => {
      const payload = { message_id: 'msg_789', status: 'SENT' };
      const buffer = Buffer.from(JSON.stringify(payload));

      const result = webhooks.parse(buffer);
      assert.equal(result.message_id, 'msg_789');
      assert.equal(result.status, 'SENT');
    });
  });

  describe('verifyAndParse', () => {
    it('should verify and parse in one step', async () => {
      const secret = 'combined_test_secret';
      const payload = JSON.stringify({ message_id: 'msg_combo', status: 'CLICKED' });
      const signature = createHmac('sha256', secret).update(payload).digest('hex');

      const result = await webhooks.verifyAndParse({
        provider: 'twilio',
        payload,
        signature,
        secret,
      });

      assert.equal(result.message_id, 'msg_combo');
      assert.equal(result.status, 'CLICKED');
    });

    it('should throw on invalid signature', async () => {
      await assert.rejects(
        () => webhooks.verifyAndParse({
          provider: 'termii',
          payload: '{"test": true}',
          signature: 'bad_sig',
          secret: 'secret',
        }),
        /Invalid webhook signature/,
      );
    });
  });
});
