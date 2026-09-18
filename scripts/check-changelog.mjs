#!/usr/bin/env node
/**
 * Changelog & version-discipline gate (ticket 20, question 2).
 *
 * A maintained `CHANGELOG.md` is a release artifact, not a courtesy: it is how a
 * consumer learns that a field they depend on changed. This gate makes the
 * changelog a precondition of a version bump by asserting that the version in
 * `package.json` has a dated, non-empty entry written in the Keep-a-Changelog
 * shape, and that `src/version.ts` reports the same version the manifest ships.
 *
 * Exported and self-tested against mutations for the same reason as the
 * deprecation gate.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSemver } from './check-deprecations.mjs';

const CATEGORIES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

/**
 * @returns {string[]} one message per violation; empty means the gate passed.
 */
export function evaluateChangelog({ version, sdkVersion, changelog }) {
  const errors = [];

  if (!isSemver(version)) {
    errors.push(`package.json version is not valid SemVer: ${JSON.stringify(version)}`);
    return errors;
  }
  if (sdkVersion !== version) {
    errors.push(`src/version.ts SDK_VERSION (${sdkVersion}) does not match package.json (${version})`);
  }
  if (!/Keep a Changelog/i.test(changelog)) {
    errors.push('CHANGELOG.md does not state that it follows Keep a Changelog');
  }
  if (!/Semantic Versioning/i.test(changelog)) {
    errors.push('CHANGELOG.md does not state that it follows Semantic Versioning');
  }

  const headings = [...changelog.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?/gm)];
  if (!headings.some((match) => match[1] === 'Unreleased')) {
    errors.push('CHANGELOG.md has no "## [Unreleased]" section');
  }

  const dated = headings.filter((match) => match[1] === version);
  if (dated.length === 0) {
    errors.push(`CHANGELOG.md has no dated entry for the current version ${version}`);
  } else if (dated.length > 1) {
    errors.push(`CHANGELOG.md declares version ${version} more than once`);
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dated[0][2] ?? '')) {
    errors.push(`CHANGELOG.md entry for ${version} is missing a YYYY-MM-DD date`);
  }

  // The current version's section must actually describe the release.
  const marker = `## [${version}]`;
  const start = changelog.indexOf(marker);
  if (start !== -1) {
    const rest = changelog.slice(start + marker.length);
    const nextHeading = rest.search(/\n## \[/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    const hasCategory = CATEGORIES.some((category) =>
      new RegExp(`^### ${category}\\b`, 'm').test(section),
    );
    if (!hasCategory) {
      errors.push(
        `CHANGELOG.md entry for ${version} lists none of: ${CATEGORIES.join(', ')}`,
      );
    }
  }

  if (!new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]:`, 'm').test(changelog)) {
    errors.push(`CHANGELOG.md has no link reference for [${version}]:`);
  }

  return errors;
}

export function readInputs(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const versionSource = readFileSync(join(root, 'src/version.ts'), 'utf8');
  const sdkVersion = /export const SDK_VERSION = '([^']+)'/.exec(versionSource)?.[1];
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  return { version: pkg.version, sdkVersion, changelog };
}

const GOOD = `# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-17

### Added

- The first release.

[Unreleased]: https://example.com/compare/v0.1.0...HEAD
[0.1.0]: https://example.com/releases/tag/v0.1.0
`;

function selfTest() {
  const base = { version: '0.1.0', sdkVersion: '0.1.0', changelog: GOOD };
  const mutations = [
    ['missing current version entry', { ...base, changelog: GOOD.replace('## [0.1.0] - 2026-09-17', '## [0.0.9] - 2026-09-17') }],
    ['empty release section', { ...base, changelog: GOOD.replace('### Added\n\n- The first release.\n', '') }],
    ['missing date', { ...base, changelog: GOOD.replace('## [0.1.0] - 2026-09-17', '## [0.1.0]') }],
    ['version drift', { ...base, sdkVersion: '0.2.0' }],
    ['invalid semver', { ...base, version: 'v0.1.0' }],
  ];

  const failures = [];
  if (evaluateChangelog(base).length !== 0) failures.push('clean input should pass');
  for (const [name, input] of mutations) {
    if (evaluateChangelog(input).length === 0) failures.push(`mutation not caught: ${name}`);
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  const selfFailures = selfTest();
  if (selfFailures.length > 0) {
    console.error('✗ changelog checker self-test failed');
    for (const failure of selfFailures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  const errors = evaluateChangelog(readInputs(root));
  if (errors.length > 0) {
    console.error('✗ changelog / version discipline violated');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('✓ CHANGELOG.md describes the shipped version and matches SDK_VERSION');
}
