import type { NervlyHttpClient } from "../client.js";
import type {
	ProviderOverrides,
	Recipient,
	SendVoiceOptions,
	TriggerEventOptions,
	TriggerEventRequest,
	TriggerEventResponse,
	VoiceOverride,
} from "../types.js";

export class VoiceResource {
	constructor(private readonly client: NervlyHttpClient) {}

	/**
	 * Send a Voice OTP or spoken notification.
	 * Maps to: POST /v1/events/trigger configured for the voice channel.
	 *
	 * Voice is opt-in per event: the request always carries `overrides.voice`,
	 * which is what makes the channel eligible. Supplying a partial override
	 * merges with anything already on `overrides.voice`.
	 *
	 * @param request - Spoken script, recipient, and voice options
	 * @param options - Optional trigger options (idempotency key, priority override)
	 */
	async send(
		request: SendVoiceOptions,
		options?: TriggerEventOptions,
	): Promise<TriggerEventResponse> {
		const triggerRequest = this.buildTriggerRequest(request);

		const headers: Record<string, string> = {};
		const idempotencyKey = options?.idempotencyKey || request.idempotencyKey;
		if (idempotencyKey) {
			headers["Idempotency-Key"] = idempotencyKey;
		}

		const priority = options?.priority || request.priority;
		if (priority) {
			headers["X-Priority-Override"] = priority;
		}

		return this.client.post<TriggerEventResponse>(
			"/v1/events/trigger",
			triggerRequest,
			headers,
		);
	}

	/**
	 * Helper to construct a conforming TriggerEventRequest from SendVoiceOptions.
	 *
	 * Only the voice fields the caller actually provided are emitted, so an
	 * omitted `voice_id` or `language` is left for the workspace default instead
	 * of being sent as an empty string.
	 */
	public buildTriggerRequest(request: SendVoiceOptions): TriggerEventRequest {
		const to: Recipient =
			typeof request.to === "string"
				? { subscriberId: request.to, phone: request.to }
				: {
						subscriberId:
							request.to.subscriberId || request.to.phone || "unknown",
						email: request.to.email,
						phone: request.to.phone,
						deviceTokens: request.to.deviceTokens,
					};

		const payload: Record<string, unknown> = { ...(request.payload || {}) };

		const voiceOverride: VoiceOverride = {
			...(request.overrides?.voice ?? {}),
			script: request.script,
			...(request.voice_id !== undefined ? { voice_id: request.voice_id } : {}),
			...(request.language !== undefined ? { language: request.language } : {}),
		};

		const overrides: ProviderOverrides = {
			...(request.overrides || {}),
			voice: voiceOverride,
		};

		return {
			name: request.name || "transactional-voice",
			to,
			payload,
			overrides,
			category: request.category || "transactional",
		};
	}
}
