import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import oracledb from 'oracledb';
import { createOraclePool } from '../store/oracle.js';
import { loadConfig } from './config.js';

const config = loadConfig({ ...process.env, PROCESS_ROLE: 'scheduler' });
if (!config.database) throw new Error('Migrations require Oracle credentials');

const pool = await createOraclePool(config.database);
const connection = await pool.getConnection();

try {
  await connection.execute(`
    BEGIN
      EXECUTE IMMEDIATE 'CREATE TABLE schema_migrations (version NUMBER(10) PRIMARY KEY, applied_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL)';
    EXCEPTION WHEN OTHERS THEN
      IF SQLCODE != -955 THEN RAISE; END IF;
    END;`);

  const applied = await connection.execute<{ VERSION: number }>(
    `SELECT version FROM schema_migrations ORDER BY version`,
    {},
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  const versions = new Set((applied.rows ?? []).map((row) => row.VERSION));

  const migrationDir = resolve(process.cwd(), 'migrations');
  const files = (await readdir(migrationDir))
    .map((name) => ({ name, match: /^(\d+)_.*\.sql$/.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => !!item.match)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));

  for (const file of files) {
    const version = Number(file.match[1]);
    if (versions.has(version)) continue;
    const sql = await readFile(resolve(migrationDir, file.name), 'utf8');
    const statements = sql
      .split(/;\s*(?:\r?\n|$)/g)
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      if (/^INSERT\s+INTO\s+schema_migrations/i.test(statement)) continue;
      await connection.execute(statement);
    }
    await connection.execute(`INSERT INTO schema_migrations(version) VALUES (:version)`, { version });
    await connection.commit();
    process.stdout.write(`Applied migration ${file.name}\n`);
  }
} finally {
  await connection.close();
  await pool.close(5);
}
