import { NervlyHttpClient } from '../client.js';
import type { McpResponse } from '../types.js';

export class McpResource {
  constructor(private readonly client: NervlyHttpClient) {}

  /**
   * List available MCP tools.
   * Maps to: POST /v1/mcp with method='tools/list'
   */
  async listTools(): Promise<McpResponse> {
    return this.client.post<McpResponse>('/v1/mcp', {
      method: 'tools/list',
      params: null,
    });
  }

  /**
   * Call an MCP tool to inspect gateway status.
   * Maps to: POST /v1/mcp with method='tools/call'
   */
  async callTool(params?: unknown): Promise<McpResponse> {
    return this.client.post<McpResponse>('/v1/mcp', {
      method: 'tools/call',
      params: params ?? null,
    });
  }
}
