import { PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { ddb, TABLE_NAME, STATUS_INDEX } from '../utils/db.mjs';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_OFFSETS = [3, 1, 0];
const MAX_NOTE_LENGTH = 500;
const MAX_SERVICE_NAME_LENGTH = 120;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  body: JSON.stringify(body)
});

/**
 * Returns true when the value is a real calendar date in YYYY-MM-DD format.
 */
export function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Shifts a YYYY-MM-DD date backwards by the given number of days.
 */
export function subtractDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/**
 * Validates the POST /reminders payload and normalises it.
 */
export function validateReminderInput(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }

  const serviceName = typeof payload.serviceName === 'string' ? payload.serviceName.trim() : '';
  if (!serviceName) throw new HttpError(400, 'serviceName is required');
  if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
    throw new HttpError(400, `serviceName must be at most ${MAX_SERVICE_NAME_LENGTH} characters`);
  }

  if (!isValidDate(payload.expiryDate)) {
    throw new HttpError(400, 'expiryDate is required and must be a valid YYYY-MM-DD date');
  }

  const userEmail = typeof payload.userEmail === 'string' ? payload.userEmail.trim() : '';
  if (!EMAIL_PATTERN.test(userEmail)) throw new HttpError(400, 'userEmail must be a valid email address');

  const customNote = typeof payload.customNote === 'string' ? payload.customNote.trim() : '';
  if (customNote.length > MAX_NOTE_LENGTH) {
    throw new HttpError(400, `customNote must be at most ${MAX_NOTE_LENGTH} characters`);
  }

  const reminderDates = resolveReminderDates(payload);

  return { serviceName, expiryDate: payload.expiryDate, userEmail, customNote, reminderDates };
}

/**
 * Resolves the reminder dates, either from explicit dates or from day offsets
 * before the expiry date (defaults to 3 days before, 1 day before and expiry day).
 */
export function resolveReminderDates(payload) {
  let dates;

  if (payload.reminderDates !== undefined) {
    if (!Array.isArray(payload.reminderDates) || payload.reminderDates.length === 0) {
      throw new HttpError(400, 'reminderDates must be a non-empty array of YYYY-MM-DD dates');
    }
    for (const date of payload.reminderDates) {
      if (!isValidDate(date)) throw new HttpError(400, `Invalid reminder date: ${date}`);
      if (date > payload.expiryDate) {
        throw new HttpError(400, 'reminderDates cannot be after the expiry date');
      }
    }
    dates = payload.reminderDates;
  } else {
    let offsets = DEFAULT_OFFSETS;
    if (payload.reminderOffsets !== undefined) {
      if (!Array.isArray(payload.reminderOffsets) || payload.reminderOffsets.length === 0) {
        throw new HttpError(400, 'reminderOffsets must be a non-empty array of non-negative integers');
      }
      for (const offset of payload.reminderOffsets) {
        if (!Number.isInteger(offset) || offset < 0 || offset > 365) {
          throw new HttpError(400, 'reminderOffsets must contain integers between 0 and 365');
        }
      }
      offsets = payload.reminderOffsets;
    }
    dates = offsets.map((offset) => subtractDays(payload.expiryDate, offset));
  }

  return [...new Set(dates)].sort();
}

async function createReminders(payload) {
  const input = validateReminderInput(payload);
  const createdAt = new Date().toISOString();

  const items = input.reminderDates.map((reminderDate) => ({
    reminder_date: reminderDate,
    reminder_id: uuidv4(),
    serviceName: input.serviceName,
    expiryDate: input.expiryDate,
    customNote: input.customNote || undefined,
    userEmail: input.userEmail,
    status: 'PENDING',
    createdAt
  }));

  await Promise.all(
    items.map((Item) => ddb.send(new PutCommand({ TableName: TABLE_NAME, Item })))
  );

  return response(201, { created: items.length, reminders: items });
}

async function listReminders() {
  const reminders = [];
  let ExclusiveStartKey;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: STATUS_INDEX,
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'PENDING' },
        ExclusiveStartKey
      })
    );
    reminders.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  reminders.sort((a, b) => String(a.reminder_date).localeCompare(String(b.reminder_date)));
  return response(200, { count: reminders.length, reminders });
}

async function deleteReminder(reminderDate, reminderId) {
  if (!isValidDate(reminderDate)) throw new HttpError(400, 'reminder_date must be a valid YYYY-MM-DD date');
  if (!reminderId) throw new HttpError(400, 'reminder_id is required');

  const result = await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { reminder_date: reminderDate, reminder_id: reminderId },
      ReturnValues: 'ALL_OLD'
    })
  );

  if (!result.Attributes) throw new HttpError(404, 'Reminder not found');
  return response(200, { deleted: result.Attributes });
}

/**
 * Routes a normalised request. Exported to keep routing testable.
 */
export async function route({ method, path, body }) {
  const segments = path.split('/').filter(Boolean);

  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };

  if (segments[0] !== 'reminders') throw new HttpError(404, 'Not found');

  if (method === 'POST' && segments.length === 1) {
    let payload;
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      throw new HttpError(400, 'Request body must be valid JSON');
    }
    return createReminders(payload);
  }

  if (method === 'GET' && segments.length === 1) return listReminders();

  if (method === 'DELETE' && segments.length === 3) {
    return deleteReminder(decodeURIComponent(segments[1]), decodeURIComponent(segments[2]));
  }

  throw new HttpError(404, 'Not found');
}

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || 'GET';
  const path = event?.rawPath || event?.path || '/';
  const body = event?.isBase64Encoded && event?.body
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event?.body;

  try {
    return await route({ method, path, body });
  } catch (error) {
    if (error instanceof HttpError) return response(error.statusCode, { message: error.message });
    console.error('Unhandled API error:', error);
    return response(500, { message: 'Internal server error' });
  }
};
