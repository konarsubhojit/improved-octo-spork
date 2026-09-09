import type { NotificationState } from './types.js';

export interface DispatchClaim {
  occurrenceVersion: number;
  currentVersion: number;
  cancelled: boolean;
  consented: boolean;
  inMaintenance: boolean;
  state: NotificationState;
  startedSubmitting: boolean;
}

export function dispatchDecision(claim: DispatchClaim): NotificationState {
  if (claim.state !== 'queued' && claim.state !== 'retrying') return claim.state;
  if (claim.occurrenceVersion !== claim.currentVersion || claim.cancelled || !claim.consented || claim.inMaintenance) {
    return 'suppressed';
  }
  return 'submitting';
}

export function interruptedSubmission(smtpAccepted: boolean | undefined): NotificationState {
  if (smtpAccepted === true) return 'smtp-accepted';
  if (smtpAccepted === false) return 'retrying';
  return 'outcome-unknown';
}

export function shouldNotifyTransition(
  transition: 'down' | 'recovered' | 'failing' | 'unknown',
  recoveryEnabled: boolean,
  lastDownNotificationAt: number | undefined,
  now: number
): boolean {
  if (transition === 'recovered') return recoveryEnabled;
  if (transition !== 'down') return false;
  return lastDownNotificationAt === undefined || now - lastDownNotificationAt >= 15 * 60_000;
}
