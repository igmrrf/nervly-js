# nervly-sdk Architecture

`@nervly/sdk` is a lightweight, zero-runtime-dependency TypeScript client library designed for serverless, Node.js, and edge runtimes (Cloudflare Workers, Vercel Edge).

---

## 1. Design Principles (ADR-005)

- **Zero Bloat:** Native `fetch` only. No Axios, Got, or Request; `dependencies` is `{}` and is asserted to stay that way by `tests/api-stability.test.ts`.
- **Dual Build:** `import` resolves `dist/esm/`, `require` resolves `dist/cjs/`, each with its own `.d.ts`. See §3.
- **Fail-Safe Retries:** Exponential backoff with jitter for transient failures (429, 500, 502, 503, 504) and network errors, capped at 30s. A 429 that carried `Retry-After` waits exactly that long instead.
- **Typed Errors:** Every failure is a `NervlyError`. See §4.

---

## 2. Module layout

```
src/
  index.ts          public surface: the `Nervly` class, resource getters, all exported types and errors
  client.ts         NervlyHttpClient — auth, retries, timeouts, error classification
  errors.ts         the error hierarchy and its short aliases
  types.ts          the hand-written public types (the contract, mirrored from the spec)
  version.ts        SDK_VERSION, the single literal the User-Agent and packaging test agree on
  generated/        gateway.ts — do not edit; produced by `npm run codegen`
  resources/        one class per resource: events, email, messages, subscribers, users, health, mcp, webhooks
tests/
  *.test.ts         runtime suites (node:test via tsx)
  types/            compile-only contract assertions against the generated spec
  helpers/          a typed NervlyHttpClient stand-in
```

Resources are thin: each one turns arguments into a path, a body, and headers,
then hands off to `NervlyHttpClient`. No resource talks to a socket directly,
which is why the whole suite runs without a server.

---

## 3. Dual build

```
tsconfig.json        editor/typecheck config; noEmit
tsconfig.esm.json    → dist/esm   (module: NodeNext)
tsconfig.cjs.json    → dist/cjs   (module: CommonJS)
tsconfig.check.json  src + tests + examples + scripts, noEmit — what `npm run check:types` uses
```

`scripts/build.mjs` runs the two compile passes and writes a one-line
`package.json` into each output directory declaring its own `type`. The nearest
manifest is what decides how Node interprets the `.js` files beside it, so the
root package can stay `"type": "module"` while `dist/cjs` remains CommonJS — no
`rename to .cjs` step, no bundler.

`exports["."]` maps `import` and `require` to their own build *and* their own
declarations:

```jsonc
"exports": {
  ".": {
    "import": { "types": "./dist/esm/index.d.ts", "default": "./dist/esm/index.js" },
    "require": { "types": "./dist/cjs/index.d.ts", "default": "./dist/cjs/index.js" }
  },
  "./package.json": "./package.json"
}
```

Matching declarations per condition matters under `node16`/`nodenext`: a single
shared `.d.ts` describes the module format of the file it sits beside, so
pointing a CJS consumer at ESM declarations produces interop errors even though
the JavaScript would load. `npm run check:exports` proves both halves by
installing the packed tarball into a scratch project and resolving it as ESM,
CJS, `.mts`, and `.cts` (see `docs/testing_and_conformance.md` §3).

A note on `require(esm)`: Node ≥ 22.12 will happily `require()` an ES module, so
"it loaded" is not evidence that the CJS build was used. The packaging check
therefore asserts on the *resolved file path*.

---

## 4. Error hierarchy

```
NervlyError
├── NervlyApiError                     a response arrived, with a non-2xx status
│   ├── NervlyAuthenticationError      401
│   ├── NervlyValidationError          400
│   ├── NervlyNotFoundError            404
│   ├── NervlyIdempotencyError         409
│   ├── NervlyRateLimitError           429  (+ retryAfterMs)
│   └── NervlyServerError              5xx  (+ statusCode as received)
├── NervlyNetworkError                 no response: DNS, TLS, refused, timeout (+ cause)
├── NervlyRetryExhaustedError          retries ran and all failed (+ attempts, lastError)
└── NervlyWebhookSignatureError        an inbound webhook signature did not verify (+ provider)
```

Every status-specific class has a short alias (`AuthenticationError`,
`RateLimitError`, …), and `NervlyWebhookSignatureError` has the alias
`WebhookSignatureError`; each alias is the *same class object*, so `instanceof`
behaves identically whichever spelling you import. Both are exported; new code
should prefer the aliases.

`NervlyApiError` carries `statusCode`, `errorType` (the gateway's machine-readable
code, or `UNKNOWN_ERROR`), and `requestId` when the response sent
`x-request-id`.

Two distinctions worth knowing, because they are the reason the classes exist:

- **`NervlyRetryExhaustedError` vs the underlying error.** A retryable failure
  raises the exhausted wrapper *only when retries actually ran and all of them
  failed*; the last error is on `lastError`. A 503 on a client configured with
  `maxRetries: 0` — and any non-retryable status such as 400 or 404 — is thrown
  as-is, because you were only told once.
- **`NervlyNetworkError` is not a `NervlyApiError`.** No response arrived, so there
  is no status code to report and no server-side request id to quote.
