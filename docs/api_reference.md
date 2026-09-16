# nerve-sdk API Reference

Programmatic interface for `@nervehq/sdk`.

---

## 1. Initialization

```typescript
import { NerveClient } from '@nervehq/sdk';

const nerve = new NerveClient({
  apiKey: process.env.NERVE_API_KEY!,
  baseUrl: 'https://api.nervehq.io', // default
  timeoutMs: 10000,
});
```

---

## 2. Resources & Methods

### `events.trigger(payload)`
Trigger a multi-channel notification event:
```typescript
const response = await nerve.events.trigger({
  event: 'order.created',
  channel: 'sms', // 'sms' | 'whatsapp' | 'push' | 'email'
  recipient: '+2348012345678',
  variables: {
    first_name: 'Amaka',
    order_id: 'ORD-9821'
  },
  priority: 'high', // 'critical' | 'high' | 'normal' | 'low'
  idempotencyKey: 'tx_uuid_123',
});
// returns { eventId: string, status: 'TRIGGERED' }
```

### `subscribers.createOrUpdate(id, data)`
Upsert subscriber preferences and channel endpoints:
```typescript
await nerve.subscribers.createOrUpdate('sub_492', {
  phone: '+2348012345678',
  email: 'amaka@example.com',
  channels: {
    marketing: false, // opt-out
    transactional: true
  }
});
```

### `messages.getStatus(eventId)`
Retrieve delivery status and provider receipt:
```typescript
const message = await nerve.messages.getStatus('evt_98124');
// message.status: 'TRIGGERED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'SUPPRESSED'
```
