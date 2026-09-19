# nervly-sdk Checklist

TypeScript `@nervly/sdk` client library (npm). Primary responsibility: **API Stability & Contract Correctness**.
Parent checklist: [`../checklist.md`](../checklist.md)

## Tests
- [x] Unit tests on all public methods, retries, error mapping — 295 tests across
      `tests/*.test.ts`; every resource method over 2xx/4xx/5xx, both retry paths
      (success after a 503, exhaustion), immediate failure on 401/403/422, all
      status→error mappings, exponential backoff + jitter boundaries, real
      `AbortSignal` timeouts, and the dual ESM/CJS loader resolution.
- [x] Enforced coverage threshold in CI — `npm run test:coverage` builds, then
      runs the suite under Node's V8 coverage scoped to `src/**/*.ts` with
      `--test-coverage-include-all` (type-only `src/types.ts` and
      `src/generated/**` excluded), and fails below 80% line, branch, or function
      coverage. Last run: 99.44% lines, 94.71% branches, 100% functions.
      `npm test` runs this gate, so the CI step that runs `npm test` fails when
      coverage drops.
- [x] Mutation testing — `npm run test:mutation` (`scripts/mutation-test.mjs`)
      seeds 15 condition inversions (retry counts, retryable status list, auth
      header, error-body parsing, AbortError branch, exponential curve, jitter,
      30s ceiling, URL/query encoding, `Idempotency-Key`) and requires the owning
      test to fail. Last run killed 15/15 (100%); the report is committed at
      [`docs/mutation-report.json`](docs/mutation-report.json) and the table is in
      [`docs/testing_and_conformance.md`](docs/testing_and_conformance.md) §4.
- [ ] Contract tests against live `nervly-control-plane` (Pact or similar) — *not this ticket.*
      Today's contract proof is spec-based: the runtime path/schema coverage test plus the
      compiled type-level assertions against the generated OpenAPI types. A live Pact run
      against the control plane belongs to a later ticket.
- [x] Voice channel SDK contract (Ticket 59: `src/resources/voice.ts::VoiceResource` compiles `SendVoiceOptions` into `overrides.voice` with script, `voice_id` and language; the `VoiceOverride` and `Channel` wire types live in `src/types.ts`; `tests/contract.test.ts` asserts the built payload's properties exist in the OpenAPI `VoiceOverrideDto`/`ProviderOverridesDto.voice` schemas.)
- [x] Type-level tests (expect-type / tsd) for public API surface —
      `tests/types/conformance.types.ts`, compiled by `npm run check:types`. Equal<A, B>
      compares each public type to the generated spec type; verified to fail on renamed,
      optional-ised, and de-nullable fields.

## API Stability (SDK is a public commitment)
- [x] SemVer enforced; breaking changes only in major releases — the README states the
      `0.x` caveat honestly: the surface is unstable until 1.0.0, so a breaking change may
      land in a minor. Wire types cannot drift silently: `check:types` asserts them against
      the spec, and `check:codegen` asserts the spec against the SDK snapshot.
- [x] Deprecation policy: warn one minor before removal — the policy lives in
      [`deprecations.json`](deprecations.json) (a single source of truth) and is enforced by
      `npm run check:deprecations`: every registered symbol must carry the exact
      `@deprecated` annotation the registry predicts, no source file may carry an
      unregistered deprecation, and a symbol whose `removeIn` version has been reached while
      it is still exported fails the build. `EventsResource.triggerEmail` and
      `SubscribersResource.updatePreferences` are the current warnings, both removable in
      `0.2.0`. The checker self-tests against five mutations before it runs.
- [x] CHANGELOG.md maintained every release — `npm run check:changelog` fails unless the
      `package.json` version has a dated, non-empty, Keep-a-Changelog entry, the file
      declares the Keep-a-Changelog and SemVer conventions, and the link reference exists.
      The gate self-tests against five mutations.
- [x] Version aligned with control-plane API version; compatibility matrix published —
      `SDK_VERSION` is asserted equal to `package.json` by `tests/api-stability.test.ts` and
      `check:changelog`, and it is what the `User-Agent` reports. The published matrix lives
      at [`docs/version-compatibility.md`](docs/version-compatibility.md) and is checked by
      `npm run check:release`, which fails when the current SDK version has no row or its row
      names an API version other than the committed spec's `info.version`.

## Security
- [x] No secrets in examples; docs show env-var usage — `examples/basic-usage.ts` reads
      `process.env.NERVLY_API_KEY`; the README quickstart likewise.
- [x] npm provenance + signed releases; `npm publish --provenance` — 
      [`.github/workflows/release.yml`](.github/workflows/release.yml) publishes on a `v*`
      tag with `id-token: write` and `npm publish --provenance --access public`; the
      `publishConfig` block declares the same. `npm run check:release` fails if any of
      those invariants is removed. Publishing itself requires the npm credential, so it is
      the one step a scratch host cannot perform — the path is gated, the publish is not
      executed here.
- [x] Dependency audit in CI; SBOM for the package — `npm run audit`
      (`npm audit --omit=dev --audit-level=high`) and `npm run sbom`
      (`scripts/sbom.mjs`, CycloneDX via `npm sbom`) run in CI and in the release workflow;
      the SBOM is attached to the GitHub release. The SDK still has `dependencies: {}`,
      asserted by `tests/api-stability.test.ts`.
- [x] SECURITY.md + vulnerability disclosure policy — [`SECURITY.md`](SECURITY.md) describes
      reporting (`security@nervly.io`), the response commitments, coordinated disclosure and
      safe harbour, in/out of scope, and supported versions. It is in `files[]`, so it ships
      inside the tarball, and `npm run check:release` asserts its required sections exist.

## Documentation (external)
- [ ] README quickstart matches `nervly-docs` — checked in ticket 12, which owns the
      customer-facing portal. The README was corrected here where it described methods that
      do not exist (and now carries the "webhooks are not sent yet" warning).
- [x] Examples (`examples/`) tested in CI — `examples/**/*` is inside `tsconfig.check.json`,
      so `npm run check:types` fails when an example stops type-checking against the API.
