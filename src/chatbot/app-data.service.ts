import { Injectable, Logger } from '@nestjs/common';
import { AttendanceService } from '../attendance/attendance.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { ExamResultsService } from '../exams/exam-results.service';
import { FeeReportsService } from '../fees/fee-reports.service';
import { TimetableService } from '../academics/timetable/timetable.service';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';

/**
 * The chatbot's read layer — the ONLY way an answer reaches school data.
 *
 * Every method calls the same service method the REST controller calls, passing
 * the caller's own `Actor`, so tenant scoping, role checks and object-level
 * access come from the services and cannot drift from the API. A question the
 * asker's own API would refuse returns `{ error }`, never data.
 *
 * Results are STRUCTURED, not prose: the model writes the sentence. Prose here
 * would be a second place for the answer's shape to live.
 */
@Injectable()
export class ChatbotAppDataService {
  private readonly logger = new Logger(ChatbotAppDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboard: DashboardService,
    private readonly attendance: AttendanceService,
    private readonly feeReports: FeeReportsService,
    private readonly timetable: TimetableService,
    private readonly examResults: ExamResultsService,
  ) {}

  /** School roll-up: students, teachers, parents, classes + this month's deltas. */
  async counts(actor: Actor) {
    return this.attempt('counts', async () => {
      const { counts, addedThisMonth } =
        await this.dashboard.getSchoolOverview(actor);
      return { counts, addedThisMonth };
    });
  }

  /** Student headcount per class, and per section within it. */
  async studentsByGrade(actor: Actor) {
    return this.attempt('studentsByGrade', async () => {
      const schoolId = this.schoolOf(actor);
      const grades = await this.prisma.classGrade.findMany({
        where: { schoolId },
        orderBy: [{ level: 'asc' }, { name: 'asc' }],
        select: {
          name: true,
          level: true,
          sections: {
            select: {
              name: true,
              _count: {
                select: { enrollments: { where: { status: 'ACTIVE' } } },
              },
            },
          },
        },
      });
      return {
        grades: grades.map((g) => ({
          className: g.name,
          students: g.sections.reduce((n, s) => n + s._count.enrollments, 0),
          sections: g.sections.map((s) => ({
            name: s.name,
            students: s._count.enrollments,
          })),
        })),
      };
    });
  }

  /** Every class and section, with its allocated subjects. */
  async classList(actor: Actor) {
    return this.attempt('classList', async () => {
      const schoolId = this.schoolOf(actor);
      const grades = await this.prisma.classGrade.findMany({
        where: { schoolId, isActive: true },
        orderBy: [{ level: 'asc' }, { name: 'asc' }],
        select: {
          name: true,
          sections: {
            select: {
              name: true,
              room: true,
              _count: { select: { subjects: true } },
            },
          },
        },
      });
      return {
        classes: grades.map((g) => ({
          className: g.name,
          sections: g.sections.map((s) => ({
            name: s.name,
            room: s.room,
            subjects: s._count.subjects,
          })),
        })),
      };
    });
  }

  /** Schoolwide attendance: today plus a window (default trailing 30 days). */
  async schoolAttendance(actor: Actor, from?: string, to?: string) {
    return this.attempt('schoolAttendance', async () => {
      const stats = await this.attendance.getSchoolStats(actor, { from, to });
      return {
        today: marksOf(stats.today),
        window: { from: stats.from, to: stats.to, ...marksOf(stats.range) },
      };
    });
  }

  /** A teacher's own subject-classes with attendance rates. */
  async myClasses(actor: Actor, from?: string, to?: string) {
    if (actor.role !== Role.TEACHER) {
      return { error: 'Only a teacher has their own subject-classes.' };
    }
    return this.attempt('myClasses', async () => {
      const stats = await this.attendance.getTeacherStats(actor, { from, to });
      return {
        // `marks*`, not `total`/`present`: these count attendance MARKS over the
        // window, not students. The model read the old names as a headcount and
        // reported "102 present out of 120 students".
        sections: stats.sections.map((s) => ({
          subject: s.subject.name,
          className: s.section.classGrade?.name ?? null,
          section: s.section.name,
          marksTotal: s.total,
          marksPresent: s.present,
          marksAbsent: s.absent,
          presentRate: s.presentRate,
        })),
        overall: marksOf(stats.overall),
      };
    });
  }

  /** One student's attendance record. Scoped: a teacher only sees who they teach. */
  async studentAttendance(actor: Actor, studentName: string) {
    return this.attempt('studentAttendance', async () => {
      const student = await this.findStudent(actor, studentName);
      if ('error' in student) return student;
      const stats = await this.attendance.getStudentStats(
        student.id,
        {},
        actor,
      );
      return { student: student.fullName, ...stats };
    });
  }

  /** Who owes money, highest balance first. */
  async outstandingFees(actor: Actor, limit = 10) {
    return this.attempt('outstandingFees', async () => {
      const rows = await this.feeReports.outstanding(
        { limit: Math.min(limit, 25) },
        actor,
      );
      return { students: rows };
    });
  }

  /** Collected / outstanding / overdue totals. Money is minor units. */
  async feeSummary(actor: Actor) {
    return this.attempt('feeSummary', async () => {
      const summary = await this.feeReports.summary({}, actor);
      return { summary, note: 'Amounts are in minor units (paisa).' };
    });
  }

  /** Fee collection broken down by class. */
  async feesByClass(actor: Actor) {
    return this.attempt('feesByClass', async () => {
      const rows = await this.feeReports.byClass({}, actor);
      return { classes: rows };
    });
  }

  /** The caller's own timetable, optionally for one weekday. */
  async myTimetable(actor: Actor, day?: string) {
    return this.attempt('myTimetable', async () => {
      const tt = (await this.timetable.getMyTimetable(actor, {})) as {
        // The teacher branch returns no `status` — only a class timetable has one.
        status?: string | null;
        entries?: unknown[];
      };
      const wanted = day?.toUpperCase();
      const entries = (tt?.entries ?? [])
        .filter((e: any) => !wanted || e.dayOfWeek === wanted)
        .sort(
          (a: any, b: any) =>
            (a.period?.startMin ?? 0) - (b.period?.startMin ?? 0),
        )
        .map((e: any) => ({
          day: e.dayOfWeek,
          start: clock(e.period?.startMin),
          end: clock(e.period?.endMin),
          subject: e.sectionSubject?.subject?.name ?? null,
          className: e.section?.classGrade?.name ?? null,
          section: e.section?.name ?? null,
          teacher: e.teacher?.fullName ?? null,
          room: e.room ?? e.section?.room ?? null,
        }));
      return { status: tt?.status ?? null, entries };
    });
  }

  /** Exams in the school, newest first. */
  async examinations(actor: Actor, limit = 10) {
    return this.attempt('examinations', async () => {
      const schoolId = this.schoolOf(actor);
      const rows = await this.prisma.examination.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 25),
        select: {
          // The id is what lets a results lookup follow this one.
          id: true,
          title: true,
          status: true,
          resultStatus: true,
          className: true,
          sectionName: true,
          publishedAt: true,
        },
      });
      return { examinations: rows };
    });
  }

  /**
   * How a class performed in one examination: pass rate, averages, grade spread.
   *
   * `assertStaffCanView` does the scoping, so a subject teacher sees their own
   * columns and the principal sees everything — the same rule as the REST route.
   */
  async examinationSummary(actor: Actor, examinationId: string) {
    return this.attempt('examinationSummary', async () => {
      const s = await this.examResults.summary(examinationId, actor);
      return {
        examination: s.examination,
        summary: s.summary,
        subjects: s.subjects,
        gradeDistribution: s.gradeDistribution,
      };
    });
  }

  /** Per-student marks for one examination, as the results sheet shows them. */
  async examinationResults(actor: Actor, examinationId: string) {
    return this.attempt('examinationResults', async () => {
      const r = await this.examResults.results(examinationId, actor);
      return {
        examination: r.examination,
        subjects: r.subjects.map((s) => ({
          subject: s.label,
          maxScore: s.maxScore,
          passingMarks: s.passingMarks,
        })),
        students: r.rows,
        issues: r.issues,
        summary: r.summary,
      };
    });
  }

  /** Assignments, optionally only those still open. */
  async assignments(actor: Actor, limit = 10) {
    return this.attempt('assignments', async () => {
      const schoolId = this.schoolOf(actor);
      const rows = await this.prisma.assignment.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 25),
        select: {
          title: true,
          status: true,
          dueAt: true,
          sectionSubject: {
            select: {
              subject: { select: { name: true } },
              section: {
                select: {
                  name: true,
                  classGrade: { select: { name: true } },
                },
              },
            },
          },
        },
      });
      return {
        assignments: rows.map((a) => ({
          title: a.title,
          status: a.status,
          dueAt: a.dueAt,
          subject: a.sectionSubject?.subject?.name ?? null,
          className: a.sectionSubject?.section?.classGrade?.name ?? null,
          section: a.sectionSubject?.section?.name ?? null,
        })),
      };
    });
  }

  /** Quizzes, with question and attempt counts. */
  async quizzes(actor: Actor, limit = 10) {
    return this.attempt('quizzes', async () => {
      const schoolId = this.schoolOf(actor);
      const rows = await this.prisma.quiz.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 25),
        select: {
          title: true,
          isPublished: true,
          subject: { select: { name: true } },
          section: { select: { name: true } },
          _count: { select: { questions: true, attempts: true } },
        },
      });
      return {
        quizzes: rows.map((q) => ({
          title: q.title,
          published: q.isPublished,
          subject: q.subject?.name ?? null,
          section: q.section?.name ?? null,
          questions: q._count.questions,
          attempts: q._count.attempts,
        })),
      };
    });
  }

  /** The teaching staff and what each is allocated. */
  async teachers(actor: Actor) {
    return this.attempt('teachers', async () => {
      const schoolId = this.schoolOf(actor);
      const rows = await this.prisma.teacherProfile.findMany({
        where: { schoolId },
        orderBy: { fullName: 'asc' },
        select: {
          fullName: true,
          _count: { select: { sectionSubjects: true } },
        },
      });
      return {
        teachers: rows.map((t) => ({
          name: t.fullName,
          subjectClasses: t._count.sectionSubjects,
        })),
      };
    });
  }

  /** Look one student up by name: class, roll number, guardians. */
  async findStudentProfile(actor: Actor, studentName: string) {
    return this.attempt('findStudentProfile', async () => {
      const student = await this.findStudent(actor, studentName);
      if ('error' in student) return student;
      const full = await this.prisma.studentProfile.findUnique({
        where: { id: student.id },
        select: {
          fullName: true,
          rollNo: true,
          admissionNo: true,
          enrollments: {
            where: { status: 'ACTIVE' },
            take: 1,
            select: {
              section: {
                select: {
                  name: true,
                  classGrade: { select: { name: true } },
                },
              },
            },
          },
          parents: {
            select: { parent: { select: { fullName: true } } },
          },
        },
      });
      const placement = full?.enrollments[0]?.section;
      return {
        name: full?.fullName,
        rollNo: full?.rollNo,
        admissionNo: full?.admissionNo,
        className: placement?.classGrade?.name ?? null,
        section: placement?.name ?? null,
        guardians: full?.parents.map((p) => p.parent.fullName) ?? [],
      };
    });
  }

  /** Recent announcements. */
  async announcements(actor: Actor, limit = 5) {
    return this.attempt('announcements', async () => {
      const schoolId = this.schoolOf(actor);
      const rows = await this.prisma.announcement.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 15),
        select: { title: true, type: true, createdAt: true, publishAt: true },
      });
      return { announcements: rows };
    });
  }

  /** Academic years, so "this year" can be resolved. */
  async academicYears(actor: Actor) {
    return this.attempt('academicYears', async () => {
      const schoolId = this.schoolOf(actor);
      const rows = await this.prisma.academicYear.findMany({
        where: { schoolId },
        orderBy: { startDate: 'desc' },
        select: {
          name: true,
          code: true,
          isActive: true,
          startDate: true,
          endDate: true,
        },
      });
      return { academicYears: rows };
    });
  }

  // ---- helpers -----------------------------------------------------------

  /**
   * A non-admin has no school-wide read, so these tools resolve the school the
   * same way the services do and refuse the same way.
   */
  private schoolOf(actor: Actor): string {
    if (actor.role === Role.SUPER_ADMIN) {
      throw new Error('A super admin must ask within one school.');
    }
    if (!actor.schoolId) throw new Error('No school context.');
    return actor.schoolId;
  }

  /** Name lookup, scoped to the caller's school. */
  private async findStudent(actor: Actor, name: string) {
    const schoolId = this.schoolOf(actor);
    const matches = await this.prisma.studentProfile.findMany({
      where: { schoolId, fullName: { contains: name, mode: 'insensitive' } },
      take: 5,
      select: { id: true, fullName: true },
    });
    if (!matches.length) return { error: `No student matching "${name}".` };
    if (matches.length > 1) {
      return {
        error: `Several students match "${name}": ${matches
          .map((m) => m.fullName)
          .join(', ')}. Ask again with the full name.`,
      };
    }
    return matches[0];
  }

  /**
   * A failed lookup must never become a wrong answer: a refusal (the asker's own
   * API would say no) and a genuine error both return `{ error }`, which the
   * model is instructed to relay rather than work around.
   */
  private async attempt<T>(
    label: string,
    run: () => Promise<T>,
  ): Promise<T | { error: string }> {
    try {
      return await run();
    } catch (e) {
      const message = (e as Error).message;
      this.logger.warn(`chatbot tool "${label}" failed: ${message}`);
      return {
        error: /forbidden|not allowed|denied|no school/i.test(message)
          ? 'You do not have access to that.'
          : 'That information could not be read just now.',
      };
    }
  }
}

/**
 * An attendance tally counts MARKS, not people — one student marked on five days
 * is five. The service's `total`/`present` names read as a headcount, so they are
 * renamed at this boundary rather than in `tally()`, which the dashboard and the
 * REST responses also consume.
 */
const marksOf = (t: {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  presentRate: number;
}) => ({
  marksTotal: t.total,
  marksPresent: t.present,
  marksAbsent: t.absent,
  marksLate: t.late,
  marksExcused: t.excused,
  presentRate: t.presentRate,
});

const clock = (min?: number | null) =>
  min === undefined || min === null
    ? null
    : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
