import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, daysUntil, buildSubject, renderEmailHtml, renderEmailText } from '../src/utils/mailer.mjs';
import { todayUtc } from '../src/handlers/notifier.mjs';

const reminder = {
  reminder_date: '2026-03-07',
  reminder_id: 'abc',
  serviceName: 'Netflix',
  expiryDate: '2026-03-10',
  customNote: 'Cancel <before> renewal',
  userEmail: 'user@example.com'
};

test('escapeHtml neutralises HTML control characters', () => {
  assert.equal(escapeHtml('<script>"x"&\'y\''), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
});

test('daysUntil computes whole days and clamps negatives', () => {
  assert.equal(daysUntil('2026-03-07', '2026-03-10'), 3);
  assert.equal(daysUntil('2026-03-10', '2026-03-10'), 0);
  assert.equal(daysUntil('2026-03-12', '2026-03-10'), 0);
});

test('buildSubject reflects the remaining days', () => {
  assert.match(buildSubject(reminder), /expires in 3 days/);
  assert.match(buildSubject({ ...reminder, reminder_date: '2026-03-10' }), /expires today/);
});

test('renderEmailHtml escapes the custom note and includes key details', () => {
  const html = renderEmailHtml(reminder);
  assert.match(html, /Netflix/);
  assert.match(html, /2026-03-10/);
  assert.match(html, /<blockquote/);
  assert.match(html, /Cancel &lt;before&gt; renewal/);
  assert.doesNotMatch(html, /Cancel <before>/);
});

test('renderEmailText includes the note and expiry date', () => {
  const text = renderEmailText(reminder);
  assert.match(text, /Netflix trial expires in 3 day\(s\)/);
  assert.match(text, /2026-03-10/);
});

test('todayUtc formats the date as YYYY-MM-DD', () => {
  assert.equal(todayUtc(new Date('2026-03-07T23:30:00Z')), '2026-03-07');
});
