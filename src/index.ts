import { NervlyHttpClient } from './client.js';
import { EventsResource } from './resources/events.js';
import { EmailResource } from './resources/email.js';
import { VoiceResource } from './resources/voice.js';
import { MessagesResource } from './resources/messages.js';
import { SubscribersResource } from './resources/subscribers.js';
import { UsersResource } from './resources/users.js';
import { HealthResource } from './resources/health.js';
import { McpResource } from './resources/mcp.js';
import { WebhooksResource } from './resources/webhooks.js';
import type { NervlyConfig } from './types.js';

/**
 * The main Nervly SDK client.
 *
 * Provides a type-safe, ergonomic interface to the Nervly Unified
 * Notification-as-a-Service (NaaS) Gateway API.
 *
 * @example
 * ```typescript
 * import Nervly from '@nervly/sdk';
 *
 * const nerve = new Nervly({ apiKey: 'your_api_key' });
 *
 * // Send a transactional email
 * const res = await nerve.email.send({
 *   to: 'user@example.com',
 *   subject: 'Welcome to Nervly',
 *   html: '<p>Hello!</p>',
 *   provider: 'resend',
 * });
 *
 * console.log(res.eventId);
 * ```
 */
export class Nervly {
  private readonly client: NervlyHttpClient;

  /** Events resource — trigger and bulk dispatch notifications, fetch timeline. */
  public readonly events: EventsResource;

  /** Email resource — ergonomic convenience helpers for transactional email dispatch. */
  public readonly email: EmailResource;

  /** Voice resource — ergonomic convenience helpers for Voice OTP dispatch. */
  public readonly voice: VoiceResource;

  /** Messages resource — list and search message history. */
  public readonly messages: MessagesResource;

  /** Subscribers resource — manage subscriber data, preferences, and erasure. */
  public readonly subscribers: SubscribersResource;

  /** Users resource — manage subscriber notification preferences (backward-compatible). */
  public readonly users: UsersResource;

  /** Health resource — check gateway health status. */
  public readonly health: HealthResource;

  /** MCP resource — Model Context Protocol inspection tools. */
  public readonly mcp: McpResource;

  /** Webhooks resource — verify signatures and parse delivery receipts. */
  public readonly webhooks: WebhooksResource;

  constructor(config: NervlyConfig) {
    if (!config.apiKey) {
      throw new Error('Nervly SDK requires an API key. Pass { apiKey: "your_key" } to the constructor.');
    }

    this.client = new NervlyHttpClient(config);
    this.events = new EventsResource(this.client);
    this.email = new EmailResource(this.client);
    this.voice = new VoiceResource(this.client);
    this.messages = new MessagesResource(this.client);
    this.subscribers = new SubscribersResource(this.client);
    this.users = new UsersResource(this.client);
    this.health = new HealthResource(this.client);
    this.mcp = new McpResource(this.client);
    this.webhooks = new WebhooksResource();
  }
}

// Default export
export default Nervly;

// Named re-exports for convenience
export { NervlyHttpClient } from './client.js';
export { EventsResource } from './resources/events.js';
export { EmailResource } from './resources/email.js';
export { VoiceResource } from './resources/voice.js';
export { MessagesResource } from './resources/messages.js';
export { SubscribersResource } from './resources/subscribers.js';
export { UsersResource } from './resources/users.js';
export { HealthResource } from './resources/health.js';
export { McpResource } from './resources/mcp.js';
export { WebhooksResource } from './resources/webhooks.js';
export { SDK_VERSION } from './version.js';

// `Channel` is both a runtime const (so consumers can write `Channel.VOICE`)
// and a type; a value re-export carries both.
export { Channel } from './types.js';

// Re-export all types
export type {
  NervlyConfig,
  Priority,
  DeliveryStatus,
  EmailProvider,
  Recipient,
  EmailOverride,
  WhatsAppOverride,
  SmsOverride,
  VoiceOverride,
  ProviderOverrides,
  SendEmailOptions,
  EmailSendRequest,
  SendVoiceOptions,
  VoiceSendRequest,
  TriggerEventRequest,
  TriggerEventOptions,
  TriggerEventResponse,
  BulkTriggerRequest,
  BulkEventResult,
  BulkTriggerResponse,
  EventItemDto,
  MessageDto,
  ListMessagesParams,
  ListMessagesResponse,
  SubscriberErasureResponse,
  ChannelPreferences,
  UserPreferencesRequest,
  UserPreferencesResponse,
  HealthStatus,
  McpRequest,
  McpResponse,
  WebhookPayload,
  WebhookVerifyOptions,
  ApiErrorBody,
  HttpMethod,
  RequestOptions,
} from './types.js';

// Re-export all errors — both the long names and their short aliases. Both
// spellings are the same class object, so `instanceof` works either way.
export {
  NervlyError,
  NervlyError as NervlySdkError,
  NervlyApiError,
  NervlyApiError as ApiError,
  NervlyAuthenticationError,
  NervlyAuthenticationError as AuthenticationError,
  NervlyValidationError,
  NervlyValidationError as ValidationError,
  NervlyNotFoundError,
  NervlyNotFoundError as NotFoundError,
  NervlyIdempotencyError,
  NervlyIdempotencyError as IdempotencyError,
  NervlyRateLimitError,
  NervlyRateLimitError as RateLimitError,
  NervlyServerError,
  NervlyServerError as ServerError,
  NervlyNetworkError,
  NervlyNetworkError as NetworkError,
  NervlyRetryExhaustedError,
  NervlyRetryExhaustedError as RetryExhaustedError,
} from './errors.js';

