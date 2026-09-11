import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Nerve } from '../src/index.js';

type SdkMethodAccessor = (client: Nerve) => unknown;

/**
 * Explicit mapping between OpenAPI paths/methods and SDK client methods.
 * Every path in docs/static/openapi/gateway.json must have an entry here.
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

describe('SDK OpenAPI Spec Conformance', () => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const openApiPath = resolve(currentDir, '../../nerve-docs/static/openapi/gateway.json');
  const specContent = readFileSync(openApiPath, 'utf-8');
  const openApiSpec = JSON.parse(specContent) as {
    paths: Record<string, Record<string, unknown>>;
  };

  const nerve = new Nerve({ apiKey: 'nv_live_conformance_test' });

  it('should cover every path and method documented in gateway.json', () => {
    const paths = openApiSpec.paths || {};
    const missingEndpoints: string[] = [];

    for (const [path, methods] of Object.entries(paths)) {
      for (const method of Object.keys(methods)) {
        const normalizedMethod = method.toLowerCase();
        // Ignore OpenAPI metadata properties if any
        if (['parameters', 'summary', 'description'].includes(normalizedMethod)) {
          continue;
        }

        const pathMapping = CONFORMANCE_MAP[path];
        if (!pathMapping) {
          missingEndpoints.push(`${normalizedMethod.toUpperCase()} ${path} (unmapped path)`);
          continue;
        }

        const accessor = pathMapping[normalizedMethod];
        if (!accessor) {
          missingEndpoints.push(`${normalizedMethod.toUpperCase()} ${path} (unmapped method)`);
          continue;
        }

        const sdkMethod = accessor(nerve);
        assert.equal(
          typeof sdkMethod,
          'function',
          `SDK method for ${normalizedMethod.toUpperCase()} ${path} is not a function`,
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
    const openApiPaths = openApiSpec.paths || {};

    for (const [path, methods] of Object.entries(CONFORMANCE_MAP)) {
      if (!openApiPaths[path]) {
        staleMappings.push(path);
        continue;
      }
      for (const method of Object.keys(methods)) {
        if (!openApiPaths[path][method]) {
          staleMappings.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    assert.deepEqual(
      staleMappings,
      [],
      `The following mappings in CONFORMANCE_MAP no longer exist in gateway.json:\n${staleMappings.join('\n')}`,
    );
  });
});
