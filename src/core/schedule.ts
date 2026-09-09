import type { ReminderSchedule } from './types.js';

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatterCache.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    formatterCache.set(zone, value);
  }
  return value;
}

function localAt(instant: number, zone: string): LocalDateTime {
  const parts = Object.fromEntries(
    formatter(zone).formatToParts(instant).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function key(value: LocalDateTime): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
}

export function resolveLocalInstant(zone: string, value: LocalDateTime): Date {
  formatter(zone);
  const approximate = key(value);
  let firstAfter: number | undefined;
  let firstAfterKey: number | undefined;
  for (let candidate = approximate - 48 * 60 * 60_000; candidate <= approximate + 72 * 60 * 60_000; candidate += 60_000) {
    const local = localAt(candidate, zone);
    const localKey = key(local);
    if (localKey === approximate) return new Date(candidate);
    if (localKey > approximate && (firstAfterKey === undefined || localKey < firstAfterKey || (localKey === firstAfterKey && candidate < firstAfter!))) {
      firstAfter = candidate;
      firstAfterKey = localKey;
    }
  }
  if (firstAfter !== undefined) return new Date(firstAfter);
  throw new RangeError('Local date has no valid instant in the selected time zone');
}

function parseTime(value = '09:00'): [number, number] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new RangeError('localTime must be HH:mm');
  return [Number(match[1]), Number(match[2])];
}

function dateParts(date: Date): Pick<LocalDateTime, 'year' | 'month' | 'day'> {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addDays(value: Pick<LocalDateTime, 'year' | 'month' | 'day'>, days: number) {
  return dateParts(new Date(Date.UTC(value.year, value.month - 1, value.day + days)));
}

export function nextOccurrences(schedule: ReminderSchedule, after: Date, count = 5): Date[] {
  if (!Number.isInteger(count) || count < 1 || count > 5) throw new RangeError('count must be between 1 and 5');
  formatter(schedule.zone);
  if (schedule.kind === 'one-time') {
    const due = new Date(schedule.oneTimeAt ?? '');
    if (Number.isNaN(due.getTime())) throw new RangeError('oneTimeAt is required');
    return due > after ? [due] : [];
  }
  if (schedule.kind === 'elapsed') {
    const interval = schedule.intervalMinutes ?? 0;
    const start = new Date(schedule.startAt ?? '');
    if (!Number.isInteger(interval) || interval < 1 || Number.isNaN(start.getTime())) {
      throw new RangeError('elapsed schedules require startAt and a positive intervalMinutes');
    }
    const intervalMs = interval * 60_000;
    const step = Math.max(0, Math.floor((after.getTime() - start.getTime()) / intervalMs) + 1);
    return Array.from({ length: count }, (_, index) => new Date(start.getTime() + (step + index) * intervalMs));
  }

  const [hour, minute] = parseTime(schedule.localTime);
  const result: Date[] = [];
  let day = dateParts(new Date(after.getTime() - 36 * 60 * 60_000));
  for (let scanned = 0; result.length < count && scanned < 3700; scanned += 1) {
    const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
    const eligible =
      schedule.kind === 'daily' ||
      (schedule.kind === 'weekdays' && (schedule.weekdays ?? []).includes(weekday)) ||
      (schedule.kind === 'monthly' && day.day === schedule.dayOfMonth);
    if (eligible) {
      const instant = resolveLocalInstant(schedule.zone, { ...day, hour, minute });
      if (instant > after) result.push(instant);
    }
    day = addDays(day, 1);
  }
  return result;
}

export function classifyBacklog(dueAt: Date, now: Date): 'due' | 'late' | 'missed' {
  const age = now.getTime() - dueAt.getTime();
  if (age <= 0) return 'due';
  return age < 24 * 60 * 60_000 ? 'late' : 'missed';
}
