import { splitSqlScript } from './sql-script.js';

/**
 * Executes every statement in a migration file's SQL text, in order, via `execute`.
 * Each migration file is expected to be self-contained and idempotent: individual
 * `CREATE TABLE`/`CREATE INDEX` statements must tolerate being re-run against an existing,
 * compatible object, and any version bookkeeping the file performs (e.g. a trailing
 * `MERGE ... INTO schema_migrations`) must itself be safe to repeat.
 *
 * This function performs no idempotency logic itself; it is purely responsible for turning
 * script text into an ordered sequence of statements and running them. If any statement throws,
 * execution stops immediately (fail-fast) and the error propagates to the caller.
 */
export async function executeMigrationScript(sql: string, execute: (statement: string) => Promise<unknown>): Promise<void> {
  const statements = splitSqlScript(sql);
  for (const statement of statements) {
    await execute(statement);
  }
}
