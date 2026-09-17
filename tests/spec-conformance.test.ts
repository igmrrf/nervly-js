import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Nerve } from '../src/index.js';

type SdkMethodAccessor = (client: Nerve) => unknown;

interface Spec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
}

interface Operation {
  requestBody?: { content?: { 'application/json'?: { schema?: { $ref?: string } } } };
  responses: Record<string, { content?: { 'application/json'?: { schema?: { $ref?: string } } } }>;
}

/**
 * Explicit mapping between OpenAPI paths and the SDK method that calls them.
 * Every path+method in `nerve-docs/static/openapi/gateway.json` must appear
 * here, or the first test fails.
 */
const CONFORMANCE_MAP: Record<string, Record<string, SdkMethodAccessor>> = {
  '/v1/events/bulk': {
    post: (c) => c.events.bulkTrigger,
  },
  '/v1/events/trigger': {
    post: (c) => c.events.trigger,
  },
  '/v1/events/{eventId}': {
    get: (c) => c.events.get,
  },
  '/v1/health': {
    get: (c) => c.health.check,
  },
  '/v1/mcp': {
    post: (c) => c.mcp.callTool,
  },
  '/v1/messages': {
    get: (c) => c.messages.list,
  },
  '/v1/subscribers/{subscriberId}': {
    delete: (c) => c.subscribers.delete,
  },
  '/v1/users/{subscriberId}/preferences': {
    put: (c) => c.users.updatePreferences,
  },
  '/v1/webhooks/{provider}': {
    post: (c) => c.webhooks.verifySignature,
  },
};

/**
 * Paths the gateway serves but the SDK deliberately does not call, with the
 * reason. These are skipped by the schema-coverage test below.
 *
 * `POST /v1/webhooks/{provider}` is *providers* calling *us*. SDK users consume
 * delivery receipts through `webhooks.verifySignature` / `webhooks.parse` on
 * their own endpoint rather than posting to the gateway, so the operation is
 * mapped (for path coverage) without the SDK modelling its `WebhookResponse`
 * body.
 */
const NOT_CALLED_BY_SDK: Record<string, string> = {
  'POST /v1/webhooks/{provider}': 'inbound provider receipt; the SDK verifies signatures locally',
};

/**
 * Every OpenAPI component the SDK declares a TypeScript equivalent for.
 *
 * `tests/types/conformance.types.ts` proves each of these matches the generated
 * spec field-for-field. Listing them here is what lets the third test below
 * fail when the gateway grows a response schema the SDK has not modelled yet.
 *
 * Deliberately not included: `TelemetryReceiptEvent` (internal worker payload,
 * not part of any request or response the SDK sends or reads) and
 * `WebhookResponse` (see `NOT_CALLED_BY_SDK`).
 */
const MODELLED_SCHEMAS = new Set([
  'BulkEventResult',
  'BulkTriggerRequest',
  'BulkTriggerResponse',
  'ChannelPreferences',
  'EmailOverrideDto',
  'ErrorResponse',
  'EventItemDto',
  'GenericWebhookPayload',
  'HealthStatus',
  'ListMessagesResponse',
  'McpRequest',
  'McpResponse',
  'MessageDto',
  'ProviderOverridesDto',
  'RecipientDto',
  'SmsOverrideDto',
  'SubscriberErasureResponse',
  'TriggerRequest',
  'TriggerResponse',
  'UserPreferencesRequest',
  'UserPreferencesResponse',
  'WhatsAppOverrideDto',
]);

const currentDir = dirname(fileURLToPath(import.meta.url));
const openApiPath = resolve(currentDir, '../../nerve-docs/static/openapi/gateway.json');
const openApiSpec = JSON.parse(readFileSync(openApiPath, 'utf-8')) as Spec;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Every `#/components/schemas/X` reference an operation points at. */
function referencedSchemas(operation: Operation): string[] {
  const refs: string[] = [];
  const push = (ref: string | undefined) => {
    if (ref) refs.push(ref.replace('#/components/schemas/', ''));
  };

  push(operation.requestBody?.content?.['application/json']?.schema?.$ref);

  for (const [status, response] of Object.entries(operation.responses)) {
    if (status.startsWith('2')) {
      push(response.content?.['application/json']?.schema?.$ref);
    }
  }

  return refs;
}

describe('SDK OpenAPI Spec Conformance', () => {
  const nerve = new Nerve({ apiKey: 'nv_live_conformance_test' });

  it('should cover every path and method documented in gateway.json', () => {
    const missingEndpoints: string[] = [];

    for (const [path, methods] of Object.entries(openApiSpec.paths)) {
      for (const method of HTTP_METHODS) {
        if (!(method in methods)) continue;

        const accessor = CONFORMANCE_MAP[path]?.[method];
        if (!accessor) {
          missingEndpoints.push(`${method.toUpperCase()} ${path}`);
          continue;
        }

        assert.equal(
          typeof accessor(nerve),
          'function',
          `SDK method for ${method.toUpperCase()} ${path} is not a function`,
        );
      }
    }

    assert.deepEqual(
      missingEndpoints,
      [],
      `The following OpenAPI endpoints are missing from the SDK:\n${missingEndpoints.join('\n')}`,
    );
  });

  it('should not contain stale mappings for deleted OpenAPI endpoints', () => {
    const staleMappings: string[] = [];

    for (const [path, methods] of Object.entries(CONFORMANCE_MAP)) {
      for (const method of Object.keys(methods)) {
        const declared = openApiSpec.paths[path];
        if (!declared || !(method in declared)) {
          staleMappings.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    assert.deepEqual(
      staleMappings,
      [],
      `CONFORMANCE_MAP entries no longer present in the OpenAPI spec:\n${staleMappings.join('\n')}`,
    );
  });

  it('should model every request and response schema the mapped operations use', () => {
    const missing: string[] = [];

    for (const [path, methods] of Object.entries(openApiSpec.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = methods[method] as Operation | undefined;
        if (!operation) continue;

        const key = `${method.toUpperCase()} ${path}`;
        if (NOT_CALLED_BY_SDK[key]) continue;

        for (const schema of referencedSchemas(operation)) {
          if (!MODELLED_SCHEMAS.has(schema)) {
            missing.push(`${key} → ${schema}`);
          }
        }
      }
    }

    assert.deepEqual(
      missing,
      [],
      'The gateway spec references schemas the SDK does not model. Add the SDK type in\n' +
        'src/types.ts, assert it against the generated spec in tests/types/conformance.types.ts,\n' +
        `and add it to MODELLED_SCHEMAS:\n${missing.join('\n')}`,
    );
  });

  it('should only skip endpoints that are listed as deliberately not called', () => {
    // Guards against the exception list outliving the reason for it: an entry
    // that names an operation the SDK now calls is dead weight, and an entry
    // that names an operation that no longer exists is a stale excuse.
    for (const key of Object.keys(NOT_CALLED_BY_SDK)) {
      const [method, path] = key.split(' ');
      const operation = openApiSpec.paths[path ?? '']?.[(method ?? '').toLowerCase()];
      assert.ok(operation, `${key} is listed in NOT_CALLED_BY_SDK but is not in the spec`);

      const mapped = CONFORMANCE_MAP[path ?? '']?.[(method ?? '').toLowerCase()];
      assert.ok(mapped, `${key} is skipped for schema coverage but is not in CONFORMANCE_MAP`);
    }
  });
});
