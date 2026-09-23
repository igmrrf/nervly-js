# nervly-sdk Testing & Conformance

How `@nervly/sdk` proves that its types, payloads, and build outputs match the
contract the gateway actually serves — and how to re-run that proof yourself.

Ticket 11 owns this document; ticket 39 added the client-contract coverage and
mutation gates below. Everything recorded here was run against the scratch host
during verification; the mutation results are recorded because "the gate exists"
and "the gate fails when it should" are different claims.

---

## 1. The gates

| Gate | Command | Proves |
| --- | --- | --- |
| Codegen drift | `npm run check:codegen` | `src/generated/gateway.ts` is byte-identical to what the committed OpenAPI spec generates |
| Type-level conformance | `npm run check:types` | Every SDK request/response type equals the generated spec type, field-for-field |
| Runtime path coverage | `npm test` (`tests/spec-conformance.test.ts`) | Every path+method in the spec has an SDK method, no stale mappings, every referenced schema is modelled |
| Client contract coverage | `npm run test:coverage` | Every public resource method is exercised over 2xx/4xx/5xx, and line/branch/function coverage stays at or above 80% |
| Mutation | `npm run test:mutation` | Seeded defects in retry, backoff, encoding, auth, and error mapping make the owning tests fail |
| Packaging | `npm run build && npm run check:exports` | The packed tarball loads and type-checks as both ESM and CJS |

`npm run check` runs the first two. `npm test` builds, then runs the coverage
gate followed by the mutation gate. CI runs all six.

### Where the contract comes from

```
nervly-gateway/src/**            (Rust handlers + utoipa derivations)
        │  cargo run --bin gen_openapi
        ▼
nervly-docs/static/openapi/gateway.json      committed, drift-gated by the gateway repo
        │  npm run codegen   (openapi-typescript)
        ▼
nervly-sdk/src/generated/gateway.ts          committed, drift-gated by check:codegen
        │  tests/types/conformance.types.ts
        ▼
nervly-sdk/src/types.ts                      the hand-written public types
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

`tests/dual-module.test.ts` is the middle rung between the manifest assertions
and `check:exports`: it asks Node's resolver (`import.meta.resolve` and
`require.resolve`) which build each module system selects, loads that exact file
through the matching loader, and asserts the two builds expose the same runtime
export surface while remaining independent class objects.

---

## 4. Client-contract coverage and mutation testing

### Coverage

`npm run test:coverage` builds (the dual-module suite needs `dist/`), then runs
the suite under Node's built-in V8 coverage scoped to `src/**/*.ts`, failing the
process below any of the thresholds (line 80, branch 80, function 80). It uses
`--test-coverage-include-all`, so a runtime module that no test imports still
appears in the report at 0% instead of silently escaping the threshold. The
type-only files `src/types.ts` and `src/generated/gateway.ts` are excluded —
they have no runtime statements to cover. The thresholds are aggregate, so a
single tiny unimported module can be visible in the report yet not enough to
push the total below 80%; the include-all flag is what guarantees visibility
rather than silence. The last verified run (333 tests, 2026-09-23):

| Metric | Result | Threshold |
| --- | --- | --- |
| Lines | 89.55% | 80% |
| Branches | 93.55% | 80% |
| Functions | 100.00% | 80% |

The line figure dropped from the previously recorded 99.44% when
`src/ai/tools.ts` landed after that run: the module is dominated by type
declarations (covered by `check:types`, excluded from runtime accounting only
for `src/types.ts` and `src/generated/**`, so its runtime half — the catalog,
the strict-schema transforms and the toolkit factory — shows up in the
aggregate), and it sits above the floor without weakening any other file's
signal.

`tests/example-wire.test.ts` pins the runnable example (`examples/basic-usage.ts`)
at the wire level rather than the type level: it boots a real `node:http` stub,
drives the example's exported `runBasicUsage`, and asserts the captured MCP
`tools/call` body's `params` is `{ name: "gateway_status", arguments: {} }` (a
`params: null` regression fails it) and that `signatureValid` is a boolean (a
dropped `await` on `verifySignature` fails it). It never skips, so it runs in
`npm test`; the same call is re-proved against a booted gateway by
`tests/live-contract.test.ts` when its env is present.

`tests/http-contract.test.ts` is what lifts the branch signal: it drives the
real `NervlyHttpClient` against a scripted `fetch` for every public method
(`events.trigger`, `events.triggerBulk`, `events.get`, `events.triggerEmail`,
`email.send`, `messages.list`, `subscribers.delete`,
`subscribers.updatePreferences`, `users.updatePreferences`, `health.check`,
`mcp.listTools`, `mcp.callTool`) across 2xx, non-retryable 4xx, and retryable
5xx responses, and asserts the `Authorization`, `Idempotency-Key`,
`X-Priority-Override`, `User-Agent`, and `Content-Type` headers, the exact
query/URL encoding, and the empty-body rules for GET/DELETE.

`src/retry.ts` extracts the backoff arithmetic — `min(base · 2^attempt + jitter,
30s)`, with a provider `Retry-After` overriding the curve uncapped — into a pure
function so `tests/backoff.test.ts` can assert each boundary exactly rather than
sleeping through it. The same file proves the client *wires* that function up by
capturing the delays it schedules under a pinned `Math.random`.

### Mutation

`npm run test:mutation` (`scripts/mutation-test.mjs`) applies a targeted
condition inversion to a source file, runs only the test file that owns the
behaviour, and requires it to fail. A survivor, a missing anchor string (source
drift), or an unmutated control run that does not pass all exit non-zero. The
last verified run killed 15/15 seeded mutants (score 100%); the machine-readable
run is committed at [`mutation-report.json`](mutation-report.json).

| Mutation | Owning test | Expected |
| --- | --- | --- |
| `attempt < maxRetries` → off by one | `tests/http-contract.test.ts` | killed |
| `attempt < maxRetries` → never retry | `tests/client.test.ts` | killed |
| Exhaustion wrapper `if (false)` | `tests/http-contract.test.ts` | killed |
| Drop `503` from the retryable list | `tests/client.test.ts` | killed |
| Network errors not retryable | `tests/http-contract.test.ts` | killed |
| Remove the `Authorization` header | `tests/http-contract.test.ts` | killed |
| Strip error-body parsing | `tests/http-contract.test.ts` | killed |
| Disable the AbortError/timeout branch | `tests/http-contract.test.ts` | killed |
| Flatten the exponential curve | `tests/backoff.test.ts` | killed |
| Remove jitter | `tests/backoff.test.ts` | killed |
| Remove the 30s ceiling | `tests/backoff.test.ts` | killed |
| Stop encoding the subscriber id | `tests/http-contract.test.ts` | killed |
| Stop encoding the event id | `tests/http-contract.test.ts` | killed |
| Skip the `Idempotency-Key` header | `tests/http-contract.test.ts` | killed |
| Drop the `subscriber_id` query filter | `tests/http-contract.test.ts` | killed |

Stryker is intentionally not a dependency: the runner is Node's built-in
`node:test` via `tsx`, so Stryker's command runner would boot a fresh full suite
per mutant. The harness keeps the feedback loop to seconds and the seeded
mutations readable in review.

---

## 5. Running everything

```bash
npm install
npm run check           # codegen drift + type-level conformance + typecheck
npm test                # build → coverage thresholds → mutation gate
npm run test:coverage   # builds, then the coverage gate (standalone)
npm run test:mutation   # mutation gate only (no build needed)
npm run build
npm run check:exports
```

