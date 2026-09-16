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
  // Examination review cycle: submitted (-> admins), then reviewed (-> author).
  | 'EXAM_SUBMITTED'
  | 'EXAM_CHANGES_REQUESTED'
  | 'EXAM_REJECTED'
  | 'EXAM_APPROVED'
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
  | 'FEE_PAYMENT_REJECTED'
  // Timetable publish/update — ride the existing notifyAnnouncements preference.
  | 'TIMETABLE_PUBLISHED'
  | 'TIMETABLE_UPDATED';

/** Which UserSettings notify* flag gates the EMAIL side (in-app always writes). */
export type NotifyPreferenceKey =
  | 'notifyMessages'
  | 'notifyAnnouncements'
  | 'notifyGrades'
  | 'notifyAttendance';

export interface NotificationCreateEvent {
  userIds: string[];
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  /** Correlates the notification to its source for read-sync (e.g. 'Announcement' + the announcement id). */
  entityType?: string;
  entityId?: string;
  notifyPreferenceKey: NotifyPreferenceKey;
}

/**
 * Batched variant for per-recipient title/body (e.g. each student's own amount). Avoids the N+1 of one
 * NOTIFICATION_CREATE per student: preferences resolve once and every row goes in one chunked createMany.
 */
export const NOTIFICATION_CREATE_BATCH = 'notification.create.batch';

export interface NotificationBatchItem {
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
