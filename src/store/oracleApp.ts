import oracledb from 'oracledb';
import { randomUUID } from 'node:crypto';
import { nextOccurrences } from '../core/schedule.js';
import type { ReminderSchedule } from '../core/types.js';
import type { AppRepository, NotificationOutcome, NotificationWorkItem, ReminderRecord } from '../app/service.js';

export class OracleAppRepository implements AppRepository {
  constructor(private readonly pool: oracledb.Pool) {}

  async createInvite(input: { inviteId: string; workspaceId: string; email: string; tokenHash: Buffer; expiresAt: Date }): Promise<void> {
    await this.withConnection(async (connection) => {
      await connection.execute(
        `INSERT INTO invites(invite_id, workspace_id, email, token_hash, expires_at)
         VALUES(:invite_id, :workspace_id, :email, :token_hash, :expires_at)`,
        {
          invite_id: input.inviteId,
          workspace_id: input.workspaceId,
          email: input.email,
          token_hash: input.tokenHash,
          expires_at: input.expiresAt
        }
      );
      await connection.commit();
    });
  }

  async consumeInvite(input: { tokenHash: Buffer; now: Date }): Promise<{ workspaceId: string; email: string } | undefined> {
    return this.withConnection(async (connection) => {
      const invite = await connection.execute<{ INVITE_ID: string; WORKSPACE_ID: string; EMAIL: string; EXPIRES_AT: Date; USED_AT: Date | null }>(
        `SELECT invite_id, workspace_id, email, expires_at, used_at
           FROM invites
          WHERE token_hash = :token_hash
          FOR UPDATE`,
        { token_hash: input.tokenHash },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const row = invite.rows?.[0];
      if (!row || row.USED_AT || row.EXPIRES_AT <= input.now) {
        await connection.rollback();
        return undefined;
      }
      await connection.execute(`UPDATE invites SET used_at = :used_at WHERE invite_id = :invite_id`, {
        used_at: input.now,
        invite_id: row.INVITE_ID
      });
      await connection.commit();
      return { workspaceId: row.WORKSPACE_ID, email: row.EMAIL };
    });
  }

  async findOrCreateUser(email: string): Promise<{ userId: string; email: string }> {
    return this.withConnection(async (connection) => {
      const existing = await connection.execute<{ USER_ID: string; EMAIL: string }>(
        `SELECT user_id, email FROM users WHERE email = :email`,
        { email },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const row = existing.rows?.[0];
      if (row) return { userId: row.USER_ID, email: row.EMAIL };
      const userId = randomUUID();
      await connection.execute(
        `INSERT INTO users(user_id, email, verified_at) VALUES(:user_id, :email, :verified_at)`,
        { user_id: userId, email, verified_at: new Date() }
      );
      await connection.commit();
      return { userId, email };
    });
  }

  async ensureMembership(workspaceId: string, userId: string): Promise<void> {
    await this.withConnection(async (connection) => {
      const membership = await connection.execute(
        `SELECT 1 FROM memberships WHERE workspace_id = :workspace_id AND user_id = :user_id`,
        { workspace_id: workspaceId, user_id: userId }
      );
      if (!membership.rows?.length) {
        await connection.execute(
          `INSERT INTO memberships(workspace_id, user_id, role) VALUES(:workspace_id, :user_id, 'owner')`,
          { workspace_id: workspaceId, user_id: userId }
        );
        await connection.commit();
      }
    });
  }

  async createSession(input: {
    sessionId: string;
    userId: string;
    workspaceId: string;
    tokenHash: Buffer;
    csrfHash: Buffer;
    expiresAt: Date;
  }): Promise<void> {
    await this.withConnection(async (connection) => {
      await connection.execute(
        `INSERT INTO sessions(session_id, user_id, workspace_id, token_hash, csrf_hash, expires_at)
         VALUES(:session_id, :user_id, :workspace_id, :token_hash, :csrf_hash, :expires_at)`,
        {
          session_id: input.sessionId,
          user_id: input.userId,
          workspace_id: input.workspaceId,
          token_hash: input.tokenHash,
          csrf_hash: input.csrfHash,
          expires_at: input.expiresAt
        }
      );
      await connection.commit();
    });
  }

  async getSession(tokenHash: Buffer, now: Date): Promise<
    | {
        sessionId: string;
        userId: string;
        workspaceId: string;
        tokenHash: Buffer;
        csrfHash: Buffer;
        expiresAt: number;
        email: string;
      }
    | undefined
  > {
    return this.withConnection(async (connection) => {
      const session = await connection.execute<{
        SESSION_ID: string;
        USER_ID: string;
        WORKSPACE_ID: string;
        TOKEN_HASH: Buffer;
        CSRF_HASH: Buffer;
        EXPIRES_AT: Date;
        REVOKED_AT: Date | null;
        EMAIL: string;
      }>(
        `SELECT s.session_id, s.user_id, s.workspace_id, s.token_hash, s.csrf_hash, s.expires_at, s.revoked_at, u.email
           FROM sessions s
           JOIN users u ON u.user_id = s.user_id
          WHERE s.token_hash = :token_hash`,
        { token_hash: tokenHash },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const row = session.rows?.[0];
      if (!row || row.REVOKED_AT || row.EXPIRES_AT <= now) return undefined;
      return {
        sessionId: row.SESSION_ID,
        userId: row.USER_ID,
        workspaceId: row.WORKSPACE_ID,
        tokenHash: row.TOKEN_HASH,
        csrfHash: row.CSRF_HASH,
        expiresAt: row.EXPIRES_AT.getTime(),
        email: row.EMAIL
      };
    });
  }

  async revokeSession(sessionId: string, now: Date): Promise<void> {
    await this.withConnection(async (connection) => {
      await connection.execute(`UPDATE sessions SET revoked_at = :revoked_at WHERE session_id = :session_id`, {
        revoked_at: now,
        session_id: sessionId
      });
      await connection.commit();
    });
  }

  async createReminder(input: {
    workspaceId: string;
    reminderId: string;
    recipientEmail: string;
    title: string;
    note: string | undefined;
    schedule: ReminderSchedule;
    nextDueAt: Date | undefined;
  }): Promise<ReminderRecord> {
    return this.withConnection(async (connection) => {
      const recipient = await this.ensureRecipient(connection, input.workspaceId, input.recipientEmail);
      await connection.execute(
        `INSERT INTO reminders(
           workspace_id, reminder_id, recipient_id, title, note, schedule_kind, zone,
           local_schedule_json, next_due_at, schedule_version, edit_version
         ) VALUES (
           :workspace_id, :reminder_id, :recipient_id, :title, :note, :schedule_kind, :zone,
           :schedule_json, :next_due_at, 1, 1
         )`,
        {
          workspace_id: input.workspaceId,
          reminder_id: input.reminderId,
          recipient_id: recipient,
          title: input.title,
          note: input.note ?? null,
          schedule_kind: input.schedule.kind,
          zone: input.schedule.zone,
          schedule_json: JSON.stringify(input.schedule),
          next_due_at: input.nextDueAt ?? null
        }
      );
      await connection.commit();
      return {
        reminderId: input.reminderId,
        title: input.title,
        note: input.note,
        schedule: input.schedule,
        nextDueAt: input.nextDueAt,
        pausedAt: undefined,
        editVersion: 1,
        scheduleVersion: 1
      };
    });
  }

  async listReminders(workspaceId: string): Promise<ReminderRecord[]> {
    return this.withConnection(async (connection) => {
      const rows = await connection.execute<{
        REMINDER_ID: string;
        TITLE: string;
        NOTE: string | null;
        LOCAL_SCHEDULE_JSON: string;
        NEXT_DUE_AT: Date | null;
        PAUSED_AT: Date | null;
        EDIT_VERSION: number;
        SCHEDULE_VERSION: number;
      }>(
        `SELECT reminder_id, title, note, local_schedule_json, next_due_at, paused_at, edit_version, schedule_version
           FROM reminders
          WHERE workspace_id = :workspace_id AND deleted_at IS NULL
          ORDER BY next_due_at NULLS LAST`,
        { workspace_id: workspaceId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return (rows.rows ?? []).map((row) => ({
        reminderId: row.REMINDER_ID,
        title: row.TITLE,
        note: row.NOTE ?? undefined,
        schedule: JSON.parse(row.LOCAL_SCHEDULE_JSON) as ReminderSchedule,
        nextDueAt: row.NEXT_DUE_AT ?? undefined,
        pausedAt: row.PAUSED_AT ?? undefined,
        editVersion: row.EDIT_VERSION,
        scheduleVersion: row.SCHEDULE_VERSION
      }));
    });
  }

  async runReminderSchedulerTick(now: Date, limit: number): Promise<number> {
    return this.withConnection(async (connection) => {
      const due = await connection.execute<{
        WORKSPACE_ID: string;
        REMINDER_ID: string;
        RECIPIENT_ID: string;
        TITLE: string;
        NOTE: string | null;
        LOCAL_SCHEDULE_JSON: string;
        NEXT_DUE_AT: Date;
        SCHEDULE_VERSION: number;
        EMAIL: string;
      }>(
        `SELECT r.workspace_id, r.reminder_id, r.recipient_id, r.title, r.note, r.local_schedule_json,
                r.next_due_at, r.schedule_version, rc.email
           FROM reminders r
           JOIN recipients rc ON rc.workspace_id = r.workspace_id AND rc.recipient_id = r.recipient_id
          WHERE r.deleted_at IS NULL
            AND r.paused_at IS NULL
            AND r.next_due_at IS NOT NULL
            AND r.next_due_at <= :now
            AND rc.ownership_verified_at IS NOT NULL
            AND rc.consented_at IS NOT NULL
            AND rc.unsubscribed_at IS NULL
          ORDER BY r.next_due_at
          FOR UPDATE SKIP LOCKED`,
        { now },
        { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: Math.max(1, Math.min(limit, 250)) }
      );
      const rows = due.rows ?? [];
      for (const row of rows) {
        const schedule = JSON.parse(row.LOCAL_SCHEDULE_JSON) as ReminderSchedule;
        const future = nextOccurrences(schedule, row.NEXT_DUE_AT, 1);
        const nextDueAt = future[0] ?? null;
        const occurrenceId = randomUUID();
        const eventId = `reminder:${row.REMINDER_ID}:${row.SCHEDULE_VERSION}:${row.NEXT_DUE_AT.toISOString()}`;
        try {
          await connection.execute(
            `INSERT INTO reminder_occurrences(workspace_id, occurrence_id, reminder_id, schedule_version, due_at)
             VALUES(:workspace_id, :occurrence_id, :reminder_id, :schedule_version, :due_at)`,
            {
              workspace_id: row.WORKSPACE_ID,
              occurrence_id: occurrenceId,
              reminder_id: row.REMINDER_ID,
              schedule_version: row.SCHEDULE_VERSION,
              due_at: row.NEXT_DUE_AT
            }
          );
          await connection.execute(
            `INSERT INTO notifications(
               workspace_id, notification_id, event_id, recipient_id, channel, priority, state, created_at, updated_at
             ) VALUES (
               :workspace_id, :notification_id, :event_id, :recipient_id, 'email', 'reminder', 'queued', :created_at, :updated_at
             )`,
            {
              workspace_id: row.WORKSPACE_ID,
              notification_id: randomUUID(),
              event_id: eventId,
              recipient_id: row.RECIPIENT_ID,
              created_at: now,
              updated_at: now
            }
          );
        } catch (error: unknown) {
          if (!(error instanceof Error) || !('message' in error) || !String(error.message).includes('ORA-00001')) throw error;
        }
        await connection.execute(
          `UPDATE reminders
              SET next_due_at = :next_due_at,
                  schedule_version = schedule_version + 1
            WHERE workspace_id = :workspace_id
              AND reminder_id = :reminder_id`,
          {
            next_due_at: nextDueAt,
            workspace_id: row.WORKSPACE_ID,
            reminder_id: row.REMINDER_ID
          }
        );
      }
      await connection.commit();
      return rows.length;
    });
  }

  async claimNotifications(now: Date, limit: number): Promise<NotificationWorkItem[]> {
    return this.withConnection(async (connection) => {
      const rows = await connection.execute<{
        WORKSPACE_ID: string;
        NOTIFICATION_ID: string;
        RECIPIENT_ID: string;
        EVENT_ID: string;
        STATE: string;
        EMAIL: string;
      }>(
        `SELECT n.workspace_id, n.notification_id, n.recipient_id, n.event_id, n.state, r.email
           FROM notifications n
           JOIN recipients r ON r.workspace_id = n.workspace_id AND r.recipient_id = n.recipient_id
          WHERE (n.state = 'queued' OR (n.state = 'retrying' AND n.updated_at <= :now))
          ORDER BY n.created_at
          FOR UPDATE SKIP LOCKED`,
        { now },
        { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: Math.max(1, Math.min(limit, 250)) }
      );
      const items: NotificationWorkItem[] = [];
      for (const row of rows.rows ?? []) {
        const attempts = await connection.execute<{ C: number }>(
          `SELECT COUNT(*) AS c FROM notification_attempts WHERE workspace_id = :workspace_id AND notification_id = :notification_id`,
          { workspace_id: row.WORKSPACE_ID, notification_id: row.NOTIFICATION_ID },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const count = attempts.rows?.[0]?.C ?? 0;
        await connection.execute(
          `UPDATE notifications
              SET state = 'submitting', updated_at = :now
            WHERE workspace_id = :workspace_id AND notification_id = :notification_id`,
          {
            now,
            workspace_id: row.WORKSPACE_ID,
            notification_id: row.NOTIFICATION_ID
          }
        );
        await connection.execute(
          `INSERT INTO notification_attempts(workspace_id, notification_id, attempt_no, state, reserved_at)
           VALUES(:workspace_id, :notification_id, :attempt_no, 'submitting', :reserved_at)`,
          {
            workspace_id: row.WORKSPACE_ID,
            notification_id: row.NOTIFICATION_ID,
            attempt_no: count + 1,
            reserved_at: now
          }
        );
        items.push({
          workspaceId: row.WORKSPACE_ID,
          notificationId: row.NOTIFICATION_ID,
          recipientEmail: row.EMAIL,
          subject: 'Reminder due',
          textBody: `Reminder event ${row.EVENT_ID} is due.`,
          priority: 'reminder',
          attempts: count
        });
      }
      await connection.commit();
      return items;
    });
  }

  async completeNotification(input: {
    workspaceId: string;
    notificationId: string;
    attempt: number;
    now: Date;
    outcome: NotificationOutcome;
    retryAt: Date | undefined;
  }): Promise<void> {
    await this.withConnection(async (connection) => {
      let state = 'outcome-unknown';
      let updatedAt: Date = input.now;
      if (input.outcome.accepted === true) state = 'smtp-accepted';
      else if (input.outcome.accepted === false && input.retryAt) {
        state = 'retrying';
        updatedAt = input.retryAt;
      } else if (input.outcome.accepted === false) state = 'failed';
      await connection.execute(
        `UPDATE notifications
            SET state = :state,
                updated_at = :updated_at
          WHERE workspace_id = :workspace_id AND notification_id = :notification_id`,
        {
          state,
          updated_at: updatedAt,
          workspace_id: input.workspaceId,
          notification_id: input.notificationId
        }
      );
      await connection.execute(
        `UPDATE notification_attempts
            SET state = :state,
                completed_at = :completed_at,
                error_code = :error_code
          WHERE workspace_id = :workspace_id
            AND notification_id = :notification_id
            AND attempt_no = :attempt_no`,
        {
          state,
          completed_at: input.now,
          error_code: input.outcome.code ?? null,
          workspace_id: input.workspaceId,
          notification_id: input.notificationId,
          attempt_no: input.attempt
        }
      );
      await connection.commit();
    });
  }

  async dashboard(workspaceId: string): Promise<{
    reminders: Array<{ id: string; title: string; nextDueAt: string; state: string }>;
    services: Array<{ id: string; name: string; pullState: string | undefined; pushState: string | undefined }>;
    incidents: Array<{ id: string; service: string; mode: string; openedAt: string }>;
    notifications: Array<{ id: string; subject: string; state: string; updatedAt: string }>;
    quota: { rolling24h: number; rolling24hLimit: number; monthly: number; monthlyLimit: number };
  }> {
    return this.withConnection(async (connection) => {
      const reminders = await connection.execute<{ REMINDER_ID: string; TITLE: string; NEXT_DUE_AT: Date | null; PAUSED_AT: Date | null }>(
        `SELECT reminder_id, title, next_due_at, paused_at
           FROM reminders
          WHERE workspace_id = :workspace_id AND deleted_at IS NULL
          ORDER BY next_due_at NULLS LAST`,
        { workspace_id: workspaceId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 50 }
      );
      const notifications = await connection.execute<{ NOTIFICATION_ID: string; EVENT_ID: string; STATE: string; UPDATED_AT: Date }>(
        `SELECT notification_id, event_id, state, updated_at
           FROM notifications
          WHERE workspace_id = :workspace_id
          ORDER BY updated_at DESC`,
        { workspace_id: workspaceId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 50 }
      );
      const rolling = await connection.execute<{ C: number }>(
        `SELECT COUNT(*) AS c
           FROM notification_attempts
          WHERE workspace_id = :workspace_id
            AND reserved_at > :window_start`,
        {
          workspace_id: workspaceId,
          window_start: new Date(Date.now() - 24 * 60 * 60_000)
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const monthly = await connection.execute<{ C: number }>(
        `SELECT COUNT(*) AS c
           FROM notification_attempts
          WHERE workspace_id = :workspace_id
            AND reserved_at >= :month_start`,
        { workspace_id: workspaceId, month_start: monthStart },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return {
        reminders: (reminders.rows ?? []).map((row) => ({
          id: row.REMINDER_ID,
          title: row.TITLE,
          nextDueAt: row.NEXT_DUE_AT?.toISOString() ?? 'none',
          state: row.PAUSED_AT ? 'paused' : row.NEXT_DUE_AT ? 'active' : 'completed'
        })),
        services: [{ id: 'pull-disabled', name: 'Pull monitor execution', pullState: 'disabled', pushState: undefined }],
        incidents: [],
        notifications: (notifications.rows ?? []).map((row) => ({
          id: row.NOTIFICATION_ID,
          subject: row.EVENT_ID,
          state: row.STATE,
          updatedAt: row.UPDATED_AT.toISOString()
        })),
        quota: {
          rolling24h: rolling.rows?.[0]?.C ?? 0,
          rolling24hLimit: 100,
          monthly: monthly.rows?.[0]?.C ?? 0,
          monthlyLimit: 2500
        }
      };
    });
  }

  private async ensureRecipient(connection: oracledb.Connection, workspaceId: string, email: string): Promise<string> {
    const existing = await connection.execute<{ RECIPIENT_ID: string }>(
      `SELECT recipient_id
         FROM recipients
        WHERE workspace_id = :workspace_id
          AND email = :email`,
      { workspace_id: workspaceId, email },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = existing.rows?.[0];
    if (row) return row.RECIPIENT_ID;
    const recipientId = randomUUID();
    const now = new Date();
    await connection.execute(
      `INSERT INTO recipients(
         workspace_id, recipient_id, email, ownership_verified_at, consented_at, unsubscribed_at, version
       ) VALUES (
         :workspace_id, :recipient_id, :email, :ownership_verified_at, :consented_at, NULL, 1
       )`,
      {
        workspace_id: workspaceId,
        recipient_id: recipientId,
        email,
        ownership_verified_at: now,
        consented_at: now
      }
    );
    return recipientId;
  }

  private async withConnection<T>(operation: (connection: oracledb.Connection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      return await operation(connection);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  }
}
