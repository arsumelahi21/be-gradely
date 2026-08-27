import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnnouncementsService } from './announcements.service';

/** Fires notifications for scheduled announcements at publish time (not creation). Runs every minute; publishedNotified keeps re-runs idempotent (Phase 3 §3.3). */
@Injectable()
export class AnnouncementsScheduler {
  private readonly logger = new Logger(AnnouncementsScheduler.name);

  constructor(private readonly announcements: AnnouncementsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleScheduledPublish(): Promise<void> {
    try {
      const count = await this.announcements.publishDueScheduledAnnouncements();
      if (count > 0) {
        this.logger.log(
          `Notified ${count} newly-published scheduled announcement(s)`,
        );
      }
    } catch (err) {
      this.logger.error('Scheduled announcement publish failed', err as Error);
    }
  }
}
