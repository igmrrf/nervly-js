# @nervly/sdk

[![npm version](https://img.shields.io/npm/v/@nervly/sdk.svg)](https://npmjs.org/package/@nervly/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The official TypeScript SDK for Nervly NaaS (Notification as a Service). Easily integrate powerful, cross-channel notifications with advanced delivery management, templating, and provider failover directly into your applications.

> [!WARNING]
> **API Stability Warning (`0.x`):** `@nervly/sdk` is currently in active `0.x` development. The API surface is considered **unstable until 1.0.0**; minor versions may introduce refinements or backward-incompatible changes as new features land.

## Overview
Nervly is a unified notification infrastructure designed for developers. This SDK provides simple and intuitive access to the Nervly API, allowing you to seamlessly manage user preferences, trigger events, handle webhooks, inspect message delivery status, and ensure robust delivery across Email, SMS, Push, WhatsApp, and Voice.

**Examples:** [`examples/node-app/`](examples/node-app/) (Node SDK app), [`examples/edge-worker/`](examples/edge-worker/) (edge runtime), and [`examples/mcp-agent/`](examples/mcp-agent/) (MCP + agent toolkit) are scaffolding stubs until the shared harness contract lands, alongside the SDK wire-pinning example [`examples/basic-usage.ts`](examples/basic-usage.ts).

## Documentation & Links

- [**Nervly documentation**](https://docs.nervly.io) — SDK quickstart, integration guides, and the full API reference.
- [**Nervly landing page**](https://nervly.io) — the unified Notification-as-a-Service platform (NaaS) powering this SDK.
- [API reference in this repo](docs/api_reference.md) and [architecture overview](docs/architecture.md).
- [GitHub Issues](https://github.com/igmrrf/nervly-js/issues) — bug reports and feature requests.
- [Changelog](https://github.com/igmrrf/nervly-js/blob/main/CHANGELOG.md) — release history and version notes.

## Installation

```bash
npm install @nervly/sdk
```

Ships as both ES modules and CommonJS, with no runtime dependencies — `import`
resolves `dist/esm`, `require` resolves `dist/cjs`, each with its own type
declarations. Node 24+.

## Quick Start

```typescript
import { Nervly } from '@nervly/sdk';

// Initialize the client
const nervly = new Nervly({
  apiKey: 'nervly_sk_live_your_api_key',
  // Optional overrides:
  // baseUrl: 'https://api.nervly.io', // defaults to production https://api.nervly.io
  // maxRetries: 3,
  // timeout: 10000,
});

async function main() {
  try {
    // Trigger a single event
    const event = await nervly.events.trigger({
      name: 'user.signup',
      to: {
        subscriberId: 'usr_123',
        email: 'user@example.com'
      },
      payload: {
        firstName: 'John',
        verificationCode: '7823'
      }
    });
    
    console.log('Event triggered:', event.eventId);

    // Look up delivery timeline
    const message = await nervly.events.get(event.eventId);
    console.log('Status:', message.status, 'Attempts:', message.attempts);
  } catch (error) {
    console.error('Failed to trigger event:', error);
  }
}

main();
```

## API Reference

### Events

#### `nervly.events.trigger(data, options?)`

Trigger a single notification event.
Maps to `POST /v1/events/trigger`.

`to.subscriberId` is required and is stored with the message as the stable
end-user reference; it is also the per-subscriber rate-limit bucket. The
contact fields you supply decide which channels are eligible — omit `email`
and no email is attempted.

```typescript
const result = await nervly.events.trigger(
  {
    name: 'order.shipped',
    to: { subscriberId: 'usr_abc', email: 'customer@example.com' },
    payload: { trackingUrl: 'https://...' },
    overrides: {
      email: { from: 'orders@nervly.io' }
    }
  },
  {
    idempotencyKey: 'order-12345',
    priority: 'HIGH'
  }
);
```

#### `nervly.events.bulkTrigger(data)`

Trigger multiple notification events at once.
Maps to `POST /v1/events/bulk`.

```typescript
const result = await nervly.events.bulkTrigger({
  events: [
    { name: 'daily.digest', to: { subscriberId: 'usr_1', email: 'u1@nervly.io' }, payload: {} },
    { name: 'daily.digest', to: { subscriberId: 'usr_2', email: 'u2@nervly.io' }, payload: {} },
  ]
});
console.log('Batch Job ID:', result.jobId);
```

#### `nervly.events.get(eventId)`

Look up delivery status, attempts, cost, and event timeline for a message.
Maps to `GET /v1/events/:eventId`.

```typescript
const message = await nervly.events.get('evt_018e123456787abc8def0123456789ab');
console.log('Status:', message.status);
console.log('Timeline:', message.events);
```

### Messages

#### `nervly.messages.list(params?)`

List messages with optional filters and cursor-based pagination.
Maps to `GET /v1/messages`.

```typescript
const result = await nervly.messages.list({
  status: 'DELIVERED',
  channel: 'sms',
  subscriberId: 'usr_123',
  limit: 25,
});

for (const message of result.messages) {
  console.log(message.event_id, message.status);
}
```

### Subscribers

#### `nervly.subscribers.delete(subscriberId)`

Erase a subscriber: clear their contact data, delete their preferences, and
suppress any delivery queued for them. Maps to
`DELETE /v1/subscribers/:subscriberId`.

```typescript
const res = await nervly.subscribers.delete('usr_123');
console.log('Erasure confirmed:', res.status, res.subscriberId);
```

> [!NOTE]
> The subscriber ID itself is **not** deleted. The gateway keeps it in the
> erasure tombstone and the audit trail, and recent message rows keep the ID
> link for a short billing/audit window before it is unlinked. Treat the ID
> as retained pseudonymous data, not as a place to carry personal data.

### Users

#### `nervly.users.updatePreferences(subscriberId, data)`

Update a subscriber's channel and category preferences.
Maps to `PUT /v1/users/:subscriberId/preferences`.

```typescript
await nervly.users.updatePreferences('usr_123', {
  channels: {
    email: true,
    sms: false,
    whatsapp: true,
  },
});
```

`nervly.subscribers.updatePreferences` is a deprecated alias of the same call,
removed in 0.2.0.

### Sender identities

#### `nervly.senders` — `list`, `get`, `create`, `addBinding`, `verifyBinding`, `removeBinding`, `remove`

Manage sender identities and their per-provider bindings. This resource talks to
the control-plane management API (`managementUrl`, default
`https://console.nervly.io`) on the same API key; `baseUrl` and every gateway
call are untouched.

```typescript
const created = await nervly.senders.create({
  provider: 'resend',
  value: 'hello@acme.com',
  display_name: 'Acme',
  identity_unit: 'domain',
});
console.log('Identity:', created.sender.identity_id, created.binding.verification_state);

const verified = await nervly.senders.verifyBinding(
  created.sender.identity_id,
  'resend',
  'domain',
);
console.log('Verified:', verified.binding.verification_state);

const page = await nervly.senders.list({ channel: 'email', limit: 25 });
for (const sender of page.senders) {
  console.log(sender.sender_value, sender.bindings.length);
}
```

### Health

#### `nervly.health.check()`

Check the status and subsystem health of the API Gateway.
Maps to `GET /v1/health`.

```typescript
const health = await nervly.health.check();
console.log('API Status:', health.status);
```

### Model Context Protocol (MCP)

#### `nervly.mcp.listTools()` & `nervly.mcp.callTool(params)`

Call the gateway's MCP tools (diagnostics and `send_notification`).
Maps to `POST /v1/mcp`.

```typescript
const tools = await nervly.mcp.listTools();
console.log(tools);
```

### Webhooks

#### `nervly.webhooks.verifySignature(options)` & `nervly.webhooks.parse(rawBody)`

Verify incoming provider webhooks securely via timing-safe HMAC-SHA256.

> [!NOTE]
> **Nervly does not send direct outbound delivery webhooks yet.** Poll
> `events.get(eventId)` or `messages.list()` for delivery state. These helpers
> ship ahead of direct delivery so integrations written today keep working when
> it lands; nothing will arrive at your endpoint until then.
>
> At launch, real delivery events reach your machine through the local CLI's
> forwarding tunnel — `nervly forward webhooks --to <url>` (part of
> `@nervly/cli`) dials out to a Nervly-operated relay, receives the delivery
> events, and re-signs them locally with the secret in your CLI secret store.
> The tunnel is a consumer of the delivery stream, not a second webhook
> product; the helpers below verify its locally re-signed payloads the same way
> they will verify direct outbound webhooks.

```typescript
import express from 'express';
const app = express();

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-nervly-signature'] as string;
  const secret = process.env.NERVLY_WEBHOOK_SECRET!;
  
  try {
    const payload = await nervly.webhooks.verifyAndParse({
      provider: 'nervly',
      payload: req.body,
      signature,
      secret
    });
    
    console.log('Webhook payload:', payload);
    res.status(200).send();
  } catch (error) {
    res.status(400).send('Invalid Signature');
  }
});
```

## Error Handling

The SDK exposes typed error classes for granular control.

```typescript
import {
  Nervly,
  NervlyError,
  NervlyApiError,
  NervlyAuthenticationError,
  NervlyRateLimitError,
} from '@nervly/sdk';

try {
  await nervly.events.trigger({ /* ... */ });
} catch (error) {
  if (error instanceof NervlyAuthenticationError) {
    console.error('Check your API Key');
  } else if (error instanceof NervlyRateLimitError) {
    // `purpose` names which limit was hit; `remaining`/`limit` are advisory
    // budget from the draft-11 RateLimit headers, never a reason to gate a call.
    console.error(
      `Rate limit (${error.purpose ?? 'unknown'}) reached. Retry after ms:`,
      error.retryAfterMs
    );
  } else if (error instanceof NervlyApiError) {
    console.error('API Error:', error.statusCode, error.message);
  } else if (error instanceof NervlyError) {
    // Network failure, or retries exhausted — inspect `lastError` for the cause.
    console.error('Request failed:', error.message);
  }
}
```

Every status-specific class also has a short alias — `AuthenticationError`,
`RateLimitError`, `ValidationError`, `NotFoundError`, `IdempotencyError`,
`ServerError` — which is the same class object, so `instanceof` works either
way. `NervlyApiError.errorType` carries the gateway's machine-readable code and
`requestId` the `x-request-id` header, both worth logging. See
[`docs/api_reference.md`](docs/api_reference.md) §11.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | **Required** | Your API Key for Nervly. |
| `baseUrl` | `string` | `https://api.nervly.io` | The base URL for the gateway API. |
| `managementUrl` | `string` | `https://console.nervly.io` | The base URL for the control-plane management API (`nervly.senders`). |
| `maxRetries` | `number` | `3` | Number of retries on transient errors. |
| `timeout` | `number` | `10000` | Timeout in milliseconds. |
| `retryBaseDelay` | `number` | `1000` | Initial exponential backoff delay in ms. |

## License
MIT
