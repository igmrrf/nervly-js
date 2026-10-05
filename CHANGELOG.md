# Changelog

All notable changes to `@nervly/sdk` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-05

### Added

- Typed client for the Nervly gateway: `events.trigger`, `events.triggerBulk`, `events.get`, `messages.list`, `subscribers.erase`, `preferences.update`, `health.check`, and webhook signature verification and parsing.
- Types generated from the same OpenAPI contract the gateway publishes, with compile-time assertions that the hand-written public types stay equivalent to the spec.
- Dual ESM and CommonJS builds with zero runtime dependencies, on Node.js 24+ and any runtime with `fetch` and WebCrypto.
- Strict, discriminated error types for every documented failure mode.
- `events.trigger` now auto-generates a unique `Idempotency-Key` when the caller passes none, so a retried trigger cannot double-send. An explicit `options.idempotencyKey` still wins, and the generated key is reused across the SDK's internal retries of the same call.
- A repository `LICENSE` (MIT, Copyright (c) 2026 Nervly) is shipped in the published tarball, and the published `files[]` now also includes `src` so the shipped source maps resolve. `package.json` now declares `repository`, `homepage`, `bugs` and `keywords` so npm and provenance can point back at `igmrrf/nervly-js`.
- `NervlyWebhookSignatureError` (alias `WebhookSignatureError`), thrown by `webhooks.verifyAndParse` when a signature does not verify.
- Voice channel support: the `Channel` const/type (`Channel.VOICE`), the `VoiceOverride` wire type (`script`, `voice_id`, `language`), `ProviderOverrides.voice`, and a typed `voice.send` resource with `SendVoiceOptions` / `VoiceSendRequest`.
- Sender-identity management: the `nervly.senders` resource (`list`, `get`, `create`, `addBinding`, `verifyBinding`, `removeBinding`, `remove`) against the control plane's public `/v1/senders` API, the `managementUrl` config option (default `https://console.nervly.io`), and the exported `SenderIdentity`, `SenderBinding`, `SenderChannel`, `IdentityUnit`, `VerificationSource`, `VerificationState`, `DnsRecord`, `CreateSenderInput`, `CreateBindingInput`, `SenderBindingResult`, `CreateSenderResponse`, `VerifyBindingResponse`, `ListSendersParams` and `ListSendersResponse` types.

### Changed

- The email helper's from-address option is now `from` (was `sender`): `SendEmailOptions.from` and `EmailOverride.from` compile to the canonical `overrides.email.from` wire field. The SDK emits no other email sender spelling.
- `NervlyHttpClient` validates `maxRetries` (non-negative integer) and `timeout`/`retryBaseDelay` (positive finite numbers when supplied), throwing a `NervlyError` with a clear message instead of accepting values that break the retry loop or abort timer. Defaults now apply only when a field is `undefined`.
- `webhooks.verifySignature` uses the runtime-neutral WebCrypto HMAC-SHA256 primitive with a constant-time comparison instead of `node:crypto` and `Buffer`, so the helper runs unchanged in Node, browsers and edge runtimes. `WebhookVerifyOptions.payload` and `parse(rawBody)` accept `string | Uint8Array`.
- A 2xx response with an empty body now returns `{}` (matching `204`), and malformed JSON throws a `NervlyError` instead of leaking a raw `SyntaxError`.
- `package.json` declares the Node floor as `>=24.0.0`, matching the README; CI exercises both Node 24 and 26, installs with `npm ci` from the locked tree (was `npm install`), and `check:exports` builds the package before packing so `npm run verify` includes the packaging proof.
- The changelog compare/tag links now point at `igmrrf/nervly-js`.

### Removed

- The deprecated umbrella `sender` property from `EmailOverride` and `SmsOverride` wire types, and the `SendEmailOptions.sender` convenience option. The gateway removed the proto field (tag 1 reserved, ticket 32); the canonical fields are `from`/`from_name` (email) and `sender_id` (SMS).

### Fixed

- `check:release` now fails when `repository.url` is missing or not the GitHub repo, when `LICENSE` is absent from disk or `files[]`, or when the `engines.node` major disagrees with the Node floor in the README.

[Unreleased]: https://github.com/igmrrf/nervly-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/igmrrf/nervly-js/releases/tag/v0.1.0
