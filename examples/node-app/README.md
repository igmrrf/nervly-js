# Node SDK Example App — Walking Skeleton

A runnable Node application that uses `@nervly/sdk` from this repo the way a
customer would: bootstrap an ephemeral test-mode workspace, check gateway
health, trigger a notification through the SDK, and **assert the end state** —
the message reads back `DELIVERED` through `messages.list`, not merely an HTTP
200.

This is the **walking skeleton** for the shared harness contract
([`nervly-base/docs/examples/harness-contract.md`](../../../nervly-base/docs/examples/harness-contract.md)):
the runnable example that proves the contract end to end. Ticket 8 grows it
into the full SDK app (bulk trigger, preferences, typed error paths).

## Run

```sh
# From the nervly-js repo root, against a local stack (`make up` in nervly-base):
npm run example            # human transcript
npm run example -- --json  # machine-readable summary.json on stdout
make example               # same entrypoint via the Makefile
```

The run logs in as the dev seed (`make seed-dev`), mints a unique
`nervly_sk_test_*` read+write key, and revokes that key on the way out; the seed
workspace itself is never modified or deleted. On a stack whose gateway still
publishes plaintext variables over NATS, `EXAMPLES_BOOTSTRAP=fresh` instead
signs up a fully isolated ephemeral workspace
(`examples+<runid>@example.local`), captures the verification token from NATS,
verifies, logs in, mints the key, and closes the workspace at teardown — see the
contract §1.2 for the current-platform constraint on that flow. The exit code
is the contract's:

| Code | Meaning |
|---|---|
| `0` | all checks passed (message observed `DELIVERED` in test mode) |
| `1` | an assertion failed (e.g. delivery never observed) |
| `2` | environment/bootstrap failure (stack unreachable names `make up`) |
| `3` | guard refusal — non-local host, non-test key, unsupported target |

Artifacts land in `nervly-js/artifacts/` (git-ignored):

- `summary.json` — the contract schema
- `transcript.log` — the redacted human transcript
- `bootstrap.json` (0600) — run metadata; **the API key itself is never persisted**

## Configuration

All variables are documented in the contract §1.1; the commonly used ones:

| Variable | Default | Notes |
|---|---|---|
| `NERVLY_API_URL` | `http://localhost:8080` | gateway; `NERVLY_GATEWAY_URL` overrides |
| `NERVLY_CONTROL_URL` | `http://localhost:8081` | control plane (bootstrap only) |
| `NERVLY_NATS_URL` | `nats://localhost:4222` | token capture |
| `NERVLY_API_KEY` | (unset) | set to use env-first: no bootstrap, nothing torn down |
| `EXAMPLES_BOOTSTRAP` | `seed` | `seed` logs in as the dev seed user; `fresh` runs the fully isolated signup flow (contract §1.2 note) |
| `EXAMPLES_KEEP` | (unset) | `1` keeps the ephemeral workspace for debugging |
| `NERVLY_RUN_ID` | generated | unique run id; appears in email, slug, key name |

Guards are strict by design: only local hosts and `nervly_sk_test_*` keys are
accepted, and the refusal happens before any network call.

## Layout

```
examples/node-app/
  main.ts                 entrypoint + exit-code mapping
  harness/
    config.ts             contract env vars → ExampleConfig
    guards.ts             local-host / test-key / target refusals (exit 3)
    run-id.ts             unique run ids
    console.ts            control-plane client (cookies + CSRF)
    nats.ts               dependency-free NATS capture (verification token)
    bootstrap.ts          fresh-signup and seed bootstrap; teardown
    checks.ts             health → trigger → DELIVERED read-back
    summary.ts            artifacts/summary.json schema
    transcript.ts         redacted stdout + transcript.log
    redact.ts             secret scrubbing (the only output boundary)
```

Tests for the harness modules live in
[`tests/node-app-harness.test.ts`](../../tests/node-app-harness.test.ts), including
a stubbed end-to-end run (stub control plane, gateway and NATS broker) that
proves the summary schema, exit codes and cleanup without the real stack.
