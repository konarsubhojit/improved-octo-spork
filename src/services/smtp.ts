import nodemailer from 'nodemailer';
import type { Mailer, NotificationOutcome, NotificationWorkItem } from '../app/service.js';

export interface GmailSettings {
  user: string;
  appPassword: string;
  host?: string;
  port?: number;
}

export class GmailMailer implements Mailer {
  private readonly transporter;

  constructor(private readonly settings: GmailSettings) {
    this.transporter = nodemailer.createTransport({
      host: settings.host ?? 'smtp.gmail.com',
      port: settings.port ?? 587,
      secure: (settings.port ?? 587) === 465,
      requireTLS: (settings.port ?? 587) !== 465,
      tls: { rejectUnauthorized: true },
      auth: { user: settings.user, pass: settings.appPassword }
    });
  }

  async send(item: NotificationWorkItem): Promise<NotificationOutcome> {
    try {
      await this.transporter.sendMail({
        from: `"Reminder Monitor" <${this.settings.user}>`,
        to: item.recipientEmail,
        subject: item.subject,
        text: item.textBody
      });
      return { accepted: true };
    } catch (error: unknown) {
      if (error instanceof Error) return { accepted: false, code: error.name || 'smtp-error' };
      return { accepted: undefined, code: 'smtp-unknown' };
    }
  }
}

export class FakeMailer implements Mailer {
  readonly sent: NotificationWorkItem[] = [];
  constructor(private readonly accept = true) {}

  async send(item: NotificationWorkItem): Promise<NotificationOutcome> {
    this.sent.push(item);
    return this.accept ? { accepted: true } : { accepted: false, code: 'fake-rejection' };
  }
}
