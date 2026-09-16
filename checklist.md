# nerve-sdk Checklist

TypeScript `@nervehq/sdk` client library (npm). Primary responsibility: **API Stability & Contract Correctness**.
Parent checklist: [`../checklist.md`](../checklist.md)

## Tests
- [ ] Unit tests on all public methods, retries, error mapping
- [ ] Contract tests against live `nerve-control-plane` (Pact or similar)
- [ ] Type-level tests (expect-type / tsd) for public API surface

## API Stability (SDK is a public commitment)
- [ ] SemVer enforced; breaking changes only in major releases
- [ ] Deprecation policy: warn one minor before removal
- [ ] CHANGELOG.md maintained every release
- [ ] Version aligned with control-plane API version; compatibility matrix published

## Security
- [ ] No secrets in examples; docs show env-var usage
- [ ] npm provenance + signed releases; `npm publish --provenance`
- [ ] Dependency audit in CI; SBOM for the package
- [ ] SECURITY.md + vulnerability disclosure policy

## Documentation (external)
- [ ] README quickstart matches `nerve-docs`
- [ ] Examples (`examples/`) tested in CI

## Read
- [SemVer](https://semver.org/) · [Pact contract testing](https://docs.pact.io/) · [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
