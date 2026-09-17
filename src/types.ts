// --- Client Configuration ---
export interface NerveConfig {
  apiKey: string;
  baseUrl?: string;       // defaults to 'https://api.nervehq.io'
  timeout?: number;        // ms, defaults to 10000
  maxRetries?: number;      // defaults to 3
  retryBaseDelay?: number;  // ms, defaults to 1000
}

// --- Priority ---
export type Priority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

// --- Delivery Status ---
//
// `MessageDto.status` is an open string on the wire. These are the values the
// platform emits today; delivery receipts additionally report the
// bounce/complaint states. Consumers should still treat the field as
// forward-compatible.
export type DeliveryStatus =
  | 'TRIGGERED'
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'SEEN'
  | 'CLICKED'
  | 'FAILED'
  | 'SUPPRESSED'
  | 'BOUNCED_HARD'
  | 'BOUNCED_SOFT'
  | 'COMPLAINED';

// --- Channel Providers ---
export type EmailProvider = 'resend' | 'zeptomail' | 'postmark' | 'sendgrid' | string;

// --- Recipient ---
//
// Mirrors OpenAPI `RecipientDto`. Only `subscriberId` is required; the contact
// fields you supply determine which channels are eligible.
export interface Recipient {
  subscriberId: string;
  email?: string | null;
  phone?: string | null;
  deviceTokens?: string[] | null;
}

// --- Overrides ---
//
// Mirrors OpenAPI `EmailOverrideDto`, `WhatsAppOverrideDto`, `SmsOverrideDto`
// and `ProviderOverridesDto`.
export interface EmailOverride {
  sender?: string | null;
  provider?: EmailProvider | null;
  customHeaders?: Record<string, string> | null;
}

export interface WhatsAppOverride {
  /**
   * Name of the pre-approved Meta Cloud API template to send.
   *
   * The wire field is snake_case (`template_name`), matching the gateway's
   * `WhatsAppOverrideDto`.
   */
  template_name?: string | null;
  language?: string | null;
}

export interface SmsOverride {
  sender?: string | null;
}

export interface ProviderOverrides {
  email?: EmailOverride | null;
  whatsapp?: WhatsAppOverride | null;
  sms?: SmsOverride | null;
  extraParams?: Record<string, string> | null;
}

// --- Email Helper Request ---
//
// Client-side convenience shape, not a wire type: `EmailResource` compiles it
// into a `TriggerEventRequest`.
export interface SendEmailOptions {
  to: string | Recipient;
  subject: string;
  body?: string;
  html?: string;
  text?: string;
  name?: string;
  category?: string;
  payload?: Record<string, unknown>;
  sender?: string;
  provider?: EmailProvider;
  customHeaders?: Record<string, string>;
  overrides?: ProviderOverrides;
  idempotencyKey?: string;
  priority?: Priority;
}

export type EmailSendRequest = SendEmailOptions;

// --- Event Trigger ---
//
// Mirrors OpenAPI `TriggerRequest` / `TriggerResponse`.
export interface TriggerEventRequest {
  name: string;
  to: Recipient;
  payload?: Record<string, unknown> | null;
  overrides?: ProviderOverrides | null;
  category?: string | null;
}

export interface TriggerEventOptions {
  idempotencyKey?: string;
  priority?: Priority;
}

export interface TriggerEventResponse {
  eventId: string;
  status: string;
  idempotencyKey?: string | null;
  priority: string;
  channel: string;
  timestamp: string;
}

// --- Bulk Trigger ---
//
// Mirrors OpenAPI `BulkTriggerRequest`, `BulkTriggerResponse` and
// `BulkEventResult`.
export interface BulkTriggerRequest {
  events: TriggerEventRequest[];
}

export interface BulkEventResult {
  index: number;
  status: string;
  eventId?: string | null;
  channel?: string | null;
  error?: string | null;
}

export interface BulkTriggerResponse {
  jobId: string;
  status: string;
  count: number;
  failedCount: number;
  events: BulkEventResult[];
}

// --- Messages & Timelines ---
//
// Mirrors OpenAPI `MessageDto`, `EventItemDto` and `ListMessagesResponse`.
export interface EventItemDto {
  seq: number;
  status: string;
  provider?: string | null;
  detail?: unknown;
  occurred_at: string;
}

export interface MessageDto {
  event_id: string;
  event_name: string;
  subscriber_id: string;
  priority: number;
  status: DeliveryStatus | string;
  channel?: string | null;
  provider?: string | null;
  provider_message_id?: string | null;
  attempts: number;
  cost_micro_usd: number;
  test_mode: boolean;
  category?: string | null;
  variables_keys: string[];
  events?: EventItemDto[] | null;
  error_code?: string | null;
  error_detail?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListMessagesParams {
  status?: DeliveryStatus | string;
  channel?: string;
  subscriberId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface ListMessagesResponse {
  messages: MessageDto[];
  next_cursor?: string | null;
}

// --- Subscribers & Erasure ---
//
// Mirrors OpenAPI `SubscriberErasureResponse`.
export interface SubscriberErasureResponse {
  status: string;
  subscriberId: string;
  message: string;
}

// --- User Preferences ---
//
// Mirrors OpenAPI `ChannelPreferences`, `UserPreferencesRequest` and
// `UserPreferencesResponse`. Note the response timestamp is snake_case
// (`updated_at`) on the wire.
export interface ChannelPreferences {
  email?: boolean | null;
  sms?: boolean | null;
  push?: boolean | null;
  whatsapp?: boolean | null;
}

export interface UserPreferencesRequest {
  categories?: Record<string, Record<string, boolean>> | null;
  channels?: ChannelPreferences | null;
}

export interface UserPreferencesResponse {
  status: string;
  subscriberId: string;
  updated_at: string;
}

// --- Health ---
//
// Mirrors OpenAPI `HealthStatus`.
export interface HealthStatus {
  status: string;
  service: string;
  version: string;
  environment: string;
  uptime_seconds: number;
  nats_connected: boolean;
}

// --- MCP ---
//
// Mirrors OpenAPI `McpRequest` / `McpResponse`.
export interface McpRequest {
  method: string;
  params?: Record<string, unknown> | null;
}

export interface McpResponse {
  jsonrpc: string;
  result: unknown;
  id: number;
}

// --- Webhooks ---
//
// Mirrors OpenAPI `GenericWebhookPayload`. Every field is nullable because a
// provider receipt is normalised from arbitrary upstream bodies.
export interface WebhookPayload {
  message_id?: string | null;
  recipient?: string | null;
  status?: DeliveryStatus | string | null;
  channel?: string | null;
  latency_ms?: number | null;
  cost?: number | null;
}

export interface WebhookVerifyOptions {
  provider: string;
  payload: string | Buffer;
  signature: string;
  secret: string;
}

// --- API Error ---
//
// Mirrors OpenAPI `ErrorResponse`.
export interface ApiErrorBody {
  error: string;
  message: string;
  status_code: number;
}

// --- HTTP Client types ---
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method: HttpMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  skipAuth?: boolean;
}
