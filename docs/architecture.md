# nerve-sdk Architecture

`@nervehq/sdk` is a lightweight, zero-runtime-dependency TypeScript client library designed for serverless, Node.js, and edge runtimes (Cloudflare Workers, Vercel Edge).

---

## 1. Design Principles (ADR-005)

- **Zero Bloat:** Uses native `fetch` with no third-party HTTP dependencies (Axios, Got, Request).
- **Dual Build:** Produces ES Modules (`import`) and CommonJS (`require`) builds with accompanying `.d.ts` declaration maps.
- **Fail-Safe Retries:** Automatic linear backoff for transient 502/503/504 gateway responses, with configurable timeout ceiling.
- **Typed Errors:** Structured `NerveError` subclass hierarchy: `AuthenticationError` (401), `ForbiddenError` (403), `RateLimitError` (429), `ValidationError` (400), `ServerError` (5xx).
