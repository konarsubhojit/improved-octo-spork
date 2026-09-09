import { createHash, randomUUID } from 'node:crypto';
import { issueInvite, issueSession, type Session as CoreSession } from '../core/auth.js';
import { retryAt } from '../core/jobs.js';
import { nextOccurrences } from '../core/schedule.js';
import type { ReminderSchedule } from '../core/types.js';

export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  workspaceId: string;
}

export interface ReminderRecord {
  reminderId: string;
  title: string;
  note: string | undefined;
  schedule: ReminderSchedule;
  nextDueAt: Date | undefined;
  pausedAt: Date | undefined;
  editVersion: number;
  scheduleVersion: number;
}

export interface NotificationWorkItem {
  workspaceId: string;
  notificationId: string;
  recipientEmail: string;
  subject: string;
  textBody: string;
  priority: 'reminder' | 'incident' | 'verification';
  attempts: number;
}

export interface NotificationOutcome {
  accepted: boolean | undefined;
  code?: string;
}

export interface Mailer {
  send(item: NotificationWorkItem): Promise<NotificationOutcome>;
}

export interface AppRepository {
  createInvite(input: { inviteId: string; workspaceId: string; email: string; tokenHash: Buffer; expiresAt: Date }): Promise<void>;
  consumeInvite(input: { tokenHash: Buffer; now: Date }): Promise<{ workspaceId: string; email: string } | undefined>;
  findOrCreateUser(email: string): Promise<{ userId: string; email: string }>;
  ensureMembership(workspaceId: string, userId: string): Promise<void>;
  createSession(input: {
    sessionId: string;
    userId: string;
    workspaceId: string;
    tokenHash: Buffer;
    csrfHash: Buffer;
    expiresAt: Date;
  }): Promise<void>;
  getSession(tokenHash: Buffer, now: Date): Promise<(CoreSession & { sessionId: string; email: string }) | undefined>;
  revokeSession(sessionId: string, now: Date): Promise<void>;
  createReminder(input: {
    workspaceId: string;
    reminderId: string;
    recipientEmail: string;
    title: string;
    note: string | undefined;
    schedule: ReminderSchedule;
    nextDueAt: Date | undefined;
  }): Promise<ReminderRecord>;
  listReminders(workspaceId: string): Promise<ReminderRecord[]>;
  runReminderSchedulerTick(now: Date, limit: number): Promise<number>;
  claimNotifications(now: Date, limit: number): Promise<NotificationWorkItem[]>;
  completeNotification(input: {
    workspaceId: string;
    notificationId: string;
    attempt: number;
    now: Date;
    outcome: NotificationOutcome;
    retryAt: Date | undefined;
  }): Promise<void>;
  dashboard(workspaceId: string): Promise<{
    reminders: Array<{ id: string; title: string; nextDueAt: string; state: string }>;
    services: Array<{ id: string; name: string; pullState: string | undefined; pushState: string | undefined }>;
    incidents: Array<{ id: string; service: string; mode: string; openedAt: string }>;
    notifications: Array<{ id: string; subject: string; state: string; updatedAt: string }>;
    quota: { rolling24h: number; rolling24hLimit: number; monthly: number; monthlyLimit: number };
  }>;
}

export class AppService {
  constructor(
    private readonly repository: AppRepository,
    private readonly mailer: Mailer,
    private readonly now: () => Date = () => new Date()
  ) {}

  async createInvite(workspaceId: string, email: string): Promise<string> {
    const expiresAt = new Date(this.now().getTime() + 24 * 60 * 60_000);
    const { invite, token } = issueInvite(workspaceId, email, expiresAt.getTime());
    await this.repository.createInvite({
      inviteId: randomUUID(),
      workspaceId,
      email: invite.email,
      tokenHash: invite.tokenHash,
      expiresAt
    });
    return token;
  }

  async verifyInvite(token: string): Promise<{ sessionToken: string; csrfToken: string }> {
    const consumed = await this.repository.consumeInvite({ tokenHash: digest(token), now: this.now() });
    if (!consumed) throw new Error('Invite is invalid or expired');
    const user = await this.repository.findOrCreateUser(consumed.email);
    await this.repository.ensureMembership(consumed.workspaceId, user.userId);
    const expiresAt = new Date(this.now().getTime() + 14 * 24 * 60 * 60_000);
    const issued = issueSession(user.userId, consumed.workspaceId, expiresAt.getTime());
    await this.repository.createSession({
      sessionId: randomUUID(),
      userId: user.userId,
      workspaceId: consumed.workspaceId,
      tokenHash: issued.session.tokenHash,
      csrfHash: issued.session.csrfHash,
      expiresAt
    });
    return { sessionToken: issued.sessionToken, csrfToken: issued.csrfToken };
  }

  async authenticate(sessionToken: string, csrfToken: string | undefined, mutating: boolean): Promise<AuthContext> {
    const session = await this.repository.getSession(digest(sessionToken), this.now());
    if (!session) throw new Error('Unauthenticated');
    const okCsrf = !mutating || (csrfToken && digest(csrfToken).equals(session.csrfHash));
    if (!okCsrf) throw new Error('Invalid CSRF token');
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      email: session.email,
      workspaceId: session.workspaceId
    };
  }

  async signOut(context: AuthContext): Promise<void> {
    await this.repository.revokeSession(context.sessionId, this.now());
  }

  async createReminder(context: AuthContext, input: { title: string; note?: string; schedule: ReminderSchedule }): Promise<ReminderRecord> {
    const title = input.title.trim();
    if (!title || title.length > 120) throw new RangeError('title is required and must be at most 120 characters');
    if (input.note && input.note.length > 500) throw new RangeError('note must be at most 500 characters');
    const preview = nextOccurrences(input.schedule, this.now(), 1);
    const nextDueAt = preview[0];
    return this.repository.createReminder({
      workspaceId: context.workspaceId,
      reminderId: randomUUID(),
      recipientEmail: context.email,
      title,
      note: input.note,
      schedule: input.schedule,
      nextDueAt
    });
  }

  async listReminders(context: AuthContext): Promise<ReminderRecord[]> {
    return this.repository.listReminders(context.workspaceId);
  }

  preview(schedule: ReminderSchedule): string[] {
    return nextOccurrences(schedule, this.now(), 5).map((value) => value.toISOString());
  }

  async schedulerTick(limit = 100): Promise<number> {
    return this.repository.runReminderSchedulerTick(this.now(), limit);
  }

  async emailWorkerTick(limit = 100): Promise<number> {
    const items = await this.repository.claimNotifications(this.now(), limit);
    for (const item of items) {
      const outcome = await this.mailer.send(item);
      const next = outcome.accepted === false ? retryAt(item.attempts + 1, this.now().getTime(), () => 0.5) : undefined;
      await this.repository.completeNotification({
        workspaceId: item.workspaceId,
        notificationId: item.notificationId,
        attempt: item.attempts + 1,
        now: this.now(),
        outcome,
        retryAt: next === undefined ? undefined : new Date(next)
      });
    }
    return items.length;
  }

  async dashboard(context: AuthContext) {
    return this.repository.dashboard(context.workspaceId);
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
