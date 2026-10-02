# Changelog

All notable changes to `@nervly/sdk` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Voice channel support: the `Channel` const/type (`Channel.VOICE`), the `VoiceOverride` wire type (`script`, `voice_id`, `language`), `ProviderOverrides.voice`, and a typed `voice.send` resource with `SendVoiceOptions` / `VoiceSendRequest`.
- Sender-identity management: the `nervly.senders` resource (`list`, `get`, `create`, `addBinding`, `verifyBinding`, `removeBinding`, `remove`) against the control plane's public `/v1/senders` API, the `managementUrl` config option (default `https://console.nervly.io`), and the exported `SenderIdentity`, `SenderBinding`, `SenderChannel`, `IdentityUnit`, `VerificationSource`, `VerificationState`, `DnsRecord`, `CreateSenderInput`, `CreateBindingInput`, `SenderBindingResult`, `CreateSenderResponse`, `VerifyBindingResponse`, `ListSendersParams` and `ListSendersResponse` types.

## [0.1.0] - 2026-09-17

### Added

- Typed client for the Nervly gateway: `events.trigger`, `events.triggerBulk`, `events.get`, `messages.list`, `subscribers.erase`, `preferences.update`, `health.check`, and webhook signature verification and parsing.
- Types generated from the same OpenAPI contract the gateway publishes, with compile-time assertions that the hand-written public types stay equivalent to the spec.
- Dual ESM and CommonJS builds with zero runtime dependencies, on Node.js 24+ and any runtime with `fetch` and WebCrypto.
- Strict, discriminated error types for every documented failure mode.

[Unreleased]: https://github.com/igmrrf/nervly-sdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/igmrrf/nervly-sdk/releases/tag/v0.1.0
