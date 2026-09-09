import { hashHeartbeatToken } from '../core/security.js';

export interface HeartbeatSubmission {
  tokenHash: string;
  receivedAt: Date;
  eventId?: string;
}

export interface HeartbeatResult {
  accepted: boolean;
  duplicate: boolean;
}

export interface HeartbeatStore {
  record(submission: HeartbeatSubmission): Promise<HeartbeatResult>;
}

export class HeartbeatService {
  constructor(private readonly store: HeartbeatStore) {}

  async submit(token: string, eventId: string | undefined, receivedAt = new Date()): Promise<HeartbeatResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { accepted: false, duplicate: false };
    if (eventId !== undefined && (eventId.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(eventId))) {
      return { accepted: false, duplicate: false };
    }
    const submission: HeartbeatSubmission =
      eventId === undefined
        ? { tokenHash: hashHeartbeatToken(token), receivedAt }
        : { tokenHash: hashHeartbeatToken(token), receivedAt, eventId };
    return this.store.record(submission);
  }
}
