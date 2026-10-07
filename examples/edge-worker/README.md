# Edge SDK Example App (stub)

> **Scaffolding stub.** This directory will hold the edge-runtime SDK example.
> Only this README exists today; the worker project and its final run command
> arrive with the shared harness contract and walking skeleton (ticket 6 in
> `nervly-base`). Nothing here is runnable yet.

## Purpose

A runnable edge application that proves the SDK's edge-runtime claim, following
the edge-runtime viability verdict: Cloudflare Workers via `wrangler dev`, unless
that research says otherwise. The app triggers a notification and reads it back
through the SDK from the edge runtime, and shows secret/env handling
(`wrangler secret` / `.dev.vars`) plus any runtime shims the research identified —
notably `nodejs_compat` with `compatibility_date ≥ 2026-08-04`.

**Green means an asserted end state:** a test-mode message is `DELIVERED`, driven
by the harness. Deploying the worker is not required.

## Planned run command

The planned entrypoint is the repo-wide example convention `npm run example`; the
shared harness contract fixes its final form, including how this example is
selected.

```sh
npm run example   # from the nervly-js repo root (provisional)
```
