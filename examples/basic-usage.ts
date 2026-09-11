/**
 * @nerve/sdk Basic Usage Example
 *
 * Demonstrates the core features of the Nerve SDK:
 * - Client initialization
 * - Single event trigger with idempotency + priority
 * - Bulk event dispatch
 * - User preference management
 * - Health check
 * - MCP tool inspection
 * - Webhook signature verification
 * - Error handling
 */

import { createHmac } from 'node:crypto';
import Nerve, {
  NerveApiError,
  NerveAuthenticationError,
  NerveRateLimitError,
  NerveValidationError,
  NerveIdempotencyError,
  NerveNetworkError,
} from '../src/index.js';

// ─────────────────────────────────────────────────────────────────
// 1. Initialize the Nerve Client
// ─────────────────────────────────────────────────────────────────
const nerve = new Nerve({
  apiKey: process.env.NERVE_API_KEY || 'nv_test_1234567890abcdef',
  baseUrl: process.env.NERVE_BASE_URL || 'http://localhost:8080',
  timeout: 5000,      // 5s request timeout
  maxRetries: 3,       // retry up to 3 times on transient failures
});

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       @nerve/sdk  —  Basic Usage         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ─────────────────────────────────────────────────────────────
  // 2. Health Check (unauthenticated)
  // ─────────────────────────────────────────────────────────────
  console.log('▸ Checking gateway health...');
  const health = await nerve.health.check();
  console.log(`  Status: ${health.status}`);
  console.log(`  Service: ${health.service} v${health.version}`);
  console.log(`  NATS: ${health.nats_connected ? 'Connected' : 'Disconnected'}\n`);

  // ─────────────────────────────────────────────────────────────
  // 3. Trigger a Single Notification Event
  // ─────────────────────────────────────────────────────────────
  console.log('▸ Triggering a single notification event...');
  const event = await nerve.events.trigger(
    {
      name: 'payment_processed',
      to: {
        subscriberId: 'usr_9983j2',
        email: 'executive@example.com',
        phone: '+2348012345678',
        deviceTokens: ['fcm-token-xyz123'],
      },
      payload: {
        amount: '₦ 1,500,000',
        transaction_id: 'tx_77392910',
      },
      overrides: {
        email: {
          sender: 'finance@corporation.com',
          customHeaders: { 'zoho-enczapikey': 'secret-token-bypass' },
        },
        whatsapp: {
          templateName: 'tx_receipt_v2',
          language: 'en_GB',
        },
      },
    },
    {
      idempotencyKey: 'payment-tx_77392910',  // prevents duplicate processing
      priority: 'CRITICAL',                    // highest priority queue
    },
  );
  console.log(`  Event ID: ${event.eventId}`);
  console.log(`  Status: ${event.status}`);
  console.log(`  Priority: ${event.priority}\n`);

  // ─────────────────────────────────────────────────────────────
  // 4. Bulk Trigger — Batch Multiple Events
  // ─────────────────────────────────────────────────────────────
  console.log('▸ Sending bulk notification batch...');
  const batchJob = await nerve.events.bulkTrigger({
    events: [
      {
        name: 'system_maintenance',
        to: { subscriberId: 'usr_002', email: 'alice@corp.com' },
        payload: { window: '02:00-04:00 UTC', service: 'payments' },
      },
      {
        name: 'system_maintenance',
        to: { subscriberId: 'usr_003', email: 'bob@corp.com' },
        payload: { window: '02:00-04:00 UTC', service: 'payments' },
      },
    ],
  });
  console.log(`  Job ID: ${batchJob.jobId}`);
  console.log(`  Events queued: ${batchJob.count}`);
  console.log(`  Est. completion: ${batchJob.estimatedCompletion}\n`);

  // ─────────────────────────────────────────────────────────────
  // 5. Update User Notification Preferences
  // ─────────────────────────────────────────────────────────────
  console.log('▸ Updating user preferences...');
  const prefs = await nerve.users.updatePreferences('usr_9983j2', {
    channels: {
      email: true,
      sms: true,
      push: false,
      whatsapp: true,
    },
    categories: {
      marketing: { email: false, sms: false },
      transactional: { sms: true, email: true },
    },
  });
  console.log(`  Subscriber: ${prefs.subscriberId}`);
  console.log(`  Status: ${prefs.status}`);
  console.log(`  Updated at: ${prefs.updatedAt}\n`);

  // ─────────────────────────────────────────────────────────────
  // 6. MCP — Model Context Protocol Tools
  // ─────────────────────────────────────────────────────────────
  console.log('▸ Listing MCP tools...');
  const mcpTools = await nerve.mcp.listTools();
  console.log(`  MCP Response:`, JSON.stringify(mcpTools.result, null, 2));

  console.log('\n▸ Calling MCP tool...');
  const mcpStatus = await nerve.mcp.callTool();
  console.log(`  Gateway Status:`, JSON.stringify(mcpStatus.result, null, 2), '\n');

  // ─────────────────────────────────────────────────────────────
  // 7. Webhook Signature Verification (server-side)
  // ─────────────────────────────────────────────────────────────
  console.log('▸ Simulating webhook verification...');
  const webhookSecret = 'whsec_test_secret_2026';
  const rawPayload = JSON.stringify({
    message_id: 'msg_dlr_001',
    recipient: '+2348012345678',
    status: 'delivered',
    channel: 'sms',
    latency_ms: 120,
    cost: 0.005,
  });
  const webhookSignature = createHmac('sha256', webhookSecret)
    .update(rawPayload)
    .digest('hex');

  // Verify signature (what you'd do in an Express/Fastify handler)
  const isValid = nerve.webhooks.verifySignature({
    provider: 'termii',
    payload: rawPayload,
    signature: webhookSignature,
    secret: webhookSecret,
  });
  console.log(`  Signature valid: ${isValid}`);

  // Parse the verified payload
  const parsedEvent = nerve.webhooks.parse(rawPayload);
  console.log(`  Status: ${parsedEvent.status}`);
  console.log(`  Channel: ${parsedEvent.channel}`);
  console.log(`  Latency: ${parsedEvent.latency_ms}ms\n`);

  console.log('✓ All operations completed successfully!');
}

// ─────────────────────────────────────────────────────────────────
// Error Handling
// ─────────────────────────────────────────────────────────────────
main().catch((error) => {
  console.error('\n╔══════════════════════════════════════════╗');
  console.error('║          Error Occurred                   ║');
  console.error('╚══════════════════════════════════════════╝\n');

  if (error instanceof NerveAuthenticationError) {
    console.error('🔑 Authentication Error:', error.message);
    console.error('   → Check your NERVE_API_KEY environment variable');
  } else if (error instanceof NerveRateLimitError) {
    console.error('⏱  Rate Limited:', error.message);
    console.error(`   → Retry after ${error.retryAfterMs}ms`);
  } else if (error instanceof NerveIdempotencyError) {
    console.error('🔄 Idempotency Conflict:', error.message);
    console.error('   → This event was already processed');
  } else if (error instanceof NerveValidationError) {
    console.error('❌ Validation Error:', error.message);
  } else if (error instanceof NerveNetworkError) {
    console.error('🌐 Network Error:', error.message);
    console.error('   → Check if the gateway is running');
  } else if (error instanceof NerveApiError) {
    console.error(`⚠️  API Error (${error.statusCode}):`, error.message);
    console.error(`   Type: ${error.errorType}`);
  } else {
    console.error('Unexpected error:', error);
  }

  process.exit(1);
});
