# @nervly/sdk

[![npm version](https://img.shields.io/npm/v/@nervly/sdk.svg)](https://npmjs.org/package/@nervly/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The official TypeScript SDK for Nervly NaaS (Notification as a Service). Easily integrate powerful, cross-channel notifications with advanced delivery management, templating, and provider failover directly into your applications.

> [!WARNING]
> **API Stability Warning (`0.x`):** `@nervly/sdk` is currently in active `0.x` development. The API surface is considered **unstable until 1.0.0**; minor versions may introduce refinements or backward-incompatible changes as new features land.

## Overview
Nervly is a unified notification infrastructure designed for developers. This SDK provides simple and intuitive access to the Nervly API, allowing you to seamlessly manage user preferences, trigger events, handle webhooks, inspect message delivery status, and ensure robust delivery across Email, SMS, Push, WhatsApp, and Voice.

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
const nerve = new Nervly({
  apiKey: 'nerve_sk_live_your_api_key',
  // Optional overrides:
  // baseUrl: 'https://api.nervly.io', // defaults to production https://api.nervly.io
  // maxRetries: 3,
  // timeout: 10000,
});

async function main() {
  try {
    // Trigger a single event
    const event = await nerve.events.trigger({
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
    const message = await nerve.events.get(event.eventId);
    console.log('Status:', message.status, 'Attempts:', message.attempts);
  } catch (error) {
    console.error('Failed to trigger event:', error);
  }
}

main();
```

## API Reference

### Events

#### `nerve.events.trigger(data, options?)`

Trigger a single notification event.
Maps to `POST /v1/events/trigger`.

```typescript
const result = await nerve.events.trigger(
  {
    name: 'order.shipped',
    to: { subscriberId: 'usr_abc', email: 'customer@example.com' },
    payload: { trackingUrl: 'https://...' },
    overrides: {
      email: { sender: 'orders@nervly.io' }
    }
  },
  {
    idempotencyKey: 'order-12345',
    priority: 'HIGH'
  }
);
```

#### `nerve.events.bulkTrigger(data)`

Trigger multiple notification events at once.
Maps to `POST /v1/events/bulk`.

```typescript
const result = await nerve.events.bulkTrigger({
  events: [
    { name: 'daily.digest', to: { subscriberId: 'usr_1', email: 'u1@nervly.io' }, payload: {} },
    { name: 'daily.digest', to: { subscriberId: 'usr_2', email: 'u2@nervly.io' }, payload: {} },
  ]
});
console.log('Batch Job ID:', result.jobId);
```

#### `nerve.events.get(eventId)`

Look up delivery status, attempts, cost, and event timeline for a message.
Maps to `GET /v1/events/:eventId`.

```typescript
const message = await nerve.events.get('evt_018e123456787abc8def0123456789ab');
console.log('Status:', message.status);
console.log('Timeline:', message.events);
```

### Messages

#### `nerve.messages.list(params?)`

List messages with optional filters and cursor-based pagination.
Maps to `GET /v1/messages`.

```typescript
const result = await nerve.messages.list({
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

#### `nerve.subscribers.delete(subscriberId)`

Erase a subscriber and delete their personal data (NDPR / right-to-erasure).
Maps to `DELETE /v1/subscribers/:subscriberId`.

```typescript
const res = await nerve.subscribers.delete('usr_123');
console.log('Erasure confirmed:', res.status, res.subscriberId);
```

#### `nerve.subscribers.updatePreferences(subscriberId, data)`

Update a subscriber's channel preferences.
Maps to `PUT /v1/users/:subscriberId/preferences`.

```typescript
await nerve.subscribers.updatePreferences('usr_123', {
  channels: {
    email: true,
    sms: false,
    whatsapp: true,
  },
});
```

### Health

#### `nerve.health.check()`

Check the status and subsystem health of the API Gateway.
Maps to `GET /v1/health`.

```typescript
const health = await nerve.health.check();
console.log('API Status:', health.status);
```

### Model Context Protocol (MCP)

#### `nerve.mcp.listTools()` & `nerve.mcp.callTool(params)`

Interact with MCP diagnostic tools.
Maps to `POST /v1/mcp`.

```typescript
const tools = await nerve.mcp.listTools();
console.log(tools);
```

### Webhooks

#### `nerve.webhooks.verifySignature(options)` & `nerve.webhooks.parse(rawBody)`

Verify incoming provider webhooks securely via timing-safe HMAC-SHA256.

> [!NOTE]
> **Nervly does not send outbound delivery webhooks yet.** Poll
> `events.get(eventId)` or `messages.list()` for delivery state. These helpers
> ship ahead of the feature so integrations written today keep working when it
> lands; nothing will arrive at your endpoint until then.

```typescript
import express from 'express';
const app = express();

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-nervly-signature'] as string;
  const secret = process.env.NERVE_WEBHOOK_SECRET!;
  
  try {
    const payload = await nerve.webhooks.verifyAndParse({
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
  await nerve.events.trigger({ /* ... */ });
} catch (error) {
  if (error instanceof NervlyAuthenticationError) {
    console.error('Check your API Key');
  } else if (error instanceof NervlyRateLimitError) {
    console.error('Rate limit reached. Retry after ms:', error.retryAfterMs);
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
[`docs/api_reference.md`](docs/api_reference.md) §9.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | **Required** | Your API Key for Nervly. |
| `baseUrl` | `string` | `https://api.nervly.io` | The base URL for the API. |
| `maxRetries` | `number` | `3` | Number of retries on transient errors. |
| `timeout` | `number` | `10000` | Timeout in milliseconds. |
| `retryBaseDelay` | `number` | `1000` | Initial exponential backoff delay in ms. |

## License
MIT
