/**
 * The SDK's own version.
 *
 * Kept as a literal so the ESM and CJS bundles agree without either one having
 * to read `package.json` at runtime. `tests/spec-conformance.test.ts` asserts
 * it stays in step with the published version, and it is what the
 * `User-Agent` header reports.
 */
export const SDK_VERSION = "0.1.0";
