# nerve-sdk Testing & Conformance

How `@nervehq/sdk` proves that its types, payloads, and build outputs match the
contract the gateway actually serves — and how to re-run that proof yourself.

Ticket 11 owns this document. Everything below was run against the scratch host
during verification; the mutation results are recorded because "the gate exists"
and "the gate fails when it should" are different claims.

---

## 1. The four gates

| Gate | Command | Proves |
| --- | --- | --- |
| Codegen drift | `npm run check:codegen` | `src/generated/gateway.ts` is byte-identical to what the committed OpenAPI spec generates |
| Type-level conformance | `npm run check:types` | Every SDK request/response type equals the generated spec type, field-for-field |
| Runtime path coverage | `npm test` (`tests/spec-conformance.test.ts`) | Every path+method in the spec has an SDK method, no stale mappings, every referenced schema is modelled |
| Packaging | `npm run build && npm run check:exports` | The packed tarball loads and type-checks as both ESM and CJS |

`npm run check` runs the first two. CI runs all four.

### Where the contract comes from

```
nerve-gateway/src/**            (Rust handlers + utoipa derivations)
        │  cargo run --bin gen_openapi
        ▼
nerve-docs/static/openapi/gateway.json      committed, drift-gated by the gateway repo
        │  npm run codegen   (openapi-typescript)
        ▼
nerve-sdk/src/generated/gateway.ts          committed, drift-gated by check:codegen
        │  tests/types/conformance.types.ts
        ▼
nerve-sdk/src/types.ts                      the hand-written public types
```

Two gates hold this chain together at the SDK end. `check:codegen` catches the
spec moving without the generated types being refreshed. `check:types` catches
the generated types moving without `src/types.ts` following. Neither is
redundant: editing `src/generated/gateway.ts` by hand passes nothing, and a
stale generated file passes `check:types` against a stale spec.

### Why the schemas are named

`MODELLED_SCHEMAS` in `tests/spec-conformance.test.ts` lists every component the
SDK declares a type for. The third test walks every operation and fails when the
spec references a request or response schema that is not in that list — so a new
gateway response body cannot be added without the SDK either modelling it or
recording a reason in `NOT_CALLED_BY_SDK`. The exception list is itself checked:
an entry that names an operation the SDK now calls, or one that no longer exists,
fails the fourth test.

---

## 2. What the type-level assertions compare, and the four exceptions

`tests/types/conformance.types.ts` is compiled by `npm run check:types`, not run.
Each assertion is `Expect<Equal<SdkType, SpecType>>`, which resolves to `false`
on any difference in requiredness, nullability, or spelling — `channel?: string`
is not equal to `channel: string`, and `updatedAt` is not equal to `updated_at`.

Four spec properties are normalised before comparison, because utoipa's
`#[schema(value_type = Object)]` records a free-form JSON object as
`Record<string, never>` — *the empty object* — since the Rust field is
`serde_json::Value` and no shape can be derived from it. Comparing against that
verbatim would fail for a generator artefact rather than a real violation.

The four are `TriggerRequest.payload`, `BulkTriggerRequest.events`,
`UserPreferencesRequest.categories`, `McpRequest.params`, plus `McpResponse.result`
(overridden to `unknown` because the server returns one of several shapes).
`WithProp<T, K, V>` restates exactly that property and leaves every *other*
property as the spec declares it, so a field the spec gains later still has to be
modelled. A fifth `value_type = Object` field would surface as a failure, which
is the point: this list is reviewed, not inferred.

### Mutation evidence

Each gate was verified to fail when broken. Run in the SDK repo during
verification:

| Mutation | Expected | Result |
| --- | --- | --- |
| Rename `UserPreferencesResponse.updated_at` → `updatedAt` | `check:types` fails | caught |
| Make `MessageDto.attempts` optional | `check:types` fails | caught |
| Drop `| null` from `Recipient.deviceTokens` | `check:types` fails | caught |
| Delete `/v1/health` from `CONFORMANCE_MAP` | `npm test` fails | caught |
| Remove `MessageDto` from `MODELLED_SCHEMAS` | `npm test` fails | caught |
| Rename a schema in `src/generated/gateway.ts` | `check:codegen` fails | caught |
| Point `exports["."].require` at `dist/esm` | `check:exports` fails | caught |

`check:exports` asserts on the *resolved path*, not merely that loading
succeeded: Node has supported `require(esm)` since v22.12, so "it loaded" would
pass even with both conditions pointing at the same build.

---

## 3. Dual ESM/CJS build

```bash
npm run build          # tsc ×2 → dist/esm + dist/cjs, each with a type marker
npm run check:exports  # packs, installs into a scratch dir, loads + type-checks both
```

`dist/esm` is compiled with `module: NodeNext` and `dist/cjs` with
`module: CommonJS`; each carries a one-line `package.json` declaring its own
`type`, which is what lets the root manifest stay `"type": "module"` while
`dist/cjs` remains CommonJS. Each build ships its own `.d.ts`, so TypeScript
resolves declarations matching the module system the consumer uses under
`node16`/`nodenext` instead of falling back to one format.

`check:exports` is the end-to-end proof: `npm pack`, install the tarball into a
temporary project, then

- `import` it from an ESM file and confirm the resolved path is `dist/esm/…`;
- `require` it from a CJS file and confirm the resolved path is `dist/cjs/…`;
- `tsc --module nodenext` a `.mts` and a `.cts` consumer against the installed
  declarations, so both `types` conditions are exercised through the resolver.

The package has no runtime dependencies at all (`dependencies: {}`), asserted by
`tests/api-stability.test.ts`; HTTP is the platform `fetch` and nothing else.

---

## 4. Running everything

```bash
npm install
npm run check     # codegen drift + type-level conformance + typecheck
npm test          # 61 unit/contract tests (builds dist first via pretest)
npm run build
npm run check:exports
```
