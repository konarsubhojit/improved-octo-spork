import type { MonitorSnapshot } from './types.js';

export type Evidence = 'success' | 'target-failure' | 'infrastructure-failure';

export function observePull(snapshot: MonitorSnapshot, evidence: Evidence, at: string): MonitorSnapshot {
  if (snapshot.paused) return { ...snapshot, state: 'paused' };
  if (!snapshot.coverageAvailable || evidence === 'infrastructure-failure') {
    return { ...snapshot, state: 'unknown' };
  }
  if (snapshot.inMaintenance) return { ...snapshot, lastEvidenceAt: at };

  if (evidence === 'target-failure') {
    const failures = snapshot.consecutiveFailures + 1;
    return {
      ...snapshot,
      state: failures >= 3 ? 'down' : 'failing',
      consecutiveFailures: failures,
      consecutiveSuccesses: 0,
      lastEvidenceAt: at
    };
  }
  const successes = snapshot.consecutiveSuccesses + 1;
  return {
    ...snapshot,
    state: snapshot.state === 'down' && successes < 2 ? 'failing' : 'healthy',
    consecutiveFailures: 0,
    consecutiveSuccesses: successes,
    lastEvidenceAt: at
  };
}

export function evaluatePush(
  snapshot: MonitorSnapshot,
  nowMs: number,
  lastReceiptMs: number | undefined,
  intervalMs: number,
  graceMs: number
): MonitorSnapshot {
  if (snapshot.paused) return { ...snapshot, state: 'paused' };
  if (!snapshot.coverageAvailable || snapshot.inMaintenance || lastReceiptMs === undefined) {
    return { ...snapshot, state: 'unknown' };
  }
  const age = nowMs - lastReceiptMs;
  const state = age <= intervalMs ? 'healthy' : age <= intervalMs + graceMs ? 'failing' : 'down';
  return { ...snapshot, state, lastEvidenceAt: new Date(lastReceiptMs).toISOString() };
}

export function resumeCycle(snapshot: MonitorSnapshot): MonitorSnapshot {
  const { lastEvidenceAt: _lastEvidenceAt, ...rest } = snapshot;
  return {
    ...rest,
    state: 'unknown',
    paused: false,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0
  };
}
