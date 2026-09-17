/**
 * Type-level conformance: the SDK's public types vs the generated OpenAPI types.
 *
 * `tests/spec-conformance.test.ts` proves at runtime that *every path and
 * method* in the gateway spec has an SDK method. This file proves the other
 * half of the contract, which only the compiler can see: that for each of those
 * methods the request and response shapes the SDK declares are exactly the
 * shapes the spec declares — same requiredness, same nullability, same enum
 * spellings.
 *
 * It is compiled, not run: `npm run check:types` type-checks this file along
 * with `src/`. `Equal<A, B>` resolves to `false` the moment the two drift, and
 * the resulting "Type 'false' does not satisfy the constraint 'true'" is the
 * failure. Nothing here emits JavaScript.
 *
 * Deliberately outside the `tests/*.test.ts` glob: this is a compiler gate, not
 * a test case. `npm run check:types` runs it; `npm test` does not, and should
 * not.
 */
import type { components } from '../../src/generated/gateway.js';
import type {
  ApiErrorBody,
  BulkEventResult,
  BulkTriggerRequest,
  BulkTriggerResponse,
  ChannelPreferences,
  EmailOverride,
  EventItemDto,
  HealthStatus,
  ListMessagesResponse,
  McpRequest,
  McpResponse,
  MessageDto,
  ProviderOverrides,
  Recipient,
  SmsOverride,
  SubscriberErasureResponse,
  TriggerEventRequest,
  TriggerEventResponse,
  UserPreferencesRequest,
  UserPreferencesResponse,
  WebhookPayload,
  WhatsAppOverride,
} from '../../src/index.js';

/** Compile-time assertion: the argument must be `true`. */
type Expect<T extends true> = T;

/**
 * Structural type equality. `true` only when each type is assignable to the
 * other *and* optionality agrees — `{ a?: string }` is not equal to
 * `{ a: string }`.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Replaces one property's type, keeping every other property exactly as the
 * spec declares it — including any property added to the spec later.
 *
 * Used only for the four spec properties listed in `NormalisedSpecTypes` below.
 * Prefer it to restating a whole schema by hand: a hand-written substitute would
 * silently lose a field the spec gains later.
 */
type WithProp<T, K extends keyof T, V> = { [P in keyof T]: P extends K ? V : T[P] };

type Spec = components['schemas'];

/*
 * ─── Normalised spec types ─────────────────────────────────────────────────
 *
 * utoipa's `#[schema(value_type = Object)]` records a free-form JSON object as
 * `Record<string, never>` — *the empty object*, because the Rust field is
 * `serde_json::Value` and no shape can be derived from it. That is narrower
 * than what the server accepts and returns, and comparing against it verbatim
 * would fail for a generator artefact rather than a contract violation.
 *
 * These four aliases restate exactly those properties with the type the server
 * really honours, and nothing else. If a fifth `value_type = Object` field is
 * ever added to the spec the comparison fails, which is the point: this list is
 * reviewed, not inferred.
 */
type TriggerRequestFromSpec = WithProp<Spec['TriggerRequest'], 'payload', Record<string, unknown> | null>;

type BulkTriggerRequestFromSpec = WithProp<Spec['BulkTriggerRequest'], 'events', TriggerRequestFromSpec[]>;

type UserPreferencesRequestFromSpec = WithProp<
  Spec['UserPreferencesRequest'],
  'categories',
  Record<string, Record<string, boolean>> | null
>;

type McpRequestFromSpec = WithProp<Spec['McpRequest'], 'params', Record<string, unknown> | null>;

type McpResponseFromSpec = WithProp<Spec['McpResponse'], 'result', unknown>;

// ─── Requests ───────────────────────────────────────────────────────────────

export type _TriggerRequest = Expect<Equal<TriggerEventRequest, TriggerRequestFromSpec>>;
export type _Recipient = Expect<Equal<Recipient, Spec['RecipientDto']>>;
export type _ProviderOverrides = Expect<Equal<ProviderOverrides, Spec['ProviderOverridesDto']>>;
export type _EmailOverride = Expect<Equal<EmailOverride, Spec['EmailOverrideDto']>>;
export type _WhatsAppOverride = Expect<Equal<WhatsAppOverride, Spec['WhatsAppOverrideDto']>>;
export type _SmsOverride = Expect<Equal<SmsOverride, Spec['SmsOverrideDto']>>;
export type _BulkTriggerRequest = Expect<Equal<BulkTriggerRequest, BulkTriggerRequestFromSpec>>;
export type _UserPreferencesRequest = Expect<
  Equal<UserPreferencesRequest, UserPreferencesRequestFromSpec>
>;
export type _ChannelPreferences = Expect<Equal<ChannelPreferences, Spec['ChannelPreferences']>>;
export type _McpRequest = Expect<Equal<McpRequest, McpRequestFromSpec>>;

// ─── Responses ──────────────────────────────────────────────────────────────

export type _TriggerResponse = Expect<Equal<TriggerEventResponse, Spec['TriggerResponse']>>;
export type _BulkEventResult = Expect<Equal<BulkEventResult, Spec['BulkEventResult']>>;
export type _BulkTriggerResponse = Expect<Equal<BulkTriggerResponse, Spec['BulkTriggerResponse']>>;
export type _MessageDto = Expect<Equal<MessageDto, Spec['MessageDto']>>;
export type _EventItemDto = Expect<Equal<EventItemDto, Spec['EventItemDto']>>;
export type _ListMessagesResponse = Expect<Equal<ListMessagesResponse, Spec['ListMessagesResponse']>>;
export type _SubscriberErasureResponse = Expect<
  Equal<SubscriberErasureResponse, Spec['SubscriberErasureResponse']>
>;
export type _UserPreferencesResponse = Expect<
  Equal<UserPreferencesResponse, Spec['UserPreferencesResponse']>
>;
export type _HealthStatus = Expect<Equal<HealthStatus, Spec['HealthStatus']>>;
export type _McpResponse = Expect<Equal<McpResponse, McpResponseFromSpec>>;
export type _WebhookPayload = Expect<Equal<WebhookPayload, Spec['GenericWebhookPayload']>>;
export type _ApiErrorBody = Expect<Equal<ApiErrorBody, Spec['ErrorResponse']>>;

// Referencing every assertion in one tuple keeps "declared but never used"
// from hiding an assertion that was accidentally left out of the list.
export type ConformanceAssertions = [
  _TriggerRequest,
  _Recipient,
  _ProviderOverrides,
  _EmailOverride,
  _WhatsAppOverride,
  _SmsOverride,
  _BulkTriggerRequest,
  _UserPreferencesRequest,
  _ChannelPreferences,
  _McpRequest,
  _TriggerResponse,
  _BulkEventResult,
  _BulkTriggerResponse,
  _MessageDto,
  _EventItemDto,
  _ListMessagesResponse,
  _SubscriberErasureResponse,
  _UserPreferencesResponse,
  _HealthStatus,
  _McpResponse,
  _WebhookPayload,
  _ApiErrorBody,
];
