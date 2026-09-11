import { NerveHttpClient } from './client.js';
import { EventsResource } from './resources/events.js';
import { MessagesResource } from './resources/messages.js';
import { SubscribersResource } from './resources/subscribers.js';
import { UsersResource } from './resources/users.js';
import { HealthResource } from './resources/health.js';
import { McpResource } from './resources/mcp.js';
import { WebhooksResource } from './resources/webhooks.js';
import type { NerveConfig } from './types.js';

/**
 * The main Nerve SDK client.
 *
 * Provides a type-safe, ergonomic interface to the Nerve Unified
 * Notification-as-a-Service (NaaS) Gateway API.
 *
 * @example
 * ```typescript
 * import Nerve from '@nervehq/sdk';
 *
 * const nerve = new Nerve({ apiKey: 'your_api_key' });
 *
 * // Trigger a notification
 * const result = await nerve.events.trigger({
 *   name: 'welcome_email',
 *   to: { subscriberId: 'usr_001', email: 'user@example.com' },
 *   payload: { firstName: 'John' },
 * });
 *
 * console.log(result.eventId);
 * ```
 */
export class Nerve {
  private readonly client: NerveHttpClient;

  /** Events resource — trigger and bulk dispatch notifications, fetch timeline. */
  public readonly events: EventsResource;

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

  constructor(config: NerveConfig) {
    if (!config.apiKey) {
      throw new Error('Nerve SDK requires an API key. Pass { apiKey: "your_key" } to the constructor.');
    }

    this.client = new NerveHttpClient(config);
    this.events = new EventsResource(this.client);
    this.messages = new MessagesResource(this.client);
    this.subscribers = new SubscribersResource(this.client);
    this.users = new UsersResource(this.client);
    this.health = new HealthResource(this.client);
    this.mcp = new McpResource(this.client);
    this.webhooks = new WebhooksResource();
  }
}

// Default export
export default Nerve;

// Named re-exports for convenience
export { NerveHttpClient } from './client.js';
export { EventsResource } from './resources/events.js';
export { MessagesResource } from './resources/messages.js';
export { SubscribersResource } from './resources/subscribers.js';
export { UsersResource } from './resources/users.js';
export { HealthResource } from './resources/health.js';
export { McpResource } from './resources/mcp.js';
export { WebhooksResource } from './resources/webhooks.js';

// Re-export all types
export type {
  NerveConfig,
  Priority,
  DeliveryStatus,
  Recipient,
  EmailOverride,
  WhatsAppOverride,
  ProviderOverrides,
  TriggerEventRequest,
  TriggerEventOptions,
  TriggerEventResponse,
  BulkTriggerRequest,
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
} from './types.js';

// Re-export all errors
export {
  NerveError,
  NerveApiError,
  NerveAuthenticationError,
  NerveValidationError,
  NerveIdempotencyError,
  NerveRateLimitError,
  NerveNetworkError,
  NerveRetryExhaustedError,
} from './errors.js';

