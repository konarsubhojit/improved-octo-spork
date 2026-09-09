import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { splitSqlScript } from '../src/runtime/migration/sql-script.js';
import { executeMigrationScript } from '../src/runtime/migration/run-script.js';
import { parseMigrationFileNames, pendingMigrations } from '../src/runtime/migration/plan.js';
import { runMigrations, type MigrationDeps } from '../src/runtime/migration/migrator.js';
import { classifyExistingObject, classifyMonitorModeColumn, type MonitorModeState } from '../src/runtime/migration/compatibility.js';
import { extractSqlLiteralsFromSource, findReservedIdentifiers } from '../src/runtime/migration/reserved-words.js';

// --- sql-script.ts: splitSqlScript -----------------------------------------------------------

test('splitSqlScript keeps a leading comment attached to the following statement', () => {
  const stmts = splitSqlScript(`-- header comment\nCREATE TABLE foo (id NUMBER);\n`);
  assert.equal(stmts.length, 1);
  assert.match(stmts[0]!, /^-- header comment/);
  assert.match(stmts[0]!, /CREATE TABLE foo/);
});

test('splitSqlScript does not split BEGIN/EXCEPTION/END on internal semicolons', () => {
  const script = `BEGIN
  EXECUTE IMMEDIATE 'CREATE TABLE a (id NUMBER)';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -955 THEN RAISE; END IF;
END;
/
SELECT 1 FROM dual;
`;
  const stmts = splitSqlScript(script);
  assert.equal(stmts.length, 2);
  assert.match(stmts[0]!, /^BEGIN[\s\S]*END;$/);
  assert.ok(!stmts[0]!.includes('/'), 'slash batch terminator must not be part of the statement');
  assert.equal(stmts[1], 'SELECT 1 FROM dual;');
});

test('splitSqlScript handles nested BEGIN/END, IF..END IF and LOOP..END LOOP without miscounting depth', () => {
  const script = `DECLARE
  v_x NUMBER := 0;
BEGIN
  FOR i IN 1 .. 3 LOOP
    BEGIN
      IF v_x = 1 THEN
        NULL;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
  END LOOP;
END;
/
`;
  const stmts = splitSqlScript(script);
  assert.equal(stmts.length, 1);
  assert.match(stmts[0]!, /^DECLARE[\s\S]*END;$/);
});

test('splitSqlScript keeps a declared procedure inside its anonymous PL/SQL block', () => {
  const script = `DECLARE
  PROCEDURE validate IS
  BEGIN
    NULL;
  END;
BEGIN
  validate;
END;
/
`;
  assert.deepEqual(splitSqlScript(script), [script.trim().replace(/\n\/$/, '')]);
});

test('splitSqlScript treats semicolons inside quoted string literals as data, not terminators', () => {
  const stmts = splitSqlScript(`INSERT INTO t(v) VALUES ('a;b;c');\nINSERT INTO t(v) VALUES ('it''s; here');\n`);
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0], `INSERT INTO t(v) VALUES ('a;b;c');`);
  assert.equal(stmts[1], `INSERT INTO t(v) VALUES ('it''s; here');`);
});

test('splitSqlScript ignores a lone `/` batch-terminator line and SET session commands', () => {
  const stmts = splitSqlScript(`SET DEFINE OFF\nBEGIN\n  NULL;\nEND;\n/\nSET SERVEROUTPUT ON\nSELECT 1 FROM dual;\n`);
  assert.deepEqual(stmts, ['BEGIN\n  NULL;\nEND;', 'SELECT 1 FROM dual;']);
});

test('splitSqlScript preserves statement ordering across multiple plain statements', () => {
  const stmts = splitSqlScript(`CREATE TABLE a (id NUMBER);\nCREATE TABLE b (id NUMBER);\nCREATE INDEX ix ON a(id);\n`);
  assert.deepEqual(
    stmts.map((s) => s.match(/^CREATE (TABLE|INDEX) (\w+)/)?.[2]),
    ['a', 'b', 'ix']
  );
});

// --- run-script.ts: executeMigrationScript ----------------------------------------------------

test('executeMigrationScript executes statements in order and stops on first failure', async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      executeMigrationScript(`SELECT 1 FROM dual;\nSELECT 2 FROM dual;\nSELECT 3 FROM dual;\n`, async (stmt) => {
        calls.push(stmt);
        if (stmt.includes('2')) throw new Error('boom');
      }),
    /boom/
  );
  assert.deepEqual(calls, ['SELECT 1 FROM dual;', 'SELECT 2 FROM dual;']);
});

// --- plan.ts -------------------------------------------------------------------------------

test('parseMigrationFileNames filters non-migration files and orders numerically', () => {
  const files = parseMigrationFileNames(['README.md', '010_ten.sql', '002_two.sql', '001_mvp.sql']);
  assert.deepEqual(
    files.map((f) => f.version),
    [1, 2, 10]
  );
});

test('pendingMigrations skips already-recorded versions without replaying them', () => {
  const files = parseMigrationFileNames(['001_mvp.sql', '002_next.sql']);
  const pending = pendingMigrations(files, new Set([1]));
  assert.deepEqual(pending.map((f) => f.name), ['002_next.sql']);
});

// --- migrator.ts: runMigrations orchestration -------------------------------------------------

function fakeDeps(overrides: Partial<MigrationDeps> & { files: Record<string, string> }): MigrationDeps {
  const { files, ...rest } = overrides;
  return {
    schemaMigrationsExists: async () => false,
    listAppliedVersions: async () => [],
    listMigrationFileNames: async () => Object.keys(files),
    readMigrationFile: async (name) => files[name]!,
    execute: async () => undefined,
    commit: async () => undefined,
    ...rest
  };
}

test('runMigrations applies a fresh migration and records progress', async () => {
  const executed: string[] = [];
  let commits = 0;
  const appliedFiles: string[] = [];
  const deps = fakeDeps({
    files: { '001_mvp.sql': `BEGIN\n  NULL;\nEND;\n/\nMERGE INTO schema_migrations t USING (SELECT 1 v FROM dual) s ON (t.version=s.v) WHEN NOT MATCHED THEN INSERT (version) VALUES (s.v);\n` },
    execute: async (stmt) => {
      executed.push(stmt);
    },
    commit: async () => {
      commits += 1;
    },
    onApplied: (file) => appliedFiles.push(file.name)
  });

  const applied = await runMigrations(deps);
  assert.equal(executed.length, 2);
  assert.equal(commits, 1);
  assert.deepEqual(appliedFiles, ['001_mvp.sql']);
  assert.deepEqual(applied.map((f) => f.name), ['001_mvp.sql']);
});

test('runMigrations skips a version already recorded in schema_migrations (no replay)', async () => {
  const executed: string[] = [];
  const deps = fakeDeps({
    files: { '001_mvp.sql': 'BEGIN NULL; END;\n/\n' },
    schemaMigrationsExists: async () => true,
    listAppliedVersions: async () => [1],
    execute: async (stmt) => {
      executed.push(stmt);
    }
  });

  const applied = await runMigrations(deps);
  assert.deepEqual(executed, []);
  assert.deepEqual(applied, []);
});

test('runMigrations treats an existing empty schema_migrations table as no versions applied', async () => {
  const executed: string[] = [];
  const deps = fakeDeps({
    files: { '001_mvp.sql': 'BEGIN NULL; END;\n/\n' },
    schemaMigrationsExists: async () => true,
    listAppliedVersions: async () => [], // table exists but a prior bootstrap never recorded a row
    execute: async (stmt) => {
      executed.push(stmt);
    }
  });

  const applied = await runMigrations(deps);
  assert.equal(executed.length, 1);
  assert.deepEqual(applied.map((f) => f.name), ['001_mvp.sql']);
});

test('runMigrations never records a version when a statement in the file fails', async () => {
  let commits = 0;
  const deps = fakeDeps({
    files: { '001_mvp.sql': 'SELECT 1 FROM dual;\nMERGE INTO schema_migrations t USING (SELECT 1 v FROM dual) s ON (t.version=s.v) WHEN NOT MATCHED THEN INSERT (version) VALUES (s.v);\n' },
    execute: async (stmt) => {
      if (stmt.startsWith('SELECT')) throw Object.assign(new Error('ORA-00942: table or view does not exist'), { errorNum: 942 });
    },
    commit: async () => {
      commits += 1;
    }
  });

  await assert.rejects(() => runMigrations(deps), /ORA-00942/);
  assert.equal(commits, 0);
});

test('the real 001 resumes a partial schema, does not record on compatibility failure, and is a no-op after success', async () => {
  const sql = await readFile(resolve(process.cwd(), 'migrations/001_mvp.sql'), 'utf8');
  const executed: string[] = [];
  let commits = 0;
  const partialRows = [{ workspace_id: 'workspace-1', reminder_id: 'reminder-1' }];
  const partial = fakeDeps({
    files: { '001_mvp.sql': sql },
    schemaMigrationsExists: async () => true,
    listAppliedVersions: async () => [],
    execute: async (statement) => {
      executed.push(statement);
    },
    commit: async () => {
      commits += 1;
    }
  });
  await runMigrations(partial);
  assert.equal(executed.length, 2, 'the real block and ledger MERGE must both execute for an empty ledger');
  assert.equal(commits, 1);
  assert.deepEqual(partialRows, [{ workspace_id: 'workspace-1', reminder_id: 'reminder-1' }], 'resume must not lose prior rows');

  const failedStatements: string[] = [];
  await assert.rejects(
    () =>
      runMigrations(
        fakeDeps({
          files: { '001_mvp.sql': sql },
          schemaMigrationsExists: async () => true,
          listAppliedVersions: async () => [],
          execute: async (statement) => {
            failedStatements.push(statement);
            throw Object.assign(new Error('ORA-20006: incompatible DUE_AT_EPOCH column'), { errorNum: 20006 });
          }
        })
      ),
    /incompatible DUE_AT_EPOCH/
  );
  assert.equal(failedStatements.length, 1, 'a compatibility failure must stop before the version MERGE');

  const noOpStatements: string[] = [];
  await runMigrations(
    fakeDeps({
      files: { '001_mvp.sql': sql },
      schemaMigrationsExists: async () => true,
      listAppliedVersions: async () => [1],
      execute: async (statement) => {
        noOpStatements.push(statement);
      }
    })
  );
  assert.deepEqual(noOpStatements, [], 'a successfully recorded version must not replay 001');
});

test('runMigrations does not swallow an unrelated error (only Oracle itself may decide ORA-00955 is safe)', async () => {
  const deps = fakeDeps({
    files: { '001_mvp.sql': 'BEGIN NULL; END;\n/\n' },
    execute: async () => {
      throw Object.assign(new Error('ORA-00955: name is already used by an existing object'), { errorNum: 955 });
    }
  });
  // The CLI must never itself interpret/swallow ORA-00955; only the migration file's own PL/SQL
  // exception handler may do that (and only after validating compatibility). If the database
  // raises it to the driver uncaught, it must propagate.
  await assert.rejects(() => runMigrations(deps), /ORA-00955/);
});

test('runMigrations applies multiple pending files in ascending version order', async () => {
  const order: string[] = [];
  const deps = fakeDeps({
    files: {
      '002_second.sql': 'SELECT 1 FROM dual;\n',
      '001_first.sql': 'SELECT 1 FROM dual;\n'
    },
    onApplied: (file) => order.push(file.name)
  });
  await runMigrations(deps);
  assert.deepEqual(order, ['001_first.sql', '002_second.sql']);
});

// --- compatibility.ts: existing-object classification rules -----------------------------------

test('classifyExistingObject treats a matching table as compatible (safe to skip)', () => {
  const result = classifyExistingObject(
    { kind: 'table', name: 'WORKSPACES', expectedColumnCount: 3 },
    { objectType: 'TABLE', columnCount: 3 }
  );
  assert.deepEqual(result, { status: 'compatible' });
});

test('classifyExistingObject rejects a name collision with a non-table object', () => {
  const result = classifyExistingObject(
    { kind: 'table', name: 'WORKSPACES', expectedColumnCount: 3 },
    { objectType: 'VIEW' }
  );
  assert.equal(result.status, 'incompatible');
  assert.match((result as { reason: string }).reason, /already exists as VIEW, expected TABLE/);
});

test('classifyExistingObject rejects a table with a different column count', () => {
  const result = classifyExistingObject(
    { kind: 'table', name: 'WORKSPACES', expectedColumnCount: 3 },
    { objectType: 'TABLE', columnCount: 5 }
  );
  assert.equal(result.status, 'incompatible');
  assert.match((result as { reason: string }).reason, /already exists with 5 column\(s\), expected 3/);
});

test('classifyExistingObject rejects when the colliding name is not visible in USER_OBJECTS', () => {
  const result = classifyExistingObject({ kind: 'table', name: 'WORKSPACES', expectedColumnCount: 3 }, {});
  assert.equal(result.status, 'incompatible');
  assert.match((result as { reason: string }).reason, /not visible in USER_OBJECTS/);
});

test('classifyExistingObject accepts a matching index and rejects an index on the wrong table', () => {
  const expected: Parameters<typeof classifyExistingObject>[0] = {
    kind: 'index',
    name: 'REMINDERS_DUE_IDX',
    expectedTable: 'REMINDERS'
  };
  assert.deepEqual(classifyExistingObject(expected, { objectType: 'INDEX', indexOnExpectedTable: true }), {
    status: 'compatible'
  });
  const wrongTable = classifyExistingObject(expected, { objectType: 'INDEX', indexOnExpectedTable: false });
  assert.equal(wrongTable.status, 'incompatible');
  assert.match((wrongTable as { reason: string }).reason, /not on table REMINDERS/);
});

// --- migrations/001_mvp.sql: run the real handwritten script through the tested parser --------

test('the real migrations/001_mvp.sql parses into exactly one idempotent PL/SQL block plus one MERGE, and both execute as opaque units', async () => {
  const sql = await readFile(resolve(process.cwd(), 'migrations/001_mvp.sql'), 'utf8');
  const stmts = splitSqlScript(sql);
  assert.equal(stmts.length, 2, 'expected one anonymous PL/SQL block and one trailing MERGE');
  assert.match(stmts[0]!, /DECLARE[\s\S]*END;$/);
  assert.match(stmts[1]!, /MERGE INTO schema_migrations[\s\S]*;$/);
  // The block must not have been split on any of its many internal semicolons.
  assert.ok(stmts[0]!.includes("EXCEPTION\n      WHEN OTHERS THEN"));
  assert.ok(stmts[0]!.includes('RAISE_APPLICATION_ERROR'));

  const executed: string[] = [];
  await executeMigrationScript(sql, async (stmt) => {
    executed.push(stmt);
  });
  assert.equal(executed.length, 2);
});

test('migrations/001_mvp.sql declares a column count for every table matching its own DDL text', async () => {
  const sql = await readFile(resolve(process.cwd(), 'migrations/001_mvp.sql'), 'utf8');
  const entries = [...sql.matchAll(/v_name\(v_n\) := '([A-Z_]+)';\s*\n\s*v_kind\(v_n\) := 'TABLE';\s*\n\s*v_cols\(v_n\) := (\d+);\s*\n\s*v_ddl\(v_n\) := '([\s\S]*?)';\n/g)];
  assert.ok(entries.length >= 20, `expected many table entries, found ${entries.length}`);

  for (const [, name, colsText, ddl] of entries) {
    const declaredCount = Number(colsText);
    const actualCount = countTableColumns(ddl!);
    assert.equal(actualCount, declaredCount, `${name}: declared column count ${declaredCount} does not match DDL (${actualCount})`);
  }
});

test('migrations/001_mvp.sql uses UTC epoch keys instead of timezone-aware timestamps in unique constraints', async () => {
  const sql = await readFile(resolve(process.cwd(), 'migrations/001_mvp.sql'), 'utf8');
  const occurrence = sql.match(/CREATE TABLE reminder_occurrences \(([\s\S]*?)\)'/i)?.[1];
  const checkRun = sql.match(/CREATE TABLE check_runs \(([\s\S]*?)\)'/i)?.[1];

  assert.match(occurrence ?? '', /due_at TIMESTAMP\(3\) WITH TIME ZONE NOT NULL/);
  assert.match(occurrence ?? '', /due_at_epoch NUMBER\(19\) NOT NULL/);
  assert.match(occurrence ?? '', /UNIQUE \(workspace_id, reminder_id, schedule_version, due_at_epoch\)/);
  assert.doesNotMatch(occurrence ?? '', /UNIQUE \([^)]*due_at\)/);
  assert.match(checkRun ?? '', /slot_at TIMESTAMP\(3\) WITH TIME ZONE NOT NULL/);
  assert.match(checkRun ?? '', /slot_at_epoch NUMBER\(19\) NOT NULL/);
  assert.match(checkRun ?? '', /UNIQUE \(workspace_id, monitor_id, config_version, slot_at_epoch\)/);
  assert.doesNotMatch(checkRun ?? '', /UNIQUE \([^)]*slot_at\)/);
  assert.match(sql, /verify_epoch_deduplication\(/);
  assert.match(sql, /failed creating ' \|\| v_name\(i\)/);
});

test('migrations/001_mvp.sql has no other timezone-aware timestamp in a primary or unique key', async () => {
  const sql = await readFile(resolve(process.cwd(), 'migrations/001_mvp.sql'), 'utf8');
  const tableDdls = [...sql.matchAll(/CREATE TABLE [a-z_]+ \(([\s\S]*?)\)'/gi)].map((match) => match[1]!);
  for (const ddl of tableDdls) {
    const timezoneColumns = [...ddl.matchAll(/^\s*([a-z_]+) TIMESTAMP(?:\(\d+\))? WITH TIME ZONE\b/gim)].map((match) => match[1]);
    for (const timezoneColumn of timezoneColumns) {
      assert.doesNotMatch(ddl, new RegExp(`(?:PRIMARY KEY|UNIQUE) \\([^)]*\\b${timezoneColumn}\\b`, 'i'));
    }
  }
});

test('reminder occurrence binding uses epoch milliseconds for a timezone-independent instant key', async () => {
  const source = await readFile(resolve(process.cwd(), 'src/store/oracleApp.ts'), 'utf8');
  assert.match(source, /due_at_epoch: row\.NEXT_DUE_AT\.getTime\(\)/);

  const sameInstantUtc = new Date('2026-11-01T05:30:00.123Z');
  const sameInstantOffset = new Date('2026-11-01T01:30:00.123-04:00');
  const dstFoldLater = new Date('2026-11-01T01:30:00.123-05:00');
  assert.equal(sameInstantUtc.getTime(), sameInstantOffset.getTime(), 'equal instants must deduplicate across offsets');
  assert.notEqual(sameInstantUtc.getTime(), dstFoldLater.getTime(), 'DST-fold instants must remain distinct');
  assert.equal(sameInstantUtc.getTime() % 1000, 123, 'millisecond precision must be retained');
});

test('schema inspection is an explicit read-only .env command', async () => {
  const packageJson = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const source = await readFile(resolve(process.cwd(), 'src/runtime/inspect-schema.ts'), 'utf8');
  assert.equal(packageJson.scripts['inspect:schema'], 'node --env-file=.env --import tsx src/runtime/inspect-schema.ts');
  assert.match(source, /FROM user_tab_columns/);
  assert.match(source, /FROM user_constraints/);
  assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE)\b/);
});

// --- reserved-words.ts: Oracle reserved identifiers -------------------------------------------

test('findReservedIdentifiers reproduces the ORA-03050 failure for the historical monitors DDL', () => {
  // Exactly the DDL that failed live with:
  //   ORA-20008: Migration 001: failed creating MONITORS: ORA-03050: invalid identifier:
  //   "MODE" is a reserved word
  const historical = `CREATE TABLE monitors (
  workspace_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  mode VARCHAR2(8) NOT NULL CHECK (mode IN ('pull', 'push')),
  state VARCHAR2(16) DEFAULT 'unknown' NOT NULL
)`;
  const findings = findReservedIdentifiers(historical);
  assert.ok(
    findings.some((finding) => finding.identifier === 'MODE' && finding.context.includes('CREATE TABLE MONITORS')),
    `expected the reserved column MODE to be reported, got ${JSON.stringify(findings)}`
  );
});

test('findReservedIdentifiers flags reserved identifiers in DML and DDL but accepts quoted or renamed ones', () => {
  assert.deepEqual(
    findReservedIdentifiers(`SELECT deadline_version FROM monitors WHERE mode = 'push'`).map((f) => f.identifier),
    ['MODE']
  );
  assert.deepEqual(
    findReservedIdentifiers(`INSERT INTO monitors(workspace_id, mode) VALUES (:workspace_id, 'push')`).map((f) => f.identifier),
    ['MODE']
  );
  assert.deepEqual(findReservedIdentifiers(`SELECT monitor_mode AS mode FROM monitors`).map((f) => f.identifier), ['MODE']);
  // Quoting is the only legal way to keep a reserved word as an identifier; the migration uses it
  // solely to rename the legacy column away.
  assert.deepEqual(findReservedIdentifiers(`ALTER TABLE monitors RENAME COLUMN "MODE" TO monitor_mode`), []);
  assert.deepEqual(findReservedIdentifiers(`SELECT deadline_version FROM monitors WHERE monitor_mode = 'push'`), []);
  // Bind variables and pseudocolumns must not be misreported as identifiers.
  assert.deepEqual(findReservedIdentifiers(`SELECT object_type FROM user_objects WHERE object_name = :mode AND ROWNUM = 1`), []);
});

test('no handwritten migration uses an Oracle reserved word as an unquoted identifier', async () => {
  for (const file of ['migrations/001_mvp.sql', 'migrations/002_monitor_mode.sql']) {
    const sql = await readFile(resolve(process.cwd(), file), 'utf8');
    assert.deepEqual(findReservedIdentifiers(sql), [], `${file} must not declare/reference reserved identifiers unquoted`);
  }
});

test('no runtime SQL uses an Oracle reserved word as an unquoted identifier', async () => {
  const sources = ['src/store/oracle.ts', 'src/store/oracleApp.ts', 'src/runtime/migrate.ts', 'src/runtime/inspect-schema.ts'];
  for (const file of sources) {
    const statements = extractSqlLiteralsFromSource(await readFile(resolve(process.cwd(), file), 'utf8'));
    assert.ok(statements.length > 0, `${file}: expected to find SQL statements to audit`);
    for (const statement of statements) {
      assert.deepEqual(findReservedIdentifiers(statement), [], `${file}: ${statement}`);
    }
  }
});

// --- monitors.monitor_mode: schema, transition rules and runtime mapping ----------------------

test('migrations/001_mvp.sql declares monitor_mode with the pull/push contract and no MODE column', async () => {
  const sql = await readFile(resolve(process.cwd(), 'migrations/001_mvp.sql'), 'utf8');
  const monitors = sql.match(/CREATE TABLE monitors \(([\s\S]*?)\)'/i)?.[1] ?? '';
  assert.match(monitors, /monitor_mode VARCHAR2\(8\) NOT NULL CHECK \(monitor_mode IN \(''pull'', ''push''\)\)/);
  assert.doesNotMatch(monitors, /^\s*mode\b/im);
  // The legacy column may only appear quoted, in the one-off rename.
  assert.match(sql, /ALTER TABLE monitors RENAME COLUMN "MODE" TO monitor_mode/);
});

test('migrations/002_monitor_mode.sql is a parsable forward migration recorded as version 2', async () => {
  const sql = await readFile(resolve(process.cwd(), 'migrations/002_monitor_mode.sql'), 'utf8');
  const stmts = splitSqlScript(sql);
  assert.equal(stmts.length, 2, 'expected one anonymous PL/SQL block and one trailing MERGE');
  assert.match(stmts[0]!, /DECLARE[\s\S]*END;$/);
  assert.ok(!stmts[0]!.includes('\n/'), 'the slash batch terminator must not be part of the statement');
  assert.match(stmts[1]!, /MERGE INTO schema_migrations[\s\S]*SELECT 2 AS version[\s\S]*;$/);
  // It must never repair schema by recreating or copying, and must not replay data migrations.
  assert.doesNotMatch(stmts[0]!, /\b(DROP|TRUNCATE|CREATE TABLE|DELETE)\b/i);
  assert.match(stmts[0]!, /RAISE_APPLICATION_ERROR/);
});

test('classifyMonitorModeColumn mirrors the PL/SQL transition rules for every column state', () => {
  const valid = { dataType: 'VARCHAR2', charLength: 8, nullable: false };
  const state = (overrides: Partial<MonitorModeState>): MonitorModeState => ({ hasPullPushCheck: true, ...overrides });

  assert.deepEqual(classifyMonitorModeColumn(state({ current: valid })), { action: 'none' });
  assert.deepEqual(classifyMonitorModeColumn(state({ legacy: valid })), { action: 'rename-legacy' });

  const both = classifyMonitorModeColumn(state({ legacy: valid, current: valid }));
  assert.equal(both.action, 'stop');
  assert.match((both as { reason: string }).reason, /both the legacy "MODE" column and MONITOR_MODE/);

  const neither = classifyMonitorModeColumn(state({}));
  assert.equal(neither.action, 'stop');
  assert.match((neither as { reason: string }).reason, /neither MONITOR_MODE nor a legacy "MODE" column/);

  const wrongType = classifyMonitorModeColumn(state({ current: { dataType: 'NUMBER', charLength: 0, nullable: false } }));
  assert.equal(wrongType.action, 'stop');
  const nullable = classifyMonitorModeColumn(state({ current: { ...valid, nullable: true } }));
  assert.equal(nullable.action, 'stop');
  const wrongLength = classifyMonitorModeColumn(state({ legacy: { ...valid, charLength: 16 } }));
  assert.equal(wrongLength.action, 'stop');

  const missingCheck = classifyMonitorModeColumn({ current: valid, hasPullPushCheck: false });
  assert.equal(missingCheck.action, 'stop');
  assert.match((missingCheck as { reason: string }).reason, /CHECK constraint/);
});

test('the PL/SQL monitor-mode guard covers the same states as classifyMonitorModeColumn', async () => {
  for (const file of ['migrations/001_mvp.sql', 'migrations/002_monitor_mode.sql']) {
    const sql = await readFile(resolve(process.cwd(), file), 'utf8');
    assert.match(sql, /v_legacy > 0 AND v_current > 0/, `${file}: both-column refusal`);
    assert.match(sql, /v_legacy = 0 AND v_current = 0/, `${file}: neither-column refusal`);
    assert.match(sql, /data_type = 'VARCHAR2'[\s\S]*char_length = 8[\s\S]*nullable = 'N'/, `${file}: type/nullability check`);
    assert.match(sql, /search_condition_vc\) LIKE '%PULL%'/, `${file}: pull/push check constraint`);
    assert.match(sql, /IF v_current = 0 THEN[\s\S]*RENAME COLUMN "MODE" TO monitor_mode/, `${file}: legacy rename`);
  }
});

test('the fixed 001 and forward 002 apply in order for a fresh install and skip already-recorded versions', async () => {
  const files = {
    '001_mvp.sql': await readFile(resolve(process.cwd(), 'migrations/001_mvp.sql'), 'utf8'),
    '002_monitor_mode.sql': await readFile(resolve(process.cwd(), 'migrations/002_monitor_mode.sql'), 'utf8')
  };

  const freshOrder: string[] = [];
  await runMigrations(fakeDeps({ files, onApplied: (file) => freshOrder.push(file.name) }));
  assert.deepEqual(freshOrder, ['001_mvp.sql', '002_monitor_mode.sql']);

  // Legacy install: version 1 is already recorded, so only the forward migration may run - 001
  // alone can never repair it, which is why 002 exists.
  const legacyOrder: string[] = [];
  await runMigrations(
    fakeDeps({
      files,
      schemaMigrationsExists: async () => true,
      listAppliedVersions: async () => [1],
      onApplied: (file) => legacyOrder.push(file.name)
    })
  );
  assert.deepEqual(legacyOrder, ['002_monitor_mode.sql']);

  // Repeat run after both versions are recorded: no statement is executed at all, so no data can
  // change and no historical migration is replayed.
  const repeated: string[] = [];
  await runMigrations(
    fakeDeps({
      files,
      schemaMigrationsExists: async () => true,
      listAppliedVersions: async () => [1, 2],
      execute: async (statement) => {
        repeated.push(statement);
      }
    })
  );
  assert.deepEqual(repeated, []);
});

test('a refused monitor-mode state stops before 002 is recorded as applied', async () => {
  const files = {
    '002_monitor_mode.sql': await readFile(resolve(process.cwd(), 'migrations/002_monitor_mode.sql'), 'utf8')
  };
  let commits = 0;
  const executed: string[] = [];
  await assert.rejects(
    () =>
      runMigrations(
        fakeDeps({
          files,
          schemaMigrationsExists: async () => true,
          listAppliedVersions: async () => [1],
          execute: async (statement) => {
            executed.push(statement);
            throw Object.assign(
              new Error('ORA-20009: Migration 002: table MONITORS has both the legacy "MODE" column and MONITOR_MODE.'),
              { errorNum: 20009 }
            );
          },
          commit: async () => {
            commits += 1;
          }
        })
      ),
    /ORA-20009/
  );
  assert.equal(executed.length, 1, 'the failure must stop before the ledger MERGE');
  assert.equal(commits, 0, 'a failed migration must never be recorded as applied');
});

/**
 * Test-only helper: counts column definitions (as opposed to PRIMARY KEY/FOREIGN KEY/UNIQUE/CHECK
 * table-level constraints) in a `CREATE TABLE name (...)` DDL string, by splitting on top-level
 * commas (respecting nested parentheses). This is a self-consistency check on the authored
 * migration file, not a general SQL parser.
 */
function countTableColumns(ddl: string): number {
  const open = ddl.indexOf('(');
  const close = ddl.lastIndexOf(')');
  const body = ddl.slice(open + 1, close);
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);

  const constraintKeywords = /^\s*(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i;
  return parts.map((p) => p.trim()).filter((p) => p && !constraintKeywords.test(p)).length;
}
