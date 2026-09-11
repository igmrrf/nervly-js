// node:crypto is dynamically imported at runtime to avoid breaking browser bundles
import type { WebhookPayload, WebhookVerifyOptions, DeliveryStatus } from '../types.js';

export class WebhooksResource {
  /**
   * Verify a webhook signature from a delivery provider.
   * Uses HMAC-SHA256 with timing-safe comparison to prevent timing attacks.
   *
   * @param options - The verification options (provider, payload, signature, secret)
   * @returns true if the signature is valid
   */
  async verifySignature(options: WebhookVerifyOptions): Promise<boolean> {
    const { createHmac, timingSafeEqual } = await import('node:crypto');
    const { payload, signature, secret } = options;

    const payloadStr = typeof payload === 'string'
      ? payload
      : payload.toString('utf-8');

    const expectedSignature = createHmac('sha256', secret)
      .update(payloadStr)
      .digest('hex');

    // Timing-safe comparison to prevent timing attacks
    try {
      const sigBuffer = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');

      if (sigBuffer.length !== expectedBuffer.length) {
        return false;
      }

      return timingSafeEqual(sigBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Parse a raw webhook body into a typed WebhookPayload.
   *
   * @param rawBody - The raw request body (string or Buffer)
   * @returns Parsed and validated webhook payload
   */
  parse(rawBody: string | Buffer): WebhookPayload {
    const bodyStr = typeof rawBody === 'string'
      ? rawBody
      : rawBody.toString('utf-8');

    const parsed = JSON.parse(bodyStr) as WebhookPayload;

    // Normalize status to uppercase DeliveryStatus
    if (parsed.status) {
      parsed.status = parsed.status.toUpperCase() as DeliveryStatus;
    }

    return parsed;
  }

  /**
   * Verify signature and parse in a single step.
   * Throws if signature is invalid.
   */
  async verifyAndParse(options: WebhookVerifyOptions): Promise<WebhookPayload> {
    const isValid = await this.verifySignature(options);
    if (!isValid) {
      throw new Error(`Invalid webhook signature from provider: ${options.provider}`);
    }
    return this.parse(options.payload);
  }
}
