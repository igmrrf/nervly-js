# nerve-sdk Publishing & Release Standards

Guidelines for versioning and publishing `@nervehq/sdk` to npm.

Ticket 11 owns the packaging guarantees (dual build, exports map, no runtime
dependencies). The release-provenance items — `--provenance`, SBOM, dependency
audit, `SECURITY.md` — belong to ticket 20.

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

1. Verify the contract and the build in one pass:
   ```bash
   npm install
   npm run check          # codegen drift + type-level spec conformance
   npm test               # unit + contract tests (rebuilds dist via pretest)
   npm run build
   npm run check:exports  # packed tarball loads and type-checks as ESM and CJS
   ```
2. Update `version` in `package.json` and `SDK_VERSION` in `src/version.ts` to
   match. `tests/api-stability.test.ts` asserts the two agree, so a forgotten
   bump fails the suite rather than shipping a `User-Agent` that lies.
3. Document the change in `CHANGELOG.md` (see the checklist; the file is added
   when the first release is cut).
4. Publish with provenance:
   ```bash
   npm publish --access public --provenance
   ```

## 4. Why the Packaging Check Installs the Tarball

`npm run check:exports` does not import `./dist/…` directly. It runs `npm pack`,
installs the result into a scratch directory, and resolves `@nervehq/sdk` from
there. Path-relative imports would pass while the published package was broken —
a missing `files` entry, a stray `.npmignore`, or an `exports` condition that
points at a directory the tarball does not contain. Installing the tarball is the
only version of the check that sees what a consumer sees.
