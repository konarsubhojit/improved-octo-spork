import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBacklog, nextOccurrences, resolveLocalInstant } from '../src/core/schedule.js';
import { evaluatePush, observePull, resumeCycle } from '../src/core/monitoring.js';
import {
  assertPublicAddresses,
  generateHeartbeatCredential,
  HeartbeatLedger,
  tokenMatches,
  validateProbeUrl
} from '../src/core/security.js';
import { acceptsResult, claimJob, reserveQuota, retryAt, type QuotaReservation } from '../src/core/jobs.js';
import type { LeasedJob, MonitorSnapshot } from '../src/core/types.js';
import { assertTenant, authenticate, consumeInvite, issueInvite, issueSession } from '../src/core/auth.js';
import { dispatchDecision, interruptedSubmission, shouldNotifyTransition } from '../src/core/outbox.js';
import { HeartbeatService, type HeartbeatSubmission } from '../src/services/heartbeat.js';
import { loadConfig } from '../src/runtime/config.js';

test('calendar recurrence preserves local time across DST and chooses the earlier fold', () => {
  const spring = nextOccurrences(
    { kind: 'daily', zone: 'America/New_York', localTime: '09:00' },
    new Date('2026-03-07T14:00:00Z'),
    2
  );
  assert.deepEqual(spring.map((date) => date.toISOString()), ['2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z']);

  assert.equal(
    resolveLocalInstant('America/New_York', { year: 2026, month: 11, day: 1, hour: 1, minute: 30 }).toISOString(),
    '2026-11-01T05:30:00.000Z'
  );
});

test('nonexistent local time advances to first valid instant and supports non-hour offsets', () => {
  assert.equal(
    resolveLocalInstant('America/New_York', { year: 2026, month: 3, day: 8, hour: 2, minute: 30 }).toISOString(),
    '2026-03-08T07:00:00.000Z'
  );
  assert.equal(
    resolveLocalInstant('Australia/Lord_Howe', { year: 2026, month: 10, day: 4, hour: 2, minute: 15 }).toISOString(),
    '2026-10-03T15:30:00.000Z'
  );
  assert.equal(
    resolveLocalInstant('Pacific/Apia', { year: 2011, month: 12, day: 30, hour: 9, minute: 0 }).toISOString(),
    '2011-12-30T10:00:00.000Z'
  );
});

test('monthly dates skip absent months and elapsed recurrence is duration based', () => {
  const monthly = nextOccurrences(
    { kind: 'monthly', zone: 'UTC', localTime: '10:00', dayOfMonth: 31 },
    new Date('2026-01-31T10:00:00Z'),
    3
  );
  assert.deepEqual(monthly.map((date) => date.toISOString()), [
    '2026-03-31T10:00:00.000Z',
    '2026-05-31T10:00:00.000Z',
    '2026-07-31T10:00:00.000Z'
  ]);
  const elapsed = nextOccurrences(
    { kind: 'elapsed', zone: 'UTC', startAt: '2026-01-01T00:00:00Z', intervalMinutes: 1440 },
    new Date('2026-01-02T12:00:00Z'),
    2
  );
  assert.deepEqual(elapsed.map((date) => date.toISOString()), ['2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z']);
  assert.equal(
    nextOccurrences(
      { kind: 'elapsed', zone: 'UTC', startAt: '2026-01-02T00:00:00Z', intervalMinutes: 60 },
      new Date('2026-01-01T00:00:00Z'),
      1
    )[0]?.toISOString(),
    '2026-01-02T00:00:00.000Z'
  );
  assert.equal(classifyBacklog(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z')), 'missed');
});

const initial: MonitorSnapshot = {
  state: 'unknown',
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  coverageAvailable: true,
  paused: false,
  inMaintenance: false
};

test('pull thresholds, recovery, pause, maintenance, and platform outage are independent evidence', () => {
  let state = observePull(initial, 'target-failure', '2026-01-01T00:00:00Z');
  assert.equal(state.state, 'failing');
  state = observePull(state, 'target-failure', '2026-01-01T00:01:00Z');
  state = observePull(state, 'target-failure', '2026-01-01T00:02:00Z');
  assert.equal(state.state, 'down');
  state = observePull(state, 'success', '2026-01-01T00:03:00Z');
  assert.equal(state.state, 'failing');
  state = observePull(state, 'success', '2026-01-01T00:04:00Z');
  assert.equal(state.state, 'healthy');
  assert.equal(observePull({ ...state, coverageAvailable: false }, 'target-failure', 'x').state, 'unknown');
  assert.equal(observePull({ ...state, inMaintenance: true }, 'target-failure', 'x').state, 'failing');
  assert.equal(evaluatePush({ ...initial, inMaintenance: true }, 421_000, 0, 300_000, 120_000).state, 'down');
  assert.equal(resumeCycle({ ...state, paused: true }).state, 'unknown');
});

test('push deadlines use server receipt time and one fresh heartbeat recovers', () => {
  assert.equal(evaluatePush(initial, 0, undefined, 300_000, 120_000).state, 'unknown');
  assert.equal(evaluatePush(initial, 300_000, 0, 300_000, 120_000).state, 'healthy');
  assert.equal(evaluatePush(initial, 360_000, 0, 300_000, 120_000).state, 'failing');
  assert.equal(evaluatePush(initial, 421_000, 0, 300_000, 120_000).state, 'down');
  assert.equal(evaluatePush({ ...initial, state: 'down' }, 422_000, 422_000, 300_000, 120_000).state, 'healthy');
});

test('heartbeat credentials are random, hash-only comparable, and duplicate events do not extend receipt', () => {
  const first = generateHeartbeatCredential();
  const second = generateHeartbeatCredential();
  assert.equal(Buffer.from(first.token, 'base64url').length, 32);
  assert.notEqual(first.token, second.token);
  assert.equal(tokenMatches(first.token, first.hash), true);
  assert.equal(tokenMatches(second.token, first.hash), false);

  const ledger = new HeartbeatLedger();
  assert.equal(ledger.receive(100, 'event-1').duplicate, false);
  assert.equal(ledger.receive(200, 'event-1').duplicate, true);
  assert.equal(ledger.lastReceipt?.receivedAt, 100);
});

test('probe validation rejects internal targets and resolutions', () => {
  assert.equal(validateProbeUrl('https://status.example.com/').hostname, 'status.example.com');
  for (const target of [
    'http://example.com',
    '******example.com',
    'https://127.0.0.1',
    'https://metadata.google.internal',
    'https://example.com:8443'
  ]) assert.throws(() => validateProbeUrl(target));
  assert.throws(() => validateProbeUrl('https://api.example.com', ['example.com']));
  assert.doesNotThrow(() => assertPublicAddresses(['8.8.8.8', '2606:4700:4700::1111']));
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fd00::1', '2001:db8::1', '2001:db8::2', '2002:0808:0808::']) {
    assert.throws(() => assertPublicAddresses([address]));
  }
});

test('leases reclaim expired work and fence stale or cancelled results', () => {
  const job: LeasedJob = { id: '1', availableAt: 0, attempts: 0, maxAttempts: 5, fence: 0, cancelled: false };
  const first = claimJob(job, 'a', 100, 50);
  assert.ok(first);
  assert.equal(claimJob(first, 'b', 120, 50), undefined);
  const reclaimed = claimJob(first, 'b', 151, 50);
  assert.ok(reclaimed);
  assert.equal(acceptsResult(reclaimed, 'a', first.fence, 160), false);
  assert.equal(acceptsResult(reclaimed, 'b', reclaimed.fence, 160), true);
  assert.equal(acceptsResult({ ...reclaimed, cancelled: true }, 'b', reclaimed.fence, 160), false);
});

test('quota reservations preserve headroom and retries stop after five attempts', () => {
  let reservations: QuotaReservation[] = Array.from({ length: 80 }, (_, index) => ({ at: index, priority: 'reminder' }));
  assert.equal(reserveQuota(reservations, 100, 'reminder'), undefined);
  reservations = Array.from({ length: 99 }, (_, index) => ({ at: index, priority: 'incident' }));
  assert.equal(reserveQuota(reservations, 100, 'incident')?.length, 100);
  assert.equal(reserveQuota([...reservations, { at: 100, priority: 'incident' }], 100, 'verification'), undefined);
  assert.equal(retryAt(5, 0), undefined);
  assert.equal(retryAt(1, 0, () => 0.5), 30_000);
});

test('invites and sessions are expiring one-use credentials with CSRF and tenant isolation', () => {
  const issued = issueInvite('workspace-a', 'USER@example.com', 100);
  const used = consumeInvite(issued.invite, issued.token, 99);
  assert.equal(used.email, 'user@example.com');
  assert.throws(() => consumeInvite(used, issued.token, 99));

  const login = issueSession('user-a', 'workspace-a', 200);
  assert.deepEqual(authenticate(login.session, login.sessionToken, 100), {
    userId: 'user-a',
    workspaceId: 'workspace-a'
  });
  assert.throws(() => authenticate(login.session, login.sessionToken, 100, 'wrong', true));
  assert.doesNotThrow(() => authenticate(login.session, login.sessionToken, 100, login.csrfToken, true));
  assert.throws(() => assertTenant('workspace-a', 'workspace-b'), /Not found/);
});

test('dispatch rechecks versions, cancellation, consent and maintenance, preserving ambiguous outcomes', () => {
  const claim = {
    occurrenceVersion: 2,
    currentVersion: 2,
    cancelled: false,
    consented: true,
    inMaintenance: false,
    state: 'queued' as const,
    startedSubmitting: false
  };
  assert.equal(dispatchDecision(claim), 'submitting');
  assert.equal(dispatchDecision({ ...claim, currentVersion: 3 }), 'suppressed');
  assert.equal(dispatchDecision({ ...claim, cancelled: true }), 'suppressed');
  assert.equal(dispatchDecision({ ...claim, consented: false }), 'suppressed');
  assert.equal(dispatchDecision({ ...claim, inMaintenance: true }), 'suppressed');
  assert.equal(interruptedSubmission(undefined), 'outcome-unknown');
  assert.equal(shouldNotifyTransition('down', true, 0, 899_999), false);
  assert.equal(shouldNotifyTransition('down', true, 0, 900_000), true);
  assert.equal(shouldNotifyTransition('recovered', false, undefined, 0), false);
});

test('heartbeat service stores only token hash and rejects malformed credentials', async () => {
  const credential = generateHeartbeatCredential();
  let captured: HeartbeatSubmission | undefined;
  const service = new HeartbeatService({
    async record(submission) {
      captured = submission;
      return { accepted: true, duplicate: false };
    }
  });
  assert.equal((await service.submit(credential.token, 'event-1', new Date(100))).accepted, true);
  assert.equal(captured?.tokenHash, credential.hash);
  assert.equal(JSON.stringify(captured).includes(credential.token), false);
  assert.equal((await service.submit('short', undefined)).accepted, false);
  assert.equal((await service.submit(credential.token, 'bad event')).accepted, false);
});

test('role configuration keeps probe credentials absent and outbound execution fail-closed', () => {
  assert.deepEqual(loadConfig({ PROCESS_ROLE: 'probe' }), {
    role: 'probe',
    port: 3000,
    probeExecutionEnabled: false
  });
  assert.throws(() => loadConfig({ PROCESS_ROLE: 'probe', ORACLE_PASSWORD: 'secret' }));
  assert.throws(() => loadConfig({ PROCESS_ROLE: 'probe', ORACLE_USER: 'metadata-only' }));
  assert.throws(() => loadConfig({ PROCESS_ROLE: 'probe', GMAIL_USER: 'metadata-only' }));
  assert.throws(() => loadConfig({ PROCESS_ROLE: 'probe', PROBE_EXECUTION_ENABLED: 'true' }), /fail-closed/);
  assert.throws(() => loadConfig({ PROCESS_ROLE: 'api' }), /HTTPS/);
});
