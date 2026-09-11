import { NerveHttpClient } from '../client.js';
import type {
  TriggerEventRequest,
  TriggerEventOptions,
  TriggerEventResponse,
  BulkTriggerRequest,
  BulkTriggerResponse,
  MessageDto,
} from '../types.js';

export class EventsResource {
  constructor(private readonly client: NerveHttpClient) {}

  /**
   * Trigger a single notification event.
   * Maps to: POST /v1/events/trigger
   *
   * @param data - The event trigger payload
   * @param options - Optional idempotency key and priority override
   */
  async trigger(data: TriggerEventRequest, options?: TriggerEventOptions): Promise<TriggerEventResponse> {
    const headers: Record<string, string> = {};

    if (options?.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    if (options?.priority) {
      headers['X-Priority-Override'] = options.priority;
    }

    return this.client.post<TriggerEventResponse>('/v1/events/trigger', data, headers);
  }

  /**
   * Trigger multiple notification events in a single batch.
   * Maps to: POST /v1/events/bulk
   */
  async bulkTrigger(data: BulkTriggerRequest): Promise<BulkTriggerResponse> {
    return this.client.post<BulkTriggerResponse>('/v1/events/bulk', data);
  }

  /**
   * Look up the status and event timeline for a single message by event ID.
   * Maps to: GET /v1/events/:eventId
   *
   * @param eventId - The event identifier (`evt_<hex>` or UUID)
   */
  async get(eventId: string): Promise<MessageDto> {
    return this.client.get<MessageDto>(`/v1/events/${encodeURIComponent(eventId)}`);
  }
}

