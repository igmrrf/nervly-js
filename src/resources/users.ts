import { NerveHttpClient } from '../client.js';
import type { UserPreferencesRequest, UserPreferencesResponse } from '../types.js';

export class UsersResource {
  constructor(private readonly client: NerveHttpClient) {}

  /**
   * Update a subscriber's notification channel and category preferences.
   * Maps to: PUT /v1/users/:subscriberId/preferences
   */
  async updatePreferences(
    subscriberId: string,
    data: UserPreferencesRequest,
  ): Promise<UserPreferencesResponse> {
    return this.client.put<UserPreferencesResponse>(
      `/v1/users/${encodeURIComponent(subscriberId)}/preferences`,
      data,
    );
  }
}
