import type { NervlyHttpClient } from "../client.js";
import type { HealthStatus } from "../types.js";

export class HealthResource {
	constructor(private readonly client: NervlyHttpClient) {}

	/**
	 * Check the health status of the Nervly Gateway.
	 * Maps to: GET /v1/health (unauthenticated)
	 */
	async check(): Promise<HealthStatus> {
		return this.client.request<HealthStatus>({
			method: "GET",
			path: "/v1/health",
			skipAuth: true,
		});
	}
}
