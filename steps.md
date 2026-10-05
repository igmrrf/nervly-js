# Deployment Steps — `@nervly/sdk`

How to prepare, publish, and verify a release. Publishing is automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml): **a `v*` tag
is the only trigger**, and the workflow re-runs the full contract before the
tarball leaves the building. The rationale behind each gate lives in
[`docs/publishing.md`](docs/publishing.md); this file is the operational
runbook.

> Current status: `v0.1.0` was released on 2026-10-05 from
> [`e5f06c9`](https://github.com/igmrrf/nervly-js/commit/e5f06c9789cbf04dab50b891de2cd413d04715e5)
> with provenance and the SBOM attached.

---

## 0. One-time prerequisites

1. **Node.js >= 24** locally (`.nvmrc` pins 26.10.0; CI tests 24 and 26).
2. **The GitHub repository must be public.** `npm publish --provenance`
   hard-requires a public `repository` that matches `package.json`
   (`git+https://github.com/igmrrf/nervly-js.git`) case-sensitively.
   Via CLI:
   ```bash
   gh repo edit igmrrf/nervly-js --visibility public --accept-visibility-change-consequences
   ```
   (or Settings → General → Danger Zone). Do this once, before the first tag.
3. **Repository secrets** (Settings → Secrets and variables → Actions):
   - `NPM_TOKEN` — an npm granular/automation token with publish rights and
     2FA bypass. Used as `NODE_AUTH_TOKEN` by the publish step.
   - `CROSS_REPO_TOKEN` — a GitHub token that can read `nervly-docs`; both the
     CI and release workflows clone `nervly-docs` as the OpenAPI spec fixture
     (`check:codegen` / `check:release` hard-read
     `../nervly-docs/static/openapi/gateway.json`).
4. **Local sibling checkout** for the same gates:
   ```bash
   git clone --depth 1 git@github.com:igmrrf/nervly-docs.git ../nervly-docs
   ```
5. Confirm `npm whoami` and that your npm account can publish under the
   `@nervly` scope.

---

## 1. Prepare the release commit

1. Start from a clean, up-to-date `main`; CI (PR or a manual
   `workflow_dispatch` run) must be green.
2. Bump the version in **both** places (tests assert they agree, and the
   `User-Agent` reports `SDK_VERSION`):
   - `package.json` → `"version"`
   - `src/version.ts` → `SDK_VERSION`
3. Add a dated, non-empty entry to `CHANGELOG.md` under the new version
   (Keep-a-Changelog format; `check:changelog` enforces it). Fix the
   `[<version>]` compare link if needed.
4. Add a row to `docs/version-compatibility.md` mapping the SDK version to the
   committed gateway API version (`info.version` of
   `nervly-docs/static/openapi/gateway.json`); `check:release` fails if the row
   is missing or names a different API version.
5. If a symbol's `removeIn` version has been reached, remove it and its
   `deprecations.json` entry now; `check:deprecations` fails otherwise.
6. Verify `package.json` invariants are intact: `publishConfig` still declares
   `access: public` + `provenance: true` + the public registry, `files[]` still
   ships `dist/esm`, `dist/cjs`, `src`, `LICENSE`, `README.md`, `SECURITY.md`,
   `CHANGELOG.md`, and `repository.url` matches the GitHub repo.

## 2. Verify locally (same gates the release runs)

```bash
npm ci
npm run verify     # check (codegen/types/readme/changelog/deprecations/release)
                   # + tests (coverage >= 80, mutation 15/15)
                   # + check:exports (packs, installs into a scratch dir, ESM + CJS + tsc nodenext)
npm run audit      # 0 high/critical runtime advisories
npm run sbom       # .security-reports/sbom/nervly-js.cdx.json
```

Optional but recommended for a release candidate: run the live contract suite
against a booted gateway (the root `nervly-base` CI job `sdk-live-contract`
runs this automatically with the mTLS stack):

```bash
NERVLY_BASE_URL=https://... NERVLY_API_KEY=nv_... npm run test:live
```

## 3. Commit and tag

```bash
git add package.json src/version.ts CHANGELOG.md docs/version-compatibility.md
git commit -m "chore(sdk): release vX.Y.Z"
git push
git tag vX.Y.Z
git push origin vX.Y.Z
```

The tag must equal `v<package.json version>` exactly; the workflow fails the
release if it does not. Pushing the tag is the publish action — nothing else
publishes. Do **not** run `npm publish` from a laptop: provenance only works
from the supported CI (and `publishConfig.provenance` makes a local publish
attempt provenance anyway).

## 4. What the release workflow does (automated)

Trigger: push of tag `v*`. Permissions: `contents: write` (attach SBOM),
`id-token: write` (provenance).

1. Checkout this repo, then clone the `nervly-docs` OpenAPI fixture
   (`CROSS_REPO_TOKEN`).
2. `npm ci` from the locked tree.
3. `npm run verify` — all contract, test, and packaging gates.
4. Fail if the tag disagrees with `package.json`.
5. `npm run audit` and `npm run sbom`.
6. `npm publish --provenance --access public` with `NODE_AUTH_TOKEN`.
7. Attach the CycloneDX SBOM to the GitHub release (auto-generated notes).

## 5. Verify the published release

```bash
npm view @nervly/sdk version dist.integrity
npm view @nervly/sdk repository.url engines
```

Smoke-test the tarball a consumer would get, in a scratch directory:

```bash
mkdir /tmp/nervly-smoke && cd /tmp/nervly-smoke
npm init -y
npm install @nervly/sdk@X.Y.Z
node -e "const N=require('@nervly/sdk').default; console.log(typeof N, require('@nervly/sdk').SDK_VERSION)"
node --input-type=module -e "import N,{SDK_VERSION} from '@nervly/sdk'; console.log(typeof N, SDK_VERSION)"
npm audit signatures
```

Check the npm package page shows the **Provenance** badge linking back to this
repo and commit, and that the GitHub release has the SBOM attached.

## 6. If something is wrong

- **Workflow failed before `npm publish` succeeded** (most failures): the
  version is still available. Delete the tag, fix, and re-tag:
  ```bash
  git tag -d vX.Y.Z
  git push origin :refs/tags/vX.Y.Z
  # fix, commit, then tag/push again
  ```
- **Published but broken**: a published version can never be reused. Ship a
  patch, and flag the bad one:
  ```bash
  npm deprecate @nervly/sdk@X.Y.Z "reason; use X.Y.(Z+1)"
  # only if latest must point at a known-good version:
  npm dist-tag add @nervly/sdk@X.Y.(Z-1) latest
  ```
- If a tag push produced a failed run, inspect Actions → Release; every gate
  prints its own failure. Re-running the same failed workflow is safe only if
  `npm publish` did not complete.

## 7. Hardening (recommended follow-ups)

- Migrate the publish path to **npm trusted publishing (OIDC)** and delete the
  `NPM_TOKEN` secret. This also generates provenance without the flag; it
  requires one-time configuration on npmjs.com and is best done after the
  package exists.
- Add a protected GitHub `environment` (required reviewers) to the publish job
  in `release.yml`.
- Enable branch protection on `main` requiring the CI check.
