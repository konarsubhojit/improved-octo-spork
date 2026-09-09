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

test('reminder edit pause resume delete enforce optimistic conflicts and lifecycle changes', async () => {
  const clock = new TestClock('2026-01-01T00:00:00.000Z');
  const repo = new InMemoryRepo(clock);
  const service = new AppService(repo, new FakeMailer(true), () => clock.now());
  const invite = await service.createInvite('ws-a', 'owner@example.com');
  const verified = await service.verifyInvite(invite);
  const context = await service.authenticate(verified.sessionToken, verified.csrfToken, true);

  const created = await service.createReminder(context, {
    title: 'Original',
    schedule: { kind: 'elapsed', zone: 'UTC', startAt: '2026-01-01T00:01:00.000Z', intervalMinutes: 60 }
  });
  const edited = await service.editReminder(context, {
    reminderId: created.reminderId,
    expectedEditVersion: created.editVersion,
    title: 'Edited',
    schedule: { kind: 'elapsed', zone: 'UTC', startAt: '2026-01-01T00:02:00.000Z', intervalMinutes: 60 }
  });
  assert.equal(edited.editVersion, created.editVersion + 1);
  await assert.rejects(() =>
    service.pauseReminder(context, created.reminderId, created.editVersion)
  );

  const paused = await service.pauseReminder(context, created.reminderId, edited.editVersion);
  assert.ok(paused.pausedAt);
  const resumed = await service.resumeReminder(context, created.reminderId, paused.editVersion);
  assert.equal(resumed.pausedAt, undefined);
  await service.deleteReminder(context, created.reminderId, resumed.editVersion);
  assert.equal((await service.listReminders(context)).length, 0);
});

test('recipient unsubscribe between queue and send suppresses delivery', async () => {
  const clock = new TestClock('2026-01-01T00:00:00.000Z');
  const repo = new InMemoryRepo(clock);
  const mailer = new FakeMailer(true);
  const service = new AppService(repo, mailer, () => clock.now());
  const invite = await service.createInvite('ws-a', 'owner@example.com');
  const verified = await service.verifyInvite(invite);
  const context = await service.authenticate(verified.sessionToken, verified.csrfToken, true);

  const reminder = await service.createReminder(context, {
    title: 'Subscription bill',
    schedule: { kind: 'elapsed', zone: 'UTC', startAt: '2026-01-01T00:01:00.000Z', intervalMinutes: 60 }
  });
  clock.set('2026-01-01T00:01:00.000Z');
  assert.equal(await service.schedulerTick(), 1);
  const recipients = await service.listRecipients(context);
  assert.equal(recipients.length, 1);
  await service.setRecipientSubscription(context, {
    recipientId: recipients[0]!.recipientId,
    expectedVersion: recipients[0]!.version,
    subscribed: false
  });

  assert.equal(await service.emailWorkerTick(), 0);
  assert.equal(mailer.sent.length, 0);
  assert.deepEqual(repo.getNotificationStates(context.workspaceId), ['suppressed']);
});

test('push monitor service creation and token rotation only expose full URL once per action', async () => {
  const clock = new TestClock('2026-01-01T00:00:00.000Z');
  const repo = new InMemoryRepo(clock);
  const service = new AppService(repo, new FakeMailer(true), () => clock.now());
  const invite = await service.createInvite('ws-a', 'owner@example.com');
  const verified = await service.verifyInvite(invite);
  const context = await service.authenticate(verified.sessionToken, verified.csrfToken, true);

  const app = await service.createService(context, 'Payments API');
  const monitor = await service.createPushMonitor(context, {
    serviceId: app.serviceId,
    publicBaseUrl: 'https://example.test',
    startExpectingNow: true
  });
  assert.match(monitor.heartbeatUrl, /^https:\/\/example\.test\/h\/[A-Za-z0-9_-]{43}$/);
  const listed = await service.listPushMonitors(context);
  assert.equal(listed.length, 1);
  assert.equal((listed[0] as { heartbeatUrl?: string }).heartbeatUrl, undefined);

  const rotated = await service.rotatePushMonitorToken(context, listed[0]!.monitorId, 'https://example.test');
  assert.match(rotated.heartbeatUrl, /^https:\/\/example\.test\/h\/[A-Za-z0-9_-]{43}$/);
  assert.notEqual(rotated.heartbeatUrl, monitor.heartbeatUrl);
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
  recipientId: string;
  title: string;
  note: string | undefined;
  schedule: ReminderSchedule;
  nextDueAt: Date | undefined;
  pausedAt: Date | undefined;
  deletedAt: Date | undefined;
  scheduleVersion: number;
  editVersion: number;
};
type RecipientRow = {
  workspaceId: string;
  recipientId: string;
  email: string;
  ownershipVerifiedAt: Date | undefined;
  consentedAt: Date | undefined;
  unsubscribedAt: Date | undefined;
  version: number;
};
type NotificationRow = {
  workspaceId: string;
  notificationId: string;
  eventId: string;
  reminderId: string | undefined;
  scheduleVersion: number | undefined;
  recipientId: string;
  recipientEmail: string;
  subject: string;
  textBody: string;
  state: 'queued' | 'submitting' | 'retrying' | 'smtp-accepted' | 'failed' | 'outcome-unknown' | 'suppressed';
  attempts: number;
  availableAt: Date;
  updatedAt: Date;
};
type ServiceRow = { workspaceId: string; serviceId: string; name: string; deletedAt?: Date };
type PushMonitorRow = {
  workspaceId: string;
  monitorId: string;
  serviceId: string;
  state: 'healthy' | 'failing' | 'down' | 'unknown' | 'paused';
  intervalMs: number;
  graceMs: number;
  pausedAt: Date | undefined;
  lastEvidenceAt: Date | undefined;
  editVersion: number;
  tokenHash: string;
};

class InMemoryRepo implements AppRepository {
  private invites: InviteRow[] = [];
  private users = new Map<string, string>();
  private sessions: SessionRow[] = [];
  private reminders: ReminderRow[] = [];
  private recipients: RecipientRow[] = [];
  private notifications: NotificationRow[] = [];
  private services: ServiceRow[] = [];
  private pushMonitors: PushMonitorRow[] = [];

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
    const recipient = this.ensureRecipient(input.workspaceId, input.recipientEmail);
    const row: ReminderRow = {
      workspaceId: input.workspaceId,
      reminderId: input.reminderId,
      recipientId: recipient.recipientId,
      title: input.title,
      note: input.note,
      schedule: input.schedule,
      nextDueAt: input.nextDueAt,
      pausedAt: undefined,
      deletedAt: undefined,
      scheduleVersion: 1,
      editVersion: 1
    };
    this.reminders.push(row);
    return this.asReminder(row);
  }

  async listReminders(workspaceId: string) {
    return this.reminders.filter((row) => row.workspaceId === workspaceId && !row.deletedAt).map((row) => this.asReminder(row));
  }

  async updateReminder(input: {
    workspaceId: string;
    reminderId: string;
    expectedEditVersion: number;
    title: string;
    note: string | undefined;
    schedule: ReminderSchedule;
    nextDueAt: Date | undefined;
  }) {
    const row = this.reminders.find((item) => item.workspaceId === input.workspaceId && item.reminderId === input.reminderId && !item.deletedAt);
    if (!row) return 'not-found' as const;
    if (row.editVersion !== input.expectedEditVersion) return 'conflict' as const;
    row.title = input.title;
    row.note = input.note;
    row.schedule = input.schedule;
    row.nextDueAt = input.nextDueAt;
    row.pausedAt = undefined;
    row.editVersion += 1;
    row.scheduleVersion += 1;
    return this.asReminder(row);
  }

  async pauseReminder(input: { workspaceId: string; reminderId: string; expectedEditVersion: number; now: Date }) {
    const row = this.reminders.find((item) => item.workspaceId === input.workspaceId && item.reminderId === input.reminderId && !item.deletedAt);
    if (!row) return 'not-found' as const;
    if (row.editVersion !== input.expectedEditVersion) return 'conflict' as const;
    row.pausedAt = input.now;
    row.nextDueAt = undefined;
    row.editVersion += 1;
    row.scheduleVersion += 1;
    return this.asReminder(row);
  }

  async resumeReminder(input: { workspaceId: string; reminderId: string; expectedEditVersion: number; now: Date; nextDueAt: Date | undefined }) {
    const row = this.reminders.find((item) => item.workspaceId === input.workspaceId && item.reminderId === input.reminderId && !item.deletedAt);
    if (!row) return 'not-found' as const;
    if (row.editVersion !== input.expectedEditVersion) return 'conflict' as const;
    row.pausedAt = undefined;
    row.nextDueAt = input.nextDueAt;
    row.editVersion += 1;
    row.scheduleVersion += 1;
    return this.asReminder(row);
  }

  async deleteReminder(input: { workspaceId: string; reminderId: string; expectedEditVersion: number; now: Date }) {
    const row = this.reminders.find((item) => item.workspaceId === input.workspaceId && item.reminderId === input.reminderId && !item.deletedAt);
    if (!row) return 'not-found' as const;
    if (row.editVersion !== input.expectedEditVersion) return 'conflict' as const;
    row.deletedAt = input.now;
    row.pausedAt = input.now;
    row.nextDueAt = undefined;
    row.editVersion += 1;
    row.scheduleVersion += 1;
    return 'deleted' as const;
  }

  async listRecipients(workspaceId: string) {
    return this.recipients.filter((row) => row.workspaceId === workspaceId).map((row) => ({ ...row }));
  }

  async setRecipientSubscription(input: {
    workspaceId: string;
    recipientId: string;
    expectedVersion: number;
    subscribed: boolean;
    now: Date;
  }) {
    const row = this.recipients.find((item) => item.workspaceId === input.workspaceId && item.recipientId === input.recipientId);
    if (!row) return 'not-found' as const;
    if (row.version !== input.expectedVersion) return 'conflict' as const;
    row.consentedAt = input.subscribed ? row.consentedAt ?? input.now : undefined;
    row.unsubscribedAt = input.subscribed ? undefined : input.now;
    row.version += 1;
    return { ...row };
  }

  async listServices(workspaceId: string) {
    return this.services.filter((row) => row.workspaceId === workspaceId && !row.deletedAt).map((row) => ({ serviceId: row.serviceId, name: row.name }));
  }

  async createService(input: { workspaceId: string; serviceId: string; name: string }) {
    const row: ServiceRow = { workspaceId: input.workspaceId, serviceId: input.serviceId, name: input.name };
    this.services.push(row);
    return { serviceId: row.serviceId, name: row.name };
  }

  async listPushMonitors(workspaceId: string) {
    return this.pushMonitors.filter((row) => row.workspaceId === workspaceId).map((row) => ({ ...row }));
  }

  async createPushMonitor(input: {
    workspaceId: string;
    serviceId: string;
    monitorId: string;
    intervalMs: number;
    graceMs: number;
    startExpectingNow: boolean;
    now: Date;
    tokenHash: string;
  }) {
    const service = this.services.find((row) => row.workspaceId === input.workspaceId && row.serviceId === input.serviceId && !row.deletedAt);
    if (!service) return 'not-found' as const;
    const created: PushMonitorRow = {
      workspaceId: input.workspaceId,
      monitorId: input.monitorId,
      serviceId: input.serviceId,
      state: 'unknown',
      intervalMs: input.intervalMs,
      graceMs: input.graceMs,
      pausedAt: undefined,
      lastEvidenceAt: undefined,
      editVersion: 1,
      tokenHash: input.tokenHash
    };
    this.pushMonitors.push(created);
    return { ...created };
  }

  async rotatePushMonitorToken(input: { workspaceId: string; monitorId: string; now: Date; tokenHash: string }) {
    const row = this.pushMonitors.find((item) => item.workspaceId === input.workspaceId && item.monitorId === input.monitorId);
    if (!row) return 'not-found' as const;
    row.tokenHash = input.tokenHash;
    return 'rotated' as const;
  }

  async runReminderSchedulerTick(now: Date, limit: number): Promise<number> {
    const due = this.reminders
      .filter((row) => !row.deletedAt && !row.pausedAt && row.nextDueAt && row.nextDueAt <= now)
      .slice(0, limit);
    for (const row of due) {
      const recipient = this.recipients.find((item) => item.workspaceId === row.workspaceId && item.recipientId === row.recipientId);
      if (!recipient || !recipient.ownershipVerifiedAt || !recipient.consentedAt || recipient.unsubscribedAt) continue;
      const dueAt = row.nextDueAt ?? now;
      this.notifications.push({
        workspaceId: row.workspaceId,
        notificationId: `${row.reminderId}:${row.scheduleVersion}`,
        eventId: `reminder:${row.reminderId}:${row.scheduleVersion}:${dueAt.toISOString()}`,
        reminderId: row.reminderId,
        scheduleVersion: row.scheduleVersion,
        recipientId: row.recipientId,
        recipientEmail: recipient.email,
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
    const claimable: NotificationRow[] = [];
    for (const row of ready) {
      const recipient = this.recipients.find((item) => item.workspaceId === row.workspaceId && item.recipientId === row.recipientId);
      const reminder = row.reminderId
        ? this.reminders.find((item) => item.workspaceId === row.workspaceId && item.reminderId === row.reminderId)
        : undefined;
      if (
        !recipient ||
        !recipient.ownershipVerifiedAt ||
        !recipient.consentedAt ||
        !!recipient.unsubscribedAt ||
        !reminder ||
        !!reminder.deletedAt ||
        !!reminder.pausedAt ||
        row.scheduleVersion !== reminder.scheduleVersion - 1
      ) {
        row.state = 'suppressed';
        row.updatedAt = now;
        continue;
      }
      row.state = 'submitting';
      row.attempts += 1;
      row.updatedAt = now;
      claimable.push(row);
    }
    return claimable.map((row) => ({
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
    reminders: Array<{ id: string; title: string; nextDueAt: string; state: string; editVersion: number }>;
    services: Array<{ id: string; name: string; pullState: string | undefined; pushState: string | undefined }>;
    incidents: Array<{ id: string; service: string; mode: string; openedAt: string }>;
    notifications: Array<{ id: string; subject: string; state: string; updatedAt: string }>;
    quota: { rolling24h: number; rolling24hLimit: number; monthly: number; monthlyLimit: number };
  }> {
    return {
      reminders: this.reminders
        .filter((row) => row.workspaceId === workspaceId && !row.deletedAt)
        .map((row) => ({
          id: row.reminderId,
          title: row.title,
          nextDueAt: row.nextDueAt?.toISOString() ?? 'none',
          state: row.pausedAt ? 'paused' : row.nextDueAt ? 'active' : 'completed',
          editVersion: row.editVersion
        })),
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

  getNotificationStates(workspaceId: string): string[] {
    return this.notifications.filter((row) => row.workspaceId === workspaceId).map((row) => row.state);
  }

  private ensureRecipient(workspaceId: string, email: string): RecipientRow {
    const existing = this.recipients.find((row) => row.workspaceId === workspaceId && row.email === email);
    if (existing) return existing;
    const created: RecipientRow = {
      workspaceId,
      recipientId: `${workspaceId}:${email}`,
      email,
      ownershipVerifiedAt: this.clock.now(),
      consentedAt: this.clock.now(),
      unsubscribedAt: undefined,
      version: 1
    };
    this.recipients.push(created);
    return created;
  }

  private asReminder(row: ReminderRow): ReminderRow {
    return { ...row };
  }
}
