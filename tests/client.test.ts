import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Nerve } from '../src/index.js';

describe('Nerve Client', () => {
  it('should throw if no API key is provided', () => {
    assert.throws(() => new Nerve({ apiKey: '' }), /API key/);
  });

  it('should create client with valid config and default to https://api.nervehq.io', () => {
    const nerve = new Nerve({ apiKey: 'test_key_123' });
    assert.ok(nerve);
    assert.ok(nerve.events);
    assert.ok(nerve.messages);
    assert.ok(nerve.subscribers);
    assert.ok(nerve.users);
    assert.ok(nerve.health);
    assert.ok(nerve.mcp);
    assert.ok(nerve.webhooks);
  });

  it('should expose all resource properties', () => {
    const nerve = new Nerve({ apiKey: 'test_key' });
    assert.equal(typeof nerve.events.trigger, 'function');
    assert.equal(typeof nerve.events.bulkTrigger, 'function');
    assert.equal(typeof nerve.events.get, 'function');
    assert.equal(typeof nerve.messages.list, 'function');
    assert.equal(typeof nerve.subscribers.delete, 'function');
    assert.equal(typeof nerve.subscribers.updatePreferences, 'function');
    assert.equal(typeof nerve.users.updatePreferences, 'function');
    assert.equal(typeof nerve.health.check, 'function');
    assert.equal(typeof nerve.mcp.listTools, 'function');
    assert.equal(typeof nerve.mcp.callTool, 'function');
    assert.equal(typeof nerve.webhooks.verifySignature, 'function');
    assert.equal(typeof nerve.webhooks.parse, 'function');
  });
});
