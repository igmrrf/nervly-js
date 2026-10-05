import type { NervlyHttpClient } from "../client.js";
import type {
	BulkTriggerRequest,
	BulkTriggerResponse,
	MessageDto,
	TriggerEventOptions,
	TriggerEventRequest,
	TriggerEventResponse,
} from "../types.js";

/** A fresh idempotency key for one logical trigger call. */
function generateIdempotencyKey(): string {
	return globalThis.crypto.randomUUID();
}

export class EventsResource {
	constructor(private readonly client: NervlyHttpClient) {}

	/**
	 * Trigger a single notification event.
	 * Maps to: POST /v1/events/trigger
	 *
	 * A unique `Idempotency-Key` is generated when the caller does not supply
	 * one, so the SDK's own retries of this call cannot double-send. An explicit
	 * `options.idempotencyKey` always wins.
	 *
	 * @param data - The event trigger payload
	 * @param options - Optional idempotency key and priority override
	 */
	async trigger(
		data: TriggerEventRequest,
		options?: TriggerEventOptions,
	): Promise<TriggerEventResponse> {
		const headers: Record<string, string> = {};
		const idempotencyKey = options?.idempotencyKey || generateIdempotencyKey();
		headers["Idempotency-Key"] = idempotencyKey;

		if (options?.priority) {
			headers["X-Priority-Override"] = options.priority;
		}

		return this.client.post<TriggerEventResponse>(
			"/v1/events/trigger",
			data,
			headers,
		);
	}

	/**
	 * Convenience helper to trigger an email notification with typed email payload.
	 *
	 * @deprecated since 0.1.0: use `EmailResource.send`; removal in 0.2.0.
	 * @param request - Typed email send options
	 * @param options - Optional trigger options
	 */
	async triggerEmail(
		request: import("../types.js").SendEmailOptions,
		options?: TriggerEventOptions,
	): Promise<TriggerEventResponse> {
		const to: import("../types.js").Recipient =
			typeof request.to === "string"
				? { subscriberId: request.to, email: request.to }
				: {
						subscriberId:
							request.to.subscriberId || request.to.email || "unknown",
						email: request.to.email,
						phone: request.to.phone,
						deviceTokens: request.to.deviceTokens,
					};

		const payload: Record<string, unknown> = {
			subject: request.subject,
			...(request.payload || {}),
		};

		if (request.html) {
			payload.html = request.html;
		}
		if (request.text) {
			payload.text = request.text;
		}
		if (request.body && !payload.html && !payload.text) {
			payload.body = request.body;
		}

		let emailOverride: import("../types.js").EmailOverride | undefined = request
			.overrides?.email
			? { ...request.overrides.email }
			: undefined;

		if (request.from || request.provider || request.customHeaders) {
			emailOverride = {
				...(emailOverride || {}),
				...(request.from ? { from: request.from } : {}),
				...(request.provider ? { provider: request.provider } : {}),
				...(request.customHeaders
					? { customHeaders: request.customHeaders }
					: {}),
			};
		}

		let overrides: import("../types.js").ProviderOverrides | undefined =
			request.overrides;
		if (emailOverride) {
			overrides = {
				...(overrides || {}),
				email: emailOverride,
			};
		}

		const triggerPayload: TriggerEventRequest = {
			name: request.name || "transactional-email",
			to,
			payload,
			overrides,
			category: request.category || "transactional",
		};

		const idempotencyKey = options?.idempotencyKey || request.idempotencyKey;
		const priority = options?.priority || request.priority;

		return this.trigger(triggerPayload, {
			...(idempotencyKey ? { idempotencyKey } : {}),
			...(priority ? { priority } : {}),
		});
	}

	/**
	 * Trigger multiple notification events in a single batch.
	 * Maps to: POST /v1/events/bulk
	 */
	async bulkTrigger(data: BulkTriggerRequest): Promise<BulkTriggerResponse> {
		return this.client.post<BulkTriggerResponse>("/v1/events/bulk", data);
	}

	/**
	 * Look up the status and event timeline for a single message by event ID.
	 * Maps to: GET /v1/events/:eventId
	 *
	 * @param eventId - The event identifier (`evt_<hex>` or UUID)
	 */
	async get(eventId: string): Promise<MessageDto> {
		return this.client.get<MessageDto>(
			`/v1/events/${encodeURIComponent(eventId)}`,
		);
	}
}
