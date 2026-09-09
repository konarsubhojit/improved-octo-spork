import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type oracledb from 'oracledb';
import { OracleAppRepository } from '../src/store/oracleApp.js';
import { OracleHeartbeatStore } from '../src/store/oracle.js';
import { findReservedIdentifiers } from '../src/runtime/migration/reserved-words.js';

/**
 * These tests exercise the real repository SQL against a recording fake connection: they prove the
 * exact statements the driver would receive (column names, predicates, bind names) and the row
 * mappings, without any Oracle connection. They cannot prove the Oracle *engine* accepts the SQL;
 * that requires the opt-in manual verification documented in migrations/README.md.
 */

interface Recorded {
  sql: string;
  binds: Record<string, unknown>;
}

interface FakeDb {
  pool: oracledb.Pool;
  executed: Recorded[];
  commits: number;
  rollbacks: number;
}

function fakeDb(respond: (sql: string) => unknown[] | undefined): FakeDb {
  const state = { executed: [] as Recorded[], commits: 0, rollbacks: 0 };
  const connection = {
    async execute(sql: string, binds: Record<string, unknown> = {}) {
      state.executed.push({ sql, binds });
      return { rows: respond(sql) };
    },
    async commit() {
      state.commits += 1;
    },
    async rollback() {
      state.rollbacks += 1;
    },
    async close() {
      /* no-op */
    }
  };
  const pool = { getConnection: async () => connection } as unknown as oracledb.Pool;
  return {
    pool,
    get executed() {
      return state.executed;
    },
    get commits() {
      return state.commits;
    },
    get rollbacks() {
      return state.rollbacks;
    }
  } as FakeDb;
}

/** Every statement the repository sends must be free of unquoted Oracle reserved identifiers. */
function assertNoReservedIdentifiers(executed: Recorded[]): void {
  for (const { sql } of executed) {
    assert.deepEqual(findReservedIdentifiers(sql), [], sql);
  }
}

test('listPushMonitors selects push monitors via monitor_mode and maps rows', async () => {
  const db = fakeDb((sql) =>
    sql.includes('FROM monitors')
      ? [
          {
            MONITOR_ID: 'monitor-1',
            SERVICE_ID: 'service-1',
            STATE: 'healthy',
            CONFIG_JSON: JSON.stringify({ intervalMs: 300_000, graceMs: 120_000 }),
            PAUSED_AT: null,
            LAST_EVIDENCE_AT: null,
            EDIT_VERSION: 3
          }
        ]
      : []
  );

  const monitors = await new OracleAppRepository(db.pool).listPushMonitors('workspace-1');

  const [query] = db.executed;
  assert.match(query!.sql, /AND monitor_mode = 'push'/);
  assert.doesNotMatch(query!.sql, /(?<![_\w])mode\s*=/);
  assert.equal(query!.binds.workspace_id, 'workspace-1');
  assertNoReservedIdentifiers(db.executed);
  assert.deepEqual(monitors, [
    {
      monitorId: 'monitor-1',
      serviceId: 'service-1',
      state: 'healthy',
      intervalMs: 300_000,
      graceMs: 120_000,
      pausedAt: undefined,
      lastEvidenceAt: undefined,
      editVersion: 3
    }
  ]);
});

test('createPushMonitor inserts monitor_mode and issues a heartbeat credential', async () => {
  const db = fakeDb((sql) => (sql.includes('FROM services') ? [{ '1': 1 }] : []));
  const now = new Date('2026-09-09T00:00:00.000Z');

  const created = await new OracleAppRepository(db.pool).createPushMonitor({
    workspaceId: 'workspace-1',
    serviceId: 'service-1',
    monitorId: 'monitor-1',
    intervalMs: 300_000,
    graceMs: 120_000,
    startExpectingNow: true,
    now,
    tokenHash: 'ab'.repeat(32)
  });

  const insert = db.executed.find((entry) => entry.sql.includes('INSERT INTO monitors'));
  assert.ok(insert, 'expected a monitors insert');
  assert.match(insert!.sql, /workspace_id, monitor_id, service_id, monitor_mode, state,/);
  assert.match(insert!.sql, /'push', 'unknown'/);
  assert.ok(
    db.executed.some((entry) => entry.sql.includes('INSERT INTO heartbeat_credentials')),
    'expected a heartbeat credential insert'
  );
  assertNoReservedIdentifiers(db.executed);
  assert.equal(db.commits, 1);
  assert.deepEqual(created, {
    monitorId: 'monitor-1',
    serviceId: 'service-1',
    state: 'unknown',
    intervalMs: 300_000,
    graceMs: 120_000,
    pausedAt: undefined,
    lastEvidenceAt: undefined,
    editVersion: 1
  });
});

test('createPushMonitor refuses a monitor for a service in another workspace', async () => {
  const db = fakeDb(() => []);
  const result = await new OracleAppRepository(db.pool).createPushMonitor({
    workspaceId: 'workspace-2',
    serviceId: 'service-1',
    monitorId: 'monitor-2',
    intervalMs: 300_000,
    graceMs: 120_000,
    startExpectingNow: false,
    now: new Date(),
    tokenHash: 'cd'.repeat(32)
  });
  assert.equal(result, 'not-found');
  assert.equal(db.executed.length, 1, 'workspace isolation must be checked before any insert');
  assert.equal(db.executed[0]!.binds.workspace_id, 'workspace-2');
  assert.equal(db.commits, 0);
});

test('rotatePushMonitorToken revokes the current credential and inserts the next version', async () => {
  const db = fakeDb((sql) => (sql.includes('MAX(credential_version)') ? [{ V: 4 }] : []));
  const result = await new OracleAppRepository(db.pool).rotatePushMonitorToken({
    workspaceId: 'workspace-1',
    monitorId: 'monitor-1',
    now: new Date('2026-09-09T00:00:00.000Z'),
    tokenHash: 'ef'.repeat(32)
  });

  assert.equal(result, 'rotated');
  const insert = db.executed.find((entry) => entry.sql.includes('INSERT INTO heartbeat_credentials'));
  assert.equal(insert!.binds.credential_version, 5);
  assert.ok(db.executed.some((entry) => entry.sql.includes('SET revoked_at')));
  assertNoReservedIdentifiers(db.executed);
  assert.equal(db.commits, 1);
});

test('heartbeat lookup resolves the monitor through monitor_mode and records evidence', async () => {
  const db = fakeDb((sql) => {
    if (sql.includes('FROM heartbeat_credentials')) return [{ WORKSPACE_ID: 'workspace-1', MONITOR_ID: 'monitor-1' }];
    if (sql.includes('FROM heartbeat_receipts')) return [];
    if (sql.includes('FROM monitors')) return [{ DEADLINE_VERSION: 7, LAST_EVIDENCE_AT: null }];
    return [];
  });

  const result = await new OracleHeartbeatStore(db.pool).record({
    tokenHash: 'ab'.repeat(32),
    eventId: 'event-1',
    receivedAt: new Date('2026-09-09T00:00:00.000Z')
  });

  assert.deepEqual(result, { accepted: true, duplicate: false });
  const monitorQuery = db.executed.find((entry) => entry.sql.includes('FROM monitors'));
  assert.match(monitorQuery!.sql, /AND monitor_mode = 'push' AND paused_at IS NULL AND deleted_at IS NULL/);
  const receipt = db.executed.find((entry) => entry.sql.includes('INSERT INTO heartbeat_receipts'));
  assert.equal(receipt!.binds.deadline_version, 8);
  const update = db.executed.find((entry) => entry.sql.includes('UPDATE monitors'));
  assert.equal(update!.binds.deadline_version, 7, 'the update must fence on the observed deadline version');
  assertNoReservedIdentifiers(db.executed);
  assert.equal(db.commits, 1);
});

test('heartbeat lookup rejects an unknown credential and deduplicates a repeated event id', async () => {
  const unknown = fakeDb(() => []);
  assert.deepEqual(
    await new OracleHeartbeatStore(unknown.pool).record({ tokenHash: 'ab'.repeat(32), receivedAt: new Date() }),
    { accepted: false, duplicate: false }
  );
  assert.equal(unknown.commits, 0);

  const duplicate = fakeDb((sql) => {
    if (sql.includes('FROM heartbeat_credentials')) return [{ WORKSPACE_ID: 'workspace-1', MONITOR_ID: 'monitor-1' }];
    if (sql.includes('FROM heartbeat_receipts')) return [{ '1': 1 }];
    return [];
  });
  assert.deepEqual(
    await new OracleHeartbeatStore(duplicate.pool).record({
      tokenHash: 'ab'.repeat(32),
      eventId: 'event-1',
      receivedAt: new Date()
    }),
    { accepted: true, duplicate: true }
  );
  assert.equal(duplicate.commits, 0);
});

test('dashboard maps reminders, notifications, incidents and quota without reserved identifiers', async () => {
  const db = fakeDb((sql) => {
    if (sql.includes('FROM reminders')) {
      return [
        {
          REMINDER_ID: 'reminder-1',
          TITLE: 'Pay subscription',
          NEXT_DUE_AT: new Date('2026-09-10T00:00:00.000Z'),
          PAUSED_AT: null,
          EDIT_VERSION: 2
        }
      ];
    }
    if (sql.includes('FROM notifications')) {
      return [
        {
          NOTIFICATION_ID: 'notification-1',
          EVENT_ID: 'reminder-due',
          STATE: 'smtp-accepted',
          UPDATED_AT: new Date('2026-09-09T00:00:00.000Z')
        }
      ];
    }
    return [{ C: 1 }];
  });

  const dashboard = await new OracleAppRepository(db.pool).dashboard('workspace-1');

  assertNoReservedIdentifiers(db.executed);
  assert.equal(dashboard.reminders[0]?.state, 'active');
  assert.equal(dashboard.notifications[0]?.state, 'smtp-accepted');
  assert.deepEqual(dashboard.incidents, [], 'incident grouping is still pending; the JSON shape must stay stable');
  assert.equal(dashboard.services[0]?.pullState, 'disabled', 'pull monitor execution stays disabled');
  assert.equal(dashboard.quota.rolling24h, 1);
});

test('the API and domain contracts keep the JSON property `mode` while the column is monitor_mode', async () => {
  const api = await readFile(resolve(process.cwd(), 'src/runtime/api.ts'), 'utf8');
  const types = await readFile(resolve(process.cwd(), 'src/core/types.ts'), 'utf8');
  const service = await readFile(resolve(process.cwd(), 'src/app/service.ts'), 'utf8');

  assert.match(api, /data\.mode !== 'push'/, 'the monitor creation route must keep reading the JSON property `mode`');
  assert.match(types, /export type MonitorMode = 'pull' \| 'push'/);
  assert.match(service, /mode: string/, 'the dashboard incident contract keeps its `mode` property');
  // The API layer must not leak the physical column name into the JSON contract.
  assert.doesNotMatch(api, /monitor_mode/);
});
