# Edge SDK Example App (`edge-worker`)

A runnable **workerd** application that uses `@nervly/sdk` from a Cloudflare
Workers runtime (`wrangler dev`, local mode) and proves the SDK's edge claim
end to end. This is ticket 9's example app, following
`nervly-base/.wayfinder/example-applications/research/sdk-edge-runtimes.md` §4
(workerd is the chosen runtime: the only one where the full SDK surface is
vendor-supported without shims).

## What it proves

- The SDK runs unmodified in `workerd`: the worker constructs a `Nervly` client
  **per request from `env`** (never at module scope) and exposes
  `health.check`, `events.trigger`, `events.get` and `messages.list` over HTTP.
- **Green means an asserted end state:** the trigger's test-mode message reads
  back `DELIVERED` through `messages.list` — never "an HTTP call returned 200".
- Secret handling is real: the key is injected into the Worker through
  `.dev.vars` locally, is git-ignored, never appears in the transcript, the
  summary or wrangler's output, and the harness revokes the key it minted.

## Run it

Stack prerequisites: the local nervly stack is up and seeded (`make up` /
`make seed-dev` in `nervly-base`), i.e. gateway on `http://localhost:8080`,
control plane on `http://localhost:8081`.

```sh
cd nervly-js
npm run example -- edge-worker          # human transcript
npm run example -- edge-worker --json   # summary JSON on stdout
make example ARGS="edge-worker"         # Makefile equivalent
```

The repo dispatcher (`scripts/example.mjs`) builds the SDK first when `dist/` is
missing or older than `src/`, then runs this harness. Deploying the worker is
**not required** and nothing here talks to Cloudflare's network: `wrangler dev`
serves workerd locally and needs no account or login.

Expected transcript (shape; ids vary per run):

```
edge-worker run 20261007T120000Z-ab12 (target=local)
→ check: SDK dist present and fresh
→ bootstrap (seed): login as dev@nervly.local
  minted test-mode key examples-20261007T120000Z-ab12 (id key_…)
  workspace dev-local (source=seed)
→ artifact: bootstrap.json
→ wrangler: starting local workerd on port 53xxx
  worker ready at http://127.0.0.1:53xxx
→ checks: GET /health (worker -> gateway, NATS connected)
  gateway healthy (status=OK)
→ checks: POST /events (events.trigger with idempotency key)
  trigger accepted (event evt_…)
→ checks: GET /events/evt_…
→ checks: read back evt_… via GET /messages (bound 30000ms)
  asserted end state: evt_… is DELIVERED in test mode (channel=email)
✓ all checks passed (asserted test-mode DELIVERED)
→ teardown: revoking API key examples-20261007T120000Z-ab12
  API key revoked
summary: …/artifacts/edge-worker/summary.json
edge-worker finished: PASS (run 20261007T120000Z-ab12)
```

Artifacts land in `artifacts/edge-worker/` (git-ignored): `summary.json`,
`transcript.log`, `bootstrap.json` and `wrangler.log`. Exit codes follow the
shared contract: `0` pass, `1` assertion failed, `2` environment/bootstrap
failure, `3` guard refusal.

## Configuration and guards

The harness reads only the contract's environment table
(`nervly-base/docs/examples/harness-contract.md` §1.1). Before any network work
it refuses (exit 3) a non-local URL, a non-test key, an unsupported
`NERVLY_TARGET`, and a malformed `NERVLY_RUN_ID`.

- Test-mode only: the harness mints a `nervly_sk_test_*` read+write key, uses
  it, and revokes it on teardown. Live keys are refused.
- `EXAMPLES_BOOTSTRAP=seed` (default) logs in as `dev@nervly.local` and mints
  one uniquely named key (`examples-<runId>`).
- `NERVLY_API_KEY` is env-first: bootstrap is skipped and nothing is minted or
  revoked.
- `EXAMPLES_BOOTSTRAP=fresh` is **refused with exit 3**: the current platform
  cannot expose the email-verification token to an unprivileged harness
  (contract §1.2), so `seed` is the supported isolated-ish mode.
- `EXAMPLES_KEEP=1` skips revoking the key for debugging; the local `.dev.vars`
  is still removed.

## Secrets: `.dev.vars` locally, `wrangler secret` on deploy

Worker bindings (`NERVLY_API_KEY`, optional `NERVLY_API_URL`) are read from
`env` at request time:

- **Local:** the harness writes `examples/edge-worker/.dev.vars` (mode `0600`,
  git-ignored via `.gitignore`) with the minted test key and deletes it on
  teardown — success, failure or SIGINT/SIGTERM. `wrangler dev` reports such
  values as `(hidden)`.
- **Deploy:** `wrangler secret put NERVLY_API_KEY` (and
  `wrangler secret put NERVLY_API_URL` if the gateway is not the default).

The key never appears on a command line, in stdout, in the transcript, in
`summary.json`, or in `wrangler.log`. The release gate
`grep -R "nervly_sk_test_" artifacts/` finds nothing after a run.

## Runtime shims and the Vercel Edge gap

- `wrangler.jsonc` pins `compatibility_date: "2026-08-04"`, so workerd's Node
  compatibility (`node:crypto`, `Buffer`) is on by default; older dates would
  need `compatibility_flags: ["nodejs_compat"]`. The journey here needs no Node
  APIs — only `webhooks.verifySignature` does, and this example does not use it.
- **Vercel Edge is not supported as a whole-package target (documented, not
  papered over):** `webhooks.verifySignature` dynamically imports `node:crypto`,
  which Vercel Edge does not support, so the package is "broken as shipped"
  there (research §2.2/§3). The core trigger/read-back paths would work on
  Web APIs alone, but Vercel also recommends Node.js over Edge for new projects.
  Making the helper WebCrypto-based is filed as SDK follow-up work, not
  implemented by this example.
- Workerd bundling resolves the `@nervly/sdk` self-reference to the built
  `dist/esm` entry. If a future esbuild stops doing that, `wrangler.jsonc`
  carries a commented `alias` fallback to `dist/esm/index.js`; the harness
  refuses to run when `dist` is missing or older than `src` (exit 2), so the
  example can never silently prove a stale bundle.

## Development

```
examples/edge-worker/
  main.ts            harness entry (`npm run example -- edge-worker`)
  worker.ts          thin workerd entry (default export only)
  app.ts             routes + per-request client construction (unit-tested)
  wrangler.jsonc     compatibility date, main, commented dist alias
  harness/           config, guards, bootstrap, checks, wrangler process manager
```

Tests: `tests/edge-worker-harness.test.ts` (guards, config, redaction, summary,
`.dev.vars`, wrangler process lifecycle, bootstrap), `tests/edge-worker-worker.test.ts`
(worker routing against a stubbed gateway over the real SDK client), and
`tests/edge-worker-checks.test.ts` (the asserted end-state logic). Run them with
`npx tsx --test tests/edge-worker-*.test.ts`.
