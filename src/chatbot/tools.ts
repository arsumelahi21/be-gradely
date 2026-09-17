import { ChatbotAppDataService } from './app-data.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';

/**
 * The model's ENTIRE reachable surface.
 *
 * A tool is the only way an answer touches school data, and each one delegates
 * to `ChatbotAppDataService` → the scoped feature services. The model never sees
 * Prisma, never composes a query, and cannot reach a table no tool exposes.
 *
 * `roles` is defence in depth: the service would refuse a teacher asking for
 * school-wide fees anyway, but a tool the caller may not use is never put in
 * front of the model, so it cannot be tempted into calling it.
 */
export interface ChatTool {
  name: string;
  description: string;
  roles: Role[];
  /** JSON Schema for the arguments, as the Messages API expects. */
  input: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  run: (
    data: ChatbotAppDataService,
    actor: Actor,
    args: Record<string, any>,
  ) => Promise<unknown>;
}

const ADMIN = [Role.SUPER_ADMIN, Role.SCHOOL_ADMIN];
const STAFF = [Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.TEACHER];
const NO_ARGS = { type: 'object' as const, properties: {} };

export const CHAT_TOOLS: ChatTool[] = [
  {
    name: 'school_counts',
    description:
      'Total students, teachers, parents and classes in the school, plus how many were added this month. Use for "how many students", "school summary", "strength".',
    roles: ADMIN,
    input: NO_ARGS,
    run: (d, a) => d.counts(a),
  },
  {
    name: 'students_by_class',
    description:
      'Student headcount per class, broken down by section. Use when asked to split, divide or group the roll by class, grade or section.',
    roles: ADMIN,
    input: NO_ARGS,
    run: (d, a) => d.studentsByGrade(a),
  },
  {
    name: 'class_list',
    description:
      'Every class and its sections, with room and how many subjects each section has allocated.',
    roles: ADMIN,
    input: NO_ARGS,
    run: (d, a) => d.classList(a),
  },
  {
    name: 'school_attendance',
    description:
      'Schoolwide attendance: today, plus a window (default the trailing 30 days). Dates are YYYY-MM-DD.',
    roles: ADMIN,
    input: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD' },
      },
    },
    run: (d, a, args) => d.schoolAttendance(a, args.from, args.to),
  },
  {
    name: 'my_classes',
    description:
      "The asking teacher's own subject-classes with attendance rates. Teachers only.",
    roles: [Role.TEACHER],
    input: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD' },
      },
    },
    run: (d, a, args) => d.myClasses(a, args.from, args.to),
  },
  {
    name: 'student_attendance',
    description:
      "One student's attendance record and rate, looked up by name. A teacher only reaches students they teach.",
    roles: STAFF,
    input: {
      type: 'object',
      properties: {
        studentName: { type: 'string', description: 'Full or partial name' },
      },
      required: ['studentName'],
    },
    run: (d, a, args) => d.studentAttendance(a, args.studentName),
  },
  {
    name: 'student_profile',
    description:
      "One student's class, section, roll number, admission number and guardians, by name.",
    roles: STAFF,
    input: {
      type: 'object',
      properties: {
        studentName: { type: 'string', description: 'Full or partial name' },
      },
      required: ['studentName'],
    },
    run: (d, a, args) => d.findStudentProfile(a, args.studentName),
  },
  {
    name: 'outstanding_fees',
    description:
      'Students who owe money, highest balance first. Amounts are in minor units (paisa) — divide by 100 for rupees.',
    roles: ADMIN,
    input: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many students, max 25' },
      },
    },
    run: (d, a, args) => d.outstandingFees(a, args.limit ?? 10),
  },
  {
    name: 'fee_summary',
    description:
      'Collected, outstanding and overdue totals for the school. Amounts are in minor units (paisa).',
    roles: ADMIN,
    input: NO_ARGS,
    run: (d, a) => d.feeSummary(a),
  },
  {
    name: 'fees_by_class',
    description: 'Fee collection broken down by class.',
    roles: ADMIN,
    input: NO_ARGS,
    run: (d, a) => d.feesByClass(a),
  },
  {
    name: 'my_timetable',
    description:
      "The asking user's own timetable. Pass a weekday (MONDAY..SUNDAY) to narrow it to one day.",
    roles: STAFF,
    input: {
      type: 'object',
      properties: {
        day: {
          type: 'string',
          description:
            'MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY or SUNDAY',
        },
      },
    },
    run: (d, a, args) => d.myTimetable(a, args.day),
  },
  {
    name: 'examinations',
    description:
      'Examinations in the school, newest first, with id, status and result status. Call this FIRST to get an examination id for the results tools.',
    roles: STAFF,
    input: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max 25' } },
    },
    run: (d, a, args) => d.examinations(a, args.limit ?? 10),
  },
  {
    name: 'examination_summary',
    description:
      'How a class performed in one examination: pass rate, averages, per-subject summary and the grade spread. Needs an examination id from the examinations tool. Use this for "how did they do" questions.',
    roles: STAFF,
    input: {
      type: 'object',
      properties: {
        examinationId: {
          type: 'string',
          description: 'id from the examinations tool',
        },
      },
      required: ['examinationId'],
    },
    run: (d, a, args) => d.examinationSummary(a, args.examinationId),
  },
  {
    name: 'examination_results',
    description:
      "Per-student marks for one examination, with each subject's max and passing marks. Needs an examination id. A subject teacher sees only their own subjects; the principal sees every column.",
    roles: STAFF,
    input: {
      type: 'object',
      properties: {
        examinationId: {
          type: 'string',
          description: 'id from the examinations tool',
        },
      },
      required: ['examinationId'],
    },
    run: (d, a, args) => d.examinationResults(a, args.examinationId),
  },
  {
    name: 'assignments',
    description: 'Assignments, newest first, with due date, subject and class.',
    roles: STAFF,
    input: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max 25' } },
    },
    run: (d, a, args) => d.assignments(a, args.limit ?? 10),
  },
  {
    name: 'quizzes',
    description:
      'Quizzes with their subject, section, question count and attempt count.',
    roles: STAFF,
    input: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max 25' } },
    },
    run: (d, a, args) => d.quizzes(a, args.limit ?? 10),
  },
  {
    name: 'teachers',
    description:
      'The teaching staff and how many subject-classes each one is allocated.',
    roles: ADMIN,
    input: NO_ARGS,
    run: (d, a) => d.teachers(a),
  },
  {
    name: 'announcements',
    description: 'Recent announcements with their type and publish date.',
    roles: STAFF,
    input: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max 15' } },
    },
    run: (d, a, args) => d.announcements(a, args.limit ?? 5),
  },
  {
    name: 'academic_years',
    description:
      'Academic years with their dates and which one is active — use to resolve "this year" or "last year".',
    roles: STAFF,
    input: NO_ARGS,
    run: (d, a) => d.academicYears(a),
  },
];

/** Only the tools this role may use — the model never sees the others. */
export function toolsFor(role: Role): ChatTool[] {
  return CHAT_TOOLS.filter((t) => t.roles.includes(role));
}
