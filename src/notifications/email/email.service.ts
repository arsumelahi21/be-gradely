import { Injectable, Logger } from '@nestjs/common';

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  link?: string;
}

/**
 * Pluggable transactional email seam — dev/beta logs to console; swap `send`'s body for a
 * real provider later without touching producers or NotificationsListener.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  async send(msg: EmailMessage): Promise<void> {
    this.logger.log(
      `[EMAIL:stub] to=${msg.to} subject="${msg.subject}"` +
        (msg.link ? ` link=${msg.link}` : ''),
    );
  }

  /** Best-effort batch send — a single failure never aborts the rest. */
  async sendBatch(messages: EmailMessage[]): Promise<void> {
    for (const msg of messages) {
      try {
        await this.send(msg);
      } catch (err) {
        this.logger.error(`Email to ${msg.to} failed`, err as Error);
      }
    }
  }
}
