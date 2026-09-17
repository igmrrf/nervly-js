import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Nerve } from '../src/index.js';

describe('Event Trigger Schema OpenAPI Contract Test', () => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const openApiPath = resolve(currentDir, '../../nerve-docs/static/openapi/gateway.json');
  const specContent = readFileSync(openApiPath, 'utf-8');
  const openApiSpec = JSON.parse(specContent) as {
    components: {
      schemas: Record<string, {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      }>;
    };
  };

  const schemas = openApiSpec.components.schemas;

  it('OpenAPI schema must declare EmailOverrideDto with sender and provider', () => {
    const emailOverride = schemas['EmailOverrideDto'];
    assert.ok(emailOverride, 'EmailOverrideDto schema must be present in OpenAPI spec');
    assert.ok(emailOverride.properties, 'EmailOverrideDto must have properties');

    const expectedProperties = ['sender', 'provider', 'customHeaders'];
    for (const prop of expectedProperties) {
      assert.ok(
        prop in emailOverride.properties,
        `EmailOverrideDto in OpenAPI spec missing expected property: ${prop}`,
      );
    }
  });

  it('OpenAPI schema must declare ProviderOverridesDto with email, whatsapp, sms, and extraParams', () => {
    const providerOverrides = schemas['ProviderOverridesDto'];
    assert.ok(providerOverrides, 'ProviderOverridesDto schema must be present in OpenAPI spec');
    assert.ok(providerOverrides.properties, 'ProviderOverridesDto must have properties');

    const expectedProperties = ['email', 'whatsapp', 'sms', 'extraParams'];
    for (const prop of expectedProperties) {
      assert.ok(
        prop in providerOverrides.properties,
        `ProviderOverridesDto in OpenAPI spec missing expected property: ${prop}`,
      );
    }
  });

  it('OpenAPI schema must declare TriggerRequest with name, to, payload, overrides, and category', () => {
    const triggerRequest = schemas['TriggerRequest'];
    assert.ok(triggerRequest, 'TriggerRequest schema must be present in OpenAPI spec');
    assert.ok(triggerRequest.properties, 'TriggerRequest must have properties');

    const expectedProperties = ['name', 'to', 'payload', 'overrides', 'category'];
    for (const prop of expectedProperties) {
      assert.ok(
        prop in triggerRequest.properties,
        `TriggerRequest in OpenAPI spec missing expected property: ${prop}`,
      );
    }
  });

  it('built SDK email payload strictly conforms to OpenAPI TriggerRequest schema', () => {
    const nerve = new Nerve({ apiKey: 'nv_live_contract_test' });
    const payload = nerve.email.buildTriggerRequest({
      to: { subscriberId: 'sub_test_1', email: 'test@nervehq.io' },
      subject: 'Contract Test',
      html: '<p>Contract test html</p>',
      provider: 'resend',
      sender: 'Nerve <test@nervehq.io>',
      category: 'notifications',
    });

    const triggerProperties = Object.keys(schemas['TriggerRequest']?.properties || {});
    for (const key of Object.keys(payload)) {
      assert.ok(
        triggerProperties.includes(key),
        `Generated payload property '${key}' does not exist in OpenAPI TriggerRequest schema`,
      );
    }

    const emailOverrideProperties = Object.keys(schemas['EmailOverrideDto']?.properties || {});
    if (payload.overrides?.email) {
      for (const key of Object.keys(payload.overrides.email)) {
        assert.ok(
          emailOverrideProperties.includes(key),
          `Generated email override property '${key}' does not exist in OpenAPI EmailOverrideDto schema`,
        );
      }
    }
  });
});
