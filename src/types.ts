// --- Client Configuration ---
export interface NerveConfig {
  apiKey: string;
  baseUrl?: string;       // defaults to 'https://api.nervehq.io'
  timeout?: number;        // ms, defaults to 10000
  maxRetries?: number;     // defaults to 3
  retryBaseDelay?: number; // ms, defaults to 1000
}

// --- Priority ---
export type Priority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

// --- Delivery Status ---
export type DeliveryStatus = 'TRIGGERED' | 'QUEUED' | 'SENT' | 'DELIVERED' | 'SEEN' | 'CLICKED' | 'FAILED' | 'SUPPRESSED';

// --- Channel Providers ---
export type EmailProvider = 'resend' | 'zeptomail' | 'postmark' | 'sendgrid' | string;

// --- Recipient ---
export interface Recipient {
  subscriberId: string;
  email?: string;
  phone?: string;
  deviceTokens?: string[];
}

// --- Overrides ---
export interface EmailOverride {
  sender?: string;
  provider?: EmailProvider;
  customHeaders?: Record<string, string>;
}

export interface WhatsAppOverride {
  templateName?: string;
  language?: string;
}

export interface SmsOverride {
  sender?: string;
}

export interface ProviderOverrides {
  email?: EmailOverride;
  whatsapp?: WhatsAppOverride;
  sms?: SmsOverride;
  extraParams?: Record<string, string>;
}

// --- Email Helper Request ---
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
export interface TriggerEventRequest {
  name: string;
  to: Recipient;
  payload?: Record<string, unknown>;
  overrides?: ProviderOverrides;
  category?: string;
}

export interface TriggerEventOptions {
  idempotencyKey?: string;
  priority?: Priority;
}

export interface TriggerEventResponse {
  eventId: string;
  status: string;
  idempotencyKey: string | null;
  priority: string;
  channel?: string;
  timestamp: string;
}

// --- Bulk Trigger ---
export interface BulkTriggerRequest {
  events: TriggerEventRequest[];
}

export interface BulkTriggerResponse {
  jobId: string;
  status: string;
  count: number;
  estimatedCompletion: string;
}

// --- Messages & Timelines ---
export interface EventItemDto {
  timestamp: string;
  event: string;
  description?: string | null;
  channel?: string | null;
  provider?: string | null;
  latency_ms?: number | null;
  cost_micro_usd?: number | null;
}

export interface MessageDto {
  event_id: string;
  event_name: string;
  subscriber_id?: string | null;
  priority: number;
  status: DeliveryStatus | string;
  channel?: string | null;
  provider?: string | null;
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
export interface SubscriberErasureResponse {
  status: string;
  subscriberId: string;
  message: string;
}

// --- User Preferences ---
export interface ChannelPreferences {
  email?: boolean;
  sms?: boolean;
  push?: boolean;
  whatsapp?: boolean;
}

export interface UserPreferencesRequest {
  channels?: ChannelPreferences;
  categories?: Record<string, Record<string, boolean>>;
}

export interface UserPreferencesResponse {
  status: string;
  subscriberId: string;
  updatedAt: string;
}

// --- Health ---
export interface HealthStatus {
  status: string;
  service: string;
  version: string;
  environment: string;
  uptime_seconds: number;
  nats_connected: boolean;
  nats_url: string;
  idempotency_cached_keys: number;
}

// --- MCP ---
export interface McpRequest {
  method: string;
  params?: unknown;
}

export interface McpResponse {
  jsonrpc: string;
  result: unknown;
  id: number;
}

// --- Webhooks ---
export interface WebhookPayload {
  message_id?: string;
  recipient?: string;
  status?: DeliveryStatus;
  channel?: string;
  latency_ms?: number;
  cost?: number;
}

export interface WebhookVerifyOptions {
  provider: string;
  payload: string | Buffer;
  signature: string;
  secret: string;
}

// --- API Error ---
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

