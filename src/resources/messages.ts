import { NerveHttpClient } from '../client.js';
import type { ListMessagesParams, ListMessagesResponse } from '../types.js';

export class MessagesResource {
  constructor(private readonly client: NerveHttpClient) {}

  /**
   * List messages with optional filters and cursor-based pagination.
   * Maps to: GET /v1/messages
   *
   * @param params - Optional query filters (status, channel, subscriberId, from, to, limit, cursor)
   */
  async list(params?: ListMessagesParams): Promise<ListMessagesResponse> {
    const searchParams = new URLSearchParams();

    if (params) {
      if (params.status) searchParams.set('status', params.status);
      if (params.channel) searchParams.set('channel', params.channel);
      if (params.subscriberId) searchParams.set('subscriber_id', params.subscriberId);
      if (params.from) searchParams.set('from', params.from);
      if (params.to) searchParams.set('to', params.to);
      if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
      if (params.cursor) searchParams.set('cursor', params.cursor);
    }

    const query = searchParams.toString();
    const path = query ? `/v1/messages?${query}` : '/v1/messages';

    return this.client.get<ListMessagesResponse>(path);
  }
}
