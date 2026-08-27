import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  NOTIFICATION_CREATE,
  NOTIFICATION_CREATE_BATCH,
} from '../common/events/notification.events';
import type {
  NotificationCreateBatchEvent,
  NotificationCreateEvent,
} from '../common/events/notification.events';
import { NotificationsService } from './notifications.service';

/**
 * Single subscriber to notification.create; keeps producers (messaging,
 * announcements, grading) decoupled from NotificationsService.
 */
@Injectable()
export class NotificationsListener {
  constructor(private readonly notifications: NotificationsService) {}

  @OnEvent(NOTIFICATION_CREATE, { async: true })
  async handle(event: NotificationCreateEvent): Promise<void> {
    await this.notifications.handleNotificationCreate(event);
  }

  /** Personalised-per-recipient batches (e.g. one challan each for a class). */
  @OnEvent(NOTIFICATION_CREATE_BATCH, { async: true })
  async handleBatch(event: NotificationCreateBatchEvent): Promise<void> {
    await this.notifications.handleNotificationCreateBatch(event);
  }
}
