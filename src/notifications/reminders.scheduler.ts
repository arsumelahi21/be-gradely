import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import {
  NOTIFICATION_CREATE,
  NotificationCreateEvent,
} from '../common/events/notification.events';
import {
  sectionStudentIds,
  studentUserIds,
} from '../common/notifications/recipients';

/**
 * Daily "due tomorrow" reminders (Reminders category); windowed to tomorrow so each assignment/exam reminds once.
 * ponytail: no per-item dedupe table — a cron double-fire in the same day could
 * double-remind; add a `remindedAt` marker if that ever matters.
 */
@Injectable()
export class RemindersScheduler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendDueReminders(): Promise<void> {
    const [start, end] = tomorrowWindow();
    await this.remindAssignments(start, end);
    await this.remindExams(start, end);
  }

  private async remindAssignments(start: Date, end: Date): Promise<void> {
    const items = await (this.prisma as any).assignment.findMany({
      where: { status: 'PUBLISHED', dueAt: { gte: start, lt: end } },
      select: {
        id: true,
        title: true,
        sectionSubject: { select: { sectionId: true } },
      },
    });
    for (const a of items) {
      const userIds = await studentUserIds(
        this.prisma,
        await sectionStudentIds(this.prisma, a.sectionSubject.sectionId),
      );
      if (!userIds.length) continue;
      this.eventEmitter.emit(NOTIFICATION_CREATE, {
        userIds,
        type: 'ASSIGNMENT_DUE_SOON',
        title: 'Assignment due tomorrow',
        body: `"${a.title}" is due tomorrow.`,
        link: `/assignments/${a.id}`,
        notifyPreferenceKey: 'notifyAttendance',
      } as NotificationCreateEvent);
    }
  }

  private async remindExams(start: Date, end: Date): Promise<void> {
    const items = await (this.prisma as any).exam.findMany({
      where: { status: 'PUBLISHED', heldAt: { gte: start, lt: end } },
      select: {
        id: true,
        title: true,
        sectionSubject: { select: { sectionId: true } },
      },
    });
    for (const e of items) {
      const userIds = await studentUserIds(
        this.prisma,
        await sectionStudentIds(this.prisma, e.sectionSubject.sectionId),
      );
      if (!userIds.length) continue;
      this.eventEmitter.emit(NOTIFICATION_CREATE, {
        userIds,
        type: 'EXAM_UPCOMING',
        title: 'Exam tomorrow',
        body: `"${e.title}" is tomorrow.`,
        link: `/exams/${e.id}`,
        notifyPreferenceKey: 'notifyAttendance',
      } as NotificationCreateEvent);
    }
  }
}

/** [start, end) covering the whole of tomorrow in UTC. */
function tomorrowWindow(): [Date, Date] {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2),
  );
  return [start, end];
}
