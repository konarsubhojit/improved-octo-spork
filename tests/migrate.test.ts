import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { splitSqlScript } from '../src/runtime/migration/sql-script.js';
import { executeMigrationScript } from '../src/runtime/migration/run-script.js';
import { parseMigrationFileNames, pendingMigrations } from '../src/runtime/migration/plan.js';
import { runMigrations, type MigrationDeps } from '../src/runtime/migration/migrator.js';
import { classifyExistingObject } from '../src/runtime/migration/compatibility.js';

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
