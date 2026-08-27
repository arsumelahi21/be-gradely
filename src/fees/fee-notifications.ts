import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import {
  NOTIFICATION_CREATE,
  type NotificationCreateEvent,
} from '../common/events/notification.events';
import { studentAudienceUserIds } from '../common/notifications/recipients';

/**
 * "This student's fee allocation changed" — sent to the student and their
 * linked guardians only.
 *
 * Recipients come from the ParentStudent link, which is itself the
 * authorization rule, so a parent can never be notified about a child that
 * isn't theirs; and because every recipient hangs off one school's student,
 * the audience is tenant-scoped by construction.
 *
 * Callers must only invoke this when something ACTUALLY changed — that is what
 * keeps a retried save from re-notifying.
 */
export async function notifyFeeAllocationUpdated(
  prisma: PrismaService,
  eventEmitter: EventEmitter2,
  studentId: string,
  studentName: string,
  title: string,
  body: string,
): Promise<void> {
  const userIds = await studentAudienceUserIds(prisma, studentId);
  if (!userIds.length) return;

  eventEmitter.emit(NOTIFICATION_CREATE, {
    userIds,
    type: 'FEE_ALLOCATION_UPDATED',
    title,
    body,
    // Portal-relative — the bell prefixes the viewer's own dashboard.
    link: '/fees',
    entityType: 'StudentProfile',
    entityId: studentId,
    notifyPreferenceKey: 'notifyGrades',
  } as NotificationCreateEvent);
}
