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
  block raises a clear error and the whole script stops. `reminder_occurrences` and `check_runs`
  additionally verify their affected timestamp types and UTC-epoch unique-key columns. It never drops,
  recreates, or truncates anything, and it never proceeds past an incompatible object.
- Any error other than `ORA-00955` (permissions, syntax, a missing FK target, etc.) is re-raised
  immediately with the migration object name. Its Oracle code/message remains in the error stack;
  it is never swallowed.
- If the existing object passes those checks, it is treated as already applied and the script
  continues with the next object. This lets the script resume a migration that was interrupted
  partway through (Oracle DDL statements each commit implicitly, so a prior failed run can leave
  some tables created and others missing).
- The trailing `MERGE INTO schema_migrations ... WHEN NOT MATCHED THEN INSERT` records version 1
  exactly once, and is itself safe to re-run (unlike a plain `INSERT`, which would raise a
  duplicate-key error on a second run).

**This is a targeted compatibility check, not a full schema/DDL diff.** It compares object type and
(for tables) column count only, except that `reminder_occurrences` and `check_runs` additionally
verify their `TIMESTAMP(3) WITH TIME ZONE` columns, `NUMBER(19)` UTC-epoch columns, and unique-key
column order. It does not compare other column types, defaults, `CHECK`/`FOREIGN KEY` constraints,
or index key columns. If you suspect schema drift, inspect the object manually before relying on a
rerun. The general decision rules are documented and unit-tested in
`src/runtime/migration/compatibility.ts`.

**Rerunning is not a rollback mechanism.** There is no down migration, and idempotent DDL does not
undo or repair data. If a table already exists with an incompatible definition, fix it manually
(rename, drop only after confirming no data loss is acceptable, or adjust the migration) before
rerunning - the script will not do this for you.

**Single operator only.** This idempotency scheme is not concurrency-safe: it is not tested against
two sessions applying the same migration file at the same time, and Oracle's implicit per-statement
commit means a second concurrent run could observe a partially-applied first run mid-flight.
Run migrations from one operator/session at a time.

## Editing an already-applied migration file

The original `001_mvp.sql` can fail partway through because Oracle prohibits a `TIMESTAMP WITH TIME
ZONE` column in a primary or unique key (ORA-02329). The corrected first-install path retains
`due_at`/`slot_at` as `TIMESTAMP(3) WITH TIME ZONE` for absolute-instant reads, and deduplicates
with separately bound `NUMBER(19)` UTC epoch milliseconds. Equal instants with different offsets
therefore share a key; the two local times in a DST fold do not. Local IANA recurrence data remains
in `local_schedule_json` and is not converted by the database.

If a prior `001` run stopped before its ledger row was written, rerun this corrected `001` from one
session: it recognizes the preceding compatible tables and continues without dropping, truncating,
or recreating data. Do not add `002` to repair this particular midway failure—the runner will not
reach it until `001` completes. If version 1 is already recorded, use a separately reviewed forward
migration for any schema correction; this file is intentionally skipped by the CLI in that state.

Before rerunning, inspect only the relevant existing schema (the command reads Oracle dictionary
views and never performs DDL/DML):

```sh
npm run inspect:schema
```

It loads the local ignored `.env` and prints no credential values. Verify that an existing affected
table has the timestamp/epoch columns and unique-key order described above; an incompatible object
will fail the corrected `001` rather than being changed automatically. Keep the output private if
your object names are sensitive.

The automated tests parse the real migration text and test JavaScript instant-key semantics, but
fake tests cannot prove Oracle engine DDL acceptance. An optional live regression must be run
manually against an already authorized, disposable development schema only; it is not run by this
repository's test command and this project does not provision or alter a database automatically.

The scheduler claim transaction should select due `jobs` using
`FOR UPDATE SKIP LOCKED`, increment `fence`, set a bounded `lease_until`, and commit before processing.
Every result update must match `job_id`, `lease_owner`, and `fence`; expired leases are reclaimable.
This pattern requires validation against the exact existing Oracle service before production use.

No down migration is supplied because it would destroy live data. Backups, RPO/RTO, and restore
testing are intentionally deferred.
