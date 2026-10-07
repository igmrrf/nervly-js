# Node SDK Example App (stub)

> **Scaffolding stub.** This directory will hold the Node SDK example app. Only
> this README exists today; the app and its final run command arrive with the
> shared harness contract and walking skeleton (ticket 6 in `nervly-base`).
> Nothing here is runnable yet.

## Purpose

A small server application that uses the published `@nervly/sdk` from Node — the
everyday integration shape a customer would ship. It accepts a local request and
triggers a notification through the SDK, exercising `events.trigger` (idempotency
and priority), `events.bulkTrigger`, `messages.list`,
`subscribers.updatePreferences`, `health.check`, and typed SDK error handling
(`NervlyRateLimitError`, `NervlyValidationError`, …), including retry/timeout
configuration and a visible failure path.

**Green means an asserted end state:** a test-mode message is `DELIVERED` and
readable through `messages.list` — never an HTTP status alone.

## Planned run command

The planned entrypoint is the repo-wide example convention `npm run example`; the
shared harness contract fixes its final form, including how this example is
selected.

```sh
npm run example   # from the nervly-js repo root (provisional)
```
