#!/usr/bin/env node
/**
 * Codegen drift gate for the generated gateway types.
 *
 * `src/generated/gateway.ts` is produced from the committed OpenAPI spec by
 * `npm run codegen`. This script regenerates it into a temporary file and
 * compares. A mismatch means the spec moved and the SDK's types did not — which
 * is exactly the failure `tests/spec-conformance.test.ts` cannot see on its own,
 * because that test reads the spec at runtime rather than the generated types.
 *
 * Mirrors the dashboard's `npm run codegen:check`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = resolve(root, '../nerve-docs/static/openapi/gateway.json');
const generatedPath = resolve(root, 'src/generated/gateway.ts');
const tmp = mkdtempSync(join(tmpdir(), 'nerve-sdk-codegen-'));

try {
  execFileSync(
    process.execPath,
    [
      resolve(root, 'node_modules/openapi-typescript/bin/cli.js'),
      specPath,
      '-o',
      join(tmp, 'gateway.ts'),
    ],
    { cwd: root, stdio: 'inherit' },
  );

  const fresh = readFileSync(join(tmp, 'gateway.ts'), 'utf-8');
  const committed = readFileSync(generatedPath, 'utf-8');

  if (fresh !== committed) {
    console.error('');
    console.error('  Generated gateway types are stale.');
    console.error('  The committed OpenAPI spec and src/generated/gateway.ts disagree.');
    console.error('  Run "npm run codegen" in nerve-sdk and commit the result.');
    console.error('');
    process.exit(1);
  }

  console.log('✓ src/generated/gateway.ts matches nerve-docs/static/openapi/gateway.json');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
