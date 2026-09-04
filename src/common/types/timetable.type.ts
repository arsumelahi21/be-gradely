// Mirror the Prisma timetable enums as local TS enums (like role.type.ts / attendance.type.ts)
// so DTOs validate with @IsEnum without depending on the generated client.

export enum DayOfWeek {
  MONDAY = 'MONDAY',
  TUESDAY = 'TUESDAY',
  WEDNESDAY = 'WEDNESDAY',
  THURSDAY = 'THURSDAY',
  FRIDAY = 'FRIDAY',
  SATURDAY = 'SATURDAY',
  SUNDAY = 'SUNDAY',
}

export enum PeriodKind {
  CLASS = 'CLASS',
  BREAK = 'BREAK',
  LUNCH = 'LUNCH',
  ASSEMBLY = 'ASSEMBLY',
  FREE = 'FREE',
}

export enum TimetableStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

// Non-CLASS kinds must NOT carry a sectionSubjectId; a CLASS cell must.
export const NON_CLASS_KINDS: PeriodKind[] = [
  PeriodKind.BREAK,
  PeriodKind.LUNCH,
  PeriodKind.ASSEMBLY,
  PeriodKind.FREE,
];
