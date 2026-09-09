# Oracle migrations

`001_mvp.sql` targets Oracle Autonomous Transaction Processing and intentionally does not provision a
database. Apply it manually with a migration-only account, then grant the runtime roles only the
tables and operations each role needs.

## Supported ways to apply a migration file

- **CLI**: `PROCESS_ROLE=scheduler npm exec tsx src/runtime/migrate.ts` (also exposed as
  `npm run migrate`). It reads `migrations/*.sql` in ascending numeric order, skips any version
  already recorded in `schema_migrations`, and otherwise executes the file's statements in order
  via the Node Oracle driver.
- **Direct client**: run the `.sql` file with a client that understands SQL*Plus/SQLcl script
  conventions, e.g. **SQLcl** (`@migrations/001_mvp.sql`) or **SQL Developer's "Run Script" (F5)**.
  These clients honor the `/` on its own line as the batch terminator for the anonymous PL/SQL
  block; a plain `node`/`tsx` invocation of `oracledb` does **not** understand `/` or `SET`
  commands, which is why the CLI's own statement splitter (`src/runtime/migration/sql-script.ts`)
  strips them instead of sending them to the database.

Both paths run the exact same statements, so idempotency is a property of the `.sql` file itself,
not of the CLI.

## Idempotency guarantees and limits

Every `CREATE TABLE`/`CREATE INDEX` in `001_mvp.sql` (including `schema_migrations` itself) is
wrapped in `EXECUTE IMMEDIATE` inside a small PL/SQL block that catches `ORA-00955` ("name is
already used by an existing object"):

- If the existing object is not visible in `USER_OBJECTS`, is the wrong object type (e.g. a view
  where a table is expected), or - for tables - has a different column count than expected, the
  block raises a clear `ORA-20001`..`ORA-20005` error and the whole script stops. It never drops,
  recreates, or truncates anything, and it never proceeds past an incompatible object.
- Any error other than `ORA-00955` (permissions, syntax, a missing FK target, etc.) is always
  re-raised immediately; it is never swallowed.
- If the existing object passes those checks, it is treated as already applied and the script
  continues with the next object. This lets the script resume a migration that was interrupted
  partway through (Oracle DDL statements each commit implicitly, so a prior failed run can leave
  some tables created and others missing).
- The trailing `MERGE INTO schema_migrations ... WHEN NOT MATCHED THEN INSERT` records version 1
  exactly once, and is itself safe to re-run (unlike a plain `INSERT`, which would raise a
  duplicate-key error on a second run).

**This is a targeted compatibility check, not a full schema/DDL diff.** It compares object type and
(for tables) column count only - it does not compare column types, defaults, `CHECK`/`FOREIGN KEY`
constraints, or index key columns. An existing table with the right number of columns but a
different type or constraint is accepted as "compatible" and will not be flagged. If you suspect
schema drift, inspect the object manually (e.g. `DBMS_METADATA.GET_DDL`) before relying on a rerun.
The decision rules are documented and unit-tested in `src/runtime/migration/compatibility.ts`.

**Rerunning is not a rollback mechanism.** There is no down migration, and idempotent DDL does not
undo or repair data. If a table already exists with an incompatible definition, fix it manually
(rename, drop only after confirming no data loss is acceptable, or adjust the migration) before
rerunning - the script will not do this for you.

**Single operator only.** This idempotency scheme is not concurrency-safe: it is not tested against
two sessions applying the same migration file at the same time, and Oracle's implicit per-statement
commit means a second concurrent run could observe a partially-applied first run mid-flight.
Run migrations from one operator/session at a time.

## Editing an already-applied migration file

`001_mvp.sql` has not yet been executed against any Oracle service (see the root `README.md`), so
revising it here is a pre-deployment fix, not a rewrite of live schema history. Once a migration has
actually been applied anywhere, prefer a new forward migration file (`002_*.sql`, etc.) over editing
an existing one; if you manually applied an earlier version of this file's original (non-idempotent)
DDL to a database, the current idempotent version is designed to recognize the same tables it would
have created (same names, same column counts) and skip past them without touching your data.

The scheduler claim transaction should select due `jobs` using
`FOR UPDATE SKIP LOCKED`, increment `fence`, set a bounded `lease_until`, and commit before processing.
Every result update must match `job_id`, `lease_owner`, and `fence`; expired leases are reclaimable.
This pattern requires validation against the exact existing Oracle service before production use.

No down migration is supplied because it would destroy live data. Backups, RPO/RTO, and restore
testing are intentionally deferred.
