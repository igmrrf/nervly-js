import { NerveHttpClient } from '../client.js';
import type {
  SendEmailOptions,
  TriggerEventResponse,
  TriggerEventOptions,
  TriggerEventRequest,
  Recipient,
  EmailOverride,
  ProviderOverrides,
} from '../types.js';

export class EmailResource {
  constructor(private readonly client: NerveHttpClient) {}

  /**
   * Send a transactional email.
   * Maps to: POST /v1/events/trigger configured for the email channel.
   *
   * Normalizes string or object recipients, combines template variables,
   * configures provider overrides (sender, provider, customHeaders),
   * and dispatches the event through the Nerve Gateway data plane.
   *
   * @param request - Transactional email details and options
   * @param options - Optional trigger options (idempotency key, priority override)
   */
  async send(request: SendEmailOptions, options?: TriggerEventOptions): Promise<TriggerEventResponse> {
    const triggerRequest = this.buildTriggerRequest(request);

    const headers: Record<string, string> = {};
    const idempotencyKey = options?.idempotencyKey || request.idempotencyKey;
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const priority = options?.priority || request.priority;
    if (priority) {
      headers['X-Priority-Override'] = priority;
    }

    return this.client.post<TriggerEventResponse>('/v1/events/trigger', triggerRequest, headers);
  }

  /**
   * Helper to construct a conforming TriggerEventRequest from SendEmailOptions.
   */
  public buildTriggerRequest(request: SendEmailOptions): TriggerEventRequest {
    const to: Recipient = typeof request.to === 'string'
      ? { subscriberId: request.to, email: request.to }
      : {
          subscriberId: request.to.subscriberId || request.to.email || 'unknown',
          email: request.to.email,
          phone: request.to.phone,
          deviceTokens: request.to.deviceTokens,
        };

    const payload: Record<string, unknown> = {
      subject: request.subject,
      ...(request.payload || {}),
    };

    if (request.html) {
      payload.html = request.html;
    }
    if (request.text) {
      payload.text = request.text;
    }
    if (request.body && !payload.html && !payload.text) {
      payload.body = request.body;
    }

    let emailOverride: EmailOverride | undefined = request.overrides?.email
      ? { ...request.overrides.email }
      : undefined;

    if (request.sender || request.provider || request.customHeaders) {
      emailOverride = {
        ...(emailOverride || {}),
        ...(request.sender ? { sender: request.sender } : {}),
        ...(request.provider ? { provider: request.provider } : {}),
        ...(request.customHeaders ? { customHeaders: request.customHeaders } : {}),
      };
    }

    let overrides: ProviderOverrides | undefined = request.overrides;
    if (emailOverride) {
      overrides = {
        ...(overrides || {}),
        email: emailOverride,
      };
    }

    return {
      name: request.name || 'transactional-email',
      to,
      payload,
      overrides,
      category: request.category || 'transactional',
    };
  }
}
