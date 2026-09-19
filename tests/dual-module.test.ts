/**
 * Dual-module loader resolution.
 *
 * `tests/api-stability.test.ts` reads the manifest and `npm run check:exports`
 * packs the tarball end to end; this suite is the middle rung — it asks Node's
 * own resolver which build each module system selects, then loads *that* file
 * through the matching loader and proves both survive the boundary with the
 * same export surface.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonResponse, withFetch } from './helpers/http.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const require = createRequire(import.meta.url);

type SdkModule = typeof import('../src/index.js');

const ESM_ENTRY = import.meta.resolve('@nervly/sdk');
const CJS_ENTRY = require.resolve('@nervly/sdk');

function loadEsm(): Promise<SdkModule> {
  return import(ESM_ENTRY) as Promise<SdkModule>;
}

function loadCjs(): SdkModule {
  return require(CJS_ENTRY) as SdkModule;
}

describe('dual ESM/CJS loader resolution', () => {
  it('sends `import` to the ESM build and `require` to the CJS build', () => {
    assert.equal(ESM_ENTRY, new URL('../dist/esm/index.js', import.meta.url).href);
    assert.equal(CJS_ENTRY, resolve(ROOT, 'dist/cjs/index.js'));
  });

  it('installs a runnable class in both builds', async () => {
    const esm = await loadEsm();
    const cjs = loadCjs();

    for (const [label, mod] of [
      ['esm', esm],
      ['cjs', cjs],
    ] as const) {
      assert.equal(typeof mod.default, 'function', `${label} default export`);
      assert.equal(typeof mod.Nervly, 'function', `${label} named export`);
      assert.equal(mod.default, mod.Nervly, `${label} default is the Nervly class`);
      assert.equal(mod.Nervly.name, 'Nervly');
    }
  });

  it('keeps both builds as independent module instances', async () => {
    const esm = await loadEsm();
    const cjs = loadCjs();

    // Different builds are different class objects...
    assert.notEqual(esm.Nervly, cjs.Nervly);
    assert.notEqual(esm.NervlyAuthenticationError, cjs.NervlyAuthenticationError);
    // ...but each build keeps the alias identity its own consumers rely on.
    assert.equal(esm.AuthenticationError, esm.NervlyAuthenticationError);
    assert.equal(cjs.AuthenticationError, cjs.NervlyAuthenticationError);
    assert.equal(esm.SDK_VERSION, cjs.SDK_VERSION);
  });

  it('exposes the same runtime export surface from both builds', async () => {
    const esm = await loadEsm();
    const cjs = loadCjs();

    assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
    assert.ok(Object.keys(esm).includes('Nervly'));
    assert.ok(Object.keys(esm).includes('SDK_VERSION'));
    assert.ok(Object.keys(esm).includes('RetryExhaustedError'));
  });

  it('drives a real request from each build', async () => {
    const esm = await loadEsm();
    const cjs = loadCjs();

    await withFetch(
      () => jsonResponse(200, { messages: [], next_cursor: null }),
      async (requests) => {
        await new esm.Nervly({ apiKey: 'k', baseUrl: 'https://dual.test' }).messages.list();
        await new cjs.Nervly({ apiKey: 'k', baseUrl: 'https://dual.test' }).messages.list();

        assert.equal(requests.length, 2);
        assert.equal(requests[0]!.headers.get('authorization'), 'Bearer k');
        assert.equal(requests[1]!.headers.get('authorization'), 'Bearer k');
      },
    );
  });
});
