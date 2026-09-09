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

  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    const dashboard = await service.dashboard(context);
    return writeJson(response, 200, dashboard);
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
