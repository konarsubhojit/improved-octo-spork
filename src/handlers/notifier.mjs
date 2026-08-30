import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME, STATUS_INDEX } from '../utils/db.mjs';
import { sendReminderEmail } from '../utils/mailer.mjs';

/**
 * Returns the current UTC date formatted as YYYY-MM-DD.
 */
export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Fetches every PENDING reminder scheduled for the given date.
 */
export async function fetchPendingReminders(reminderDate) {
  const items = [];
  let ExclusiveStartKey;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: STATUS_INDEX,
        KeyConditionExpression: '#status = :status AND reminder_date = :today',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'PENDING', ':today': reminderDate },
        ExclusiveStartKey
      })
    );
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

/**
 * Marks a reminder as SENT, recording the delivery timestamp.
 */
export async function markAsSent(reminder) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { reminder_date: reminder.reminder_date, reminder_id: reminder.reminder_id },
        UpdateExpression: 'SET #status = :sent, sentAt = :sentAt',
        ConditionExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':sent': 'SENT',
          ':pending': 'PENDING',
          ':sentAt': new Date().toISOString()
        }
      })
    );
  } catch (error) {
    // Another concurrent run already marked this reminder as SENT - nothing to do.
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
  }
}

export const handler = async () => {
  const today = todayUtc();
  const reminders = await fetchPendingReminders(today);
  console.log(`Found ${reminders.length} pending reminder(s) for ${today}`);

  const results = await Promise.allSettled(
    reminders.map(async (reminder) => {
      await sendReminderEmail(reminder);
      await markAsSent(reminder);
    })
  );

  const failures = results.filter((result) => result.status === 'rejected');
  for (const failure of failures) {
    console.error('Failed to process reminder:', failure.reason);
  }

  const summary = {
    date: today,
    processed: reminders.length,
    sent: reminders.length - failures.length,
    failed: failures.length
  };
  console.log('Daily notifier summary:', JSON.stringify(summary));
  return summary;
};
