# nerve-sdk Checklist

TypeScript `@nervehq/sdk` client library (npm). Primary responsibility: **API Stability & Contract Correctness**.
Parent checklist: [`../checklist.md`](../checklist.md)

## Tests
- [x] Unit tests on all public methods, retries, error mapping — 61 tests across
      `tests/*.test.ts`; every resource method, both retry paths (success after a
      503, exhaustion), all five status→error mappings, timeouts, and the
      dual-build packaging assertions.
- [ ] Contract tests against live `nerve-control-plane` (Pact or similar) — *not this ticket.*
      Today's contract proof is spec-based: the runtime path/schema coverage test plus the
      compiled type-level assertions against the generated OpenAPI types. A live Pact run
      against the control plane belongs to a later ticket.
- [x] Type-level tests (expect-type / tsd) for public API surface —
      `tests/types/conformance.types.ts`, compiled by `npm run check:types`. Equal<A, B>
      compares each public type to the generated spec type; verified to fail on renamed,
      optional-ised, and de-nullable fields.

## API Stability (SDK is a public commitment)
- [x] SemVer enforced; breaking changes only in major releases — the README states the
      `0.x` caveat honestly: the surface is unstable until 1.0.0, so a breaking change may
      land in a minor. Wire types cannot drift silently: `check:types` asserts them against
      the spec, and `check:codegen` asserts the spec against the SDK snapshot.
- [x] Deprecation policy: warn one minor before removal — `events.triggerEmail`,
      `subscribers.updatePreferences`, and the `Nerve`-prefixed error names all predate
      their successors and are still exported. Short error aliases were *added* beside the
      long names rather than replacing them.
- [ ] CHANGELOG.md maintained every release — the file lands with the first published
      release; `docs/publishing.md` step 3 names it.
- [x] Version aligned with control-plane API version; compatibility matrix published —
      `SDK_VERSION` is asserted equal to `package.json` by `tests/api-stability.test.ts`,
      and it is what the `User-Agent` reports; the compatibility matrix is the generated
      spec plus the conformance gates that pin the SDK to it.

## Security
- [x] No secrets in examples; docs show env-var usage — `examples/basic-usage.ts` reads
      `process.env.NERVE_API_KEY`; the README quickstart likewise.
- [ ] npm provenance + signed releases; `npm publish --provenance` — documented in
      `docs/publishing.md` §3; wired up by ticket 20.
- [ ] Dependency audit in CI; SBOM for the package — *ticket 20.* The SDK currently has
      `dependencies: {}`, asserted by `tests/api-stability.test.ts`.
- [ ] SECURITY.md + vulnerability disclosure policy — *ticket 20.*

## Documentation (external)
- [ ] README quickstart matches `nerve-docs` — checked in ticket 12, which owns the
      customer-facing portal. The README was corrected here where it described methods that
      do not exist (and now carries the "webhooks are not sent yet" warning).
- [x] Examples (`examples/`) tested in CI — `examples/**/*` is inside `tsconfig.check.json`,
      so `npm run check:types` fails when an example stops type-checking against the API.
