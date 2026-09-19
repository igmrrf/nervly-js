# Version Compatibility Matrix

`@nervly/sdk` is generated from the OpenAPI contract the gateway publishes, and
the public types are compile-time-pinned to that contract
(`npm run check:codegen`, `npm run check:types`). This page is the published
compatibility guarantee: which SDK release is built against which API version.

## Matrix

| `@nervly/sdk` | Gateway / control-plane API | Status | Notes |
| --- | --- | --- | --- |
| `0.1.0` | `0.1.0` | Supported | Current release. Dual ESM/CJS, zero runtime dependencies. |

The API version is the `info.version` of
[`nervly-docs/static/openapi/gateway.json`](../../nervly-docs/static/openapi/gateway.json),
which the gateway regenerates from its Rust source on every commit. An SDK
release is compatible with an API version when the two cells on the same row are
equal; a gateway API change that breaks a type forces a new row and a new SDK
release, not a silent drift.

## Policy

- **Patch (`0.1.x`)** — bug fixes, documentation, dependency bumps. Compatible
  with the same API version.
- **Minor (`0.x.0`)** — additive, backwards-compatible changes. While the SDK is
  `0.x` the README states that a minor may still contain a breaking change.
- **Major (`x.0.0`)** — a breaking contract change, or a jump to a new API
  version that is not backwards compatible.
- A symbol is deprecated in one release (`@deprecated` plus an entry in
  [`deprecations.json`](../deprecations.json)) and removed no earlier than the
  version named in its `removeIn`. `npm run check:deprecations` enforces this.

This document is checked by `npm run check:release`, which fails when the row for
the current `package.json` version is missing or names a different API version.
