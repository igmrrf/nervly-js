#!/usr/bin/env node
/**
 * Release-security gate (ticket 20, questions 1, 3, 4).
 *
 * The release claims — provenance, a runtime dependency audit, an SBOM, and a
 * published disclosure policy — are only real if the pipeline that ships the
 * package enforces them. This gate reads the manifest, the tagged release
 * workflow, `SECURITY.md`, and the compatibility matrix and fails when any of
 * those claims is absent or drifts.
 *
 * It cannot publish to npm; what it proves is that the one path that *does*
 * publish is configured to sign with provenance, audit, and inventory the
 * artifact. Exported and self-tested against mutations.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function cells(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function parseMatrix(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const parts = cells(line);
    if (!/^`?\d+\.\d+\.\d+[^`]*`?$/.test(parts[0])) continue;
    rows.push({
      sdk: parts[0].replaceAll('`', ''),
      api: (parts[1] ?? '').replaceAll('`', ''),
      status: parts[2] ?? '',
    });
  }
  return rows;
}

/**
 * @returns {string[]} one message per violation; empty means the gate passed.
 */
export function evaluateRelease({ pkg, workflow, security, matrix, specVersion }) {
  const errors = [];

  // ── Manifest ──────────────────────────────────────────────────────────────
  const publish = pkg.publishConfig ?? {};
  if (publish.access !== 'public') {
    errors.push('package.json publishConfig.access must be "public"');
  }
  if (publish.provenance !== true) {
    errors.push('package.json publishConfig.provenance must be true');
  }
  if (typeof publish.registry !== 'string' || !publish.registry.includes('registry.npmjs.org')) {
    errors.push('package.json publishConfig.registry must be the public npm registry');
  }

  const files = pkg.files ?? [];
  for (const required of ['dist/esm', 'dist/cjs', 'README.md', 'SECURITY.md', 'CHANGELOG.md']) {
    if (!files.includes(required)) {
      errors.push(`package.json files[] must ship ${required}`);
    }
  }

  if (!pkg.scripts?.audit) errors.push('package.json must define an "audit" script');
  if (!pkg.scripts?.sbom) errors.push('package.json must define an "sbom" script');

  // ── Release workflow ──────────────────────────────────────────────────────
  const workflowChecks = [
    [/tags:\s*\n\s*-\s*'?v\*'?/, 'release workflow must trigger on v* tags'],
    [/id-token:\s*write/, 'release workflow needs "id-token: write" for provenance'],
    [/contents:\s*write/, 'release workflow needs "contents: write" to attach the SBOM'],
    [/npm publish[^\n]*--provenance/, 'release workflow must run `npm publish --provenance`'],
    [/npm run verify/, 'release workflow must run the full verify gate before publishing'],
    [/npm run audit/, 'release workflow must run the dependency audit'],
    [/npm run sbom/, 'release workflow must generate the SBOM'],
    [/NODE_AUTH_TOKEN/, 'release workflow must authenticate with NODE_AUTH_TOKEN'],
    [/secrets\.NPM_TOKEN/, 'release workflow must source NODE_AUTH_TOKEN from secrets.NPM_TOKEN'],
  ];
  for (const [pattern, message] of workflowChecks) {
    if (!pattern.test(workflow)) errors.push(`release workflow: ${message}`);
  }

  // ── Disclosure policy ─────────────────────────────────────────────────────
  const securityChecks = [
    [/security@nervly\.io/, 'SECURITY.md must name a reporting contact'],
    [/Reporting a vulnerability/i, 'SECURITY.md must describe how to report'],
    [/Disclosure/i, 'SECURITY.md must describe the disclosure process'],
    [/Supported versions/i, 'SECURITY.md must list supported versions'],
  ];
  for (const [pattern, message] of securityChecks) {
    if (!pattern.test(security)) errors.push(message);
  }

  // ── Compatibility matrix ──────────────────────────────────────────────────
  const rows = parseMatrix(matrix);
  const row = rows.find((candidate) => candidate.sdk === pkg.version);
  if (!row) {
    errors.push(`version-compatibility matrix has no row for ${pkg.version}`);
  } else {
    if (row.api !== specVersion) {
      errors.push(
        `version-compatibility matrix maps SDK ${pkg.version} to API ${row.api}, ` +
          `but the committed spec is ${specVersion}`,
      );
    }
    if (!/support/i.test(row.status)) {
      errors.push(`version-compatibility matrix row for ${pkg.version} must be marked Supported`);
    }
  }

  return errors;
}

export function readInputs(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const security = readFileSync(join(root, 'SECURITY.md'), 'utf8');
  const matrix = readFileSync(join(root, 'docs/version-compatibility.md'), 'utf8');
  const spec = JSON.parse(
    readFileSync(join(root, '../nerve-docs/static/openapi/gateway.json'), 'utf8'),
  );
  return { pkg, workflow, security, matrix, specVersion: spec.info.version };
}

const GOOD = {
  pkg: {
    version: '0.1.0',
    publishConfig: { access: 'public', provenance: true, registry: 'https://registry.npmjs.org/' },
    files: ['dist/esm', 'dist/cjs', 'README.md', 'SECURITY.md', 'CHANGELOG.md'],
    scripts: { audit: 'npm audit', sbom: 'node scripts/sbom.mjs' },
  },
  workflow:
    "on:\n  push:\n    tags:\n      - 'v*'\npermissions:\n  contents: write\n  id-token: write\n" +
    'run: npm run verify\nrun: npm run audit\nrun: npm run sbom\n' +
    'run: npm publish --provenance --access public\nNODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n',
  security:
    '# Security Policy\n\n## Reporting a vulnerability\n\nEmail security@nervly.io\n\n' +
    '## Disclosure\n\ncoordinated\n\n## Supported versions\n\nlatest 0.x\n',
  matrix: '| `0.1.0` | `0.1.0` | Supported | Current |\n',
  specVersion: '0.1.0',
};

function selfTest() {
  const mutations = [
    ['provenance removed', { pkg: { ...GOOD.pkg, publishConfig: { ...GOOD.pkg.publishConfig, provenance: false } } }],
    ['security not shipped', { pkg: { ...GOOD.pkg, files: ['dist/esm', 'dist/cjs'] } }],
    ['workflow lost the provenance flag', { workflow: GOOD.workflow.replace(' --provenance', '') }],
    ['workflow lost id-token', { workflow: GOOD.workflow.replace('  id-token: write\n', '') }],
    ['matrix API version drift', { specVersion: '0.2.0' }],
    ['disclosure policy missing', { security: '# Security Policy\n' }],
  ];

  const failures = [];
  if (evaluateRelease(GOOD).length !== 0) failures.push('clean input should pass');
  for (const [name, patch] of mutations) {
    if (evaluateRelease({ ...GOOD, ...patch }).length === 0) {
      failures.push(`mutation not caught: ${name}`);
    }
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  const selfFailures = selfTest();
  if (selfFailures.length > 0) {
    console.error('✗ release gate self-test failed');
    for (const failure of selfFailures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  const errors = evaluateRelease(readInputs(root));
  if (errors.length > 0) {
    console.error('✗ release security claims are not enforced');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('✓ provenance, audit, SBOM, disclosure policy, and matrix are wired');
}
