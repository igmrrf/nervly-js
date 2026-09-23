# nervly-sdk Checklist

TypeScript `@nervly/sdk` client library (npm). Primary responsibility: **API Stability & Contract Correctness**.
Parent checklist: [`../nervly-base/checklist.md`](../nervly-base/checklist.md)

## Promises

Commitments this SDK is accountable for keeping, lifted verbatim from the promise
inventory (indexed in
[`../nervly-base/checklist.md`](../nervly-base/checklist.md)). Section numbers
resolve in each app's Promises table; this table is the per-package reference.

| § | Promise | Where | Class |
|---|---|---|---|
| 1.8 | "Strictly-typed SDKs, with Node available today and the rest of the set rolling out. Protobuf or JSON. A local CLI with environment detection, secret management, and webhook forwarding. An MCP endpoint so your AI coding agent can read schemas, write integration code, and run sandbox tests — safely." | Home — developers copy | Capability |
| 1.8 | SDK language tags: Node (available); Python, Go, Java, PHP, .NET tagged "COMING SOON" | Home — developers SDK tags | Capability |
| 1.8 | "→ 202 Accepted · { eventId, status: \"QUEUED\" }" and "202 Accepted · { \"eventId\": \"evt_...\", \"status\": \"QUEUED\" }" | Home — developers code samples | Capability |
| 2.1 | Free features: "SDKs, CLI and MCP endpoint" | Pricing — Free tier features | Commercial |
| 7 | Resolved claim: "Strictly-typed SDKs in six languages" claimed six while Node shipped; the unshipped languages are now tagged "coming soon" | § 7 — claims to watch | — |

Also involved, owned jointly: 1.8 code samples reflect the `nervly-gate` 202
contract; the published compatibility matrix is reconciled with
`nervly-docs`. Backing tests: `tests/api-stability.test.ts`,
`tests/contract.test.ts`, `tests/types/conformance.types.ts`; release gates in
`scripts/check-release` / `check:deprecations` / `check:changelog`.

## Tests
- [x] Unit tests on all public methods, retries, error mapping — 333 tests across
      `tests/*.test.ts`; every resource method over 2xx/4xx/5xx, both retry paths
      (success after a 503, exhaustion), immediate failure on 401/403/422, all
      status→error mappings, exponential backoff + jitter boundaries, real
      `AbortSignal` timeouts, and the dual ESM/CJS loader resolution.
- [x] Enforced coverage threshold in CI — `npm run test:coverage` builds, then
      runs the suite under Node's V8 coverage scoped to `src/**/*.ts` with
      `--test-coverage-include-all` (type-only `src/types.ts` and
      `src/generated/**` excluded), and fails below 80% line, branch, or function
      coverage. Last run (2026-09-23, ticket 106): 89.55% lines, 93.55%
      branches, 100% functions — the drop from the previously recorded 99.44/94.71
      is the AI tool-calling module (`src/ai/tools.ts`, 71.86% lines: its
      type-only surface is covered by `check:types`, not runtime tests) landing
      after the last recorded run, still above the 80% floor.
      `npm test` runs this gate, so the CI step that runs `npm test` fails when
      coverage drops.
- [x] Mutation testing — `npm run test:mutation` (`scripts/mutation-test.mjs`)
      seeds 15 condition inversions (retry counts, retryable status list, auth
      header, error-body parsing, AbortError branch, exponential curve, jitter,
      30s ceiling, URL/query encoding, `Idempotency-Key`) and requires the owning
      test to fail. Last run killed 15/15 (100%); the report is committed at
      [`docs/mutation-report.json`](docs/mutation-report.json) and the table is in
      [`docs/testing_and_conformance.md`](docs/testing_and_conformance.md) §4.
- [x] Live contract suite against a running gateway router — ticket 27's user
      ruling (2026-09-21): the live contract is SDK ↔ the live *gateway*
      (`@nervly/sdk`'s base URL is `api.nervly.io`; it never addresses the
      control plane — that premise was corrected on both checklists), and
      **Pact is explicitly declined** for this surface: one consumer, nine
      operations, and a repo convention of spec-anchored contract checks in CI
      plus a real journey test for the live path — Pact's broker/verifier
      workflow buys nothing a booted gateway in CI does not prove. `npm run
      test:live` (`tests/live-contract.test.ts`, `make test-live`) uses the
      SDK's **real `fetch`** — no recording fetch, no mocks — against a running
      gateway (`NERVLY_BASE_URL` + `NERVLY_API_KEY`) and is falsifiable on the
      wire: an invalid key must map to `NervlyAuthenticationError` (401), a
      valid trigger must return the promised `202 { eventId, status: "QUEUED" }`
      shape, one status poll must return the `MessageDto` fields the SDK
      declares, one MCP `tools/list` must answer JSON-RPC 2.0 with a tool
      catalogue, one MCP `tools/call` `gateway_status` (the example's exact
      call) must answer with no JSON-RPC error, and `await verifySignature`
      must resolve to a real boolean. The root orchestration CI's `sdk-live-contract` job boots the
      full mTLS stack (postgres, redis, NATS, control plane, gateway), issues a
      key via `control-plane bootstrap-internal`, and runs it; this repo's own
      CI keeps the stubbed suite, where the live suite skips loudly without the
      env vars and the cross-repo job fails if that skip reason appears in its
      log (fail-on-skip discipline, like the e2e job's `--- SKIP` gate).
      **Narrowed live scope — the five uncovered operations stay spec-level:**
      `POST /v1/events/bulk`, `GET /v1/messages`,
      `DELETE /v1/subscribers/{subscriberId}`,
      `PUT /v1/users/{subscriberId}/preferences` and the inbound
      `POST /v1/webhooks/{provider}` (providers calling us) are covered by
      `tests/spec-conformance.test.ts`, `tests/types/conformance.types.ts` and
      `check:codegen`; they are not exercised live. `GET /v1/health` is
      exercised live only as the CI job's boot assertion, not in this suite.
      Re-executed 2026-09-22 by the nervly-js conformance audit against a locally booted
      mTLS stack (gateway image from `nervly-gate` 3cfc7f9, control plane from
      `nervly-control` 80c531c, TLS-only Postgres/Redis/NATS, `bootstrap-internal`
      key): the four legs then in the suite passed 4/4, 0 skip, and the MCP
      `tools/list` leg returned the six-tool catalogue verbatim. Ticket 106 added
      the `tools/call` and awaited-`verifySignature` legs (six legs total); the
      `tools/call` leg is additionally pinned deterministically off-gateway by
      `tests/example-wire.test.ts`, which runs in `npm test` and never skips.
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
- [x] README quickstart matches `nervly-docs` — closed by ticket 27's sibling
      ruling: a separate, smaller gate (this repo's own CI), not the same fix as
      the live contract test (the root cross-repo job). `npm run check:readme`
      (`make readme`, wired into `.github/workflows/ci.yml` next to the other
      `check:` gates) does both halves, following the proven
      `nervly-docs/scripts/check-quickstart.mjs` pattern: (i) every
      `typescript` fenced block in README.md is extracted into
      `docs/readme-snippets/` and type-checked against the SDK sources through
      `tsconfig.check.json` — the same mechanism `examples/**` already get, so
      a snippet naming a method, field or option the SDK does not ship fails
      the build; the one placeholder fence (`{ /* ... */ }`) is skipped by
      name; (ii) the README's documented base URL, `@nervly/sdk` version pins
      and Node floor, plus the "does not send outbound delivery webhooks yet"
      warning, must agree with the committed portal content
      (`content/quickstart.md`, `content/reference/sdk.md`, and the
      outbound-webhooks roadmap in `content/guides/delivery-receipts.md`) — the
      same string-level agreement `check-sdk-version.mjs` enforces on the
      portal side. Both halves verified falsifiable: a renamed README method
      (`events.fetch`) and a drifted base URL each fail the gate. The README
      still carries the "webhooks are not sent yet" warning, and the gate fails
      if the portal's roadmap ever flips while the warning stays stale.
- [x] Examples (`examples/`) tested in CI — `examples/**/*` is inside `tsconfig.check.json`,
      so `npm run check:types` fails when an example stops type-checking against the API.
      The guarantee is no longer only type-level: `tests/example-wire.test.ts` boots a real
      `node:http` stub, drives `examples/basic-usage.ts`'s exported `runBasicUsage`, and asserts
      on the bytes the SDK sent — the MCP `tools/call` body's `params` must be the example's
      `{ name: "gateway_status", arguments: {} }` (never `null`, which the gateway rejects with
      JSON-RPC `-32602`), a JSON-RPC error inside HTTP 200 must reject rather than print success,
      and `signatureValid` must be a real boolean (a dropped `await` on `verifySignature` makes it
      a Promise and fails). The suite is deterministic and never skips, so it runs in `npm test`;
      `tests/live-contract.test.ts` re-proves the same `tools/call` and the awaited boolean against
      a booted gateway when `NERVLY_BASE_URL`/`NERVLY_API_KEY` are present. `McpResource.callTool`
      now requires `params` at the type level, so the former no-arg call is a compile error too.
