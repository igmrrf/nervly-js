# Node SDK Example App

A small `node:http` server that uses `@nervly/sdk` from this repo the way a
customer would ship: one SDK client with explicit timeout/retry configuration,
routes that call the SDK, typed SDK errors mapped to machine-readable HTTP
responses, and a harness run that **asserts the end state** — the triggered
message reads back `DELIVERED` through the app's own `GET /messages` surface in
test mode, not merely an HTTP 200.

This is the reference implementation of the shared example harness contract
([`nervly-base/docs/examples/harness-contract.md`](../../../nervly-base/docs/examples/harness-contract.md))
and the everyday Node integration shape for ticket 8.

## Run

```sh
# From the nervly-js repo root, against a local stack (`make up` in nervly-base):
npm run example            # human transcript
npm run example -- --json  # machine-readable summary.json on stdout
make example               # same entrypoint via the Makefile
```

The run logs in as the dev seed (`make seed-dev`), mints a unique
`nervly_sk_test_*` read+write key, starts the app on an **ephemeral port** with
that key, drives every endpoint over HTTP, asserts the end state, stops the
app, and revokes the key; the seed workspace itself is never modified or
deleted. On a stack whose gateway still publishes plaintext variables over
NATS, `EXAMPLES_BOOTSTRAP=fresh` instead signs up a fully isolated ephemeral
workspace (`examples+<runid>@example.local`) and closes it at teardown — see
the contract §1.2 for the current-platform constraint on that flow.

## Endpoints

The app exposes the SDK's core integration surface:

| Method + path | SDK call | What it does |
|---|---|---|
| `GET /health` | `health.check` | gateway health; a dead gateway maps to `503 NETWORK_ERROR` |
| `POST /events` | `events.trigger` | body `{name, to, payload?, category?, idempotencyKey?, priority?}`; returns `202 {eventId, status, priority, channel, idempotencyKey}` |
| `POST /events/bulk` | `events.bulkTrigger` | body `{events: [...]}`; returns `202 {jobId, status, count, failedCount, events}` |
| `GET /messages` | `messages.list` | filters `subscriberId`/`subscriber_id`, `status`, `channel`, `from`, `to`, `limit`, `cursor` |
| `GET /events/:eventId` | `events.get` | one message by event id |
| `PUT /subscribers/:subscriberId/preferences` | `subscribers.updatePreferences` | body `{channels?, categories?}`; returns `200 {status, subscriberId, updated_at}` |

Unknown routes and malformed bodies answer `400`/`404` with the same
machine-readable error shape as SDK failures.

## Typed error mapping

Every SDK error becomes `{ "error": { "type", "message", "status", … } }`:

| SDK error | HTTP | `error.type` |
|---|---|---|
| `NervlyValidationError` (gateway 400) | `400` | `VALIDATION_ERROR` |
| `NervlyApiError` (gateway 422) | `422` | `VALIDATION_ERROR` |
| `NervlyAuthenticationError` | `401` | `AUTHENTICATION_ERROR` |
| `NervlyNotFoundError` | `404` | `NOT_FOUND` |
| `NervlyIdempotencyError` | `409` | `IDEMPOTENCY_CONFLICT` |
| `NervlyRateLimitError` | `429` | `RATE_LIMIT_EXCEEDED` (adds `retry_after_ms`, `purpose`) |
| `NervlyServerError` | `502` | `UPSTREAM_ERROR` |
| `NervlyNetworkError` | `503` | `NETWORK_ERROR` |
| `NervlyRetryExhaustedError` | `503` | `RETRY_EXHAUSTED` (adds `attempts`) |
| other `NervlyApiError` | gateway status | the gateway's `error` code |
| anything else | `500` | `INTERNAL_ERROR` |

The harness demonstrates validation and not-found **live** against the local
stack (an empty bulk and a missing event) and asserts both. The full table,
including rate-limit and retry-exhaustion branches, is covered by
`tests/node-app-app.test.ts` against stubs.

## Retry and timeout configuration

The app builds one client with explicit values — a 10 s per-request timeout,
two retries on `429`/`5xx`/network failures, and a 250 ms base exponential
backoff — and the harness transcript prints them at startup. The harness
contract pins the environment surface (§1.1), so these are not environment
variables; tests and embedders override them through `startApp({ … })` /
`resolveAppConfig`. A transient failure surfaces as `503 RETRY_EXHAUSTED`
after the configured attempts; `tests/node-app-app.test.ts` proves the retry,
exhaustion and timeout paths end to end.

## SDK resolution and version

The app imports the **package entry** — `import Nervly from "@nervly/sdk"` —
which resolves through the repo's `exports` map to the built `dist/esm`
bundle, exactly what a customer installing the published package gets. It does
not import `src`. `npm run example` (via `scripts/example.mjs`) rebuilds
`dist` first whenever it is missing or older than `src/`, so the entrypoint can
never run a stale bundle.

The SDK is pinned to **`0.1.1`**, this repo's `package.json` version: the
example exercises the API surface that version ships (including
`subscribers.updatePreferences`, which the SDK marks deprecated in favour of
`users.updatePreferences` for removal in `0.2.0`).

## Standalone

The same server runs on its own, without the harness bootstrap. It imports the
built package entry, so build once first (and after SDK changes):

```sh
npm run build

NERVLY_API_KEY=nervly_sk_test_… \
NERVLY_API_URL=http://localhost:8080 \
npx tsx examples/node-app/server.ts --port 3000
```

`--port 0` picks an ephemeral port; the default is `3000`. The same guards as
the harness apply: only local gateway/control hosts and `nervly_sk_test_*` keys
are accepted, and a refusal exits `3` before the server starts (exit `2` for a
missing key or bad configuration). `NERVLY_GATEWAY_URL` overrides
`NERVLY_API_URL` for data-plane calls.

## Expected transcript

```text
node-app run 20261007T123008Z-4872 (target=local)
→ bootstrap (seed): login as dev@nervly.local
  minted test-mode key examples-20261007T123008Z-4872 (id 0c4a3506c30aa65d)
  workspace dev-local (source=seed)
→ app: listening at http://127.0.0.1:61647 (timeout=10000ms maxRetries=2 retryBaseDelay=250ms)
→ checks: app health (gateway reachable, NATS connected)
  gateway healthy (status=OK)
→ checks: POST /events (idempotency + priority)
  trigger accepted (event evt_8d8baef762654c24b88de153fa98d9e9)
→ checks: replay POST /events with idempotency-key example-20261007T123008Z-4872
  replay returned the same event evt_8d8baef762654c24b88de153fa98d9e9
→ checks: GET /events/evt_8d8baef762654c24b88de153fa98d9e9
→ checks: POST /events/bulk (2 events)
→ checks: PUT /subscribers/sub-example-20261007t123008z-4872/preferences
→ checks: typed error mapping (validation, not found)
→ checks: read back evt_8d8baef762654c24b88de153fa98d9e9 via GET /messages (bound 30000ms)
  asserted end state: evt_8d8baef762654c24b88de153fa98d9e9 is DELIVERED in test mode
✓ all checks passed (asserted test-mode DELIVERED)
→ teardown: revoking API key examples-20261007T123008Z-4872
  API key revoked
summary: …/nervly-js/artifacts/summary.json
node-app finished: PASS (run 20261007T123008Z-4872)
```

The exit code is the contract's:

| Code | Meaning |
|---|---|
| `0` | all checks passed (message observed `DELIVERED` in test mode) |
| `1` | an assertion failed (e.g. delivery never observed) |
| `2` | environment/bootstrap failure (stack unreachable names `make up`) |
| `3` | guard refusal — non-local host, non-test key, unsupported target |

Artifacts land in `nervly-js/artifacts/` (git-ignored):

- `summary.json` — the contract schema; `checks[]` names every endpoint driven
- `transcript.log` — the redacted human transcript
- `bootstrap.json` (0600) — run metadata; **the API key itself is never persisted**

## Configuration

All contract variables are documented in the contract §1.1; the commonly used
ones:

| Variable | Default | Notes |
|---|---|---|
| `NERVLY_API_URL` | `http://localhost:8080` | gateway; `NERVLY_GATEWAY_URL` overrides |
| `NERVLY_CONTROL_URL` | `http://localhost:8081` | control plane (bootstrap only) |
| `NERVLY_NATS_URL` | `nats://localhost:4222` | token capture |
| `NERVLY_API_KEY` | (unset) | set to use env-first: no bootstrap, nothing torn down |
| `EXAMPLES_BOOTSTRAP` | `seed` | `seed` logs in as the dev seed user; `fresh` runs the isolated signup flow (contract §1.2 note) |
| `EXAMPLES_KEEP` | (unset) | `1` keeps the ephemeral workspace for debugging |
| `NERVLY_RUN_ID` | generated | unique run id; appears in email, slug, key name |

Guards are strict by design: only local hosts and `nervly_sk_test_*` keys are
accepted, and the refusal happens before any network call.

## Layout

```
examples/node-app/
  app.ts                  node:http server, routes, typed error → HTTP mapping
  server.ts               standalone entry (env guards, PORT, signals)
  main.ts                 harness entrypoint + exit-code mapping
  harness/
    config.ts             contract env vars → ExampleConfig
    guards.ts             local-host / test-key / target refusals (exit 3)
    run-id.ts             unique run ids
    console.ts            control-plane client (cookies + CSRF)
    nats.ts               dependency-free NATS capture (verification token)
    bootstrap.ts          fresh-signup and seed bootstrap; teardown
    checks.ts             drives the app; asserts DELIVERED + replay + errors
    summary.ts            artifacts/summary.json schema
    transcript.ts         redacted stdout + transcript.log
    redact.ts             secret scrubbing (the only output boundary)
```

Tests live in
[`tests/node-app-harness.test.ts`](../../tests/node-app-harness.test.ts)
(contract invariants around the app, stubbed stack) and
[`tests/node-app-app.test.ts`](../../tests/node-app-app.test.ts) (routes, retry/
timeout wiring, error mapping, standalone server).
