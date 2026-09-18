# nerve-sdk Documentation

Internal engineering and release documentation for `@nervehq/sdk`, the official
TypeScript client library for Nerve. Versioned here rather than in `nerve-docs`,
which is strictly customer-facing (ADR-012).

---

## Document Index

1. [`architecture.md`](architecture.md) — module layout, the dual ESM/CJS build and why each
   condition carries its own declarations, and the error hierarchy.
2. [`api_reference.md`](api_reference.md) — the public method surface, resource by resource,
   with the wire type each method returns.
3. [`testing_and_conformance.md`](testing_and_conformance.md) — the four CI gates, the
   spec → codegen → types → assertions chain, the normalised spec properties, and the
   mutation evidence that each gate fails when it should.
4. [`publishing.md`](publishing.md) — what ships in the tarball, the `exports` map, the
   SemVer/deprecation/changelog gates, and the release checklist.
5. [`version-compatibility.md`](version-compatibility.md) — the published matrix mapping each
   SDK release to the gateway API version it was generated against.

## Related, outside this directory

- Gateway contract source: [`nerve-docs/static/openapi/gateway.json`](../../nerve-docs/static/openapi/gateway.json)
  — generated from the Rust handlers, never edited by hand.
- Generated types: [`src/generated/gateway.ts`](../src/generated/gateway.ts) — produced by
  `npm run codegen`, drift-gated by `npm run check:codegen`.
- Production-readiness checklist: [`checklist.md`](../checklist.md).
