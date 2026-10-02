import type { NervlyHttpClient } from "../client.js";
import type {
	CreateBindingInput,
	CreateSenderInput,
	CreateSenderResponse,
	IdentityUnit,
	ListSendersParams,
	ListSendersResponse,
	SenderIdentity,
	VerifyBindingResponse,
} from "../types.js";

/**
 * Sender-identity management against the control plane's public API.
 *
 * This resource runs on the SDK's *management* client
 * (`config.managementUrl`, default `https://console.nervly.io`), not the
 * gateway client, so its paths carry no host. It is the identity-first public
 * surface; the console's provider-card projection, discovery/import, provider
 * credentials and webhook secrets are not exposed here.
 */
export class SendersResource {
	constructor(private readonly client: NervlyHttpClient) {}

	/**
	 * List the workspace's sender identities with their nested bindings,
	 * newest first, cursor-paginated.
	 * Maps to: GET /v1/senders
	 */
	async list(params?: ListSendersParams): Promise<ListSendersResponse> {
		const searchParams = new URLSearchParams();

		if (params) {
			if (params.limit !== undefined)
				searchParams.set("limit", String(params.limit));
			if (params.cursor) searchParams.set("cursor", params.cursor);
			if (params.channel) searchParams.set("channel", params.channel);
			if (params.provider) searchParams.set("provider", params.provider);
		}

		const query = searchParams.toString();
		const path = query ? `/v1/senders?${query}` : "/v1/senders";

		return this.client.get<ListSendersResponse>(path);
	}

	/**
	 * Get one identity with all of its bindings.
	 * Maps to: GET /v1/senders/{identityId}
	 *
	 * @param identityId - The control-plane UUID returned as `identity_id`
	 */
	async get(identityId: string): Promise<SenderIdentity> {
		return this.client.get<SenderIdentity>(
			`/v1/senders/${encodeURIComponent(identityId)}`,
		);
	}

	/**
	 * Create or reuse the identity for `(channel, value)` and add its first
	 * binding. Repeating the same identity/provider/unit reuses both rows.
	 * Maps to: POST /v1/senders
	 */
	async create(input: CreateSenderInput): Promise<CreateSenderResponse> {
		return this.client.post<CreateSenderResponse>("/v1/senders", input);
	}

	/**
	 * Bind an existing identity to another provider.
	 * Maps to: POST /v1/senders/{identityId}/bindings
	 */
	async addBinding(
		identityId: string,
		input: CreateBindingInput,
	): Promise<CreateSenderResponse> {
		return this.client.post<CreateSenderResponse>(
			`/v1/senders/${encodeURIComponent(identityId)}/bindings`,
			input,
		);
	}

	/**
	 * Re-check exactly one binding against its provider and return the new
	 * state. `identityUnit` selects one row: a domain and an address binding
	 * may coexist on one provider.
	 * Maps to:
	 * POST /v1/senders/{identityId}/bindings/{provider}/{identityUnit}/verify
	 */
	async verifyBinding(
		identityId: string,
		provider: string,
		identityUnit: IdentityUnit,
	): Promise<VerifyBindingResponse> {
		return this.client.post<VerifyBindingResponse>(
			`/v1/senders/${encodeURIComponent(identityId)}/bindings/` +
				`${encodeURIComponent(provider)}/${encodeURIComponent(identityUnit)}/verify`,
		);
	}

	/**
	 * Remove exactly one binding, named by its identity unit. The binding is
	 * deleted; it is never moved to a `revoked` state.
	 * Maps to:
	 * DELETE /v1/senders/{identityId}/bindings/{provider}/{identityUnit}
	 */
	async removeBinding(
		identityId: string,
		provider: string,
		identityUnit: IdentityUnit,
	): Promise<{ status: string }> {
		return this.client.delete<{ status: string }>(
			`/v1/senders/${encodeURIComponent(identityId)}/bindings/` +
				`${encodeURIComponent(provider)}/${encodeURIComponent(identityUnit)}`,
		);
	}

	/**
	 * Delete the identity and cascade every binding under it. This is the
	 * public-only identity delete; the console keeps binding-only deletion.
	 * Maps to: DELETE /v1/senders/{identityId}
	 */
	async remove(identityId: string): Promise<{ status: string }> {
		return this.client.delete<{ status: string }>(
			`/v1/senders/${encodeURIComponent(identityId)}`,
		);
	}
}
