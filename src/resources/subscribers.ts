import { NerveHttpClient } from '../client.js';
import type {
  SubscriberErasureResponse,
  UserPreferencesRequest,
  UserPreferencesResponse,
} from '../types.js';

export class SubscribersResource {
  constructor(private readonly client: NerveHttpClient) {}

  /**
   * Erase a subscriber and delete their personal data (NDPR / right-to-erasure).
   * Maps to: DELETE /v1/subscribers/:subscriberId
   *
   * @param subscriberId - Your identifier for the end user, as sent in `to.subscriberId`
   */
  async delete(subscriberId: string): Promise<SubscriberErasureResponse> {
    return this.client.delete<SubscriberErasureResponse>(
      `/v1/subscribers/${encodeURIComponent(subscriberId)}`,
    );
  }

  /**
   * Update a subscriber's notification channel and category preferences.
   * Maps to: PUT /v1/users/:subscriberId/preferences
   *
   * @deprecated since 0.1.0: use `UsersResource.updatePreferences`; removal in 0.2.0.
   * @param subscriberId - Your identifier for the end user
   * @param data - Channel and category preferences
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
