import type { components } from "./generated/gateway.js";

// --- Client Configuration ---
export interface NervlyConfig {
	apiKey: string;
	baseUrl?: string; // defaults to 'https://api.nervly.io'
	/**
	 * Base URL of the control-plane management API the `senders` resource
	 * calls. Defaults to `https://console.nervly.io`; `baseUrl` and every
	 * gateway resource are untouched by it.
	 */
	managementUrl?: string;
	timeout?: number; // ms, defaults to 10000
	maxRetries?: number; // defaults to 3
	retryBaseDelay?: number; // ms, defaults to 1000
}

// --- Priority ---
export type Priority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";

// --- Channel ---
//
// The delivery channels the gateway routes an event over. Exposed as a const
// object *and* a type of the same name so consumers can write `Channel.VOICE`
// for the value and `Channel` for the union.
export const Channel = {
	SMS: "sms",
	EMAIL: "email",
	PUSH: "push",
	WHATSAPP: "whatsapp",
	VOICE: "voice",
	ITSM: "itsm",
} as const;

export type Channel = (typeof Channel)[keyof typeof Channel];

// --- Delivery Status ---
//
// `MessageDto.status` is an open string on the wire. These are the values the
// platform emits today; delivery receipts additionally report the
// bounce/complaint states. Consumers should still treat the field as
// forward-compatible.
export type DeliveryStatus =
	| "TRIGGERED"
	| "QUEUED"
	| "SENT"
	| "DELIVERED"
	| "SEEN"
	| "CLICKED"
	| "FAILED"
	| "SUPPRESSED"
	| "BOUNCED_HARD"
	| "BOUNCED_SOFT"
	| "COMPLAINED";

// --- Channel Providers ---
export type EmailProvider =
	| "resend"
	| "zeptomail"
	| "postmark"
	| "sendgrid"
	| string;

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
	provider?: EmailProvider | null;
	customHeaders?: Record<string, string> | null;
	/** Canonical From address; the only email sender field on the wire. */
	from?: string | null;
	/** Optional display name paired with `from`. */
	from_name?: string | null;
	/** Canonical reply-to address. */
	reply_to?: string | null;
	/** Canonical carbon-copy recipients. */
	cc?: string[] | null;
	/** Canonical blind-carbon-copy recipients. */
	bcc?: string[] | null;
}

export interface WhatsAppOverride {
	/**
	 * Canonical per-message WhatsApp sender in E.164 (e.g. `+2348012345678`).
	 *
	 * Anti-spoof: it may name only a WhatsApp identity the workspace has
	 * configured; whether the workspace actually owns the number is decided by
	 * the worker (`SENDER_NOT_ALLOWED`).
	 */
	from?: string | null;
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
	/** Canonical Sender ID; the only SMS sender field on the wire. */
	sender_id?: string | null;
	/** Optional provider routing hint honoured by the downstream carrier. */
	route?: string | null;
}

export interface VoiceOverride {
	/**
	 * Spoken script for the call. Falls back to the workspace voice template
	 * when omitted.
	 */
	script?: string | null;
	/**
	 * TTS voice profile to speak the script in. The wire field is snake_case
	 * (`voice_id`), matching the gateway's `VoiceOverrideDto` and the worker key.
	 */
	voice_id?: string | null;
	/**
	 * BCP-47 language tag for the voice profile.
	 */
	language?: string | null;
	/** Canonical per-message voice caller identity (provider-gated to Infobip). */
	caller_id?: string | null;
}

export interface ProviderOverrides {
	email?: EmailOverride | null;
	whatsapp?: WhatsAppOverride | null;
	sms?: SmsOverride | null;
	voice?: VoiceOverride | null;
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
	/** Canonical From address; compiled to `overrides.email.from`. */
	from?: string;
	provider?: EmailProvider;
	customHeaders?: Record<string, string>;
	overrides?: ProviderOverrides;
	idempotencyKey?: string;
	priority?: Priority;
}

export type EmailSendRequest = SendEmailOptions;

// --- Voice Helper Request ---
//
// Client-side convenience shape, not a wire type: `VoiceResource` compiles it
// into a `TriggerEventRequest`. Voice is opt-in per event: supplying this at
// all (specifically `overrides.voice`) is what makes the channel eligible.
export interface SendVoiceOptions {
	/** A subscriber id or phone number, or a full recipient; voice needs `phone`. */
	to: string | Recipient;
	/** Spoken script. Supports `{{variable}}` placeholders from `payload`. */
	script: string;
	/** TTS voice profile; only Infobip honours this today. */
	voice_id?: string;
	/** BCP-47 language tag; defaults to `en-US` in the worker. */
	language?: string;
	name?: string;
	category?: string;
	payload?: Record<string, unknown>;
	overrides?: ProviderOverrides;
	idempotencyKey?: string;
	priority?: Priority;
}

export type VoiceSendRequest = SendVoiceOptions;

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

// --- Sender identities (public management API) ---
//
// Mirrors the control plane's `/v1/senders` wire contract (ticket 23 §3),
// snake_case on the wire like the rest of the API. These are management-plane
// objects: they are served by `https://console.nervly.io`, not the gateway.

export type SenderChannel = "email" | "sms" | "voice";

export type IdentityUnit = "domain" | "address" | "sender_id" | "caller_id";

export type VerificationSource = "byo" | "platform";

export type VerificationState =
	| "pending"
	| "verified"
	| "failed"
	| "self_declared";

/** One provider's verification of one identity unit. */
export interface SenderBinding {
	provider: string;
	channel: SenderChannel;
	identity_unit: IdentityUnit;
	unit_value: string;
	verification_source: VerificationSource;
	verification_state: VerificationState;
	verified_at: string | null;
	last_checked_at: string | null;
	failure_reason: string | null;
}

/** A sender identity with its nested per-provider bindings. */
export interface SenderIdentity {
	/** Control-plane UUID, opaque; there is no new id scheme. */
	identity_id: string;
	channel: SenderChannel;
	/** From Address, Sender ID or Caller ID. */
	sender_value: string;
	/** Email-only display name, otherwise null. */
	display_name: string | null;
	created_at: string;
	updated_at: string;
	bindings: SenderBinding[];
}

/** A provider DNS record to add. Empty when the provider exposes none. */
export interface DnsRecord {
	type: string;
	name: string;
	value: string;
}

/** The result of binding and re-checking: the binding plus provider records. */
export interface SenderBindingResult {
	binding: SenderBinding;
	dns: DnsRecord[];
}

/** Body for `senders.create`. */
export interface CreateSenderInput {
	provider: string;
	/** From address, sender id or caller id; the identity literal. */
	value: string;
	/** Email-only display name. */
	display_name?: string;
	/** Optional; derived from the value and channel when omitted. */
	identity_unit?: IdentityUnit;
	/** Optional; validated against the provider's supported channels. */
	channel?: SenderChannel;
	/** Who verifies the binding; defaults to the credential actually used. */
	verify_with?: "nervly" | "provider";
}

/** Body for `senders.addBinding`. */
export interface CreateBindingInput {
	provider: string;
	/** Optional; derived from the identity value and channel when omitted. */
	identity_unit?: IdentityUnit;
	/** Who verifies the binding; defaults to the credential actually used. */
	verify_with?: "nervly" | "provider";
}

/** Returned by both create paths (`senders.create` and `senders.addBinding`). */
export interface CreateSenderResponse {
	sender: SenderIdentity;
	binding: SenderBinding;
	dns: DnsRecord[];
}

/** Returned by `senders.verifyBinding`. */
export interface VerifyBindingResponse extends SenderBindingResult {
	/** The provider error or prompt when the re-check could not verify. */
	last_error?: string;
}

export interface ListSendersParams {
	/** Page size; defaults to 50, capped at 100 by the server. */
	limit?: number;
	/** Opaque cursor from a previous page's `next_cursor`. */
	cursor?: string;
	channel?: SenderChannel;
	provider?: string;
}

export interface ListSendersResponse {
	senders: SenderIdentity[];
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
	voice?: boolean | null;
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
	deployment: string;
	environment: string;
	key_mode: string;
	nats_connected: boolean;
	service: string;
	status: string;
	uptime_seconds: number;
	version: string;
}

// --- MCP ---
//
// Mirrors OpenAPI `McpRequest` / `McpResponse` / `JsonRpcError`.
export interface McpRequest {
	method: string;
	params?: Record<string, unknown> | null;
	id?: JsonRpcId | null;
}

/** A JSON-RPC 2.0 correlation id: a string, an integer, or `null` on a parse error. */
export type JsonRpcId = string | number | null;

export interface JsonRpcError {
	code: number;
	message: string;
	data?: Record<string, unknown> | null;
}

export interface McpResponse {
	jsonrpc: string;
	result?: unknown;
	error?: JsonRpcError | null;
	id: JsonRpcId;
}

/**
 * Every tool the gateway's MCP catalog can advertise. `send_notification`
 * requires the `write` scope, so a read-only key's `tools/list` omits it.
 */
export type McpToolName =
	| "gateway_status"
	| "idempotency_inspect"
	| "send_notification"
	| "check_delivery_status"
	| "list_templates"
	| "verify_subscriber_channel";

/** The JSON-Schema-typed description of one MCP tool, as returned by `tools/list`. */
export interface McpToolDefinition {
	name: McpToolName | string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties?: boolean;
	};
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
	payload: string | Uint8Array;
	signature: string;
	secret: string;
}

// --- API Error ---
//
// Derived from the generated OpenAPI contract rather than hand-copied, so the
// body cannot drift from `ErrorResponse`. `purpose` names which limit a `429`
// hit (absent on a fail-closed store fault); `retry_after_seconds` mirrors the
// `Retry-After` header for body-only consumers. Both are optional.
export type RateLimitPurpose = components["schemas"]["RateLimitPurpose"];

export type ApiErrorBody = components["schemas"]["ErrorResponse"];

// --- HTTP Client types ---
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
	method: HttpMethod;
	path: string;
	body?: unknown;
	headers?: Record<string, string>;
	skipAuth?: boolean;
}
