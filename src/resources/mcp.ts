import type { NervlyHttpClient } from "../client.js";
import type { McpResponse } from "../types.js";

export class McpResource {
	constructor(private readonly client: NervlyHttpClient) {}

	/**
	 * List available MCP tools.
	 * Maps to: POST /v1/mcp with method='tools/list'
	 */
	async listTools(): Promise<McpResponse> {
		return this.client.post<McpResponse>("/v1/mcp", {
			method: "tools/list",
			params: null,
		});
	}

	/**
	 * Call an MCP tool.
	 * Maps to: POST /v1/mcp with method='tools/call'
	 *
	 * `params` is required: the gateway's `tools/call` handler deserializes
	 * `{ name, arguments }` and rejects a null params with JSON-RPC `-32602`,
	 * so a no-argument call is never valid. Typing it as required makes the
	 * former `callTool()` footgun a compile error.
	 */
	async callTool(params: {
		name: string;
		arguments?: Record<string, unknown>;
	}): Promise<McpResponse> {
		return this.client.post<McpResponse>("/v1/mcp", {
			method: "tools/call",
			params,
		});
	}
}
