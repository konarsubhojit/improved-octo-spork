import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createOraclePool } from '../store/oracle.js';
import { OracleAppRepository } from '../store/oracleApp.js';
import { AppService } from '../app/service.js';
import { FakeMailer } from '../services/smtp.js';
import { loadConfig } from './config.js';
import type { ReminderSchedule } from '../core/types.js';

const config = loadConfig(process.env);
if (config.role !== 'api' || !config.database || !config.trustedOrigin || !config.publicBaseUrl) {
  throw new Error('This entrypoint requires PROCESS_ROLE=api');
}
const pool = await createOraclePool(config.database);
const repository = new OracleAppRepository(pool);
const service = new AppService(repository, new FakeMailer(true));

const server = createServer((request, response) => {
  void handle(request, response).catch(() => {
    if (!response.headersSent) writeJson(response, 500, { error: 'Internal server error' });
    else response.end();
  });
});

server.listen(config.port, '127.0.0.1');

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.method === 'OPTIONS') return writeJson(response, 204, {});

  const body = await readBody(request);
  const url = new URL(request.url ?? '/', config.publicBaseUrl);

  if (request.method === 'POST' && url.pathname === '/api/auth/verify') {
    const token = asRecord(body).token;
    if (typeof token !== 'string') return writeJson(response, 400, { error: 'token is required' });
    try {
      const created = await service.verifyInvite(token);
      response.setHeader('Set-Cookie', sessionCookie(created.sessionToken));
      return writeJson(response, 200, { csrfToken: created.csrfToken });
    } catch {
      return writeJson(response, 400, { error: 'Invite is invalid or expired' });
    }
  }

  const mutating = request.method !== 'GET' && request.method !== 'HEAD';
  if (mutating && request.headers.origin !== config.trustedOrigin) return writeJson(response, 403, { error: 'Invalid origin' });

  const sessionToken = parseSessionCookie(request.headers.cookie);
  if (!sessionToken) return writeJson(response, 401, { error: 'Unauthenticated' });
  const context = await service.authenticate(sessionToken, headerString(request.headers['x-csrf-token']), mutating);

  if (request.method === 'POST' && url.pathname === '/api/auth/signout') {
    await service.signOut(context);
    response.setHeader('Set-Cookie', clearSessionCookie());
    return writeJson(response, 204, {});
  }

  if (request.method === 'POST' && url.pathname === '/api/invites') {
    const email = asRecord(body).email;
    if (typeof email !== 'string') return writeJson(response, 400, { error: 'email is required' });
    const token = await service.createInvite(context.workspaceId, email);
    return writeJson(response, 201, { token });
  }

  if (request.method === 'POST' && url.pathname === '/api/reminders') {
    const data = asRecord(body);
    const title = data.title;
    const schedule = data.schedule;
    if (typeof title !== 'string' || !schedule || typeof schedule !== 'object') {
      return writeJson(response, 422, { error: 'title and schedule are required' });
    }
    const created = await service.createReminder(
      context,
      typeof data.note === 'string'
        ? { title, note: data.note, schedule: schedule as ReminderSchedule }
        : { title, schedule: schedule as ReminderSchedule }
    );
    return writeJson(response, 201, {
      reminderId: created.reminderId,
      nextDueAt: created.nextDueAt?.toISOString() ?? null,
      scheduleVersion: created.scheduleVersion,
      editVersion: created.editVersion
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/reminders/preview') {
    const schedule = asRecord(body).schedule;
    if (!schedule || typeof schedule !== 'object') return writeJson(response, 422, { error: 'schedule is required' });
    return writeJson(response, 200, { occurrences: service.preview(schedule as ReminderSchedule) });
  }

  if (request.method === 'GET' && url.pathname === '/api/reminders') {
    const reminders = await service.listReminders(context);
    return writeJson(response, 200, {
      reminders: reminders.map((row) => ({
        reminderId: row.reminderId,
        title: row.title,
        note: row.note,
        nextDueAt: row.nextDueAt?.toISOString() ?? null,
        pausedAt: row.pausedAt?.toISOString() ?? null,
        scheduleVersion: row.scheduleVersion,
        editVersion: row.editVersion,
        schedule: row.schedule
      }))
    });
  }

  const reminderMatch = /^\/api\/reminders\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
  if (request.method === 'PATCH' && reminderMatch?.[1]) {
    const data = asRecord(body);
    const expectedEditVersion = Number(data.expectedEditVersion);
    if (!Number.isInteger(expectedEditVersion) || expectedEditVersion < 1) {
      return writeJson(response, 422, { error: 'expectedEditVersion must be a positive integer' });
    }
    const action = data.action;
    try {
      if (action === 'pause') {
        const updated = await service.pauseReminder(context, reminderMatch[1], expectedEditVersion);
        return writeJson(response, 200, reminderPayload(updated));
      }
      if (action === 'resume') {
        const updated = await service.resumeReminder(context, reminderMatch[1], expectedEditVersion);
        return writeJson(response, 200, reminderPayload(updated));
      }
      const title = data.title;
      const schedule = data.schedule;
      if (typeof title !== 'string' || !schedule || typeof schedule !== 'object') {
        return writeJson(response, 422, { error: 'title and schedule are required for edit' });
      }
      const updated = await service.editReminder(
        context,
        typeof data.note === 'string'
          ? { reminderId: reminderMatch[1], expectedEditVersion, title, note: data.note, schedule: schedule as ReminderSchedule }
          : { reminderId: reminderMatch[1], expectedEditVersion, title, schedule: schedule as ReminderSchedule }
      );
      return writeJson(response, 200, reminderPayload(updated));
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Conflict') return writeJson(response, 409, { error: 'edit conflict' });
      if (error instanceof Error && error.message === 'Not found') return writeJson(response, 404, { error: 'Not found' });
      throw error;
    }
  }

  if (request.method === 'DELETE' && reminderMatch?.[1]) {
    const expectedEditVersion = Number(url.searchParams.get('expectedEditVersion'));
    if (!Number.isInteger(expectedEditVersion) || expectedEditVersion < 1) {
      return writeJson(response, 422, { error: 'expectedEditVersion query parameter is required' });
    }
    try {
      await service.deleteReminder(context, reminderMatch[1], expectedEditVersion);
      return writeJson(response, 204, {});
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Conflict') return writeJson(response, 409, { error: 'edit conflict' });
      if (error instanceof Error && error.message === 'Not found') return writeJson(response, 404, { error: 'Not found' });
      throw error;
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/recipients') {
    const recipients = await service.listRecipients(context);
    return writeJson(response, 200, {
      recipients: recipients.map((row) => ({
        recipientId: row.recipientId,
        email: row.email,
        ownershipVerifiedAt: row.ownershipVerifiedAt?.toISOString() ?? null,
        consentedAt: row.consentedAt?.toISOString() ?? null,
        unsubscribedAt: row.unsubscribedAt?.toISOString() ?? null,
        version: row.version
      }))
    });
  }

  const recipientMatch = /^\/api\/recipients\/([0-9a-fA-F-]{36})\/subscription$/.exec(url.pathname);
  if (request.method === 'PUT' && recipientMatch?.[1]) {
    const data = asRecord(body);
    const expectedVersion = Number(data.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || typeof data.subscribed !== 'boolean') {
      return writeJson(response, 422, { error: 'expectedVersion and subscribed are required' });
    }
    try {
      const updated = await service.setRecipientSubscription(context, {
        recipientId: recipientMatch[1],
        expectedVersion,
        subscribed: data.subscribed
      });
      return writeJson(response, 200, {
        recipientId: updated.recipientId,
        email: updated.email,
        ownershipVerifiedAt: updated.ownershipVerifiedAt?.toISOString() ?? null,
        consentedAt: updated.consentedAt?.toISOString() ?? null,
        unsubscribedAt: updated.unsubscribedAt?.toISOString() ?? null,
        version: updated.version
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Conflict') return writeJson(response, 409, { error: 'version conflict' });
      if (error instanceof Error && error.message === 'Not found') return writeJson(response, 404, { error: 'Not found' });
      throw error;
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    const dashboard = await service.dashboard(context);
    return writeJson(response, 200, dashboard);
  }

  if (request.method === 'GET' && url.pathname === '/api/services') {
    const services = await service.listServices(context);
    const monitors = await service.listPushMonitors(context);
    return writeJson(response, 200, {
      services: services.map((item) => ({
        serviceId: item.serviceId,
        name: item.name,
        pushMonitors: monitors.filter((row) => row.serviceId === item.serviceId).map((row) => ({
          monitorId: row.monitorId,
          state: row.state,
          intervalMs: row.intervalMs,
          graceMs: row.graceMs,
          pausedAt: row.pausedAt?.toISOString() ?? null,
          lastEvidenceAt: row.lastEvidenceAt?.toISOString() ?? null,
          editVersion: row.editVersion
        }))
      }))
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/services') {
    const name = asRecord(body).name;
    if (typeof name !== 'string') return writeJson(response, 422, { error: 'name is required' });
    const created = await service.createService(context, name);
    return writeJson(response, 201, created);
  }

  const serviceMonitorsMatch = /^\/api\/services\/([0-9a-fA-F-]{36})\/monitors$/.exec(url.pathname);
  if (request.method === 'POST' && serviceMonitorsMatch?.[1]) {
    const data = asRecord(body);
    if (data.mode !== 'push') return writeJson(response, 422, { error: 'Only push monitors are currently supported' });
    try {
      const monitorInput: {
        serviceId: string;
        intervalMs?: number;
        graceMs?: number;
        startExpectingNow?: boolean;
        publicBaseUrl: string;
      } = {
        serviceId: serviceMonitorsMatch[1],
        startExpectingNow: data.startExpectingNow === true,
        publicBaseUrl: config.publicBaseUrl!
      };
      if (Number.isFinite(Number(data.intervalMs))) monitorInput.intervalMs = Number(data.intervalMs);
      if (Number.isFinite(Number(data.graceMs))) monitorInput.graceMs = Number(data.graceMs);
      const created = await service.createPushMonitor(context, monitorInput);
      return writeJson(response, 201, created);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Not found') return writeJson(response, 404, { error: 'Not found' });
      throw error;
    }
  }

  const rotateMatch = /^\/api\/monitors\/([0-9a-fA-F-]{36})\/rotate$/.exec(url.pathname);
  if (request.method === 'POST' && rotateMatch?.[1]) {
    try {
      const rotated = await service.rotatePushMonitorToken(context, rotateMatch[1], config.publicBaseUrl!);
      return writeJson(response, 200, rotated);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Not found') return writeJson(response, 404, { error: 'Not found' });
      throw error;
    }
  }

  writeJson(response, 404, { error: 'Not found' });
}

function sessionCookie(token: string): string {
  return `__Host-session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${14 * 24 * 60 * 60}`;
}

function clearSessionCookie(): string {
  return '__Host-session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
}

function parseSessionCookie(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /(?:^|; )__Host-session=([^;]+)/.exec(value);
  return match?.[1];
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function reminderPayload(row: {
  reminderId: string;
  title: string;
  note: string | undefined;
  nextDueAt: Date | undefined;
  pausedAt: Date | undefined;
  scheduleVersion: number;
  editVersion: number;
  schedule: ReminderSchedule;
}): Record<string, unknown> {
  return {
    reminderId: row.reminderId,
    title: row.title,
    note: row.note ?? null,
    nextDueAt: row.nextDueAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    scheduleVersion: row.scheduleVersion,
    editVersion: row.editVersion,
    schedule: row.schedule
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(value);
    size += value.byteLength;
    if (size > 64 * 1024) throw new Error('Body too large');
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.writeHead(status).end(status === 204 ? '' : JSON.stringify(body));
}
