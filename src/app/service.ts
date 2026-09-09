import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

export interface RecipientRecord {
  recipientId: string;
  email: string;
  ownershipVerifiedAt: Date | undefined;
  consentedAt: Date | undefined;
  unsubscribedAt: Date | undefined;
  version: number;
}

export interface ServiceRecord {
  serviceId: string;
  name: string;
}

export interface PushMonitorRecord {
  monitorId: string;
  serviceId: string;
  state: 'healthy' | 'failing' | 'down' | 'unknown' | 'paused';
  intervalMs: number;
  graceMs: number;
  pausedAt: Date | undefined;
  lastEvidenceAt: Date | undefined;
  editVersion: number;
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
  updateReminder(input: {
    workspaceId: string;
    reminderId: string;
    expectedEditVersion: number;
    title: string;
    note: string | undefined;
    schedule: ReminderSchedule;
    nextDueAt: Date | undefined;
  }): Promise<ReminderRecord | 'not-found' | 'conflict'>;
  pauseReminder(input: {
    workspaceId: string;
    reminderId: string;
    expectedEditVersion: number;
    now: Date;
  }): Promise<ReminderRecord | 'not-found' | 'conflict'>;
  resumeReminder(input: {
    workspaceId: string;
    reminderId: string;
    expectedEditVersion: number;
    now: Date;
    nextDueAt: Date | undefined;
  }): Promise<ReminderRecord | 'not-found' | 'conflict'>;
  deleteReminder(input: {
    workspaceId: string;
    reminderId: string;
    expectedEditVersion: number;
    now: Date;
  }): Promise<'deleted' | 'not-found' | 'conflict'>;
  listReminders(workspaceId: string): Promise<ReminderRecord[]>;
  listRecipients(workspaceId: string): Promise<RecipientRecord[]>;
  setRecipientSubscription(input: {
    workspaceId: string;
    recipientId: string;
    expectedVersion: number;
    subscribed: boolean;
    now: Date;
  }): Promise<RecipientRecord | 'not-found' | 'conflict'>;
  listServices(workspaceId: string): Promise<ServiceRecord[]>;
  createService(input: { workspaceId: string; serviceId: string; name: string }): Promise<ServiceRecord>;
  listPushMonitors(workspaceId: string): Promise<PushMonitorRecord[]>;
  createPushMonitor(input: {
    workspaceId: string;
    serviceId: string;
    monitorId: string;
    intervalMs: number;
    graceMs: number;
    startExpectingNow: boolean;
    now: Date;
    tokenHash: string;
  }): Promise<PushMonitorRecord | 'not-found'>;
  rotatePushMonitorToken(input: {
    workspaceId: string;
    monitorId: string;
    now: Date;
    tokenHash: string;
  }): Promise<'rotated' | 'not-found'>;
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
    reminders: Array<{ id: string; title: string; nextDueAt: string; state: string; editVersion: number }>;
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

  async editReminder(
    context: AuthContext,
    input: { reminderId: string; expectedEditVersion: number; title: string; note?: string; schedule: ReminderSchedule }
  ): Promise<ReminderRecord> {
    const title = input.title.trim();
    if (!title || title.length > 120) throw new RangeError('title is required and must be at most 120 characters');
    if (input.note && input.note.length > 500) throw new RangeError('note must be at most 500 characters');
    const nextDueAt = nextOccurrences(input.schedule, this.now(), 1)[0];
    const updated = await this.repository.updateReminder({
      workspaceId: context.workspaceId,
      reminderId: input.reminderId,
      expectedEditVersion: input.expectedEditVersion,
      title,
      note: input.note,
      schedule: input.schedule,
      nextDueAt
    });
    if (updated === 'not-found') throw new Error('Not found');
    if (updated === 'conflict') throw new Error('Conflict');
    return updated;
  }

  async pauseReminder(context: AuthContext, reminderId: string, expectedEditVersion: number): Promise<ReminderRecord> {
    const updated = await this.repository.pauseReminder({
      workspaceId: context.workspaceId,
      reminderId,
      expectedEditVersion,
      now: this.now()
    });
    if (updated === 'not-found') throw new Error('Not found');
    if (updated === 'conflict') throw new Error('Conflict');
    return updated;
  }

  async resumeReminder(context: AuthContext, reminderId: string, expectedEditVersion: number): Promise<ReminderRecord> {
    const reminders = await this.repository.listReminders(context.workspaceId);
    const current = reminders.find((row) => row.reminderId === reminderId);
    if (!current) throw new Error('Not found');
    const nextDueAt = nextOccurrences(current.schedule, this.now(), 1)[0];
    const updated = await this.repository.resumeReminder({
      workspaceId: context.workspaceId,
      reminderId,
      expectedEditVersion,
      now: this.now(),
      nextDueAt
    });
    if (updated === 'not-found') throw new Error('Not found');
    if (updated === 'conflict') throw new Error('Conflict');
    return updated;
  }

  async deleteReminder(context: AuthContext, reminderId: string, expectedEditVersion: number): Promise<void> {
    const deleted = await this.repository.deleteReminder({
      workspaceId: context.workspaceId,
      reminderId,
      expectedEditVersion,
      now: this.now()
    });
    if (deleted === 'not-found') throw new Error('Not found');
    if (deleted === 'conflict') throw new Error('Conflict');
  }

  async listRecipients(context: AuthContext): Promise<RecipientRecord[]> {
    return this.repository.listRecipients(context.workspaceId);
  }

  async setRecipientSubscription(
    context: AuthContext,
    input: { recipientId: string; expectedVersion: number; subscribed: boolean }
  ): Promise<RecipientRecord> {
    const updated = await this.repository.setRecipientSubscription({
      workspaceId: context.workspaceId,
      recipientId: input.recipientId,
      expectedVersion: input.expectedVersion,
      subscribed: input.subscribed,
      now: this.now()
    });
    if (updated === 'not-found') throw new Error('Not found');
    if (updated === 'conflict') throw new Error('Conflict');
    return updated;
  }

  async listServices(context: AuthContext): Promise<ServiceRecord[]> {
    return this.repository.listServices(context.workspaceId);
  }

  async createService(context: AuthContext, name: string): Promise<ServiceRecord> {
    const normalized = name.trim();
    if (!normalized || normalized.length > 120) throw new RangeError('name is required and must be at most 120 characters');
    return this.repository.createService({ workspaceId: context.workspaceId, serviceId: randomUUID(), name: normalized });
  }

  async listPushMonitors(context: AuthContext): Promise<PushMonitorRecord[]> {
    return this.repository.listPushMonitors(context.workspaceId);
  }

  async createPushMonitor(
    context: AuthContext,
    input: { serviceId: string; intervalMs?: number; graceMs?: number; startExpectingNow?: boolean; publicBaseUrl: string }
  ): Promise<PushMonitorRecord & { heartbeatUrl: string }> {
    const intervalMs = Math.max(60_000, Math.floor(input.intervalMs ?? 300_000));
    const graceMs = Math.max(0, Math.floor(input.graceMs ?? 120_000));
    const { token, hash } = issueHeartbeatToken();
    const created = await this.repository.createPushMonitor({
      workspaceId: context.workspaceId,
      serviceId: input.serviceId,
      monitorId: randomUUID(),
      intervalMs,
      graceMs,
      startExpectingNow: input.startExpectingNow === true,
      now: this.now(),
      tokenHash: hash
    });
    if (created === 'not-found') throw new Error('Not found');
    return { ...created, heartbeatUrl: `${input.publicBaseUrl}/h/${token}` };
  }

  async rotatePushMonitorToken(
    context: AuthContext,
    monitorId: string,
    publicBaseUrl: string
  ): Promise<{ heartbeatUrl: string }> {
    const { token, hash } = issueHeartbeatToken();
    const rotated = await this.repository.rotatePushMonitorToken({
      workspaceId: context.workspaceId,
      monitorId,
      now: this.now(),
      tokenHash: hash
    });
    if (rotated === 'not-found') throw new Error('Not found');
    return { heartbeatUrl: `${publicBaseUrl}/h/${token}` };
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

function issueHeartbeatToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}
