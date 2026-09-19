# nervly-sdk API Reference

Programmatic interface for `@nervly/sdk`. Every method below maps to exactly one
operation in [`gateway.json`](../../nerve-docs/static/openapi/gateway.json); the
mapping is asserted by `tests/spec-conformance.test.ts`, and the request/response
shapes are asserted against the generated spec by
`tests/types/conformance.types.ts`.

Status codes shown are what the gateway returns on success.

---

## 1. Initialization

```typescript
import Nervly from '@nervly/sdk';          // default export
import { Nervly as Named } from '@nervly/sdk'; // or the named one — same class

const nerve = new Nervly({
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
const event = await nerve.events.trigger(
  {
    name: 'payment-received',       // workflow name
    to: { subscriberId: 'user_8f21c', email: 'ada@example.com' },
    payload: { amount: '24500.00' }, // template variables ({{amount}})
    category: 'receipts',            // matched against subscriber preferences
    overrides: {
      email: { sender: 'billing@yourcompany.com', provider: 'resend' },
      sms: { sender: 'Nervly' },
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
const batch = await nerve.events.bulkTrigger({
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
const message = await nerve.events.get('evt_018e123456787abc8def0123456789ab');
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
await nerve.email.send({
  to: 'customer@example.com',       // string, or a full Recipient
  subject: 'Your receipt',
  html: '<p>Thanks!</p>',
  text: 'Thanks!',                  // optional plain-text alternative
  category: 'transactional',
  provider: 'resend',               // shorthand for overrides.email.provider
  sender: 'Billing <billing@example.com>',
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
await nerve.voice.send({
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
const page = await nerve.messages.list({
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
const erasure = await nerve.subscribers.delete('user_8f21c');
// { status: 'accepted', subscriberId, message }
```

Anonymises the subscriber row and suppresses any delivery queued for it.

### `subscribers.updatePreferences(subscriberId, data) → UserPreferencesResponse` — `PUT /v1/users/{subscriberId}/preferences` (200)

### `users.updatePreferences(subscriberId, data) → UserPreferencesResponse` — same endpoint

```typescript
const prefs = await nerve.users.updatePreferences('user_8f21c', {
  channels: { email: true, sms: false, whatsapp: true, push: false },
  categories: { marketing: { email: false, sms: false } },  // takes precedence
});
// { status: 'UPDATED', subscriberId, updated_at }
```

The write is a one-level merge: a channel you omit keeps its current value, and a
category you send replaces that category's flags wholesale.

---

## 7. Health

### `health.check() → HealthStatus` — `GET /v1/health` (200, unauthenticated)

```typescript
const health = await nerve.health.check();
// { status, service, version, environment, uptime_seconds, nats_connected }
```

`nats_connected: false` means accepted events are being buffered rather than
published to the broker.

---

## 8. Model Context Protocol

### `mcp.listTools() → McpResponse` — `POST /v1/mcp` (200)

### `mcp.callTool(params) → McpResponse` — `POST /v1/mcp` (200)

```typescript
const tools = await nerve.mcp.listTools();
const status = await nerve.mcp.callTool({ name: 'gateway_status' });
// { jsonrpc: '2.0', id, result }
```

Unknown methods return an error object inside a 200 response rather than a
non-2xx status.

---

## 9. Webhooks

> **Nervly does not send outbound delivery webhooks yet.** Poll `events.get()` or
> `messages.list()` for delivery state. These helpers ship ahead of the feature
> so an integration written today keeps working when it lands.

### `webhooks.verifySignature(options) → Promise<boolean>`

### `webhooks.parse(rawBody) → WebhookPayload`

### `webhooks.verifyAndParse(options) → Promise<WebhookPayload>`

```typescript
const payload = await nerve.webhooks.verifyAndParse({
  provider: 'resend',
  payload: req.body,                       // raw string or Buffer — not parsed JSON
  signature: req.headers['x-nervly-signature']!,
  secret: process.env.NERVLY_WEBHOOK_SECRET!,
});
// { message_id?, recipient?, status?, channel?, latency_ms?, cost? }
```

Comparison is HMAC-SHA256 through `timingSafeEqual`, and a length mismatch
returns `false` rather than throwing. `verifyAndParse` throws a plain `Error`
with `Invalid webhook signature from provider: <provider>` when verification
fails — handle it as a 400 to your own caller.

---

## 10. Errors

Every failure is a `NervlyError`. See [`architecture.md`](architecture.md) §4 for
the full hierarchy; the short aliases are the same class objects as their
`Nervly`-prefixed names.

```typescript
import { AuthenticationError, RateLimitError, ApiError, NervlyError } from '@nervly/sdk';

try {
  await nerve.events.trigger({ name: 'x', to: { subscriberId: 's' } });
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
