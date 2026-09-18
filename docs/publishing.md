# nerve-sdk Publishing & Release Standards

Guidelines for versioning and publishing `@nervehq/sdk` to npm.

Ticket 11 owns the packaging guarantees (dual build, exports map, no runtime
dependencies). Ticket 20 owns the release path: `--provenance`, the runtime
dependency audit, the SBOM, the `SECURITY.md` disclosure policy, and the
SemVer/deprecation gates below.

---

## 1. SemVer Discipline

- **Patch (0.1.X):** Bug fixes, documentation updates, dependency bumps.
- **Minor (0.X.0):** Non-breaking additions (new methods, optional request properties).
- **Major (X.0.0):** Breaking contract changes (renamed fields, removed parameters).

The minor-versus-major boundary is mechanically checkable for the *wire* types:
`src/types.ts` is asserted equal to the generated spec by `npm run check:types`,
so a field rename in the spec cannot reach a release without the SDK types being
changed deliberately. Because the SDK is `0.x`, a breaking change may still land
in a minor — the `README` says so explicitly.

The version, the changelog, and the compatibility matrix are held together by
three gates, all of which run in `npm run check` and therefore in CI and in the
tagged release workflow:

| Gate | Command | Proves |
| --- | --- | --- |
| Changelog | `npm run check:changelog` | `package.json`, `src/version.ts`, and a dated, non-empty Keep-a-Changelog entry all agree |
| Deprecations | `npm run check:deprecations` | every `@deprecated` symbol is registered in `deprecations.json`, carries the predicted annotation, and is removed before its `removeIn` window closes |
| Release | `npm run check:release` | provenance, audit, SBOM, `SECURITY.md`, and the [compatibility matrix](version-compatibility.md) are all wired |

The deprecation policy is a one-minor warning. A release that reaches a
deprecated symbol's `removeIn` version without deleting the symbol fails
`check:deprecations` — the promise is enforced, not documented.

## 2. What Ships

`files` limits the tarball to `dist/esm`, `dist/cjs`, and `README.md`. The
`exports` map is the only supported entry point:

| Condition | JavaScript | Declarations |
| --- | --- | --- |
| `import` | `dist/esm/index.js` | `dist/esm/index.d.ts` |
| `require` | `dist/cjs/index.js` | `dist/cjs/index.d.ts` |

`main`, `module`, and `types` remain for resolvers that predate `exports` (Jest
without `node16` resolution, Metro, older bundlers). `./package.json` is exported
so tooling can read the version.

There are no runtime dependencies. If one is ever added, the packaging test that
asserts `dependencies === {}` must be changed in the same commit, so the decision
is visible in review rather than implicit in a lockfile.

## 3. Release Steps

Publishing is automated by
[`.github/workflows/release.yml`](../.github/workflows/release.yml), triggered by
a `v*` tag. The steps below are what that workflow runs, and what you reproduce
locally before tagging.

1. Verify the contract and the build in one pass:
   ```bash
   npm install
   npm run check          # codegen, types, changelog, deprecations, release, tsc
   npm test               # unit + contract tests (rebuilds dist via pretest)
   npm run build
   npm run check:exports  # packed tarball loads and type-checks as ESM and CJS
   ```
2. Update `version` in `package.json` and `SDK_VERSION` in `src/version.ts` to
   match. `tests/api-stability.test.ts` asserts the two agree, and
   `check:changelog` fails when the new version has no dated entry, so a
   forgotten bump fails the suite rather than shipping a `User-Agent` that lies.
3. Document the change in `CHANGELOG.md` and add a row to
   [`version-compatibility.md`](version-compatibility.md) for the API version the
   release targets.
4. Audit the runtime dependency tree and inventory the build:
   ```bash
   npm run audit          # fails on high/critical advisories (runtime)
   npm run sbom            # writes .security-reports/sbom/nerve-sdk.cdx.json
   ```
5. Tag and push. The workflow re-runs the gates, checks that the tag equals
   `v<package.json version>`, then:
   ```bash
   npm publish --provenance --access public
   ```
   Provenance is signed by the workflow's OIDC identity (`id-token: write`), so
   the tarball is cryptographically linked to the commit that built it. The SBOM
   is attached to the GitHub release.

### Why `--provenance` is passed twice

It is declared in `publishConfig` in `package.json` *and* passed on the command
line. Removing it from the manifest alone does not silently downgrade a release:
`npm run check:release` fails, and the workflow log still shows the flag.

## 4. Why the Packaging Check Installs the Tarball

`npm run check:exports` does not import `./dist/…` directly. It runs `npm pack`,
installs the result into a scratch directory, and resolves `@nervehq/sdk` from
there. Path-relative imports would pass while the published package was broken —
a missing `files` entry, a stray `.npmignore`, or an `exports` condition that
points at a directory the tarball does not contain. Installing the tarball is the
only version of the check that sees what a consumer sees.
