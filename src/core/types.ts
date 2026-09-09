export type MonitorState = 'healthy' | 'failing' | 'down' | 'unknown' | 'paused';
export type MonitorMode = 'pull' | 'push';
export type NotificationState =
  | 'queued'
  | 'submitting'
  | 'smtp-accepted'
  | 'retrying'
  | 'failed'
  | 'suppressed'
  | 'outcome-unknown';

export interface TenantEntity {
  workspaceId: string;
  version: number;
}

export interface ReminderSchedule {
  kind: 'one-time' | 'daily' | 'weekdays' | 'monthly' | 'elapsed';
  zone: string;
  localTime?: string;
  oneTimeAt?: string;
  startAt?: string;
  weekdays?: number[];
  dayOfMonth?: number;
  intervalMinutes?: number;
}

export interface MonitorSnapshot {
  state: MonitorState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastEvidenceAt?: string;
  coverageAvailable: boolean;
  paused: boolean;
  inMaintenance: boolean;
}

export interface LeasedJob {
  id: string;
  availableAt: number;
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseUntil?: number;
  fence: number;
  cancelled: boolean;
}
