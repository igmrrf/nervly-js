#!/usr/bin/env node
/**
 * Deprecation-discipline gate (ticket 20, question 2).
 *
 * The SDK promises a one-minor warning before a symbol is removed. A promise
 * written only in a document is a promise nobody enforces, so the policy lives
 * in `deprecations.json` and this gate ties it to three things:
 *
 *   1. Every registered symbol carries the exact `@deprecated` annotation the
 *      registry predicts, in the file that declares its class.
 *   2. No source file carries an `@deprecated` annotation that is not
 *      registered — an undocumented deprecation fails the build.
 *   3. A symbol whose `removeIn` version has been reached is still exported:
 *      the window closed and the removal did not happen.
 *
 * The evaluator is exported and self-tested against mutations so a regression
 * in the checker fails the build instead of reporting a vacuous pass.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Compare two SemVer strings. A pre-release sorts below its release. */
export function compareSemver(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`not semver: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  const preA = pa[4];
  const preB = pb[4];
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

export function isSemver(value) {
  return typeof value === 'string' && SEMVER.test(value);
}

/** The annotation the registry predicts, character for character. */
export function expectedAnnotation(entry) {
  return `@deprecated since ${entry.since}: use \`${entry.replacement}\`; removal in ${entry.removeIn}.`;
}

/**
 * @returns {string[]} one message per violation; empty means the gate passed.
 */
export function evaluateDeprecations({ version, entries, sources }) {
  const errors = [];

  if (!isSemver(version)) {
    errors.push(`package version is not valid SemVer: ${JSON.stringify(version)}`);
    return errors;
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push('deprecations.json registers no symbols — either add one or delete the registry');
    return errors;
  }

  const registered = new Set();

  entries.forEach((entry, index) => {
    const label = entry.symbol ?? `entry #${index}`;

    if (typeof entry.symbol !== 'string' || !entry.symbol.includes('.')) {
      errors.push(`${label}: symbol must be "ClassName.method"`);
      return;
    }
    if (!isSemver(entry.since) || !isSemver(entry.removeIn)) {
      errors.push(`${label}: since and removeIn must be valid SemVer`);
      return;
    }
    if (compareSemver(entry.removeIn, entry.since) <= 0) {
      errors.push(`${label}: removeIn (${entry.removeIn}) must be after since (${entry.since})`);
      return;
    }

    const annotation = expectedAnnotation(entry);
    registered.add(annotation);

    if (compareSemver(version, entry.removeIn) >= 0) {
      errors.push(
        `${label}: removal window closed at ${entry.removeIn} (current ${version}); ` +
          'delete the symbol and its registry entry',
      );
      return;
    }

    const [className, method] = entry.symbol.split('.');
    const owner = sources.filter((file) => file.text.includes(`class ${className}`));
    if (owner.length === 0) {
      errors.push(`${label}: no source file declares "class ${className}"`);
      return;
    }
    const annotated = owner.some((file) => file.text.includes(annotation));
    if (!annotated) {
      errors.push(
        `${label}: expected annotation not found in ${owner.map((f) => f.path).join(', ')}:\n` +
          `      ${annotation}`,
      );
      return;
    }
    if (!owner.some((file) => file.text.includes(method))) {
      errors.push(`${label}: "class ${className}" has no member named ${method}`);
    }
  });

  for (const file of sources) {
    const lines = file.text.split('\n');
    lines.forEach((line, index) => {
      const match = /@deprecated\b.*/.exec(line);
      if (!match) return;
      const annotation = match[0].trim();
      if (!registered.has(annotation)) {
        errors.push(
          `${file.path}:${index + 1}: undocumented deprecation — add it to deprecations.json:\n` +
            `      ${annotation}`,
        );
      }
    });
  }

  return errors;
}

function collectSources(root) {
  const src = join(root, 'src');
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push({ path: relative(root, full), text: readFileSync(full, 'utf8') });
      }
    }
  };
  if (statSync(src).isDirectory()) walk(src);
  return out;
}

export function readInputs(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const registry = JSON.parse(readFileSync(join(root, 'deprecations.json'), 'utf8'));
  return { version: pkg.version, entries: registry.symbols, sources: collectSources(root) };
}

function selfTest() {
  const base = {
    version: '0.1.0',
    entries: [
      {
        symbol: 'EventsResource.triggerEmail',
        since: '0.1.0',
        removeIn: '0.2.0',
        replacement: 'EmailResource.send',
      },
    ],
    sources: [
      {
        path: 'src/resources/events.ts',
        text:
          'export class EventsResource {\n' +
          '  /**\n' +
          '   * @deprecated since 0.1.0: use `EmailResource.send`; removal in 0.2.0.\n' +
          '   */\n' +
          '  async triggerEmail() {}\n' +
          '}\n',
      },
    ],
  };

  const mutations = [
    ['unregistered annotation', { ...base, sources: [{ ...base.sources[0], text: `${base.sources[0].text}\n/** @deprecated whenever */` }] }],
    ['annotation drift', { ...base, entries: [{ ...base.entries[0], replacement: 'EmailResource.sendNow' }] }],
    ['removal window closed', { ...base, version: '0.2.0' }],
    ['invalid semver', { ...base, version: '0.1' }],
    ['removeIn before since', { ...base, entries: [{ ...base.entries[0], removeIn: '0.0.9' }] }],
  ];

  const failures = [];
  if (evaluateDeprecations(base).length !== 0) {
    failures.push('clean input should pass');
  }
  for (const [name, input] of mutations) {
    if (evaluateDeprecations(input).length === 0) {
      failures.push(`mutation not caught: ${name}`);
    }
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  const selfFailures = selfTest();
  if (selfFailures.length > 0) {
    console.error('✗ deprecation checker self-test failed');
    for (const failure of selfFailures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  const errors = evaluateDeprecations(readInputs(root));
  if (errors.length > 0) {
    console.error('✗ deprecation policy violated');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('✓ deprecation registry, source annotations, and removal windows are consistent');
}
