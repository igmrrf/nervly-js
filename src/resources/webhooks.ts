import { NervlyWebhookSignatureError } from "../errors.js";
import type {
	DeliveryStatus,
	WebhookPayload,
	WebhookVerifyOptions,
} from "../types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The hex digest of an HMAC-SHA256 signature: 32 bytes, 64 hex characters. */
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

function payloadBytes(payload: string | Uint8Array): Uint8Array<ArrayBuffer> {
	const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
	// Copy into a fresh ArrayBuffer-backed view: WebCrypto's `BufferSource` does
	// not accept a view that may sit on a SharedArrayBuffer.
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

/**
 * Constant-time comparison of two hex digests. Length and character-set checks
 * happen first (they are public information), then every character is folded
 * into one accumulator so a mismatching prefix cannot be timed.
 */
function timingSafeHexEqual(a: string, b: string): boolean {
	if (!HEX_SHA256.test(a) || !HEX_SHA256.test(b)) {
		return false;
	}
	const left = a.toLowerCase();
	const right = b.toLowerCase();
	let diff = 0;
	for (let index = 0; index < left.length; index++) {
		diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return diff === 0;
}

/**
 * Signature verification and parsing helpers for delivery webhooks.
 *
 * **Nervly does not send direct outbound delivery webhooks yet.** They are
 * explicitly out of scope for the launch surface — poll `events.get(eventId)`
 * or `messages.list()` for delivery state, or run the launch-scope
 * `nervly forward webhooks` tunnel. These helpers ship ahead of the feature so
 * that an integration written today keeps working when direct webhooks land,
 * and so the verification logic is reviewed once rather than reimplemented by
 * every caller. Nothing will arrive at your endpoint until then.
 */
export class WebhooksResource {
	/**
	 * Verify a webhook signature from a delivery provider.
	 * Uses the WebCrypto HMAC-SHA256 primitive with a constant-time comparison
	 * to prevent timing attacks. Runs in Node, browsers and edge runtimes.
	 *
	 * @param options - The verification options (provider, payload, signature, secret)
	 * @returns true if the signature is valid
	 */
	async verifySignature(options: WebhookVerifyOptions): Promise<boolean> {
		const { payload, signature, secret } = options;

		if (secret.length === 0) {
			return false;
		}

		let digest: Uint8Array;
		try {
			const key = await globalThis.crypto.subtle.importKey(
				"raw",
				encoder.encode(secret),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			digest = new Uint8Array(
				await globalThis.crypto.subtle.sign("HMAC", key, payloadBytes(payload)),
			);
		} catch {
			throw new NervlyWebhookSignatureError(options.provider);
		}

		return timingSafeHexEqual(bytesToHex(digest), signature);
	}

	/**
	 * Parse a raw webhook body into a typed WebhookPayload.
	 *
	 * Normalizes a `status` to its uppercase DeliveryStatus spelling and leaves
	 * the rest of the body untouched. This is a parser, not a validator: it
	 * does not check that the body is a real delivery receipt.
	 *
	 * @param rawBody - The raw request body (string or Uint8Array)
	 * @returns Parsed webhook payload
	 */
	parse(rawBody: string | Uint8Array): WebhookPayload {
		const bodyStr =
			typeof rawBody === "string" ? rawBody : decoder.decode(rawBody);

		const parsed = JSON.parse(bodyStr) as WebhookPayload;

		// Normalize status to uppercase DeliveryStatus
		if (parsed.status) {
			parsed.status = parsed.status.toUpperCase() as DeliveryStatus;
		}

		return parsed;
	}

	/**
	 * Verify signature and parse in a single step.
	 *
	 * @throws {NervlyWebhookSignatureError} when the signature does not verify.
	 */
	async verifyAndParse(options: WebhookVerifyOptions): Promise<WebhookPayload> {
		const isValid = await this.verifySignature(options);
		if (!isValid) {
			throw new NervlyWebhookSignatureError(options.provider);
		}
		return this.parse(options.payload);
	}
}
