-- Oracle Autonomous Transaction Processing schema. Apply once with a dedicated migration account.
CREATE TABLE schema_migrations (
  version NUMBER(10) PRIMARY KEY,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE workspaces (
  workspace_id VARCHAR2(36) PRIMARY KEY,
  name VARCHAR2(120) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE users (
  user_id VARCHAR2(36) PRIMARY KEY,
  email VARCHAR2(254) NOT NULL UNIQUE,
  verified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE memberships (
  workspace_id VARCHAR2(36) NOT NULL,
  user_id VARCHAR2(36) NOT NULL,
  role VARCHAR2(16) DEFAULT 'owner' NOT NULL CHECK (role = 'owner'),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE invites (
  invite_id VARCHAR2(36) PRIMARY KEY,
  workspace_id VARCHAR2(36) NOT NULL,
  email VARCHAR2(254) NOT NULL,
  token_hash RAW(32) NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE TABLE verification_tokens (
  token_id VARCHAR2(36) PRIMARY KEY,
  workspace_id VARCHAR2(36) NOT NULL,
  user_id VARCHAR2(36) NOT NULL,
  token_hash RAW(32) NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_ip_hash RAW(32) NOT NULL,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id)
);

CREATE TABLE sessions (
  session_id VARCHAR2(36) PRIMARY KEY,
  user_id VARCHAR2(36) NOT NULL,
  workspace_id VARCHAR2(36) NOT NULL,
  token_hash RAW(32) NOT NULL UNIQUE,
  csrf_hash RAW(32) NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id)
);

CREATE TABLE recipients (
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
);

CREATE TABLE reminders (
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
);
CREATE INDEX reminders_due_idx ON reminders(next_due_at, workspace_id);

CREATE TABLE reminder_occurrences (
  workspace_id VARCHAR2(36) NOT NULL,
  occurrence_id VARCHAR2(36) NOT NULL,
  reminder_id VARCHAR2(36) NOT NULL,
  schedule_version NUMBER(10) NOT NULL,
  due_at TIMESTAMP WITH TIME ZONE NOT NULL,
  disposition VARCHAR2(16) DEFAULT 'scheduled' NOT NULL,
  PRIMARY KEY (workspace_id, occurrence_id),
  UNIQUE (workspace_id, reminder_id, schedule_version, due_at),
  FOREIGN KEY (workspace_id, reminder_id) REFERENCES reminders(workspace_id, reminder_id)
);

CREATE TABLE services (
  workspace_id VARCHAR2(36) NOT NULL,
  service_id VARCHAR2(36) NOT NULL,
  name VARCHAR2(120) NOT NULL,
  maintenance_until TIMESTAMP WITH TIME ZONE,
  deleted_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (workspace_id, service_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE TABLE monitors (
  workspace_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  service_id VARCHAR2(36) NOT NULL,
  mode VARCHAR2(8) NOT NULL CHECK (mode IN ('pull', 'push')),
  state VARCHAR2(16) DEFAULT 'unknown' NOT NULL,
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
);
CREATE INDEX monitors_due_idx ON monitors(next_check_at, workspace_id);

CREATE TABLE target_authorizations (
  workspace_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  method VARCHAR2(16) NOT NULL,
  challenge_hash RAW(32) NOT NULL,
  verified_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  PRIMARY KEY (workspace_id, monitor_id),
  FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, monitor_id)
);

CREATE TABLE heartbeat_credentials (
  workspace_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  credential_version NUMBER(10) NOT NULL,
  token_hash RAW(32) NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (workspace_id, monitor_id, credential_version),
  FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, monitor_id)
);

CREATE TABLE heartbeat_receipts (
  workspace_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  receipt_id VARCHAR2(36) NOT NULL,
  event_id VARCHAR2(128),
  received_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  deadline_version NUMBER(10) NOT NULL,
  PRIMARY KEY (workspace_id, receipt_id),
  UNIQUE (workspace_id, monitor_id, event_id),
  FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, monitor_id)
);

CREATE TABLE check_runs (
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
);

CREATE TABLE incidents (
  workspace_id VARCHAR2(36) NOT NULL,
  incident_id VARCHAR2(36) NOT NULL,
  monitor_id VARCHAR2(36) NOT NULL,
  opened_at TIMESTAMP WITH TIME ZONE NOT NULL,
  closed_at TIMESTAMP WITH TIME ZONE,
  latest_transition VARCHAR2(16) NOT NULL,
  PRIMARY KEY (workspace_id, incident_id),
  FOREIGN KEY (workspace_id, monitor_id) REFERENCES monitors(workspace_id, monitor_id)
);
CREATE UNIQUE INDEX one_open_incident_idx ON incidents(
  CASE WHEN closed_at IS NULL THEN workspace_id END,
  CASE WHEN closed_at IS NULL THEN monitor_id END
);

CREATE TABLE jobs (
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
  state VARCHAR2(16) DEFAULT 'queued' NOT NULL,
  payload_json CLOB CHECK (payload_json IS JSON),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);
CREATE INDEX jobs_claim_idx ON jobs(state, available_at, lease_until);

CREATE TABLE notifications (
  workspace_id VARCHAR2(36) NOT NULL,
  notification_id VARCHAR2(36) NOT NULL,
  event_id VARCHAR2(80) NOT NULL,
  recipient_id VARCHAR2(36) NOT NULL,
  channel VARCHAR2(16) DEFAULT 'email' NOT NULL,
  priority VARCHAR2(16) NOT NULL,
  state VARCHAR2(24) DEFAULT 'queued' NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  PRIMARY KEY (workspace_id, notification_id),
  UNIQUE (workspace_id, event_id, recipient_id, channel),
  FOREIGN KEY (workspace_id, recipient_id) REFERENCES recipients(workspace_id, recipient_id)
);

CREATE TABLE notification_attempts (
  workspace_id VARCHAR2(36) NOT NULL,
  notification_id VARCHAR2(36) NOT NULL,
  attempt_no NUMBER(2) NOT NULL,
  state VARCHAR2(24) NOT NULL,
  reserved_at TIMESTAMP WITH TIME ZONE NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  error_code VARCHAR2(80),
  PRIMARY KEY (workspace_id, notification_id, attempt_no),
  FOREIGN KEY (workspace_id, notification_id) REFERENCES notifications(workspace_id, notification_id)
);
CREATE INDEX notification_quota_idx ON notification_attempts(reserved_at, state);

CREATE TABLE audit_events (
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
);

INSERT INTO schema_migrations(version) VALUES (1);
