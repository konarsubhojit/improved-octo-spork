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
  additionally verify their affected timestamp types and UTC-epoch unique-key columns, and
  `monitors` additionally validates its monitor mode column (see the reserved-words section below). It never drops,
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

## Reserved words: `monitors.mode` -> `monitors.monitor_mode`

Oracle rejects `MODE` as an identifier:
`ORA-03050: invalid identifier: "MODE" is a reserved word`
(<https://docs.oracle.com/error-help/db/ora-03050/>). A reserved word can only be used as an
identifier when it is double-quoted, which makes every later reference case-sensitive and
quote-dependent, so the physical column was renamed to `MONITOR_MODE` instead. **The API/domain JSON
property is unchanged and remains `mode`** - only the database mapping moved.

What each install needs:

| Existing state | What to run | What happens |
| --- | --- | --- |
| Fresh schema | `001` then `002` (the CLI does both) | `MONITORS` is created with `MONITOR_MODE`; `002` validates and is a no-op |
| `001` failed before/at `MONITORS` (no ledger row) | rerun `001`, then `002` | existing compatible objects are recognized and skipped; `MONITORS` is created with `MONITOR_MODE` |
| `001` recorded as version 1, legacy `"MODE"` column | `002` (the CLI skips `001`) | `ALTER TABLE monitors RENAME COLUMN "MODE" TO monitor_mode`, in place, preserving all rows and the `NOT NULL` / pull-push `CHECK` |
| `MONITOR_MODE` already correct | `002` | validated no-op |
| Both `"MODE"` and `MONITOR_MODE`, or neither, or wrong type/nullability, or missing pull/push `CHECK` | `001`/`002` stop | actionable `ORA-20009`..`ORA-20012` error; nothing is changed, dropped or guessed |

`002` alone cannot repair an install where `001` failed part-way (the runner never reaches `002`
until `001` completes), and `001` alone cannot repair an install that already recorded version 1 -
which is why the rename logic exists in both files. Neither file replays a historical data
migration, and neither drops, truncates, recreates or copies a table.

The rename itself is `ALTER TABLE ... RENAME COLUMN`, so data, `NOT NULL`, and the `CHECK`
constraint follow the column; Oracle rewrites the stored check condition to the new name. The
transition rules are mirrored, and unit-tested, as
`classifyMonitorModeColumn` in `src/runtime/migration/compatibility.ts`; keep the PL/SQL and the
TypeScript in sync if they ever change.

## Identifier audit: method, scope and limits

All handwritten table, column and index names in `migrations/*.sql`, plus every SQL statement in
`src/store/*.ts` and `src/runtime/{migrate,inspect-schema}.ts`, were audited against the Oracle SQL
reserved-word list. The audit is executable, not a one-off review:
`src/runtime/migration/reserved-words.ts` implements it and `tests/migrate.test.ts` fails the build
if any reserved word is used as an unquoted identifier (table name, column definition, insert column
list, select item, alias, or predicate operand).

- **Result:** `monitors.mode` was the only reserved-word identifier. Everything else is a keyword-ish
  but non-reserved word (for example `state`, `role`, `zone`, `method`, `action`, `channel`,
  `priority`, `outcome`, `attempts`, `version`, `name`) or a plural/suffixed form of a reserved word
  that is itself not reserved (`SESSIONS` vs `SESSION`, `USERS` vs `USER`). Those were left alone
  deliberately: renaming non-reserved identifiers without evidence would churn the schema for no
  benefit.
- **Sources:** the Oracle SQL Language Reference appendix *Oracle SQL Reserved Words*
  (<https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Oracle-SQL-Reserved-Words.html>)
  and the `ORA-03050` error help page (<https://docs.oracle.com/error-help/db/ora-03050/>).
- **Limits:** the word list is a static copy, so it cannot know about words a specific release or
  edition reserves in addition to the documented list. The scanner is a targeted matcher for the SQL
  subset this repository writes by hand - it does not parse index key *expressions*, dynamically
  concatenated identifiers, or SQL built outside these files. It checks identifier *usage*, not
  Oracle's own parser: only a live database can be authoritative.
- **Optional, read-only live check.** If you want your database's own list, run this as any account
  that already has the privilege - it is a `SELECT` against a dictionary view, performs no DDL/DML,
  and no elevated/DBA grant should be requested for it:

  ```sql
  SELECT keyword FROM v$reserved_words WHERE reserved = 'Y' ORDER BY keyword;
  ```

  (<https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/V-RESERVED_WORDS.html>.) If
  your instance reserves a word this repository uses as an identifier, open an issue with the word;
  do not quote it in place.

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
will fail the corrected `001` rather than being changed automatically. To check the monitor mode
column specifically, the same read-only command's dictionary queries can be adapted, or run:

```sql
SELECT column_name, data_type, char_length, nullable
  FROM user_tab_columns WHERE table_name = 'MONITORS' AND column_name IN ('MODE', 'MONITOR_MODE');
``` Keep the output private if
your object names are sensitive.

If the failed run stopped at `MONITORS` with `ORA-20008 ... ORA-03050`, no `MONITORS` table exists
yet: rerunning the corrected `001` from one session creates it with `MONITOR_MODE` and continues
with the remaining objects. Do not drop the tables that earlier statements already created, and do
not grant additional privileges - neither is needed.

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
