import nodemailer from 'nodemailer';

let transporter;

/**
 * Lazily creates the Gmail SMTP transport (STARTTLS on port 587).
 */
export function getTransporter() {
  if (!transporter) {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) {
      throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD environment variables are required');
    }
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS
      requireTLS: true,
      auth: { user, pass }
    });
  }
  return transporter;
}

/**
 * Escapes a value so it can be safely interpolated into the HTML email body.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Builds the reminder email subject line.
 */
export function buildSubject(reminder) {
  const days = daysUntil(reminder.reminder_date, reminder.expiryDate);
  if (days > 0) {
    return `Reminder: "${reminder.serviceName}" trial expires in ${days} day${days === 1 ? '' : 's'}`;
  }
  return `Reminder: "${reminder.serviceName}" trial expires today`;
}

/**
 * Whole days between two YYYY-MM-DD dates (to - from), never negative.
 */
export function daysUntil(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86400000));
}

/**
 * Renders the HTML body of the reminder email.
 */
export function renderEmailHtml(reminder) {
  const service = escapeHtml(reminder.serviceName);
  const expiry = escapeHtml(reminder.expiryDate);
  const days = daysUntil(reminder.reminder_date, reminder.expiryDate);
  const when = days > 0 ? `in <strong>${days} day${days === 1 ? '' : 's'}</strong>` : '<strong>today</strong>';
  const note = reminder.customNote
    ? `<blockquote style="margin:16px 0;padding:12px 16px;border-left:4px solid #4f46e5;background:#f5f5ff;color:#333;font-style:italic;">${escapeHtml(
        reminder.customNote
      )}</blockquote>`
    : '';

  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:24px;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">
      <h1 style="margin:0 0 16px;font-size:20px;color:#4f46e5;">Trial expiry reminder</h1>
      <p style="margin:0 0 12px;">Your <strong>${service}</strong> trial expires ${when}.</p>
      <p style="margin:0 0 12px;">Exact expiry date: <strong>${expiry}</strong> (UTC).</p>
      ${note}
      <p style="margin:16px 0;">
        <a href="https://myaccount.google.com/subscriptions"
           style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:6px;">
          Review or cancel your subscriptions
        </a>
      </p>
      <p style="margin:0;font-size:13px;color:#6b7280;">
        One-click action: open the link above (or the provider's billing page) and cancel the trial before
        ${expiry} to avoid being charged.
      </p>
    </div>
  </body>
</html>`;
}

/**
 * Renders a plain-text fallback body.
 */
export function renderEmailText(reminder) {
  const days = daysUntil(reminder.reminder_date, reminder.expiryDate);
  const when = days > 0 ? `in ${days} day(s)` : 'today';
  const note = reminder.customNote ? `\n\nYour note: ${reminder.customNote}` : '';
  return `Your ${reminder.serviceName} trial expires ${when} (expiry date: ${reminder.expiryDate} UTC).${note}\n\nCancel the trial before the expiry date to avoid being charged.`;
}

/**
 * Sends the reminder email for a single DynamoDB reminder item.
 */
export async function sendReminderEmail(reminder) {
  const transport = getTransporter();
  return transport.sendMail({
    from: `"Trial Expiry Reminder" <${process.env.GMAIL_USER}>`,
    to: reminder.userEmail,
    subject: buildSubject(reminder),
    text: renderEmailText(reminder),
    html: renderEmailHtml(reminder)
  });
}
