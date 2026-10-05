# nervly-sdk API Reference

Programmatic interface for `@nervly/sdk`. Every gateway method below maps to
exactly one operation in
[`gateway.json`](../../nervly-docs/static/openapi/gateway.json); the mapping is
asserted by `tests/spec-conformance.test.ts`, and the request/response shapes are
asserted against the generated spec by `tests/types/conformance.types.ts`. The
sender-identity methods in §7 call the control plane's `/v1/senders` instead.

Status codes shown are what the origin returns on success.

---

## 1. Initialization

```typescript
import Nervly from '@nervly/sdk';          // default export
import { Nervly as Named } from '@nervly/sdk'; // or the named one — same class

const nervly = new Nervly({
  apiKey: process.env.NERVLY_API_KEY!, // required; throws if empty
  baseUrl: 'https://api.nervly.io',  // default
  timeout: 10_000,                    // ms, default
  maxRetries: 3,                      // default
  retryBaseDelay: 1_000,              // ms, backoff floor, default
});
```

Configure from the environment; never inline a key. The SDK sends
`Authorization: Bearer <apiKey>` and `User-Agent: @nervly/sdk/<version>` on
every request except `health.check()`.

---

## 2. Events

### `events.trigger(data, options?) → TriggerEventResponse` — `POST /v1/events/trigger` (200/202)

```typescript
const event = await nervly.events.trigger(
  {
    name: 'payment-received',       // workflow name
    to: { subscriberId: 'user_8f21c', email: 'ada@example.com' },
    payload: { amount: '24500.00' }, // template variables ({{amount}})
    category: 'receipts',            // matched against subscriber preferences
    overrides: {
      email: { from: 'billing@yourcompany.com', provider: 'resend' },
      sms: { sender_id: 'Nervly' },
      whatsapp: { template_name: 'order_shipped_v3', language: 'en_US' },
      extraParams: { custom_key: 'value' },
    },
  },
  { idempotencyKey: 'tx_77392910', priority: 'CRITICAL' },
);
// event: { eventId, status, priority, channel, timestamp, idempotencyKey }
```

`options.idempotencyKey` is sent as the `Idempotency-Key` header; a replay within
the retention window returns the original response. `options.priority` is sent as
`X-Priority-Override` and selects the JetStream lane (`CRITICAL`/`HIGH` →
critical; `NORMAL`/`LOW` → bulk).

### `events.bulkTrigger(data) → BulkTriggerResponse` — `POST /v1/events/bulk` (200)

```typescript
const batch = await nervly.events.bulkTrigger({
  events: [
    { name: 'daily.digest', to: { subscriberId: 'usr_1', email: 'u1@example.com' } },
    { name: 'daily.digest', to: { subscriberId: 'usr_2', email: 'u2@example.com' } },
  ],
});
// batch: { jobId, status, count, failedCount, events: [{ index, status, eventId?, channel?, error? }] }
```

Events succeed or fail individually: read `failedCount` and the per-event
`error`, not the HTTP status. Priority is ignored for bulk by design.

### `events.get(eventId) → MessageDto` — `GET /v1/events/{eventId}` (200)

```typescript
const message = await nervly.events.get('evt_018e123456787abc8def0123456789ab');
// message.status: 'TRIGGERED' | 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'SUPPRESSED' | ...
// message.events: [{ seq, status, provider?, detail?, occurred_at }]
```

### `events.triggerEmail(request, options?) → TriggerEventResponse` — same endpoint

Convenience wrapper for email-only sends, kept for backward compatibility.
`email.send()` below is the same builder; prefer it in new code.

---

## 3. Email

### `email.send(request, options?) → TriggerEventResponse` — `POST /v1/events/trigger` (200/202)

```typescript
await nervly.email.send({
  to: 'customer@example.com',       // string, or a full Recipient
  subject: 'Your receipt',
  html: '<p>Thanks!</p>',
  text: 'Thanks!',                  // optional plain-text alternative
  category: 'transactional',
  provider: 'resend',               // shorthand for overrides.email.provider
  from: 'Billing <billing@example.com>',
  customHeaders: { 'Reply-To': 'support@example.com' },
  idempotencyKey: 'tx_1',
  priority: 'HIGH',
});
```

`email.buildTriggerRequest(request)` returns the `TriggerRequest` without sending
it — useful for asserting what will go on the wire.

---

## 4. Voice

### `voice.send(request, options?) → TriggerEventResponse` — `POST /v1/events/trigger` (200/202)

```typescript
await nervly.voice.send({
  to: { subscriberId: 'user_8f21c', phone: '+2348012345678' },  // phone required
  script: 'Your verification code is 4827',                    // required
  voice_id: 'Ada',                                             // optional TTS profile
  language: 'en-US',                                           // optional BCP-47 tag
  category: 'security',
  payload: { code: '4827' },                                   // {{variable}} source
  idempotencyKey: 'otp_1',
  priority: 'CRITICAL',
});
```

Voice is opt-in per event — `voice.send` always emits `overrides.voice`, which
is what makes the channel eligible; it is never inferred from a phone number.
Only the fields you supply are sent (`voice_id` and `language` are omitted, not
emptied, when unset), and a partial override merges with any pre-existing
`overrides.voice`. `voice.buildTriggerRequest(request)` returns the
`TriggerRequest` without sending it.

`Channel` is exported as both a const and a type, so `Channel.VOICE === 'voice'`
and `Channel` names the union `'sms' | 'email' | 'push' | 'whatsapp' | 'voice' | 'itsm'`.

---

## 5. Messages

### `messages.list(params?) → ListMessagesResponse` — `GET /v1/messages` (200)

```typescript
const page = await nervly.messages.list({
  status: 'DELIVERED',
  channel: 'sms',
  subscriberId: 'user_8f21c',  // sent as `subscriber_id`
  from: '2026-01-01T00:00:00Z',
  to: '2026-02-01T00:00:00Z',
  limit: 25,                   // default 50, max 100
  cursor: page.next_cursor ?? undefined,
});
// page: { messages: MessageDto[], next_cursor?: string | null }
```

---

## 6. Subscribers & preferences

### `subscribers.delete(subscriberId) → SubscriberErasureResponse` — `DELETE /v1/subscribers/{subscriberId}` (202)

```typescript
const erasure = await nervly.subscribers.delete('user_8f21c');
// { status: 'accepted', subscriberId, message }
```

Anonymises the subscriber row and suppresses any delivery queued for it.

### `subscribers.updatePreferences(subscriberId, data) → UserPreferencesResponse` — `PUT /v1/users/{subscriberId}/preferences` (200)

### `users.updatePreferences(subscriberId, data) → UserPreferencesResponse` — same endpoint

```typescript
const prefs = await nervly.users.updatePreferences('user_8f21c', {
  channels: { email: true, sms: false, whatsapp: true, push: false },
  categories: { marketing: { email: false, sms: false } },  // takes precedence
});
// { status: 'UPDATED', subscriberId, updated_at }
```

The write is a one-level merge: a channel you omit keeps its current value, and a
category you send replaces that category's flags wholesale.

---

## 7. Sender identities (management API)

Every method below calls the **control plane**, not the gateway: the resource
runs on a second client whose origin is `config.managementUrl` (default
`https://console.nervly.io`). `baseUrl` and every gateway resource are
untouched, and the same API key authenticates both. Sender management requires
the key's `write` scope for mutations and `read` for reads.

### `senders.list(params?) → ListSendersResponse` — `GET /v1/senders` (200)

```typescript
const page = await nervly.senders.list({
  channel: 'email',
  provider: 'resend',
  limit: 25,                    // default 50, server cap 100
  cursor: page.next_cursor ?? undefined,
});
// page: { senders: SenderIdentity[], next_cursor?: string | null }
```

### `senders.get(identityId) → SenderIdentity` — `GET /v1/senders/{identityId}` (200)

```typescript
const sender = await nervly.senders.get('b3f0c1a2-…');
// sender.bindings: SenderBinding[]
```

### `senders.create(input) → CreateSenderResponse` — `POST /v1/senders` (201)

```typescript
const created = await nervly.senders.create({
  provider: 'resend',
  value: 'hello@acme.com',
  display_name: 'Acme',        // email-only
  identity_unit: 'domain',     // derived from value/channel when omitted
  verify_with: 'provider',     // or 'nervly'
});
// created: { sender, binding, dns }
```

Repeating the same `(value, provider, identity_unit)` reuses the identity and
binding rather than creating duplicates.

### `senders.addBinding(identityId, input) → CreateSenderResponse` — `POST /v1/senders/{identityId}/bindings` (201)

```typescript
await nervly.senders.addBinding('b3f0c1a2-…', {
  provider: 'postmark',
  identity_unit: 'address',
});
```

### `senders.verifyBinding(identityId, provider, identityUnit) → VerifyBindingResponse` — `POST /v1/senders/{identityId}/bindings/{provider}/{identityUnit}/verify` (200)

```typescript
const verified = await nervly.senders.verifyBinding('b3f0c1a2-…', 'resend', 'domain');
// verified: { binding, dns, last_error? }
```

`identity_unit` is required: a domain and an address binding can coexist on one
provider, so an absent or unknown unit is a `400` rather than a fallback.

### `senders.removeBinding(identityId, provider, identityUnit) → { status }` — `DELETE /v1/senders/{identityId}/bindings/{provider}/{identityUnit}` (200)

```typescript
await nervly.senders.removeBinding('b3f0c1a2-…', 'resend', 'domain');
// { status: 'deleted' }
```

### `senders.remove(identityId) → { status }` — `DELETE /v1/senders/{identityId}` (200)

```typescript
await nervly.senders.remove('b3f0c1a2-…');
// { status: 'deleted' }; cascades every binding under the identity
```

Failures reuse the error classes in §11 unchanged: `400` →
`NervlyValidationError`, `401` → `NervlyAuthenticationError`, `404` →
`NervlyNotFoundError`, `409` → `NervlyIdempotencyError`, `403`/`503` →
`NervlyApiError` (the `503` is a `NervlyServerError`). The control-plane machine
code rides on `errorType`.

---

## 8. Health

### `health.check() → HealthStatus` — `GET /v1/health` (200, unauthenticated)

```typescript
const health = await nervly.health.check();
// { status, service, version, environment, uptime_seconds, nats_connected }
```

`nats_connected: false` means accepted events are being buffered rather than
published to the broker.

---

## 9. Model Context Protocol

### `mcp.listTools() → McpResponse` — `POST /v1/mcp` (200)

### `mcp.callTool(params) → McpResponse` — `POST /v1/mcp` (200)

```typescript
const tools = await nervly.mcp.listTools();
const status = await nervly.mcp.callTool({ name: 'gateway_status' });
// { jsonrpc: '2.0', id, result }
```

Unknown methods return an error object inside a 200 response rather than a
non-2xx status.

---

## 10. Webhooks

> **Nervly does not send outbound delivery webhooks yet.** Poll `events.get()` or
> `messages.list()` for delivery state. These helpers ship ahead of the feature
> so an integration written today keeps working when it lands.

### `webhooks.verifySignature(options) → Promise<boolean>`

### `webhooks.parse(rawBody) → WebhookPayload`

### `webhooks.verifyAndParse(options) → Promise<WebhookPayload>`

```typescript
const payload = await nervly.webhooks.verifyAndParse({
  provider: 'resend',
  payload: req.body,                       // raw string or Uint8Array (Buffer included) — not parsed JSON
  signature: req.headers['x-nervly-signature']!,
  secret: process.env.NERVLY_WEBHOOK_SECRET!,
});
// { message_id?, recipient?, status?, channel?, latency_ms?, cost? }
```

Comparison is HMAC-SHA256 through the runtime-neutral WebCrypto primitive with
a constant-time comparison, and a length mismatch returns `false` rather than
throwing. `verifyAndParse` throws `NervlyWebhookSignatureError` (alias
`WebhookSignatureError`, carrying `provider`) when verification fails — handle
it as a 400 to your own caller.

---

## 11. Errors

Every failure is a `NervlyError`. See [`architecture.md`](architecture.md) §4 for
the full hierarchy; the short aliases are the same class objects as their
`Nervly`-prefixed names.

```typescript
import { AuthenticationError, RateLimitError, ApiError, NervlyError } from '@nervly/sdk';

try {
  await nervly.events.trigger({ name: 'x', to: { subscriberId: 's' } });
} catch (error) {
  if (error instanceof RateLimitError) {
    await sleep(error.retryAfterMs);          // from the Retry-After header
  } else if (error instanceof AuthenticationError) {
    // 401 — key missing, malformed, or revoked
  } else if (error instanceof ApiError) {
    console.error(error.statusCode, error.errorType, error.requestId);
  } else if (error instanceof NervlyError) {
    // network, retry exhaustion, or anything else the SDK raises
  }
}
```
