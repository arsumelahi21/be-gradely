import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InstallmentRemindersService } from './installment-reminders.service';

/**
 * Fires installment due-date reminders. Follows AnnouncementsScheduler, but
 * runs DAILY rather than every minute: announcement publish times are
 * minute-precise, while due dates are day-precise, so a minute cron would be
 * 1,440x the work for the same result.
 *
 * The sweep's `dueDate <= today + daysBefore` window is what makes a daily tick
 * safe — a run missed to downtime catches up on the next one, and
 * `reminderSentAt` stops the repeat.
 */
@Injectable()
export class FeeInstallmentsScheduler {
  private readonly logger = new Logger(FeeInstallmentsScheduler.name);

  constructor(private readonly reminders: InstallmentRemindersService) {}

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async handleInstallmentReminders(): Promise<void> {
    try {
      const { reminded } = await this.reminders.sweep();
      if (reminded > 0) {
        this.logger.log(`Sent ${reminded} installment reminder(s)`);
      }
    } catch (err) {
      this.logger.error('Installment reminder sweep failed', err as Error);
    }
  }
}
