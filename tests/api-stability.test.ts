import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as sdk from "../src/index.js";
import {
	AuthenticationError,
	NervlyApiError,
	NervlyAuthenticationError,
	NervlyError,
	NervlyIdempotencyError,
	NervlyNetworkError,
	NervlyNotFoundError,
	NervlyRateLimitError,
	NervlyRetryExhaustedError,
	NervlyServerError,
	NervlyValidationError,
	NervlyWebhookSignatureError,
	RateLimitError,
	ValidationError,
	WebhookSignatureError,
} from "../src/index.js";
import { SDK_VERSION } from "../src/version.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

describe("Error hierarchy", () => {
	it("should root every SDK error at NervlyError", () => {
		const errors: NervlyError[] = [
			new NervlyApiError(418, "TEAPOT", "teapot"),
			new NervlyAuthenticationError(),
			new NervlyValidationError("bad"),
			new NervlyNotFoundError(),
			new NervlyIdempotencyError(),
			new NervlyRateLimitError(),
			new NervlyServerError(),
			new NervlyNetworkError("offline"),
			new NervlyRetryExhaustedError(3, new Error("last")),
			new NervlyWebhookSignatureError("termii"),
		];

		for (const error of errors) {
			assert.ok(
				error instanceof NervlyError,
				`${error.name} is not a NervlyError`,
			);
			assert.ok(error instanceof Error);
			assert.equal(typeof error.name, "string");
			assert.ok(error.message.length > 0);
		}
	});

	it("should keep `instanceof` working across the prototype chain", () => {
		assert.ok(new NervlyAuthenticationError() instanceof NervlyApiError);
		assert.ok(new NervlyRateLimitError() instanceof NervlyApiError);
		assert.ok(new NervlyNotFoundError() instanceof NervlyApiError);
		assert.ok(new NervlyServerError() instanceof NervlyApiError);
		// A network error is not an API error: no response ever arrived.
		assert.ok(!(new NervlyNetworkError("offline") instanceof NervlyApiError));
	});

	it("should expose short aliases that are the same class object", () => {
		assert.equal(AuthenticationError, NervlyAuthenticationError);
		assert.equal(RateLimitError, NervlyRateLimitError);
		assert.equal(ValidationError, NervlyValidationError);
		assert.equal(sdk.ApiError, NervlyApiError);
		assert.equal(sdk.NotFoundError, NervlyNotFoundError);
		assert.equal(sdk.IdempotencyError, NervlyIdempotencyError);
		assert.equal(sdk.ServerError, NervlyServerError);
		assert.equal(sdk.NetworkError, NervlyNetworkError);
		assert.equal(sdk.RetryExhaustedError, NervlyRetryExhaustedError);
		assert.equal(sdk.NervlySdkError, NervlyError);
		assert.equal(WebhookSignatureError, NervlyWebhookSignatureError);

		// The alias catches what the long name throws.
		const caught: unknown = (() => {
			try {
				throw new NervlyAuthenticationError();
			} catch (error) {
				return error;
			}
		})();

		assert.ok(caught instanceof AuthenticationError);
	});

	it("should carry status-specific metadata", () => {
		assert.equal(new NervlyAuthenticationError().statusCode, 401);
		assert.equal(new NervlyValidationError("bad").statusCode, 400);
		assert.equal(new NervlyNotFoundError().statusCode, 404);
		assert.equal(new NervlyIdempotencyError().statusCode, 409);
		assert.equal(new NervlyRateLimitError("slow", 7000).retryAfterMs, 7000);
		assert.equal(new NervlyServerError("boom", 502).statusCode, 502);
		assert.equal(
			new NervlyApiError(499, "CLIENT_CLOSED", "gone", "req_1").requestId,
			"req_1",
		);
	});

	it("should keep the last error on RetryExhaustedError", () => {
		const last = new NervlyServerError("db down", 503);
		const error = new NervlyRetryExhaustedError(3, last);
		assert.equal(error.attempts, 3);
		assert.equal(error.lastError, last);
		assert.match(error.message, /All 3 retry attempts exhausted/);
	});
});

describe("Dual ESM/CJS distribution", () => {
	const pkg = JSON.parse(
		readFileSync(resolve(currentDir, "../package.json"), "utf-8"),
	) as {
		version: string;
		type: string;
		main: string;
		module: string;
		types: string;
		exports: Record<string, Record<string, { types: string; default: string }>>;
	};

	it("should declare the SDK version taken from the manifest", () => {
		assert.equal(SDK_VERSION, pkg.version);
	});

	it("should route import and require to separate builds", () => {
		assert.equal(pkg.type, "module");
		assert.equal(pkg.exports["."]!.import!.default, "./dist/esm/index.js");
		assert.equal(pkg.exports["."]!.require!.default, "./dist/cjs/index.js");
		// Each condition carries the declarations that match its module system.
		assert.match(pkg.exports["."]!.import!.types, /dist\/esm\/.*\.d\.ts$/);
		assert.match(pkg.exports["."]!.require!.types, /dist\/cjs\/.*\.d\.ts$/);
		// Legacy resolvers fall back to the CJS build via `main`, and to the ESM
		// build via `module`.
		assert.equal(pkg.main, "./dist/cjs/index.js");
		assert.equal(pkg.module, "./dist/esm/index.js");
	});

	it("should ship both builds with the right module marker in each", async () => {
		const fs = await import("node:fs");

		for (const [dir, type] of [
			["../dist/esm", "module"],
			["../dist/cjs", "commonjs"],
		] as const) {
			const resolved = resolve(currentDir, dir);
			assert.ok(
				fs.existsSync(resolved),
				`${dir} is missing — run \`npm run build\``,
			);

			const marker = JSON.parse(
				fs.readFileSync(resolve(resolved, "package.json"), "utf-8"),
			) as {
				type: string;
			};
			assert.equal(
				marker.type,
				type,
				`${dir}/package.json must declare type=${type}`,
			);

			for (const file of [
				"index.js",
				"index.d.ts",
				"errors.js",
				"types.d.ts",
			]) {
				assert.ok(
					fs.existsSync(resolve(resolved, file)),
					`${dir}/${file} is missing from the published build`,
				);
			}
		}
	});

	it("should have no runtime dependencies beyond the platform fetch", () => {
		const manifest = JSON.parse(
			readFileSync(resolve(currentDir, "../package.json"), "utf-8"),
		) as { dependencies?: Record<string, string> };

		assert.deepEqual(manifest.dependencies ?? {}, {});
	});
});

describe("Webhook helpers — signing round trip used by the docs", () => {
	it("should verify a signature produced with node:crypto", async () => {
		const { WebhooksResource } = await import("../src/resources/webhooks.js");
		const webhooks = new WebhooksResource();

		const secret = "whsec_test_123";
		const payload = JSON.stringify({
			message_id: "evt_1",
			status: "delivered",
		});
		const signature = createHmac("sha256", secret)
			.update(payload)
			.digest("hex");

		assert.equal(
			await webhooks.verifySignature({
				provider: "resend",
				payload,
				signature,
				secret,
			}),
			true,
		);
	});
});
