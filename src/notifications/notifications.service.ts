import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from '../common/types/actor.type';
import {
  NotificationCreateBatchEvent,
  NotificationCreateEvent,
  NotifyPreferenceKey,
} from '../common/events/notification.events';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { featureFlags } from '../common/config/feature-flags';
import { EmailMessage, EmailService } from './email/email.service';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';

const CREATE_CHUNK = 1000;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /**
   * Fan-out for a notification event: writes in-app rows for every recipient (chunked
   * createMany), then emails only those whose preferences allow it. Producer emits without awaiting.
   */
  async handleNotificationCreate(
    event: NotificationCreateEvent,
  ): Promise<void> {
    const userIds = [...new Set(event.userIds)].filter(Boolean);
    if (!userIds.length) return;

    const key: NotifyPreferenceKey = event.notifyPreferenceKey;

    // Per-user notification preferences (missing row => all defaults on). Fetched
    // once and shared by both the in-app and email fan-out below.
    const settings = await this.prisma.userSettings.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        inAppNotifications: true,
        emailNotifications: true,
        [key]: true,
      } as any,
    });
    const settingsByUser = new Map(settings.map((s: any) => [s.userId, s]));

    // 1) In-app rows — only for recipients whose in-app master AND this category
    // are enabled (both default on when there's no settings row).
    const inAppUserIds = userIds.filter((userId) => {
      const s: any = settingsByUser.get(userId);
      return (s?.inAppNotifications ?? true) && (s?.[key] ?? true);
    });
    try {
      for (let i = 0; i < inAppUserIds.length; i += CREATE_CHUNK) {
        const chunk = inAppUserIds.slice(i, i + CREATE_CHUNK);
        await this.prisma.notification.createMany({
          data: chunk.map((userId) => ({
            userId,
            type: event.type,
            title: event.title,
            body: event.body,
            link: event.link ?? null,
            entityType: event.entityType ?? null,
            entityId: event.entityId ?? null,
          })),
        });
      }
    } catch (err) {
      // Fire-and-forget handler: a recipient may have been removed between the
      // emit and this write. Log and continue — never crash over a stale userId.
      this.logger.warn(
        `notification in-app write skipped: ${(err as Error).message}`,
      );
    }

    // 2) Email side — gated behind the beta feature flag, then narrowed to recipients
    // whose email master AND this category are enabled.
    if (featureFlags.emailNotifications) {
      try {
        const messages = await this.buildEmailMessages(
          event,
          settingsByUser,
          userIds,
        );
        if (messages.length) await this.email.sendBatch(messages);
      } catch (err) {
        this.logger.error('Notification email fan-out failed', err as Error);
      }
    }
  }

  /**
   * Fan-out for a BATCH of personalised notifications (e.g. one per student in
   * a generated class). Costs a constant number of queries no matter how many
   * items: one settings read for the union of recipients, one chunked
   * createMany for every row, one user read for the email side.
   */
  async handleNotificationCreateBatch(
    event: NotificationCreateBatchEvent,
  ): Promise<void> {
    const items = (event.items ?? []).filter((i) => i.userIds?.length);
    if (!items.length) return;

    const key: NotifyPreferenceKey = event.notifyPreferenceKey;
    const allUserIds = [
      ...new Set(items.flatMap((i) => i.userIds.filter(Boolean))),
    ];
    if (!allUserIds.length) return;

    const settings = await this.prisma.userSettings.findMany({
      where: { userId: { in: allUserIds } },
      select: {
        userId: true,
        inAppNotifications: true,
        emailNotifications: true,
        [key]: true,
      } as any,
    });
    const settingsByUser = new Map(settings.map((s: any) => [s.userId, s]));
    const inAppAllowed = (userId: string) => {
      const s: any = settingsByUser.get(userId);
      return (s?.inAppNotifications ?? true) && (s?.[key] ?? true);
    };

    // 1) Flatten every item into rows, then write them all together.
    const rows = items.flatMap((item) =>
      [...new Set(item.userIds.filter(Boolean))]
        .filter(inAppAllowed)
        .map((userId) => ({
          userId,
          type: event.type,
          title: item.title,
          body: item.body,
          link: item.link ?? null,
          entityType: item.entityType ?? null,
          entityId: item.entityId ?? null,
        })),
    );

    try {
      for (let i = 0; i < rows.length; i += CREATE_CHUNK) {
        await this.prisma.notification.createMany({
          data: rows.slice(i, i + CREATE_CHUNK),
        });
      }
    } catch (err) {
      this.logger.warn(
        `notification batch in-app write skipped: ${(err as Error).message}`,
      );
    }

    // 2) Email side — one user lookup for the whole batch.
    if (featureFlags.emailNotifications) {
      try {
        const users = await this.prisma.user.findMany({
          where: { id: { in: allUserIds }, isActive: true },
          select: { id: true, email: true },
        });
        const emailById = new Map(users.map((u) => [u.id, u.email]));
        const messages: EmailMessage[] = [];

        for (const item of items) {
          for (const userId of new Set(item.userIds.filter(Boolean))) {
            const to = emailById.get(userId);
            if (!to) continue;
            const s: any = settingsByUser.get(userId);
            if ((s?.emailNotifications ?? true) && (s?.[key] ?? true)) {
              messages.push({
                to,
                subject: item.title,
                body: item.body,
                link: item.link,
              });
            }
          }
        }
        if (messages.length) await this.email.sendBatch(messages);
      } catch (err) {
        this.logger.error(
          'Notification batch email fan-out failed',
          err as Error,
        );
      }
    }
  }

  private async buildEmailMessages(
    event: NotificationCreateEvent,
    settingsByUser: Map<string, any>,
    userIds: string[],
  ): Promise<EmailMessage[]> {
    const key: NotifyPreferenceKey = event.notifyPreferenceKey;
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds }, isActive: true },
      select: { id: true, email: true },
    });

    const messages: EmailMessage[] = [];
    for (const user of users) {
      if (!user.email) continue;
      const s: any = settingsByUser.get(user.id);
      // Missing settings row => defaults (all enabled).
      const emailEnabled = s?.emailNotifications ?? true;
      const typeEnabled = s?.[key] ?? true;
      if (emailEnabled && typeEnabled) {
        messages.push({
          to: user.email,
          subject: event.title,
          body: event.body,
          link: event.link,
        });
      }
    }
    return messages;
  }

  // ---- endpoints ---------------------------------------------------------

  async list(actor: Actor, query: ListNotificationsQueryDto) {
    const { page, pageSize, skip, take } = resolvePagination(query);
    // Announcements have their own dashboard container — legacy NEW_ANNOUNCEMENT
    // rows are excluded. `since` scopes the bell to "today only".
    const sinceFilter = query.since
      ? { createdAt: { gte: new Date(query.since) } }
      : {};
    const where = {
      userId: actor.userId,
      type: { not: 'NEW_ANNOUNCEMENT' },
      ...sinceFilter,
      ...(query.unreadOnly ? { isRead: false } : {}),
    };

    const [total, unread, items] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({
        where: {
          userId: actor.userId,
          isRead: false,
          type: { not: 'NEW_ANNOUNCEMENT' },
          ...sinceFilter,
        },
      }),
      this.prisma.notification.findMany({
        where,
        // Newest first; id tiebreak keeps a same-millisecond batch deterministic.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
    ]);

    return { page, pageSize, total, unread, items };
  }

  async unreadCount(actor: Actor, since?: string) {
    const count = await this.prisma.notification.count({
      where: {
        userId: actor.userId,
        isRead: false,
        type: { not: 'NEW_ANNOUNCEMENT' },
        ...(since ? { createdAt: { gte: new Date(since) } } : {}),
      },
    });
    return { unread: count };
  }

  /** Remove notifications from the caller's list — hard delete, own rows only.
   *  Only removes the notification row; the underlying entity is untouched. */
  async dismiss(ids: string[], actor: Actor) {
    // Guard the Prisma footgun: `deleteMany({ where: { id: { in: undefined } } })`
    // ignores the id filter and would wipe ALL of the user's notifications.
    const clean = (ids ?? []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (!clean.length) return { dismissed: 0 };
    const res = await this.prisma.notification.deleteMany({
      where: { id: { in: clean }, userId: actor.userId },
    });
    return { dismissed: res.count };
  }

  async markRead(id: string, actor: Actor) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.userId !== actor.userId) {
      throw new ForbiddenException('Not allowed');
    }
    return this.prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });
  }

  /** Bulk mark-as-read by id (per-category "mark all read"); own rows only. */
  async markManyRead(ids: string[], actor: Actor) {
    if (!ids.length) return { updated: 0 };
    const res = await this.prisma.notification.updateMany({
      where: { id: { in: ids }, userId: actor.userId, isRead: false },
      data: { isRead: true },
    });
    return { updated: res.count };
  }

  async markAllRead(actor: Actor) {
    const res = await this.prisma.notification.updateMany({
      where: { userId: actor.userId, isRead: false },
      data: { isRead: true },
    });
    return { updated: res.count };
  }
}
