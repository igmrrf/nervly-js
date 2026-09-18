/**
 * Secret gate for the published package.
 *
 * `npm publish` ships exactly the files `npm pack` reports. A credential that
 * reaches that tarball is public and permanent, so this test enumerates the
 * packed file list and scans every one of them for high-signal credential
 * shapes before a release can go out.
 *
 * The mutation/self-test at the bottom runs the same `findSecrets` used for the
 * real scan, so a scanner regression fails the build instead of reporting a
 * vacuous "clean".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findSecrets } from './helpers/secret-scanner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function expand(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) return expand(p);
    return [relative(ROOT, p)];
  });
}

/**
 * The authoritative published set, taken from `npm pack` itself. Falls back to
 * the `files` field only if npm is unavailable, so the test degrades instead of
 * silently scanning nothing.
 */
function publishedFiles(): string[] {
  try {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out.slice(out.indexOf('['))) as Array<{
      files: Array<{ path: string }>;
    }>;
    return parsed[0].files.map((file) => file.path);
  } catch {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    return (pkg.files ?? []).flatMap((entry) => expand(join(ROOT, entry)));
  }
}

const FILES = publishedFiles();

describe('published package contains no credentials', () => {
  it('found the built package to scan', () => {
    assert.ok(FILES.length > 0, 'package publishes at least one file');
    assert.ok(
      FILES.some((file) => file.startsWith('dist/')),
      'packed set includes build output, so the scan is not vacuous',
    );
  });

  for (const file of FILES) {
    it(file, () => {
      const abs = join(ROOT, file);
      if (!statSync(abs).isFile()) return;
      const text = readFileSync(abs, 'utf8');
      const found = findSecrets(text);
      assert.deepEqual(
        found,
        [],
        `${file} contains ${found.map((finding) => finding.name).join(', ')}`,
      );
    });
  }
});

describe('secret scanner self-test', () => {
  it('flags a synthetic AWS access key id', () => {
    const found = findSecrets('const id = "AKIAIOSFODNN7EXAMPLE";');
    assert.ok(found.some((finding) => finding.name === 'AWS access key id'));
  });

  it('flags a synthetic DSN with an inline password', () => {
    const found = findSecrets('DATABASE_URL=postgres://admin:hunter2@db.internal:5432/prod');
    assert.ok(found.some((finding) => finding.name === 'DSN with inline password'));
  });

  it('flags synthetic GitHub, Stripe, Slack and Bearer tokens', () => {
    const names = findSecrets(
      [
        'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
        'github_pat_0123456789abcdefghijklmnopqrstuvwxyz',
        'sk_live_0123456789abcdefghij',
        'xoxb-0123456789-abcdefghijklmnop',
        'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      ].join('\n'),
    ).map((finding) => finding.name);

    for (const name of [
      'GitHub token',
      'GitHub fine-grained PAT',
      'Stripe live secret key',
      'Slack token',
      'Bearer token literal',
    ]) {
      assert.ok(names.includes(name), `expected scanner to flag ${name}`);
    }
  });

  it('does not flag ordinary source text', () => {
    assert.deepEqual(findSecrets('const greeting = "hello world";'), []);
  });
});
