/**
 * Notification event contract — producers emit this and stay decoupled from the
 * implementation; a single listener in src/notifications writes in-app rows and batched email.
 */
export const NOTIFICATION_CREATE = 'notification.create';

export type NotificationType =
  | 'NEW_MESSAGE'
  // Legacy — no longer emitted (announcements have their own dashboard container)
  // and excluded from the bell list/count. Kept for back-compat filtering.
  | 'NEW_ANNOUNCEMENT'
  | 'USER_REPORT'
  | 'USER_ENROLLED'
  | 'ASSIGNMENT_PUBLISHED'
  | 'ASSIGNMENT_SUBMITTED'
  | 'ASSIGNMENT_GRADED'
  | 'ASSIGNMENT_DUE_SOON'
  | 'QUIZ_PUBLISHED'
  | 'QUIZ_SUBMITTED'
  | 'QUIZ_GRADED'
  | 'EXAM_PUBLISHED'
  | 'EXAM_RESULT'
  | 'EXAM_UPCOMING'
  | 'ATTENDANCE_MARKED'
  // Fee events ride the existing notifyGrades preference — no new UserSettings column.
  | 'FEE_CHALLAN_ISSUED'
  | 'FEE_PAYMENT_RECEIVED'
  | 'FEE_ALLOCATION_UPDATED'
  // The only fee event with no user action behind it — a daily sweep fires it.
  | 'FEE_INSTALLMENT_DUE_SOON'
  // Online payment proof: submitted (-> admins), then reviewed (-> submitter).
  | 'FEE_PAYMENT_SUBMITTED'
  | 'FEE_PAYMENT_VERIFIED'
  | 'FEE_PAYMENT_REJECTED';

/** Which UserSettings notify* flag gates the EMAIL side (in-app always writes). */
export type NotifyPreferenceKey =
  | 'notifyMessages'
  | 'notifyAnnouncements'
  | 'notifyGrades'
  | 'notifyAttendance';

export interface NotificationCreateEvent {
  /** Full recipient set — the listener fans out (createMany + batched email). */
  userIds: string[];
  type: NotificationType;
  title: string;
  body: string;
  /** Deep link, e.g. /student-dashboard/messages/{threadId}. */
  link?: string;
  /** Correlates the notification to its source for read-sync (e.g. 'Announcement' + the announcement id). */
  entityType?: string;
  entityId?: string;
  notifyPreferenceKey: NotifyPreferenceKey;
}

/**
 * Batched variant: many DIFFERENT notifications published in one go.
 *
 * `NOTIFICATION_CREATE` carries one title/body for many recipients, which can't
 * express "each student hears their own amount". Emitting it once per student
 * would work but costs a settings query + a write per student — the N+1 this
 * exists to avoid. The listener resolves preferences for the union of all
 * recipients ONCE and writes every row in one chunked createMany.
 */
export const NOTIFICATION_CREATE_BATCH = 'notification.create.batch';

/** One personalised notification inside a batch. */
export interface NotificationBatchItem {
  /** Recipients for THIS item (e.g. one student plus their guardians). */
  userIds: string[];
  title: string;
  body: string;
  link?: string;
  entityType?: string;
  entityId?: string;
}

export interface NotificationCreateBatchEvent {
  /** Type and preference are shared — a batch is one kind of event. */
  type: NotificationType;
  notifyPreferenceKey: NotifyPreferenceKey;
  items: NotificationBatchItem[];
}
