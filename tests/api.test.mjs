import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDate, subtractDays, resolveReminderDates, validateReminderInput } from '../src/handlers/api.mjs';

const base = {
  serviceName: 'Netflix',
  expiryDate: '2026-03-10',
  userEmail: 'user@example.com'
};

test('isValidDate accepts real dates and rejects invalid ones', () => {
  assert.equal(isValidDate('2026-03-10'), true);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('10-03-2026'), false);
  assert.equal(isValidDate(undefined), false);
});

test('subtractDays handles month boundaries', () => {
  assert.equal(subtractDays('2026-03-01', 3), '2026-02-26');
  assert.equal(subtractDays('2026-03-10', 0), '2026-03-10');
});

test('resolveReminderDates defaults to 3 days, 1 day and expiry day', () => {
  assert.deepEqual(resolveReminderDates(base), ['2026-03-07', '2026-03-09', '2026-03-10']);
});

test('resolveReminderDates de-duplicates custom offsets', () => {
  assert.deepEqual(resolveReminderDates({ ...base, reminderOffsets: [1, 1, 0] }), ['2026-03-09', '2026-03-10']);
});

test('resolveReminderDates rejects dates after expiry', () => {
  assert.throws(() => resolveReminderDates({ ...base, reminderDates: ['2026-03-11'] }), /after the expiry date/);
});

test('validateReminderInput rejects bad payloads', () => {
  assert.throws(() => validateReminderInput({ ...base, serviceName: '  ' }), /serviceName is required/);
  assert.throws(() => validateReminderInput({ ...base, expiryDate: 'soon' }), /expiryDate/);
  assert.throws(() => validateReminderInput({ ...base, userEmail: 'nope' }), /userEmail/);
  assert.throws(() => validateReminderInput({ ...base, customNote: 'x'.repeat(501) }), /customNote/);
});

test('validateReminderInput normalises a valid payload', () => {
  const result = validateReminderInput({ ...base, serviceName: ' Netflix ', customNote: ' cancel ' });
  assert.equal(result.serviceName, 'Netflix');
  assert.equal(result.customNote, 'cancel');
  assert.equal(result.reminderDates.length, 3);
});
