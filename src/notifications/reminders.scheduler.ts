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
  sectionYearStudentIds,
  studentUserIds,
} from '../common/notifications/recipients';
import { formatMinutes } from '../exams/exam-mappers';

/**
 * Daily "due tomorrow" reminders, windowed to tomorrow so each assignment/exam reminds once.
 * ponytail: no dedupe table, so a same-day cron double-fire could double-remind; add `remindedAt` if needed.
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

  // One reminder per subject paper sitting tomorrow; only published exams, only that session's roster.
  private async remindExams(start: Date, end: Date): Promise<void> {
    const items = await this.prisma.exam.findMany({
      where: {
        heldAt: { gte: start, lt: end },
        examination: { status: 'PUBLISHED' },
      },
      select: {
        startMin: true,
        venue: true,
        sectionSubject: { select: { subject: { select: { name: true } } } },
        examination: {
          select: {
            id: true,
            title: true,
            sectionId: true,
            academicYearId: true,
          },
        },
      },
    });
    for (const e of items) {
      const userIds = await studentUserIds(
        this.prisma,
        await sectionYearStudentIds(
          this.prisma,
          e.examination.sectionId,
          e.examination.academicYearId,
        ),
      );
      if (!userIds.length) continue;
      const when = e.startMin != null ? ` at ${formatMinutes(e.startMin)}` : '';
      const where = e.venue ? ` in ${e.venue}` : '';
      this.eventEmitter.emit(NOTIFICATION_CREATE, {
        userIds,
        type: 'EXAM_UPCOMING',
        title: 'Exam tomorrow',
        body: `${e.sectionSubject.subject.name} — "${e.examination.title}" is tomorrow${when}${where}.`,
        link: `/exams/${e.examination.id}`,
        entityType: 'Examination',
        entityId: e.examination.id,
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
