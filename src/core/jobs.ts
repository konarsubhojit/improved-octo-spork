import type { LeasedJob } from './types.js';

export function claimJob(job: LeasedJob, worker: string, now: number, leaseMs: number): LeasedJob | undefined {
  if (job.cancelled || job.availableAt > now || job.attempts >= job.maxAttempts) return undefined;
  if (job.leaseUntil !== undefined && job.leaseUntil > now) return undefined;
  return {
    ...job,
    leaseOwner: worker,
    leaseUntil: now + leaseMs,
    fence: job.fence + 1,
    attempts: job.attempts + 1
  };
}

export function acceptsResult(current: LeasedJob, worker: string, fence: number, now: number): boolean {
  return !current.cancelled && current.leaseOwner === worker && current.fence === fence && (current.leaseUntil ?? 0) >= now;
}

export interface QuotaReservation {
  at: number;
  priority: 'verification' | 'incident' | 'reminder';
}

export function reserveQuota(
  reservations: readonly QuotaReservation[],
  now: number,
  priority: QuotaReservation['priority'],
  dailyLimit = 100,
  reminderHeadroom = 20
): QuotaReservation[] | undefined {
  const active = reservations.filter(({ at }) => at > now - 24 * 60 * 60_000);
  const limit = priority === 'reminder' ? dailyLimit - reminderHeadroom : dailyLimit;
  if (active.length >= limit) return undefined;
  return [...active, { at: now, priority }];
}

export function retryAt(attempt: number, now: number, random = Math.random): number | undefined {
  if (attempt >= 5) return undefined;
  const base = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  return now + Math.floor(base * (0.8 + random() * 0.4));
}
