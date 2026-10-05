# nervly-sdk Documentation

Internal engineering and release documentation for `@nervly/sdk`, the official
TypeScript client library for Nervly. Versioned here rather than in `nervly-docs`,
which is strictly customer-facing (ADR-012).

---

## Document Index

1. [`architecture.md`](architecture.md) — module layout, the dual ESM/CJS build and why each
   condition carries its own declarations, and the error hierarchy.
2. [`api_reference.md`](api_reference.md) — the public method surface, resource by resource,
   with the wire type each method returns.
3. [`testing_and_conformance.md`](testing_and_conformance.md) — the CI gates, the
   spec → codegen → types → assertions chain, the normalised spec properties, the
   client-contract coverage thresholds, the mutation evidence that each gate fails
   when it should, and the dual-loader proof.
4. [`publishing.md`](publishing.md) — what ships in the tarball, the `exports` map, the
   SemVer/deprecation/changelog gates, and the release checklist.
5. [`version-compatibility.md`](version-compatibility.md) — the published matrix mapping each
   SDK release to the gateway API version it was generated against.

## Related, outside this directory

- Gateway contract source: [`nervly-docs/static/openapi/gateway.json`](../../nervly-docs/static/openapi/gateway.json)
  — generated from the Rust handlers, never edited by hand.
- Generated types: [`src/generated/gateway.ts`](../src/generated/gateway.ts) — produced by
  `npm run codegen`, drift-gated by `npm run check:codegen`.
- Production-readiness checklist: [`checklist.md`](../checklist.md).
- Deployment runbook: [`steps.md`](../steps.md) — one-time prerequisites, local
  verification, tagging, published-release checks, and failure recovery.
