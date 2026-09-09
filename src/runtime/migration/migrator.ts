import { parseMigrationFileNames, pendingMigrations, type MigrationFile } from './plan.js';
import { executeMigrationScript } from './run-script.js';

/**
 * Narrow, testable seams the CLI migration runner needs from an Oracle connection. Kept generic
 * (no `oracledb` import) so this module can be unit-tested with deterministic fakes and carries
 * no live credentials or network dependency.
 */
export interface MigrationDeps {
  /** True when the `schema_migrations` tracking table already exists (targeted dictionary check). */
  schemaMigrationsExists(): Promise<boolean>;
  /** Versions already recorded in `schema_migrations`. Only called when the table exists. */
  listAppliedVersions(): Promise<number[]>;
  /** Lists migration file names available on disk (e.g. `001_mvp.sql`, `002_x.sql`). */
  listMigrationFileNames(): Promise<string[]>;
  /** Reads the full SQL text of a migration file by name. */
  readMigrationFile(name: string): Promise<string>;
  /** Executes a single top-level statement (a plain SQL statement or an anonymous PL/SQL block). */
  execute(statement: string): Promise<unknown>;
  /** Commits DML performed by the current migration file (e.g. its trailing version MERGE). */
  commit(): Promise<void>;
  /** Called once per migration file successfully applied, for CLI progress reporting. */
  onApplied?(file: MigrationFile): void;
}

/**
 * Applies every not-yet-recorded migration file, in version order. Fails fast: if any statement
 * in a file throws, that error propagates immediately and no later file (nor that file's own
 * version-recording statement) is executed. Already-recorded versions are skipped entirely,
 * never replayed.
 */
export async function runMigrations(deps: MigrationDeps): Promise<MigrationFile[]> {
  const versions = new Set<number>();
  if (await deps.schemaMigrationsExists()) {
    for (const version of await deps.listAppliedVersions()) versions.add(version);
  }

  const files = parseMigrationFileNames(await deps.listMigrationFileNames());
  const applied: MigrationFile[] = [];

  for (const file of pendingMigrations(files, versions)) {
    const sql = await deps.readMigrationFile(file.name);
    await executeMigrationScript(sql, (statement) => deps.execute(statement));
    await deps.commit();
    applied.push(file);
    deps.onApplied?.(file);
  }

  return applied;
}
