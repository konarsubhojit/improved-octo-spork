import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import oracledb from 'oracledb';
import { createOraclePool } from '../store/oracle.js';
import { loadConfig } from './config.js';
import { runMigrations } from './migration/migrator.js';

const config = loadConfig({ ...process.env, PROCESS_ROLE: 'scheduler' });
if (!config.database) throw new Error('Migrations require Oracle credentials');

const pool = await createOraclePool(config.database);
const connection = await pool.getConnection();
const migrationDir = resolve(process.cwd(), 'migrations');

try {
  await runMigrations({
    // Targeted existence check only: never assume schema_migrations is missing, and never
    // blanket-swallow errors. Migration files (starting with 001_mvp.sql) are solely responsible
    // for creating schema_migrations idempotently; this CLI must not duplicate that DDL.
    async schemaMigrationsExists() {
      const result = await connection.execute<{ COUNT: number }>(
        `SELECT COUNT(*) AS "COUNT" FROM user_tables WHERE table_name = 'SCHEMA_MIGRATIONS'`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return (result.rows?.[0]?.COUNT ?? 0) > 0;
    },
    async listAppliedVersions() {
      const result = await connection.execute<{ VERSION: number }>(
        `SELECT version FROM schema_migrations ORDER BY version`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return (result.rows ?? []).map((row) => row.VERSION);
    },
    listMigrationFileNames: () => readdir(migrationDir),
    readMigrationFile: (name) => readFile(resolve(migrationDir, name), 'utf8'),
    execute: (statement) => connection.execute(statement),
    commit: () => connection.commit(),
    onApplied: (file) => process.stdout.write(`Applied migration ${file.name}\n`)
  });
} finally {
  await connection.close();
  await pool.close(5);
}
