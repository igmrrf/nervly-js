import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
	NervlyError,
	NervlyWebhookSignatureError,
	WebhookSignatureError,
} from "../src/errors.js";
import { WebhooksResource } from "../src/resources/webhooks.js";

describe("WebhooksResource", () => {
	const webhooks = new WebhooksResource();

	describe("verifySignature", () => {
		it("should return true for a valid HMAC-SHA256 signature", async () => {
			const secret = "test_webhook_secret";
			const payload = JSON.stringify({
				message_id: "msg_123",
				status: "DELIVERED",
			});
			const signature = createHmac("sha256", secret)
				.update(payload)
				.digest("hex");

			const result = await webhooks.verifySignature({
				provider: "termii",
				payload,
				signature,
				secret,
			});

			assert.equal(result, true);
		});

		it("should return false for an invalid signature", async () => {
			const result = await webhooks.verifySignature({
				provider: "termii",
				payload: '{"test": true}',
				signature: "invalid_signature_hex",
				secret: "secret",
			});

			assert.equal(result, false);
		});

		it("should return false for a tampered payload", async () => {
			const secret = "test_secret";
			const originalPayload = '{"status": "DELIVERED"}';
			const signature = createHmac("sha256", secret)
				.update(originalPayload)
				.digest("hex");

			const result = await webhooks.verifySignature({
				provider: "termii",
				payload: '{"status": "FAILED"}', // tampered
				signature,
				secret,
			});

			assert.equal(result, false);
		});

		it("should return false for a same-length signature with the wrong value", async () => {
			// A well-formed 64-hex digest, so the failure comes from the timing-safe
			// comparison rather than a length guard.
			const result = await webhooks.verifySignature({
				provider: "termii",
				payload: '{"status": "DELIVERED"}',
				signature: "f".repeat(64),
				secret: "test_secret",
			});

			assert.equal(result, false);
		});

		it("should return false when the signature is shorter than the digest", async () => {
			const result = await webhooks.verifySignature({
				provider: "termii",
				payload: '{"status": "DELIVERED"}',
				signature: "ab",
				secret: "test_secret",
			});

			assert.equal(result, false);
		});

		it("should return false for a non-hex signature without throwing", async () => {
			const result = await webhooks.verifySignature({
				provider: "termii",
				payload: '{"status": "DELIVERED"}',
				signature: "not-hex-at-all",
				secret: "test_secret",
			});

			assert.equal(result, false);
		});

		it("should return false for an empty secret instead of rejecting", async () => {
			const result = await webhooks.verifySignature({
				provider: "termii",
				payload: '{"status": "DELIVERED"}',
				signature: "0".repeat(64),
				secret: "",
			});

			assert.equal(result, false);
		});

		it("should reject with NervlyWebhookSignatureError when WebCrypto fails", async () => {
			const original = globalThis.crypto.subtle.importKey;
			globalThis.crypto.subtle.importKey = () => {
				throw new DOMException("boom", "OperationError");
			};

			try {
				const error = await webhooks
					.verifySignature({
						provider: "termii",
						payload: '{"status": "DELIVERED"}',
						signature: "0".repeat(64),
						secret: "test_secret",
					})
					.then(
						() => null,
						(e: unknown) => e,
					);

				assert.ok(error instanceof NervlyWebhookSignatureError);
				assert.ok(error instanceof NervlyError);
				assert.equal(error.provider, "termii");
			} finally {
				globalThis.crypto.subtle.importKey = original;
			}
		});

		it("should accept a Uint8Array payload without Buffer or node:crypto", async () => {
			const secret = "bytes_secret";
			const payload = new TextEncoder().encode('{"status":"DELIVERED"}');
			const signature = createHmac("sha256", secret)
				.update(payload)
				.digest("hex");

			const result = await webhooks.verifySignature({
				provider: "termii",
				payload,
				signature,
				secret,
			});

			assert.equal(result, true);
		});

		it("should accept an uppercase hex signature", async () => {
			const secret = "case_secret";
			const payload = '{"status": "DELIVERED"}';
			const signature = createHmac("sha256", secret)
				.update(payload)
				.digest("hex")
				.toUpperCase();

			const result = await webhooks.verifySignature({
				provider: "termii",
				payload,
				signature,
				secret,
			});

			assert.equal(result, true);
		});
	});

	describe("parse", () => {
		it("should parse a valid webhook payload", () => {
			const raw = JSON.stringify({
				message_id: "msg_456",
				recipient: "+2348012345678",
				status: "delivered",
				channel: "sms",
				latency_ms: 120,
				cost: 0.005,
			});

			const result = webhooks.parse(raw);
			assert.equal(result.message_id, "msg_456");
			assert.equal(result.status, "DELIVERED"); // normalized to uppercase
			assert.equal(result.channel, "sms");
		});

		it("should parse Buffer payloads", () => {
			const payload = { message_id: "msg_789", status: "SENT" };
			const buffer = Buffer.from(JSON.stringify(payload));

			const result = webhooks.parse(buffer);
			assert.equal(result.message_id, "msg_789");
			assert.equal(result.status, "SENT");
		});

		it("should parse Uint8Array payloads", () => {
			const payload = { message_id: "msg_bytes", status: "sent" };
			const bytes = new TextEncoder().encode(JSON.stringify(payload));

			const result = webhooks.parse(bytes);
			assert.equal(result.message_id, "msg_bytes");
			assert.equal(result.status, "SENT");
		});

		it("should leave an absent status undefined and preserve an uppercase one", () => {
			assert.equal(
				webhooks.parse('{"message_id":"msg_no_status"}').status,
				undefined,
			);
			assert.equal(
				webhooks.parse('{"status":"BOUNCED_HARD"}').status,
				"BOUNCED_HARD",
			);
		});
	});

	describe("verifyAndParse", () => {
		it("should verify and parse in one step", async () => {
			const secret = "combined_test_secret";
			const payload = JSON.stringify({
				message_id: "msg_combo",
				status: "CLICKED",
			});
			const signature = createHmac("sha256", secret)
				.update(payload)
				.digest("hex");

			const result = await webhooks.verifyAndParse({
				provider: "twilio",
				payload,
				signature,
				secret,
			});

			assert.equal(result.message_id, "msg_combo");
			assert.equal(result.status, "CLICKED");
		});

		it("should throw NervlyWebhookSignatureError on invalid signature", async () => {
			const error = await webhooks
				.verifyAndParse({
					provider: "termii",
					payload: '{"test": true}',
					signature: "bad_sig",
					secret: "secret",
				})
				.then(
					() => null,
					(e: unknown) => e,
				);

			assert.ok(error instanceof NervlyWebhookSignatureError);
			assert.ok(error instanceof NervlyError);
			assert.equal(error.provider, "termii");
			assert.match(error.message, /Invalid webhook signature/);
			assert.equal(WebhookSignatureError, NervlyWebhookSignatureError);
		});

		it("should reject with NervlyWebhookSignatureError for an empty secret", async () => {
			const error = await webhooks
				.verifyAndParse({
					provider: "termii",
					payload: '{"status": "DELIVERED"}',
					signature: "0".repeat(64),
					secret: "",
				})
				.then(
					() => null,
					(e: unknown) => e,
				);

			assert.ok(error instanceof NervlyWebhookSignatureError);
			assert.ok(error instanceof NervlyError);
			assert.equal(error.provider, "termii");
		});
	});
});
