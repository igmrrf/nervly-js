# Security Policy — `@nervly/sdk`

The `@nervly/sdk` package is the client half of Nervly's public API surface. A
vulnerability here can leak a workspace's API key, forge or replay a request, or
cause an integration to trust a response it should not. We welcome reports from
independent researchers and from anyone who depends on the package.

For the hosted platform (`api.nervly.io`, `app.nervly.io`, cross-tenant
isolation, billing, and the rest of the service), see the platform policy at
[`../SECURITY.md`](../SECURITY.md). This document covers the published npm
package and its release pipeline.

## Reporting a vulnerability

**Do not open a public GitHub issue, pull request, or discussion for a security problem.**

Email **security@nervly.io** with a description of the issue and the steps to
reproduce it. If you prefer encrypted email, ask for our PGP key in your first
message and we will reply with it.

Please include, where you can:

- The affected package version (`npm ls @nervly/sdk`) and runtime (Node.js
  version, bundler, or edge runtime).
- A description of the vulnerability and its impact.
- A minimal reproduction or proof-of-concept.
- Any conditions required to exploit it (a crafted API response, a malicious
  proxy, a specific `baseUrl`).

Do not test against the production service with real credentials or send to
real recipients. A **Test mode API key** (`nerve_sk_test_...`) exists for
verifying findings against your own workspace.

## Our commitments

| Stage | Target |
|---|---|
| Acknowledgement of your report | Within 2 business days |
| Initial triage and severity assessment | Within 5 business days |
| Status update cadence while a fix is in progress | Every 7 calendar days |
| Patch release for critical issues | As fast as the severity warrants; we will agree a disclosure date with you |

We will keep you informed, tell you if we cannot reproduce the issue, and credit
you in the `CHANGELOG.md` entry for the fix unless you ask us not to. Because
SDK releases are published with provenance, the fix will carry a verifiable
attestation linking the tarball to the commit it was built from.

## Disclosure

We follow coordinated disclosure. We ask that you give us a reasonable window to
ship a fix before publishing your findings, and we will not take legal action
against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  service degradation.
- Only interact with accounts and workspaces they own or have explicit
  permission to test.
- Do not exfiltrate data, pivot into other tenants, or use social engineering
  against Nervly staff or customers.
- Report promptly and do not exploit a finding beyond what is needed to
  demonstrate it.

This is a safe-harbour statement: activity conducted in line with the above is
authorised, and we will not pursue or support legal action against you for it.

## In scope

- The published `@nervly/sdk` tarball and its ESM/CommonJS builds.
- Signature verification and webhook parsing (`nerve.webhooks.*`).
- Credential handling: API keys reaching logs, telemetry, errors, or the
  `User-Agent`/query string.
- The release pipeline: `npm publish` provenance, the tagged release workflow,
  and the SBOM this repository attaches to a release.
- Dependency-chain issues that originate in the SDK's own build or publish
  tooling.

## Out of scope

- The hosted Nervly platform and its APIs — report those under the platform
  policy instead.
- Findings that require a compromised device, a malicious browser extension, or
  physical access.
- Volumetric denial-of-service against the service.
- Reports generated solely by an automated scanner with no demonstrated impact.
- Vulnerabilities in a transitive dependency that is already fixed upstream and
  reachable only in a dev dependency.

## Supported versions

The SDK is published from a single line; the latest published `0.x` release is
the supported version. Pre-1.0, the API surface is unstable but security fixes
still land as patch releases on the current minor. Each release is recorded in
[`CHANGELOG.md`](CHANGELOG.md).
