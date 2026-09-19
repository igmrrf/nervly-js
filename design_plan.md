# Nervly SDK — Design Plan

## 1. Overview

The **Nervly SDK** (`@nervly/sdk`) is a fully-typed TypeScript client library for the Nervly Unified Notification-as-a-Service (NaaS) platform. It provides developers with an ergonomic, type-safe interface to interact with the Nervly Gateway API — abstracting HTTP communication, authentication, idempotency, priority management, retry logic, and error handling.

## 2. Design Principles

| Principle | Description |
|---|---|
| **Type-Safety First** | Every request/response has a strict TypeScript interface. No `any`. |
| **Zero External Dependencies** | Uses Node.js native `fetch` (Node 18+). No axios, node-fetch, etc. |
| **Resilient by Default** | Built-in exponential backoff retry for transient failures (429, 5xx). |
| **Ergonomic API** | Resource-based fluent API: `nerve.events.trigger(...)`, `nerve.users.update(...)` |
| **Idempotency Built-in** | Auto-generates `Idempotency-Key` UUIDs or accepts user-supplied keys. |
| **Isomorphic** | Works in Node.js 18+ (primary target). |

## 3. Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Nervly (Main Client)                │
│  ┌─────────┐ ┌──────┐ ┌──────────┐ ┌─────┐ ┌──────┐│
│  │ Events  │ │Users │ │Webhooks  │ │ MCP │ │Health││
│  │Resource │ │Res.  │ │Resource  │ │Res. │ │Res.  ││
│  └────┬────┘ └──┬───┘ └────┬─────┘ └──┬──┘ └──┬───┘│
│       └─────────┴──────────┴──────────┴───────┘     │
│                         │                            │
│              ┌──────────┴──────────┐                 │
│              │    NervlyHttpClient  │                 │
│              │  (fetch + retry +   │                 │
│              │   auth + headers)   │                 │
│              └─────────────────────┘                 │
└──────────────────────────────────────────────────────┘
                          │
                    HTTPS/REST
                          │
              ┌───────────┴───────────┐
              │   Nervly Gateway API   │
              │   (Rust / Axum)       │
              └───────────────────────┘
```

## 4. API Surface

### 4.1 Client Initialization
```typescript
import Nervly from '@nervly/sdk';

const nerve = new Nervly({
  apiKey: 'your_api_key',
  baseUrl: 'https://api.nervly.io',  // optional, defaults to production
  timeout: 5000,                     // optional, ms
  maxRetries: 3,                     // optional
});
```

### 4.2 Events Resource
```typescript
// Single event trigger
const result = await nerve.events.trigger({
  name: 'payment_processed',
  to: {
    subscriberId: 'usr_9983j2',
    email: 'user@example.com',
    phone: '+2348012345678',
  },
  payload: { amount: '₦ 1,500,000', transaction_id: 'tx_77392910' },
  overrides: {
    email: { sender: 'finance@corp.com' },
    whatsapp: { templateName: 'tx_receipt_v2', language: 'en_GB' },
  },
}, {
  idempotencyKey: 'custom-key-123',    // optional
  priority: 'CRITICAL',                // optional
});

// Bulk event trigger
const bulk = await nerve.events.bulkTrigger({
  events: [
    { name: 'welcome', to: { subscriberId: 'usr_001', email: 'a@b.com' } },
    { name: 'welcome', to: { subscriberId: 'usr_002', email: 'c@d.com' } },
  ],
});
```

### 4.3 Users Resource
```typescript
const prefs = await nerve.users.updatePreferences('usr_9983j2', {
  channels: { email: true, sms: true, push: false, whatsapp: true },
  categories: { marketing: { email: false } },
});
```

### 4.4 Health Resource
```typescript
const health = await nerve.health.check();
```

### 4.5 MCP Resource
```typescript
const tools = await nerve.mcp.listTools();
const status = await nerve.mcp.callTool();
```

### 4.6 Webhooks Resource
```typescript
// Verify webhook signature
const isValid = nerve.webhooks.verifySignature({
  provider: 'termii',
  payload: rawBody,
  signature: req.headers['x-termii-signature'],
  secret: 'your_webhook_secret',
});

// Parse webhook payload
const event = nerve.webhooks.parse(rawBody);
```

## 5. Gateway API Contract Reference

| Method | Endpoint | Auth | SDK Method |
|---|---|---|---|
| `GET` | `/health` | No | `nerve.health.check()` |
| `POST` | `/v1/events/trigger` | Bearer | `nerve.events.trigger(data, opts)` |
| `POST` | `/v1/events/bulk` | Bearer | `nerve.events.bulkTrigger(data)` |
| `PUT` | `/v1/users/:id/preferences` | Bearer | `nerve.users.updatePreferences(id, data)` |
| `POST` | `/v1/mcp` | Bearer | `nerve.mcp.listTools()` / `nerve.mcp.callTool()` |
| `POST` | `/v1/webhooks/:provider` | Signature | `nerve.webhooks.verifySignature(...)` |

## 6. Error Handling Strategy

```typescript
try {
  await nerve.events.trigger({ ... });
} catch (error) {
  if (error instanceof NervlyAuthenticationError) { /* 401 */ }
  if (error instanceof NervlyRateLimitError) { /* 429, has retryAfter */ }
  if (error instanceof NervlyIdempotencyError) { /* 409 */ }
  if (error instanceof NervlyValidationError) { /* 400 */ }
  if (error instanceof NervlyApiError) { /* any API error */ }
  if (error instanceof NervlyNetworkError) { /* connection/timeout */ }
}
```

## 7. Directory Structure

```
sdk/
├── package.json
├── tsconfig.json
├── README.md
├── design_plan.md
├── src/
│   ├── index.ts                 # Main Nervly client & re-exports
│   ├── types.ts                 # All TypeScript interfaces
│   ├── errors.ts                # Custom error hierarchy
│   ├── client.ts                # Core HTTP client (fetch + retry)
│   └── resources/
│       ├── events.ts            # Events resource
│       ├── users.ts             # Users resource
│       ├── webhooks.ts          # Webhooks resource
│       ├── mcp.ts               # MCP resource
│       └── health.ts            # Health resource
├── tests/
│   ├── client.test.ts
│   ├── events.test.ts
│   └── webhooks.test.ts
└── examples/
    └── basic-usage.ts
```

## 8. Retry Strategy

- **Retryable**: HTTP 429, 500, 502, 503, 504, network errors
- **Non-retryable**: HTTP 400, 401, 403, 409
- **Algorithm**: Exponential backoff with jitter: `min(base * 2^attempt + jitter, maxDelay)`
- **Default**: 3 retries, 1s base delay, 30s max delay

## 9. Build & Distribution

- **Target**: ES2022, NodeNext module resolution
- **Output**: CommonJS + ESM dual package (`dist/cjs/` + `dist/esm/`)
- **Declarations**: Full `.d.ts` type declarations
- **Package name**: `@nervly/sdk`
