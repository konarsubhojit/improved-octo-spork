import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppService, type AppRepository, type NotificationOutcome, type NotificationWorkItem } from '../src/app/service.js';
import { FakeMailer } from '../src/services/smtp.js';
import type { ReminderSchedule } from '../src/core/types.js';

test('invite -> verify -> reminder -> scheduler -> outbox -> fake smtp history', async () => {
  const clock = new TestClock('2026-01-01T00:00:00.000Z');
  const repo = new InMemoryRepo(clock);
  const mailer = new FakeMailer(true);
  const service = new AppService(repo, mailer, () => clock.now());

  const invite = await service.createInvite('ws-a', 'owner@example.com');
  const verified = await service.verifyInvite(invite);
  const context = await service.authenticate(verified.sessionToken, verified.csrfToken, true);

  const schedule: ReminderSchedule = {
    kind: 'elapsed',
    zone: 'UTC',
    startAt: '2026-01-01T00:01:00.000Z',
    intervalMinutes: 60
  };
  await service.createReminder(context, { title: 'Pay subscription', schedule });

  assert.equal(await service.schedulerTick(), 0);
  clock.set('2026-01-01T00:02:00.000Z');
  assert.equal(await service.schedulerTick(), 1);
  assert.equal(await service.emailWorkerTick(), 1);

  const dashboard = await service.dashboard(context);
  assert.equal(dashboard.reminders.length, 1);
  assert.equal(dashboard.notifications[0]?.state, 'smtp-accepted');
  assert.equal(mailer.sent.length, 1);
  assert.match(mailer.sent[0]?.recipientEmail ?? '', /owner@example.com/);
});

test('sessions enforce csrf and workspace isolation', async () => {
  const clock = new TestClock('2026-01-01T00:00:00.000Z');
  const repo = new InMemoryRepo(clock);
  const service = new AppService(repo, new FakeMailer(true), () => clock.now());

  const tokenA = await service.createInvite('ws-a', 'a@example.com');
  const tokenB = await service.createInvite('ws-b', 'b@example.com');
  const a = await service.verifyInvite(tokenA);
  const b = await service.verifyInvite(tokenB);
  const authA = await service.authenticate(a.sessionToken, a.csrfToken, true);
  const authB = await service.authenticate(b.sessionToken, b.csrfToken, true);
  await assert.rejects(() => service.authenticate(a.sessionToken, 'wrong', true));

  const schedule: ReminderSchedule = {
    kind: 'elapsed',
    zone: 'UTC',
    startAt: '2026-01-01T00:02:00.000Z',
    intervalMinutes: 60
  };
  await service.createReminder(authA, { title: 'A only', schedule });
  await service.createReminder(authB, { title: 'B only', schedule });

  assert.equal((await service.listReminders(authA)).length, 1);
  assert.equal((await service.listReminders(authB)).length, 1);
  assert.notEqual((await service.listReminders(authA))[0]?.reminderId, (await service.listReminders(authB))[0]?.reminderId);
});

class TestClock {
  private value: Date;
  constructor(iso: string) {
    this.value = new Date(iso);
  }

  now(): Date {
    return new Date(this.value);
  }

  set(iso: string): void {
    this.value = new Date(iso);
  }
}

type InviteRow = { workspaceId: string; email: string; tokenHash: Buffer; expiresAt: Date; usedAt?: Date };
type SessionRow = { sessionId: string; userId: string; workspaceId: string; email: string; tokenHash: Buffer; csrfHash: Buffer; expiresAt: Date; revokedAt?: Date };
type ReminderRow = {
  workspaceId: string;
  reminderId: string;
  recipientEmail: string;
  title: string;
  note: string | undefined;
  schedule: ReminderSchedule;
  nextDueAt: Date | undefined;
  pausedAt: Date | undefined;
  scheduleVersion: number;
  editVersion: number;
};
type NotificationRow = {
  workspaceId: string;
  notificationId: string;
  recipientEmail: string;
  subject: string;
  textBody: string;
  state: 'queued' | 'submitting' | 'retrying' | 'smtp-accepted' | 'failed' | 'outcome-unknown';
  attempts: number;
  availableAt: Date;
  updatedAt: Date;
};

class InMemoryRepo implements AppRepository {
  private invites: InviteRow[] = [];
  private users = new Map<string, string>();
  private sessions: SessionRow[] = [];
  private reminders: ReminderRow[] = [];
  private notifications: NotificationRow[] = [];

  constructor(private readonly clock: TestClock) {}

  async createInvite(input: { inviteId: string; workspaceId: string; email: string; tokenHash: Buffer; expiresAt: Date }): Promise<void> {
    this.invites.push({ workspaceId: input.workspaceId, email: input.email, tokenHash: input.tokenHash, expiresAt: input.expiresAt });
  }

  async consumeInvite(input: { tokenHash: Buffer; now: Date }): Promise<{ workspaceId: string; email: string } | undefined> {
    const row = this.invites.find((invite) => invite.tokenHash.equals(input.tokenHash));
    if (!row || row.usedAt || row.expiresAt <= input.now) return undefined;
    row.usedAt = input.now;
    return { workspaceId: row.workspaceId, email: row.email };
  }

  async findOrCreateUser(email: string): Promise<{ userId: string; email: string }> {
    const existing = this.users.get(email);
    if (existing) return { userId: existing, email };
    const created = `${email}-id`;
    this.users.set(email, created);
    return { userId: created, email };
  }

  async ensureMembership(_workspaceId: string, _userId: string): Promise<void> {}

  async createSession(input: {
    sessionId: string;
    userId: string;
    workspaceId: string;
    tokenHash: Buffer;
    csrfHash: Buffer;
    expiresAt: Date;
  }): Promise<void> {
    const email = [...this.users.entries()].find(([, id]) => id === input.userId)?.[0] ?? '';
    this.sessions.push({ ...input, email });
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
    const row = this.sessions.find((session) => session.tokenHash.equals(tokenHash));
    if (!row || row.revokedAt || row.expiresAt <= now) return undefined;
    return {
      sessionId: row.sessionId,
      userId: row.userId,
      workspaceId: row.workspaceId,
      tokenHash: row.tokenHash,
      csrfHash: row.csrfHash,
      expiresAt: row.expiresAt.getTime(),
      email: row.email
    };
  }

  async revokeSession(sessionId: string, now: Date): Promise<void> {
    const row = this.sessions.find((session) => session.sessionId === sessionId);
    if (row) row.revokedAt = now;
  }

  async createReminder(input: {
    workspaceId: string;
    reminderId: string;
    recipientEmail: string;
    title: string;
    note: string | undefined;
    schedule: ReminderSchedule;
    nextDueAt: Date | undefined;
  }) {
    const row: ReminderRow = {
      workspaceId: input.workspaceId,
      reminderId: input.reminderId,
      recipientEmail: input.recipientEmail,
      title: input.title,
      note: input.note,
      schedule: input.schedule,
      nextDueAt: input.nextDueAt,
      pausedAt: undefined,
      scheduleVersion: 1,
      editVersion: 1
    };
    this.reminders.push(row);
    return row;
  }

  async listReminders(workspaceId: string) {
    return this.reminders.filter((row) => row.workspaceId === workspaceId);
  }

  async runReminderSchedulerTick(now: Date, limit: number): Promise<number> {
    const due = this.reminders
      .filter((row) => row.nextDueAt && row.nextDueAt <= now)
      .slice(0, limit);
    for (const row of due) {
      this.notifications.push({
        workspaceId: row.workspaceId,
        notificationId: `${row.reminderId}:${row.scheduleVersion}`,
        recipientEmail: row.recipientEmail,
        subject: row.title,
        textBody: `${row.title} is due`,
        state: 'queued',
        attempts: 0,
        availableAt: now,
        updatedAt: now
      });
      row.scheduleVersion += 1;
      row.nextDueAt = undefined;
    }
    return due.length;
  }

  async claimNotifications(now: Date, limit: number): Promise<NotificationWorkItem[]> {
    const ready = this.notifications
      .filter((row) => (row.state === 'queued' || row.state === 'retrying') && row.availableAt <= now)
      .slice(0, limit);
    for (const row of ready) {
      row.state = 'submitting';
      row.attempts += 1;
      row.updatedAt = now;
    }
    return ready.map((row) => ({
      workspaceId: row.workspaceId,
      notificationId: row.notificationId,
      recipientEmail: row.recipientEmail,
      subject: row.subject,
      textBody: row.textBody,
      priority: 'reminder',
      attempts: row.attempts - 1
    }));
  }

  async completeNotification(input: {
    workspaceId: string;
    notificationId: string;
    attempt: number;
    now: Date;
    outcome: NotificationOutcome;
    retryAt: Date | undefined;
  }): Promise<void> {
    const row = this.notifications.find(
      (item) => item.workspaceId === input.workspaceId && item.notificationId === input.notificationId
    );
    if (!row) return;
    if (input.outcome.accepted === true) {
      row.state = 'smtp-accepted';
      row.updatedAt = input.now;
      return;
    }
    if (input.outcome.accepted === false && input.retryAt) {
      row.state = 'retrying';
      row.availableAt = input.retryAt;
      row.updatedAt = input.retryAt;
      return;
    }
    row.state = input.outcome.accepted === false ? 'failed' : 'outcome-unknown';
    row.updatedAt = input.now;
  }

  async dashboard(workspaceId: string): Promise<{
    reminders: Array<{ id: string; title: string; nextDueAt: string; state: string }>;
    services: Array<{ id: string; name: string; pullState: string | undefined; pushState: string | undefined }>;
    incidents: Array<{ id: string; service: string; mode: string; openedAt: string }>;
    notifications: Array<{ id: string; subject: string; state: string; updatedAt: string }>;
    quota: { rolling24h: number; rolling24hLimit: number; monthly: number; monthlyLimit: number };
  }> {
    return {
      reminders: this.reminders
        .filter((row) => row.workspaceId === workspaceId)
        .map((row) => ({ id: row.reminderId, title: row.title, nextDueAt: row.nextDueAt?.toISOString() ?? 'none', state: 'active' })),
      services: [{ id: 'pull-disabled', name: 'Pull monitor execution', pullState: 'disabled', pushState: undefined }],
      incidents: [],
      notifications: this.notifications
        .filter((row) => row.workspaceId === workspaceId)
        .map((row) => ({ id: row.notificationId, subject: row.subject, state: row.state, updatedAt: row.updatedAt.toISOString() })),
      quota: {
        rolling24h: this.notifications.filter((row) => row.workspaceId === workspaceId).reduce((sum, row) => sum + row.attempts, 0),
        rolling24hLimit: 100,
        monthly: this.notifications.filter((row) => row.workspaceId === workspaceId).reduce((sum, row) => sum + row.attempts, 0),
        monthlyLimit: 2500
      }
    };
  }
}
