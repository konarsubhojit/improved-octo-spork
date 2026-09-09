-- Forward migration for installs whose `schema_migrations` already records version 1, i.e. where a
-- previous `001_mvp.sql` completed with the old `MODE` column. The CLI skips recorded versions, so
-- `001` alone cannot repair those installs; conversely `002` alone cannot repair an install where
-- `001` failed part-way (the runner never reaches `002` until `001` completes), which is why the
-- fix is applied in both files.
--
-- Root cause: Oracle rejects MODE as an identifier with
-- `ORA-03050: invalid identifier: "MODE" is a reserved word`
-- (https://docs.oracle.com/error-help/db/ora-03050/). The physical column is therefore
-- MONITOR_MODE; the API/domain JSON property is unchanged and remains `mode`.
--
-- Idempotency: safe to run repeatedly, via `npm run migrate` or directly (SQLcl `@`/SQL Developer
-- "Run Script", which honor the `/` terminator below). When MONITOR_MODE already exists with the
-- expected type/nullability/check constraint this block is a validated no-op; when only the legacy
-- "MODE" column exists it is renamed in place with ALTER TABLE ... RENAME COLUMN, preserving every
-- row, the NOT NULL constraint and the pull/push check condition. Nothing is dropped, truncated,
-- recreated or copied, and no historical data migration is replayed. Ambiguous or incompatible
-- states (both columns present, neither present, wrong type, missing check constraint, or no
-- MONITORS table at all) stop the script with an actionable error instead of being swallowed.
-- Single operator at a time; Oracle DDL commits implicitly, so this is not a rollback mechanism.
DECLARE
  v_table PLS_INTEGER;
  v_legacy PLS_INTEGER;
  v_current PLS_INTEGER;
  v_valid PLS_INTEGER;
  v_check PLS_INTEGER;
  v_column VARCHAR2(30);
BEGIN
  SELECT COUNT(*) INTO v_table FROM user_tables WHERE table_name = 'MONITORS';
  IF v_table = 0 THEN
    RAISE_APPLICATION_ERROR(-20013,
      'Migration 002: table MONITORS does not exist; apply 001_mvp.sql first (see ' ||
      'migrations/README.md) rather than recording this migration as applied.');
  END IF;

  SELECT COUNT(*) INTO v_legacy
    FROM user_tab_columns WHERE table_name = 'MONITORS' AND column_name = 'MODE';
  SELECT COUNT(*) INTO v_current
    FROM user_tab_columns WHERE table_name = 'MONITORS' AND column_name = 'MONITOR_MODE';

  IF v_legacy > 0 AND v_current > 0 THEN
    RAISE_APPLICATION_ERROR(-20009,
      'Migration 002: table MONITORS has both the legacy "MODE" column and MONITOR_MODE. ' ||
      'That state is ambiguous and is never resolved automatically; consolidate the values ' ||
      'manually (see migrations/README.md) before rerunning.');
  ELSIF v_legacy = 0 AND v_current = 0 THEN
    RAISE_APPLICATION_ERROR(-20010,
      'Migration 002: table MONITORS has neither MONITOR_MODE nor a legacy "MODE" column, so ' ||
      'it is not a compatible monitors table. Resolve manually before rerunning.');
  END IF;

  IF v_current > 0 THEN
    v_column := 'MONITOR_MODE';
  ELSE
    v_column := 'MODE';
  END IF;
  SELECT COUNT(*) INTO v_valid
    FROM user_tab_columns
   WHERE table_name = 'MONITORS'
     AND column_name = v_column
     AND data_type = 'VARCHAR2'
     AND char_length = 8
     AND nullable = 'N';
  IF v_valid != 1 THEN
    RAISE_APPLICATION_ERROR(-20011,
      'Migration 002: MONITORS.' || v_column || ' must be VARCHAR2(8) NOT NULL before it can ' ||
      'be used as the monitor mode column. Resolve manually before rerunning.');
  END IF;

  SELECT COUNT(*) INTO v_check
    FROM user_constraints
   WHERE table_name = 'MONITORS'
     AND constraint_type = 'C'
     AND UPPER(search_condition_vc) LIKE '%PULL%'
     AND UPPER(search_condition_vc) LIKE '%PUSH%';
  IF v_check < 1 THEN
    RAISE_APPLICATION_ERROR(-20012,
      'Migration 002: MONITORS is missing a CHECK constraint restricting the monitor mode to ' ||
      '''pull''/''push''. Add it manually before rerunning.');
  END IF;

  IF v_current = 0 THEN
    BEGIN
      -- The legacy name must be quoted here precisely because it is a reserved word.
      EXECUTE IMMEDIATE 'ALTER TABLE monitors RENAME COLUMN "MODE" TO monitor_mode';
    EXCEPTION
      WHEN OTHERS THEN
        RAISE_APPLICATION_ERROR(-20014,
          'Migration 002: failed renaming MONITORS."MODE" to MONITOR_MODE: ' || SQLERRM, TRUE);
    END;
  END IF;
END;
/

-- Records this migration as applied. MERGE keeps direct script execution idempotent; the CLI
-- additionally skips files whose version is already recorded.
MERGE INTO schema_migrations t
USING (SELECT 2 AS version FROM dual) s
ON (t.version = s.version)
WHEN NOT MATCHED THEN INSERT (version) VALUES (s.version);
