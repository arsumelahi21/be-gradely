import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsListener } from './notifications.listener';
import { RemindersScheduler } from './reminders.scheduler';
import { EmailService } from './email/email.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsListener,
    RemindersScheduler,
    EmailService,
  ],
})
export class NotificationsModule {}
