-- Oracle Autonomous Transaction Processing schema for the invite-only reminders/monitoring MVP.
-- Apply with a dedicated migration account, never the runtime application account.
--
-- Idempotency: this script is safe to run more than once against the same database, whether
-- applied directly (SQLcl `@migrations/001_mvp.sql` or SQL Developer "Run Script", which honors
-- the `/` block terminators below) or via `npm run migrate`. Each table/index is created inside
-- an EXECUTE IMMEDIATE guarded by an ORA-00955 ("name already used") handler; on that specific
-- error we verify the existing object is the expected type (TABLE/INDEX) and, for tables, that
-- its column count matches before treating it as already applied. Any other error - including an
-- incompatible object, a name collision with an unrelated object, or any ORA code other than -955
-- - is re-raised and stops the script; nothing is silently swallowed. See migrations/README.md
-- for the exact guarantees and limits of this check (it is not a full schema/DDL equivalence
-- diff, and reruns are not a rollback mechanism). The decision rules below (object type + column
-- count) are documented and unit-tested as the single source of truth in
-- src/runtime/migration/compatibility.ts; keep both in sync if these rules ever change.
--
-- Every DDL statement in Oracle performs an implicit commit, so a script that fails partway
-- through leaves the successfully created objects in place; rerunning is the supported recovery
-- path precisely because each object's creation is independently idempotent. The trailing
-- version insert uses MERGE so it is safe even if this file is re-applied after the ledger
-- (`schema_migrations`) was populated by some other means (e.g. a previously interrupted run).
-- This script only documents/supports being applied by a single operator at a time; concurrent
-- execution across two sessions is not tested and is not covered by these idempotency guarantees.
DECLARE
  TYPE t_name_tab IS TABLE OF VARCHAR2(30) INDEX BY PLS_INTEGER;
  TYPE t_kind_tab IS TABLE OF VARCHAR2(60) INDEX BY PLS_INTEGER;
  TYPE t_cols_tab IS TABLE OF PLS_INTEGER INDEX BY PLS_INTEGER;
  TYPE t_ddl_tab  IS TABLE OF CLOB INDEX BY PLS_INTEGER;
  v_name t_name_tab;
  v_kind t_kind_tab;
  v_cols t_cols_tab;
  v_ddl  t_ddl_tab;
  v_n PLS_INTEGER := 0;
  v_object_type USER_OBJECTS.OBJECT_TYPE%TYPE;
  v_count PLS_INTEGER;
  v_table_name VARCHAR2(30);
BEGIN
  v_n := v_n + 1;
  v_name(v_n) := 'SCHEMA_MIGRATIONS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 2;
  v_ddl(v_n) := 'CREATE TABLE schema_migrations (
  version NUMBER(10) PRIMARY KEY,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
)';
  v_n := v_n + 1;
  v_name(v_n) := 'WORKSPACES';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 3;
  v_ddl(v_n) := 'CREATE TABLE workspaces (
  workspace_id VARCHAR2(36) PRIMARY KEY,
  name VARCHAR2(120) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
)';
  v_n := v_n + 1;
  v_name(v_n) := 'USERS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 4;
  v_ddl(v_n) := 'CREATE TABLE users (
  user_id VARCHAR2(36) PRIMARY KEY,
  email VARCHAR2(254) NOT NULL UNIQUE,
  verified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
)';
  v_n := v_n + 1;
  v_name(v_n) := 'MEMBERSHIPS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 3;
  v_ddl(v_n) := 'CREATE TABLE memberships (
  workspace_id VARCHAR2(36) NOT NULL,
  user_id VARCHAR2(36) NOT NULL,
  role VARCHAR2(16) DEFAULT ''owner'' NOT NULL CHECK (role = ''owner''),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'INVITES';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 7;
  v_ddl(v_n) := 'CREATE TABLE invites (
  invite_id VARCHAR2(36) PRIMARY KEY,
  workspace_id VARCHAR2(36) NOT NULL,
  email VARCHAR2(254) NOT NULL,
  token_hash RAW(32) NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'VERIFICATION_TOKENS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 7;
  v_ddl(v_n) := 'CREATE TABLE verification_tokens (
  token_id VARCHAR2(36) PRIMARY KEY,
  workspace_id VARCHAR2(36) NOT NULL,
  user_id VARCHAR2(36) NOT NULL,
  token_hash RAW(32) NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_ip_hash RAW(32) NOT NULL,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'SESSIONS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 7;
  v_ddl(v_n) := 'CREATE TABLE sessions (
  session_id VARCHAR2(36) PRIMARY KEY,
  user_id VARCHAR2(36) NOT NULL,
  workspace_id VARCHAR2(36) NOT NULL,
  token_hash RAW(32) NOT NULL UNIQUE,
  csrf_hash RAW(32) NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'RECIPIENTS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 7;
  v_ddl(v_n) := 'CREATE TABLE recipients (
  workspace_id VARCHAR2(36) NOT NULL,
  recipient_id VARCHAR2(36) NOT NULL,
  email VARCHAR2(254) NOT NULL,
  ownership_verified_at TIMESTAMP WITH TIME ZONE,
  consented_at TIMESTAMP WITH TIME ZONE,
  unsubscribed_at TIMESTAMP WITH TIME ZONE,
  version NUMBER(10) DEFAULT 1 NOT NULL,
  PRIMARY KEY (workspace_id, recipient_id),
  UNIQUE (workspace_id, email),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'REMINDERS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 13;
  v_ddl(v_n) := 'CREATE TABLE reminders (
  workspace_id VARCHAR2(36) NOT NULL,
  reminder_id VARCHAR2(36) NOT NULL,
  recipient_id VARCHAR2(36) NOT NULL,
  title VARCHAR2(120) NOT NULL,
  note VARCHAR2(500),
  schedule_kind VARCHAR2(16) NOT NULL,
  zone VARCHAR2(80) NOT NULL,
  local_schedule_json CLOB NOT NULL CHECK (local_schedule_json IS JSON),
  next_due_at TIMESTAMP WITH TIME ZONE,
  schedule_version NUMBER(10) DEFAULT 1 NOT NULL,
  edit_version NUMBER(10) DEFAULT 1 NOT NULL,
  paused_at TIMESTAMP WITH TIME ZONE,
  deleted_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (workspace_id, reminder_id),
  FOREIGN KEY (workspace_id, recipient_id) REFERENCES recipients(workspace_id, recipient_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'REMINDER_OCCURRENCES';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 6;
  v_ddl(v_n) := 'CREATE TABLE reminder_occurrences (
  workspace_id VARCHAR2(36) NOT NULL,
  occurrence_id VARCHAR2(36) NOT NULL,
  reminder_id VARCHAR2(36) NOT NULL,
  schedule_version NUMBER(10) NOT NULL,
  due_at TIMESTAMP WITH TIME ZONE NOT NULL,
  disposition VARCHAR2(16) DEFAULT ''scheduled'' NOT NULL,
  PRIMARY KEY (workspace_id, occurrence_id),
  UNIQUE (workspace_id, reminder_id, schedule_version, due_at),
  FOREIGN KEY (workspace_id, reminder_id) REFERENCES reminders(workspace_id, reminder_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'SERVICES';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 5;
  v_ddl(v_n) := 'CREATE TABLE services (
  workspace_id VARCHAR2(36) NOT NULL,
  service_id VARCHAR2(36) NOT NULL,
  name VARCHAR2(120) NOT NULL,
  maintenance_until TIMESTAMP WITH TIME ZONE,
  deleted_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (workspace_id, service_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'MONITORS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 13;
  v_ddl(v_n) := 'CREATE TABLE monitors (
  workspace_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  service_id VARCHAR2(36) NOT NULL,
  mode VARCHAR2(8) NOT NULL CHECK (mode IN (''pull'', ''push'')),
  state VARCHAR2(16) DEFAULT ''unknown'' NOT NULL,
  config_json CLOB NOT NULL CHECK (config_json IS JSON),
  config_version NUMBER(10) DEFAULT 1 NOT NULL,
  deadline_version NUMBER(20) DEFAULT 0 NOT NULL,
  edit_version NUMBER(10) DEFAULT 1 NOT NULL,
  next_check_at TIMESTAMP WITH TIME ZONE,
  last_evidence_at TIMESTAMP WITH TIME ZONE,
  paused_at TIMESTAMP WITH TIME ZONE,
  deleted_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (workspace_id, monitor_id),
  FOREIGN KEY (workspace_id, service_id) REFERENCES services(workspace_id, service_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'TARGET_AUTHORIZATIONS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 6;
  v_ddl(v_n) := 'CREATE TABLE target_authorizations (
  workspace_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  method VARCHAR2(16) NOT NULL,
  challenge_hash RAW(32) NOT NULL,
  verified_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  PRIMARY KEY (workspace_id, monitor_id),
  FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, monitor_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'HEARTBEAT_CREDENTIALS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 6;
  v_ddl(v_n) := 'CREATE TABLE heartbeat_credentials (
  workspace_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  credential_version NUMBER(10) NOT NULL,
  token_hash RAW(32) NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (workspace_id, monitor_id, credential_version),
  FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, monitor_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'HEARTBEAT_RECEIPTS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 6;
  v_ddl(v_n) := 'CREATE TABLE heartbeat_receipts (
  workspace_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  receipt_id VARCHAR2(36) NOT NULL,
  event_id VARCHAR2(128),
  received_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  deadline_version NUMBER(10) NOT NULL,
  PRIMARY KEY (workspace_id, receipt_id),
  UNIQUE (workspace_id, monitor_id, event_id),
  FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, monitor_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'CHECK_RUNS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 7;
  v_ddl(v_n) := 'CREATE TABLE check_runs (
  workspace_id VARCHAR2(36) NOT NULL,
  check_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  config_version NUMBER(10) NOT NULL,
  slot_at TIMESTAMP WITH TIME ZONE NOT NULL,
  outcome VARCHAR2(32) NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (workspace_id, check_id),
  UNIQUE (workspace_id, monitor_id, config_version, slot_at),
  FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, monitor_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'INCIDENTS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 6;
  v_ddl(v_n) := 'CREATE TABLE incidents (
  workspace_id VARCHAR2(36) NOT NULL,
  incident_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  opened_at TIMESTAMP WITH TIME ZONE NOT NULL,
  closed_at TIMESTAMP WITH TIME ZONE,
  latest_transition VARCHAR2(16) NOT NULL,
  PRIMARY KEY (workspace_id, incident_id),
  FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, monitor_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'JOBS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 13;
  v_ddl(v_n) := 'CREATE TABLE jobs (
  job_id VARCHAR2(36) PRIMARY KEY,
  workspace_id VARCHAR2(36) NOT NULL,
  kind VARCHAR2(32) NOT NULL,
  entity_id VARCHAR2(36) NOT NULL,
  entity_version NUMBER(10) NOT NULL,
  available_at TIMESTAMP WITH TIME ZONE NOT NULL,
  lease_owner VARCHAR2(80),
  lease_until TIMESTAMP WITH TIME ZONE,
  fence NUMBER(20) DEFAULT 0 NOT NULL,
  attempts NUMBER(2) DEFAULT 0 NOT NULL,
  max_attempts NUMBER(2) DEFAULT 5 NOT NULL,
  state VARCHAR2(16) DEFAULT ''queued'' NOT NULL,
  payload_json CLOB CHECK (payload_json IS JSON),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'NOTIFICATIONS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 9;
  v_ddl(v_n) := 'CREATE TABLE notifications (
  workspace_id VARCHAR2(36) NOT NULL,
  notification_id VARCHAR2(36) NOT NULL,
  event_id VARCHAR2(80) NOT NULL,
  recipient_id VARCHAR2(36) NOT NULL,
  channel VARCHAR2(16) DEFAULT ''email'' NOT NULL,
  priority VARCHAR2(16) NOT NULL,
  state VARCHAR2(24) DEFAULT ''queued'' NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  PRIMARY KEY (workspace_id, notification_id),
  UNIQUE (workspace_id, event_id, recipient_id, channel),
  FOREIGN KEY (workspace_id, recipient_id) REFERENCES recipients(workspace_id, recipient_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'NOTIFICATION_ATTEMPTS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 7;
  v_ddl(v_n) := 'CREATE TABLE notification_attempts (
  workspace_id VARCHAR2(36) NOT NULL,
  notification_id VARCHAR2(36) NOT NULL,
  attempt_no NUMBER(2) NOT NULL,
  state VARCHAR2(24) NOT NULL,
  reserved_at TIMESTAMP WITH TIME ZONE NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  error_code VARCHAR2(80),
  PRIMARY KEY (workspace_id, notification_id, attempt_no),
  FOREIGN KEY (workspace_id, notification_id) REFERENCES notifications(workspace_id, notification_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'AUDIT_EVENTS';
  v_kind(v_n) := 'TABLE';
  v_cols(v_n) := 8;
  v_ddl(v_n) := 'CREATE TABLE audit_events (
  workspace_id VARCHAR2(36) NOT NULL,
  audit_id VARCHAR2(36) NOT NULL,
  actor_user_id VARCHAR2(36),
  action VARCHAR2(80) NOT NULL,
  entity_type VARCHAR2(40) NOT NULL,
  entity_id VARCHAR2(36),
  occurred_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  metadata_json CLOB CHECK (metadata_json IS JSON),
  PRIMARY KEY (workspace_id, audit_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
  FOREIGN KEY (workspace_id, actor_user_id) REFERENCES memberships(workspace_id, user_id)
)';
  v_n := v_n + 1;
  v_name(v_n) := 'REMINDERS_DUE_IDX';
  v_kind(v_n) := 'INDEX:REMINDERS';
  v_ddl(v_n) := 'CREATE INDEX reminders_due_idx ON reminders(next_due_at, workspace_id)';
  v_n := v_n + 1;
  v_name(v_n) := 'MONITORS_DUE_IDX';
  v_kind(v_n) := 'INDEX:MONITORS';
  v_ddl(v_n) := 'CREATE INDEX monitors_due_idx ON monitors(next_check_at, workspace_id)';
  v_n := v_n + 1;
  v_name(v_n) := 'ONE_OPEN_INCIDENT_IDX';
  v_kind(v_n) := 'INDEX:INCIDENTS';
  v_ddl(v_n) := 'CREATE UNIQUE INDEX one_open_incident_idx ON incidents(
  CASE WHEN closed_at IS NULL THEN workspace_id END,
  CASE WHEN closed_at IS NULL THEN monitor_id END
)';
  v_n := v_n + 1;
  v_name(v_n) := 'JOBS_CLAIM_IDX';
  v_kind(v_n) := 'INDEX:JOBS';
  v_ddl(v_n) := 'CREATE INDEX jobs_claim_idx ON jobs(state, available_at, lease_until)';
  v_n := v_n + 1;
  v_name(v_n) := 'NOTIFICATION_QUOTA_IDX';
  v_kind(v_n) := 'INDEX:NOTIFICATION_ATTEMPTS';
  v_ddl(v_n) := 'CREATE INDEX notification_quota_idx ON notification_attempts(reserved_at, state)';

  FOR i IN 1 .. v_n LOOP
    BEGIN
      EXECUTE IMMEDIATE v_ddl(i);
    EXCEPTION
      WHEN OTHERS THEN
        -- Only ORA-00955 (name already used by an existing object) is a candidate for
        -- "already applied"; every other error (permissions, syntax, FK target missing, ...)
        -- must propagate unchanged so the migration fails fast and loudly.
        IF SQLCODE != -955 THEN
          RAISE;
        END IF;

        BEGIN
          SELECT object_type INTO v_object_type
            FROM user_objects
           WHERE object_name = v_name(i)
             AND ROWNUM = 1;
        EXCEPTION
          WHEN NO_DATA_FOUND THEN
            RAISE_APPLICATION_ERROR(-20001,
              'Migration 001: object name ' || v_name(i) || ' is already used but not visible ' ||
              'in USER_OBJECTS; cannot verify compatibility. Investigate manually before rerunning.');
        END;

        IF v_kind(i) = 'TABLE' THEN
          IF v_object_type != 'TABLE' THEN
            RAISE_APPLICATION_ERROR(-20002,
              'Migration 001: ' || v_name(i) || ' already exists as ' || v_object_type ||
              ', expected TABLE. Rename/drop the conflicting object before rerunning.');
          END IF;
          SELECT COUNT(*) INTO v_count FROM user_tab_columns WHERE table_name = v_name(i);
          IF v_count != v_cols(i) THEN
            RAISE_APPLICATION_ERROR(-20003,
              'Migration 001: table ' || v_name(i) || ' already exists with ' || v_count ||
              ' column(s), expected ' || v_cols(i) || '. This is a targeted column-count check, ' ||
              'not a full definition diff; an incompatible pre-existing table must be resolved ' ||
              'manually (see migrations/README.md) before rerunning.');
          END IF;
          -- Column count matches: treat the existing table as already applied and continue.
        ELSE
          v_table_name := SUBSTR(v_kind(i), INSTR(v_kind(i), ':') + 1);
          IF v_object_type != 'INDEX' THEN
            RAISE_APPLICATION_ERROR(-20004,
              'Migration 001: ' || v_name(i) || ' already exists as ' || v_object_type ||
              ', expected INDEX. Rename/drop the conflicting object before rerunning.');
          END IF;
          SELECT COUNT(*) INTO v_count
            FROM user_indexes
           WHERE index_name = v_name(i)
             AND table_name = v_table_name;
          IF v_count = 0 THEN
            RAISE_APPLICATION_ERROR(-20005,
              'Migration 001: index ' || v_name(i) || ' already exists but not on table ' ||
              v_table_name || '. Resolve the naming collision manually before rerunning.');
          END IF;
          -- Index exists on the expected table: treat as already applied and continue.
        END IF;
    END;
  END LOOP;
END;
/

-- Records this migration as applied. MERGE (rather than INSERT) makes this statement itself
-- idempotent for direct script execution; the CLI (`src/runtime/migrate.ts`) additionally skips
-- entire files whose version is already recorded, so this MERGE only ever inserts once in
-- practice, but must tolerate being re-run without duplicating or overwriting the row.
MERGE INTO schema_migrations t
USING (SELECT 1 AS version FROM dual) s
ON (t.version = s.version)
WHEN NOT MATCHED THEN INSERT (version) VALUES (s.version);
