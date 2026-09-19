#!/usr/bin/env node
/**
 * Generates the release SBOM for `@nervly/sdk` (ticket 20, question 3).
 *
 * `npm sbom` reads the locked dependency tree and emits CycloneDX, the format
 * npm's own tooling produces. The file lands in `.security-reports/sbom/`,
 * which is gitignored (it carries a build timestamp), and the tagged release
 * workflow attaches it to the GitHub release.
 *
 * The script fails if the inventory does not describe this package at the
 * version in `package.json`, so a stale or mismatched SBOM cannot ship with a
 * release that claims to have one.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const outDir = join(root, '.security-reports', 'sbom');
const outFile = join(outDir, 'nervly-js.cdx.json');
mkdirSync(outDir, { recursive: true });

const raw = execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--sbom-type', 'library'], {
  cwd: root,
  encoding: 'utf8',
});
writeFileSync(outFile, raw);

const bom = JSON.parse(raw);
if (bom.bomFormat !== 'CycloneDX') {
  console.error(`✗ expected a CycloneDX document, got ${bom.bomFormat}`);
  process.exit(1);
}
const component = bom.metadata?.component ?? {};
if (component.version !== pkg.version) {
  console.error(
    `✗ SBOM describes version ${component.version}, package.json is ${pkg.version}`,
  );
  process.exit(1);
}

const dependencyCount = (bom.components ?? []).length;
const runtimeDependencies = Object.keys(pkg.dependencies ?? {}).length;
console.log(
  `✓ wrote .security-reports/sbom/nervly-js.cdx.json — ` +
    `${dependencyCount} component(s), ${runtimeDependencies} runtime dependency(ies)`,
);
