import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/services/cache.service';
import { invalidateSchoolStats } from '../common/cache/stats-cache';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { AuditLogService } from '../audit/audit.service';
import {
  NOTIFICATION_CREATE,
  NotificationCreateEvent,
} from '../common/events/notification.events';
import {
  parentUserIds,
  studentUserIds,
} from '../common/notifications/recipients';
import {
  examCoreSelect,
  ExamAccessService,
  ExamCore,
  HISTORY_ENROLLMENT,
} from './exam-access.service';
import { ExamSettingsService } from './exam-settings.service';
import { canEnterMarks, canFinalize, canReopen } from './exam-status';
import {
  aggregateBySession,
  assignPositions,
  GradeBandInput,
  StudentOutcome,
  studentOutcome,
  summarizeClass,
  summarizeSubjects,
  TermExamInput,
  termOutcome,
  termSubjectColumns,
} from './result-calculator';
import { cleanText, schoolHeaderSelect } from './exam-mappers';
import { SaveMarksDto, SaveRemarksDto } from './dto/results.dto';

type Db = Prisma.TransactionClient;

const sheetExamSelect = {
  ...examCoreSelect,
  gradingSchemeId: true,
  publishedAt: true,
  finalizedAt: true,
  academicYear: {
    select: { id: true, name: true, startDate: true, endDate: true },
  },
  term: { select: { id: true, name: true, startDate: true, endDate: true } },
  subjects: {
    orderBy: [{ heldAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      heldAt: true,
      maxScore: true,
      passingMarks: true,
      createdByTeacherId: true,
      sectionSubject: {
        select: {
          teacherId: true,
          teacher: { select: { id: true, fullName: true } },
          subject: { select: { id: true, name: true } },
        },
      },
    },
  },
} satisfies Prisma.ExaminationSelect;

export type SchoolHeaderRow = Prisma.SchoolGetPayload<{
  select: typeof schoolHeaderSelect;
}>;

const cardExamSelect = {
  id: true,
  sectionId: true,
  title: true,
  className: true,
  sectionName: true,
  resultStatus: true,
  publishedAt: true,
  gradingSchemeId: true,
  academicYear: { select: { id: true, name: true } },
  term: { select: { id: true, name: true } },
  subjects: {
    // `id` breaks ties so column order never depends on how the database returns rows.
    orderBy: [{ heldAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      maxScore: true,
      passingMarks: true,
      sectionSubject: {
        select: { subject: { select: { id: true, name: true } } },
      },
    },
  },
} satisfies Prisma.ExaminationSelect;

/** One finalized examination result as students, parents and the principal list it. */
export interface FinalizedResultRow {
  examination: {
    id: string;
    title: string;
    className: string;
    sectionName: string;
    academicYear: { id: string; name: string };
    term: { id: string; name: string } | null;
    finalizedAt: Date | null;
  };
  totalObtained: number | null;
  totalMax: number | null;
  percentage: number | null;
  grade: string | null;
  passed: boolean | null;
  position: number | null;
  finalizedAt: Date | null;
}

const summaryRow = (r: FinalizedResultRow) => ({
  academicYear: r.examination.academicYear,
  finalizedAt: r.finalizedAt,
  totalObtained: r.totalObtained,
  totalMax: r.totalMax,
  percentage: r.percentage,
});

/**
 * Sections whose unfinished examinations a student is expected to sit this session: their
 * ACTIVE placement, or the one they completed when they hold no active placement.
 */
function openSectionsOf(
  placements: { sectionId: string; status: string }[],
): Set<string> {
  const active = placements.filter((p) => p.status === 'ACTIVE');
  return new Set((active.length ? active : placements).map((p) => p.sectionId));
}

export interface CardStudent {
  id: string;
  fullName: string;
  rollNo: string | null;
  admissionNo: string | null;
}

export interface CardPlacement {
  className: string;
  sectionName: string;
  academicYear: { id: string; name: string };
}

/** Everything any number of result cards need, fetched once. */
export interface CardData {
  exams: Prisma.ExaminationGetPayload<{ select: typeof cardExamSelect }>[];
  marks: Map<
    string,
    { score: number | null; isAbsent: boolean; grade: string | null }
  >;
  snapshots: Map<
    string,
    {
      totalObtained: number | null;
      totalMax: number | null;
      percentage: number | null;
      grade: string | null;
      passed: boolean | null;
      position: number | null;
      finalizedAt: Date | null;
      classTeacherRemarks: string | null;
      principalRemarks: string | null;
    }
  >;
  bandsByScheme: Map<string | null, GradeBandInput[]>;
}

type SheetExam = Prisma.ExaminationGetPayload<{
  select: typeof sheetExamSelect;
}>;

export interface SheetStudent {
  id: string;
  fullName: string;
  rollNo: string | null;
  admissionNo: string | null;
}

export interface Sheet {
  exam: SheetExam;
  bands: GradeBandInput[];
  students: SheetStudent[];
  marks: Map<
    string,
    {
      score: number | null;
      isAbsent: boolean;
      remarks: string | null;
      grade: string | null;
    }
  >;
  outcomes: Map<string, StudentOutcome>;
  positions: Map<string, number>;
  stored: Map<string, Prisma.ExaminationResultGetPayload<object>>;
}

const markKey = (examId: string, studentId: string) => `${examId}:${studentId}`;

@Injectable()
export class ExamResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly access: ExamAccessService,
    private readonly settings: ExamSettingsService,
    private readonly audit: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async marksRoster(examinationId: string, subjectId: string, actor: Actor) {
    const core = await this.access.loadCore(examinationId);
    const teacherId = await this.access.assertStaffCanView(actor, core);
    const subject = await this.loadSubject(examinationId, subjectId);
    const mayEdit = this.mayEnterMarks(actor, core, subject, teacherId);
    if (actor.role === Role.TEACHER && !mayEdit) {
      throw new ForbiddenException('You do not teach this subject');
    }
    const [sheet, marked] = await Promise.all([
      this.buildSheet(this.prisma, examinationId),
      this.prisma.examResult.count({ where: { examId: subject.id } }),
    ]);
    return {
      examination: {
        id: core.id,
        title: core.title,
        className: core.className,
        sectionName: core.sectionName,
        status: core.status,
        resultStatus: core.resultStatus,
      },
      subject: {
        id: subject.id,
        label: subject.sectionSubject.subject.name,
        maxScore: subject.maxScore,
        passingMarks: subject.passingMarks,
        heldAt: subject.heldAt,
        totalsLocked: marked > 0,
      },
      editable: mayEdit && canEnterMarks(core.status, core.resultStatus),
      rows: sheet.students.map((student) => {
        const m = sheet.marks.get(markKey(subject.id, student.id));
        return {
          student,
          score: m?.score ?? null,
          isAbsent: m?.isAbsent ?? false,
          remarks: m?.remarks ?? null,
        };
      }),
    };
  }

  async saveMarks(
    examinationId: string,
    subjectId: string,
    dto: SaveMarksDto,
    actor: Actor,
  ) {
    const core = await this.access.loadCore(examinationId);
    this.access.assertSameSchool(actor, core.schoolId);
    const teacherId =
      actor.role === Role.TEACHER ? await this.access.teacherId(actor) : null;
    const subject = await this.loadSubject(examinationId, subjectId);
    if (!this.mayEnterMarks(actor, core, subject, teacherId)) {
      throw new ForbiddenException('You do not teach this subject');
    }
    if (!canEnterMarks(core.status, core.resultStatus)) {
      throw new ConflictException(
        core.resultStatus === 'FINALIZED'
          ? 'Results are finalized. Reopen them before changing marks.'
          : 'Marks can be entered once the examination is published.',
      );
    }
    const maxScore = dto.maxScore ?? subject.maxScore;
    const passingMarks =
      dto.passingMarks !== undefined ? dto.passingMarks : subject.passingMarks;
    if (maxScore == null) {
      throw new ConflictException('Set the total marks for this subject first');
    }
    if (passingMarks != null && passingMarks > maxScore) {
      throw new BadRequestException(
        'Passing marks cannot be more than total marks',
      );
    }
    const totalsChanged =
      maxScore !== subject.maxScore || passingMarks !== subject.passingMarks;
    const ids = dto.entries.map((e) => e.studentId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each student can appear only once');
    }
    for (const e of dto.entries) {
      if (!e.isAbsent && e.score != null && e.score > maxScore) {
        throw new BadRequestException(
          `Marks cannot be more than the total of ${maxScore}`,
        );
      }
    }

    const now = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        // Locks the examination row, so a concurrent finalize can't slip between check and write.
        const lock = await tx.examination.updateMany({
          where: {
            id: examinationId,
            status: 'PUBLISHED',
            resultStatus: { not: 'FINALIZED' },
          },
          data: { updatedAt: now },
        });
        if (!lock.count) {
          throw new ConflictException(
            'Results were finalized while you were editing. Reopen them to change marks.',
          );
        }
        const examIds = (
          await tx.exam.findMany({
            where: { examinationId },
            select: { id: true },
          })
        ).map((e) => e.id);
        const roster = new Set(
          await this.access.rosterStudentIds(tx, core, examIds),
        );
        if (ids.some((id) => !roster.has(id))) {
          throw new BadRequestException(
            'A student in this list is not on the class roster',
          );
        }
        if (totalsChanged) {
          // Rescaling under entered marks would silently change every grade already given.
          if (await tx.examResult.count({ where: { examId: subject.id } })) {
            throw new ConflictException(
              "Total marks can't change once marks have been entered",
            );
          }
          await tx.exam.update({
            where: { id: subject.id },
            data: { maxScore, passingMarks },
          });
        }
        for (const e of dto.entries) {
          const isAbsent = !!e.isAbsent;
          const score = isAbsent ? null : (e.score ?? null);
          await tx.examResult.upsert({
            where: {
              examId_studentId: { examId: subject.id, studentId: e.studentId },
            },
            create: {
              examId: subject.id,
              studentId: e.studentId,
              score,
              isAbsent,
              remarks: cleanText(e.remarks),
              enteredByUserId: actor.userId,
              markedAt: score != null || isAbsent ? now : null,
            },
            update: {
              score,
              isAbsent,
              ...(e.remarks !== undefined
                ? { remarks: cleanText(e.remarks) }
                : {}),
              enteredByUserId: actor.userId,
              markedAt: now,
            },
          });
        }
        await tx.examination.updateMany({
          where: { id: examinationId, resultStatus: 'NOT_STARTED' },
          data: { resultStatus: 'IN_PROGRESS' },
        });
        await tx.examinationEvent.create({
          data: {
            examinationId,
            actorUserId: actor.userId,
            type: 'MARKS_SAVED',
            details: {
              subject: subject.sectionSubject.subject.name,
              rows: dto.entries.length,
            },
          },
        });
      },
      { timeout: 30_000 },
    );

    void this.audit.record(actor.userId, 'EXAM_MARKS_SAVE', {
      schoolId: core.schoolId,
      entityType: 'Examination',
      entityId: examinationId,
      metadata: { subjectId, rows: dto.entries.length },
    });
    return this.marksRoster(examinationId, subjectId, actor);
  }

  async results(examinationId: string, actor: Actor) {
    const core = await this.access.loadCore(examinationId);
    const teacherId = await this.access.assertStaffCanView(actor, core);
    const sheet = await this.buildSheet(this.prisma, examinationId);
    const rows = sheet.students.map((st) => this.rowFor(sheet, st));
    const subjectStates = rows.flatMap((r) => r.subjects.map((s) => s.state));
    const classTeacher = teacherId
      ? await this.access.isClassTeacher(teacherId, core.sectionId)
      : false;
    const isAdmin = actor.role === Role.SCHOOL_ADMIN;
    const open =
      core.status === 'PUBLISHED' && core.resultStatus !== 'FINALIZED';
    const incompleteStudents = rows.filter((r) => !r.complete).length;
    // A subject teacher reads their own columns only: class-wide totals, positions
    // and remarks belong to the class teacher and the principal.
    const own =
      actor.role === Role.TEACHER && !classTeacher
        ? new Set(
            sheet.exam.subjects
              .filter(
                (s) =>
                  s.sectionSubject.teacherId === teacherId ||
                  s.createdByTeacherId === teacherId,
              )
              .map((s) => s.id),
          )
        : null;
    const visibleSubjects = own
      ? sheet.exam.subjects.filter((s) => own.has(s.id))
      : sheet.exam.subjects;

    return {
      school: await this.schoolHeader(core.schoolId),
      generatedAt: new Date(),
      examination: this.header(sheet.exam),
      gradingBands: sheet.bands,
      subjects: visibleSubjects.map((s) => ({
        id: s.id,
        label: s.sectionSubject.subject.name,
        maxScore: s.maxScore,
        passingMarks: s.passingMarks,
        heldAt: s.heldAt,
      })),
      rows: own ? rows.map((r) => this.narrowRow(r, own)) : rows,
      issues: {
        missingMarks: subjectStates.filter((s) => s === 'MISSING').length,
        invalidMarks: subjectStates.filter((s) => s === 'INVALID').length,
        incompleteStudents,
        failedStudents: rows.filter((r) => r.passed === false).length,
      },
      summary: summarizeClass([...sheet.outcomes.values()]),
      permissions: {
        canFinalize: isAdmin && canFinalize(core.status, core.resultStatus),
        readyToFinalize: incompleteStudents === 0 && rows.length > 0,
        canReopen: isAdmin && canReopen(core.resultStatus),
        canEditPrincipalRemarks: isAdmin && open,
        canEditClassTeacherRemarks: (isAdmin || classTeacher) && open,
      },
    };
  }

  /**
   * One subject's result register, ordered by roll number. A teacher reaches it only for a
   * published examination and only for a subject that is theirs; the principal sees any of them.
   */
  async subjectResult(examinationId: string, subjectId: string, actor: Actor) {
    const core = await this.access.loadCore(examinationId);
    const teacherId = await this.access.assertStaffCanView(actor, core);
    const subject = await this.loadSubject(examinationId, subjectId);
    if (actor.role === Role.TEACHER) {
      if (core.status !== 'PUBLISHED') {
        throw new ForbiddenException(
          'Results open once the examination is published',
        );
      }
      const mine =
        subject.sectionSubject.teacherId === teacherId ||
        subject.createdByTeacherId === teacherId ||
        core.createdByTeacherId === teacherId;
      if (!mine) throw new ForbiddenException('You do not teach this subject');
    }

    const sheet = await this.buildSheet(this.prisma, examinationId);
    const index = sheet.exam.subjects.findIndex((s) => s.id === subjectId);
    const column = sheet.exam.subjects[index];
    const rows = sheet.students.map((student) => {
      const out = sheet.outcomes.get(student.id)!.subjects[index];
      const mark = sheet.marks.get(markKey(subjectId, student.id));
      const frozen =
        sheet.exam.resultStatus === 'FINALIZED' ? mark?.grade : null;
      return {
        student,
        obtained: out.obtained,
        isAbsent: mark?.isAbsent ?? false,
        percentage: out.percentage,
        grade: frozen ?? out.grade,
        passed: out.passed,
        state: out.state,
        remarks: mark?.remarks ?? null,
      };
    });
    const scores = rows
      .filter((r) => !r.isAbsent && r.obtained != null)
      .map((r) => r.obtained as number);
    const total = scores.reduce((sum, n) => sum + n, 0);

    return {
      school: await this.schoolHeader(core.schoolId),
      examination: this.header(sheet.exam),
      subject: {
        id: column.id,
        label: column.sectionSubject.subject.name,
        maxScore: column.maxScore,
        passingMarks: column.passingMarks,
        heldAt: column.heldAt,
        teacherName: column.sectionSubject.teacher?.fullName ?? null,
      },
      gradingBands: sheet.bands,
      rows,
      summary: {
        students: rows.length,
        entered: rows.filter((r) => r.obtained != null || r.isAbsent).length,
        missing: rows.filter((r) => r.state === 'MISSING').length,
        absent: rows.filter((r) => r.isAbsent).length,
        passed: rows.filter((r) => r.passed === true).length,
        failed: rows.filter((r) => r.passed === false).length,
        highest: scores.length ? Math.max(...scores) : null,
        lowest: scores.length ? Math.min(...scores) : null,
        average: scores.length
          ? Math.round((total / scores.length) * 10) / 10
          : null,
      },
      generatedAt: new Date(),
    };
  }

  async saveRemarks(examinationId: string, dto: SaveRemarksDto, actor: Actor) {
    const core = await this.access.loadCore(examinationId);
    this.access.assertSameSchool(actor, core.schoolId);
    if (core.status !== 'PUBLISHED') {
      throw new ConflictException(
        'Remarks can be added after the examination is published',
      );
    }
    if (core.resultStatus === 'FINALIZED') {
      throw new ConflictException(
        'Results are finalized. Reopen them to change remarks.',
      );
    }
    if (actor.role === Role.TEACHER) {
      const teacherId = await this.access.teacherId(actor);
      if (!(await this.access.isClassTeacher(teacherId, core.sectionId))) {
        throw new ForbiddenException(
          'Only the class teacher can add class teacher remarks',
        );
      }
      if (dto.entries.some((e) => e.principalRemarks !== undefined)) {
        throw new ForbiddenException(
          'Only the principal can add principal remarks',
        );
      }
    }

    await this.prisma.$transaction(
      async (tx) => {
        const lock = await tx.examination.updateMany({
          where: { id: examinationId, resultStatus: { not: 'FINALIZED' } },
          data: { updatedAt: new Date() },
        });
        if (!lock.count)
          throw new ConflictException(
            'Results were finalized. Reopen them to change remarks.',
          );
        const examIds = (
          await tx.exam.findMany({
            where: { examinationId },
            select: { id: true },
          })
        ).map((e) => e.id);
        const roster = new Set(
          await this.access.rosterStudentIds(tx, core, examIds),
        );
        for (const e of dto.entries) {
          if (!roster.has(e.studentId)) {
            throw new BadRequestException(
              'A student in this list is not on the class roster',
            );
          }
          const data = {
            ...(e.classTeacherRemarks !== undefined
              ? { classTeacherRemarks: cleanText(e.classTeacherRemarks) }
              : {}),
            ...(e.principalRemarks !== undefined
              ? { principalRemarks: cleanText(e.principalRemarks) }
              : {}),
          };
          await tx.examinationResult.upsert({
            where: {
              examinationId_studentId: {
                examinationId,
                studentId: e.studentId,
              },
            },
            create: { examinationId, studentId: e.studentId, ...data },
            update: data,
          });
        }
        await tx.examinationEvent.create({
          data: {
            examinationId,
            actorUserId: actor.userId,
            type: 'REMARKS_UPDATED',
            details: { rows: dto.entries.length },
          },
        });
      },
      { timeout: 30_000 },
    );

    void this.audit.record(actor.userId, 'EXAM_REMARKS_SAVE', {
      schoolId: core.schoolId,
      entityType: 'Examination',
      entityId: examinationId,
      metadata: { rows: dto.entries.length },
    });
    return { saved: dto.entries.length };
  }

  /** All-or-nothing: grades, per-student snapshots and the lock commit together or not at all. */
  async finalize(examinationId: string, actor: Actor) {
    const core = await this.access.loadCore(examinationId);
    this.access.assertSameSchool(actor, core.schoolId);
    if (!canFinalize(core.status, core.resultStatus)) {
      throw new ConflictException(
        core.resultStatus === 'FINALIZED'
          ? 'These results are already finalized'
          : 'Results can be finalized after the examination is published',
      );
    }
    await this.settings.ensureDefaultScheme(core.schoolId);

    const now = new Date();
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const lock = await tx.examination.updateMany({
          where: {
            id: examinationId,
            status: 'PUBLISHED',
            resultStatus: { not: 'FINALIZED' },
          },
          data: { updatedAt: now },
        });
        if (!lock.count)
          throw new ConflictException('These results are already finalized');

        const sheet = await this.buildSheet(tx, examinationId);
        if (!sheet.students.length) {
          throw new ConflictException(
            'There are no students on this class roster to finalize',
          );
        }
        const incomplete = sheet.students.filter(
          (st) => !sheet.outcomes.get(st.id)!.complete,
        );
        if (incomplete.length) {
          throw new ConflictException({
            statusCode: 409,
            message: `${incomplete.length} student${incomplete.length === 1 ? ' has' : 's have'} missing or invalid marks`,
            incompleteStudents: incomplete.slice(0, 25).map((s) => s.fullName),
          });
        }

        for (const [i, subject] of sheet.exam.subjects.entries()) {
          const byGrade = new Map<string | null, string[]>();
          for (const st of sheet.students) {
            const grade = sheet.outcomes.get(st.id)!.subjects[i].grade;
            byGrade.set(grade, [...(byGrade.get(grade) ?? []), st.id]);
          }
          for (const [grade, studentIds] of byGrade) {
            await tx.examResult.updateMany({
              where: { examId: subject.id, studentId: { in: studentIds } },
              data: { grade },
            });
          }
        }

        let passed = 0;
        for (const st of sheet.students) {
          const o = sheet.outcomes.get(st.id)!;
          if (o.passed) passed += 1;
          const snapshot = {
            totalObtained: o.totalObtained,
            totalMax: o.totalMax,
            percentage: o.percentage,
            grade: o.grade,
            passed: o.passed,
            position: sheet.positions.get(st.id) ?? null,
            studentName: st.fullName,
            rollNo: st.rollNo,
            finalizedAt: now,
          };
          await tx.examinationResult.upsert({
            where: {
              examinationId_studentId: { examinationId, studentId: st.id },
            },
            create: { examinationId, studentId: st.id, ...snapshot },
            update: snapshot,
          });
        }

        await tx.examination.update({
          where: { id: examinationId },
          data: {
            resultStatus: 'FINALIZED',
            finalizedAt: now,
            finalizedByUserId: actor.userId,
          },
        });
        const failed = sheet.students.length - passed;
        await tx.examinationEvent.create({
          data: {
            examinationId,
            actorUserId: actor.userId,
            type: 'RESULTS_FINALIZED',
            details: { students: sheet.students.length, passed, failed },
          },
        });
        return { studentIds: sheet.students.map((s) => s.id), passed, failed };
      },
      { timeout: 60_000 },
    );

    await invalidateSchoolStats(this.cache, core.schoolId);
    const recipients = [
      ...new Set([
        ...(await studentUserIds(this.prisma, outcome.studentIds)),
        ...(await parentUserIds(this.prisma, outcome.studentIds)),
      ]),
    ];
    if (recipients.length) {
      this.eventEmitter.emit(NOTIFICATION_CREATE, {
        userIds: recipients,
        type: 'EXAM_RESULT',
        title: `Results available: ${core.title}`,
        body: `Results for "${core.title}" (${core.className} ${core.sectionName}) are now available.`,
        link: `/exams/${examinationId}`,
        entityType: 'Examination',
        entityId: examinationId,
        notifyPreferenceKey: 'notifyGrades',
      } as NotificationCreateEvent);
    }
    void this.audit.record(actor.userId, 'EXAM_RESULTS_FINALIZE', {
      schoolId: core.schoolId,
      entityType: 'Examination',
      entityId: examinationId,
      metadata: {
        students: outcome.studentIds.length,
        passed: outcome.passed,
        failed: outcome.failed,
      },
    });
    return this.results(examinationId, actor);
  }

  async reopen(examinationId: string, reason: string, actor: Actor) {
    const trimmed = reason?.trim();
    if (!trimmed)
      throw new BadRequestException(
        'Give a reason for reopening these results',
      );
    const core = await this.access.loadCore(examinationId);
    this.access.assertSameSchool(actor, core.schoolId);
    if (!canReopen(core.resultStatus)) {
      throw new ConflictException('Only finalized results can be reopened');
    }
    await this.prisma.$transaction(async (tx) => {
      const unlocked = await tx.examination.updateMany({
        where: { id: examinationId, resultStatus: 'FINALIZED' },
        data: {
          resultStatus: 'IN_PROGRESS',
          finalizedAt: null,
          finalizedByUserId: null,
        },
      });
      if (!unlocked.count)
        throw new ConflictException('These results were already reopened');
      await tx.examinationResult.updateMany({
        where: { examinationId },
        data: { finalizedAt: null },
      });
      await tx.examinationEvent.create({
        data: {
          examinationId,
          actorUserId: actor.userId,
          type: 'RESULTS_REOPENED',
          reason: trimmed,
        },
      });
    });
    await invalidateSchoolStats(this.cache, core.schoolId);
    void this.audit.record(actor.userId, 'EXAM_RESULTS_REOPEN', {
      schoolId: core.schoolId,
      entityType: 'Examination',
      entityId: examinationId,
    });
    return this.results(examinationId, actor);
  }

  async summary(examinationId: string, actor: Actor) {
    const core = await this.access.loadCore(examinationId);
    await this.access.assertStaffCanView(actor, core);
    const sheet = await this.buildSheet(this.prisma, examinationId);
    const rows = sheet.students.map((st) => this.rowFor(sheet, st));
    const outcomes = [...sheet.outcomes.values()];
    return {
      examination: this.header(sheet.exam),
      summary: summarizeClass(outcomes),
      subjects: summarizeSubjects(outcomes),
      gradeDistribution: sheet.bands.map((b) => ({
        label: b.label,
        isPassing: b.isPassing,
        count: rows.filter((r) => r.complete && r.grade === b.label).length,
      })),
    };
  }

  async reportCards(examinationId: string, actor: Actor, studentId?: string) {
    const core = await this.access.loadCore(examinationId);
    let only: string | null = null;
    if (actor.role === Role.STUDENT || actor.role === Role.PARENT) {
      only = await this.access.assertAudienceCanView(actor, core, studentId);
      if (core.resultStatus !== 'FINALIZED') {
        throw new ForbiddenException(
          'Results for this examination are not available yet',
        );
      }
    } else {
      const teacherId = await this.access.assertStaffCanView(actor, core);
      // A cross-subject card is the class teacher's and the principal's; a subject
      // teacher reads their own register instead of every colleague's marks.
      const classTeacher = teacherId
        ? await this.access.isClassTeacher(teacherId, core.sectionId)
        : true;
      if (actor.role === Role.TEACHER && !classTeacher) {
        throw new ForbiddenException(
          'Only the class teacher can open report cards for this section',
        );
      }
      only = studentId ?? null;
    }

    const sheet = await this.buildSheet(this.prisma, examinationId);
    const students = only
      ? sheet.students.filter((s) => s.id === only)
      : sheet.students;
    if (only && !students.length)
      throw new NotFoundException('Student is not on this result sheet');

    const exam = sheet.exam;
    const start = exam.term?.startDate ?? exam.academicYear.startDate;
    const end = exam.term?.endDate ?? exam.academicYear.endDate;
    const [school, attendance] = await Promise.all([
      this.schoolHeader(core.schoolId),
      this.prisma.attendance.groupBy({
        by: ['studentId', 'status'],
        where: {
          studentId: { in: students.map((s) => s.id) },
          sectionSubject: { sectionId: core.sectionId },
          date: { gte: start, lte: end },
        },
        _count: { _all: true },
      }),
    ]);
    const attendanceBy = new Map<string, Record<string, number>>();
    for (const g of attendance) {
      const row = attendanceBy.get(g.studentId) ?? {};
      row[g.status] = g._count._all;
      attendanceBy.set(g.studentId, row);
    }

    return {
      school,
      examination: {
        ...this.header(exam),
        provisional: core.resultStatus !== 'FINALIZED',
      },
      gradingBands: sheet.bands,
      generatedAt: new Date(),
      cards: students.map((student) => {
        const counts = attendanceBy.get(student.id);
        const total = counts
          ? Object.values(counts).reduce((a, b) => a + b, 0)
          : 0;
        const attended = (counts?.PRESENT ?? 0) + (counts?.LATE ?? 0);
        return {
          ...this.rowFor(sheet, student),
          classSize: sheet.students.length,
          attendance: total
            ? {
                present: counts?.PRESENT ?? 0,
                absent: counts?.ABSENT ?? 0,
                late: counts?.LATE ?? 0,
                excused: counts?.EXCUSED ?? 0,
                total,
                rate: Math.round((attended / total) * 1000) / 10,
              }
            : null,
        };
      }),
    };
  }

  /** A student's finalized results across every session they were placed in (history survives promotion). */
  async myResults(actor: Actor, studentId?: string) {
    const sid = await this.access.resolveAudienceStudent(actor, studentId);
    return this.finalizedResultsFor(sid);
  }

  /** The principal's view of one student's finalized results, e.g. on a parent's profile page. */
  async resultsForStudent(actor: Actor, studentId: string) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { schoolId: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    this.access.assertSameSchool(actor, student.schoolId);
    return this.finalizedResultsFor(studentId);
  }

  /** Session-by-session totals of a student's own finalized results, for dashboards. */
  async myResultsSummary(actor: Actor, studentId?: string) {
    const sid = await this.access.resolveAudienceStudent(actor, studentId);
    return {
      sessions: aggregateBySession(
        (await this.finalizedResultsFor(sid)).map(summaryRow),
      ),
    };
  }

  /** The principal's session totals for one student, from the same engine. */
  async resultsSummaryForStudent(actor: Actor, studentId: string) {
    return {
      sessions: aggregateBySession(
        (await this.resultsForStudent(actor, studentId)).map(summaryRow),
      ),
    };
  }

  /**
   * One student's result card for a session: every published examination they actually sat,
   * subject by subject, with the overall total. Exams holding no marks of theirs are left out.
   */
  async studentResultCard(
    actor: Actor,
    studentId: string,
    query: { academicYearId?: string; termId?: string },
  ) {
    this.assertPrincipal(actor);
    // Both are demanded: a card spanning sessions or terms is not a term's result.
    const { academicYearId, termId } = this.requireTermFilter(query);
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        fullName: true,
        rollNo: true,
        admissionNo: true,
        schoolId: true,
      },
    });
    if (!student) throw new NotFoundException('Student not found');
    this.access.assertSameSchool(actor, student.schoolId);
    await this.assertTermInSession(student.schoolId, academicYearId, termId);

    const placements = await this.prisma.enrollment.findMany({
      where: {
        studentId,
        status: { in: HISTORY_ENROLLMENT },
        academicYearId,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        sectionId: true,
        academicYearId: true,
        status: true,
        section: {
          select: { name: true, classGrade: { select: { name: true } } },
        },
        academicYear: { select: { id: true, name: true } },
      },
    });
    const school = await this.schoolHeader(student.schoolId);
    const placement = placements[0]
      ? {
          className: placements[0].section.classGrade.name,
          sectionName: placements[0].section.name,
          academicYear: placements[0].academicYear,
        }
      : null;
    if (!placements.length) {
      return this.composeCard(school, student, placement, this.noCardData());
    }
    const data = await this.loadCardData(student.schoolId, [student.id], {
      OR: placements.map((p) => ({
        sectionId: p.sectionId,
        academicYearId: p.academicYearId,
      })),
      termId,
    });
    return this.composeCard(
      school,
      student,
      placement,
      data,
      openSectionsOf(placements),
    );
  }

  /** Every student's result card for one section and session, printed a page per student. */
  async sectionResultCards(
    actor: Actor,
    sectionId: string,
    query: { academicYearId?: string; termId?: string },
  ) {
    this.assertPrincipal(actor);
    const { academicYearId, termId } = this.requireTermFilter(query);
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      select: {
        id: true,
        name: true,
        schoolId: true,
        classGrade: { select: { name: true } },
      },
    });
    if (!section) throw new NotFoundException('Section not found');
    this.access.assertSameSchool(actor, section.schoolId);
    const year = await this.prisma.academicYear.findFirst({
      where: { id: academicYearId, schoolId: section.schoolId },
      select: { id: true, name: true },
    });
    if (!year) throw new NotFoundException('Academic session not found');
    await this.assertTermInSession(section.schoolId, year.id, termId);

    // The section's roster for that session only, so sessions never mix.
    const roster = await this.prisma.enrollment.findMany({
      where: {
        sectionId,
        academicYearId: year.id,
        status: { in: HISTORY_ENROLLMENT },
      },
      select: {
        student: {
          select: { id: true, fullName: true, rollNo: true, admissionNo: true },
        },
      },
    });
    const students = roster
      .map((r) => r.student)
      .sort(
        (a, b) =>
          (a.rollNo ?? '\uffff').localeCompare(
            b.rollNo ?? '\uffff',
            undefined,
            {
              numeric: true,
            },
          ) || a.fullName.localeCompare(b.fullName),
      );
    const school = await this.schoolHeader(section.schoolId);
    const placement = {
      className: section.classGrade.name,
      sectionName: section.name,
      academicYear: year,
    };
    // Each student's placements this session, so one who moved sections isn't held to this
    // section's unfinished papers.
    const placementsOf = new Map<
      string,
      { sectionId: string; status: string }[]
    >();
    for (const p of await this.prisma.enrollment.findMany({
      where: {
        studentId: { in: students.map((s) => s.id) },
        academicYearId: year.id,
        status: { in: HISTORY_ENROLLMENT },
      },
      select: { studentId: true, sectionId: true, status: true },
    })) {
      placementsOf.set(p.studentId, [
        ...(placementsOf.get(p.studentId) ?? []),
        p,
      ]);
    }
    const data = await this.loadCardData(
      section.schoolId,
      students.map((s) => s.id),
      { sectionId, academicYearId: year.id, termId },
    );
    return {
      school,
      placement,
      generatedAt: new Date(),
      // Header columns come from the server too, so the sheet only lays values out.
      subjects: termSubjectColumns(
        data.exams.map((e) => ({
          subjects: e.subjects.map((s) => ({
            key: s.sectionSubject.subject.id,
            label: s.sectionSubject.subject.name,
            maxScore: s.maxScore,
          })),
        })),
      ),
      cards: students.map((s) =>
        this.composeCard(
          school,
          s,
          placement,
          data,
          openSectionsOf(placementsOf.get(s.id) ?? []),
        ),
      ),
    };
  }

  /**
   * A principal names the session AND the term before any result is extracted:
   * "all terms" is not on offer and nothing is ever chosen on their behalf.
   */
  private requireTermFilter(query: {
    academicYearId?: string;
    termId?: string;
  }): { academicYearId: string; termId: string } {
    if (!query.academicYearId) {
      throw new BadRequestException('Choose the academic session');
    }
    if (!query.termId) {
      throw new BadRequestException('Please select a term.');
    }
    return { academicYearId: query.academicYearId, termId: query.termId };
  }

  /** The term has to be this school's, and belong to the session being extracted. */
  private async assertTermInSession(
    schoolId: string,
    academicYearId: string,
    termId: string,
  ): Promise<void> {
    const term = await this.prisma.academicTerm.findFirst({
      where: { id: termId, schoolId, academicYearId },
      select: { id: true },
    });
    if (!term) {
      throw new BadRequestException(
        'Choose a term from the selected academic session',
      );
    }
  }

  private assertPrincipal(actor: Actor) {
    if (actor.role !== Role.SCHOOL_ADMIN && actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Not allowed');
    }
  }

  private noCardData(): CardData {
    return {
      exams: [],
      marks: new Map(),
      snapshots: new Map(),
      bandsByScheme: new Map(),
    };
  }

  /**
   * Batched inputs for any number of cards: the published exams matching `where` that these
   * students hold marks in, all their marks and snapshots, and one band set per scheme.
   */
  private async loadCardData(
    schoolId: string,
    studentIds: string[],
    where: Prisma.ExaminationWhereInput,
  ): Promise<CardData> {
    if (!studentIds.length) return this.noCardData();
    const exams = await this.prisma.examination.findMany({
      where: {
        AND: [
          where,
          { schoolId, status: 'PUBLISHED' },
          {
            OR: [
              {
                subjects: {
                  some: {
                    results: { some: { studentId: { in: studentIds } } },
                  },
                },
              },
              // Unfinished examinations already being marked count too, so a student skipped
              // at mark entry keeps the paper on their card — as missing, never as zero.
              {
                resultStatus: { not: 'FINALIZED' },
                subjects: { some: { results: { some: {} } } },
              },
            ],
          },
        ],
      },
      orderBy: [{ publishedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: cardExamSelect,
    });
    const subjectIds = exams.flatMap((e) => e.subjects.map((s) => s.id));
    const [marks, snapshots] = subjectIds.length
      ? await Promise.all([
          this.prisma.examResult.findMany({
            where: {
              examId: { in: subjectIds },
              studentId: { in: studentIds },
            },
            select: {
              examId: true,
              studentId: true,
              score: true,
              isAbsent: true,
              grade: true,
            },
          }),
          this.prisma.examinationResult.findMany({
            where: {
              examinationId: { in: exams.map((e) => e.id) },
              studentId: { in: studentIds },
            },
            select: {
              examinationId: true,
              studentId: true,
              totalObtained: true,
              totalMax: true,
              percentage: true,
              grade: true,
              passed: true,
              position: true,
              finalizedAt: true,
              classTeacherRemarks: true,
              principalRemarks: true,
            },
          }),
        ])
      : [[], []];
    const bandsByScheme = new Map<string | null, GradeBandInput[]>();
    for (const schemeId of new Set([
      null,
      ...exams.map((e) => e.gradingSchemeId),
    ])) {
      bandsByScheme.set(
        schemeId,
        await this.settings.bandsFor(this.prisma, schoolId, schemeId),
      );
    }
    return {
      exams,
      marks: new Map(marks.map((m) => [markKey(m.examId, m.studentId), m])),
      snapshots: new Map(
        snapshots.map((s) => [`${s.examinationId}:${s.studentId}`, s]),
      ),
      bandsByScheme,
    };
  }

  /** One student's card from batched data, keeping only the exams they hold marks in. */
  private composeCard(
    school: SchoolHeaderRow,
    student: CardStudent,
    placement: CardPlacement | null,
    data: CardData,
    openSections: ReadonlySet<string> = new Set(),
  ) {
    const identity = {
      id: student.id,
      fullName: student.fullName,
      rollNo: student.rollNo,
      admissionNo: student.admissionNo,
    };
    // A finalized examination lists exactly who sat it. An unfinished one also belongs to every
    // student placed in its section, so an unmarked student reads as incomplete, not complete.
    const sat = data.exams.filter(
      (e) =>
        e.subjects.some((s) => data.marks.has(markKey(s.id, student.id))) ||
        (e.resultStatus !== 'FINALIZED' && openSections.has(e.sectionId)),
    );
    if (!sat.length) {
      return {
        school,
        student: identity,
        placement,
        exams: [] as never[],
        overall: null,
        gradingBands: [] as GradeBandInput[],
        provisional: false,
        generatedAt: new Date(),
      };
    }
    const defaultBands = data.bandsByScheme.get(null)!;
    const cards = sat.map((e) => {
      const bands = data.bandsByScheme.get(e.gradingSchemeId) ?? defaultBands;
      const mark = (subjectId: string) =>
        data.marks.get(markKey(subjectId, student.id));
      const outcome = studentOutcome(
        e.subjects.map((s) => ({
          examId: s.id,
          label: s.sectionSubject.subject.name,
          maxScore: s.maxScore,
          passingMarks: s.passingMarks,
          score: mark(s.id)?.score ?? null,
          isAbsent: mark(s.id)?.isAbsent ?? false,
        })),
        bands,
      );
      const stored = data.snapshots.get(`${e.id}:${student.id}`) ?? null;
      const frozen = stored?.finalizedAt ? stored : null;
      return {
        id: e.id,
        title: e.title,
        className: e.className,
        sectionName: e.sectionName,
        academicYear: e.academicYear,
        term: e.term,
        publishedAt: e.publishedAt,
        provisional: e.resultStatus !== 'FINALIZED',
        subjects: e.subjects.map((s, i) => {
          const out = outcome.subjects[i];
          const m = mark(s.id);
          return {
            key: s.sectionSubject.subject.id,
            label: out.label,
            maxScore: out.maxScore,
            passingMarks: s.passingMarks,
            obtained: out.obtained,
            isAbsent: m?.isAbsent ?? false,
            percentage: out.percentage,
            grade: frozen && m?.grade ? m.grade : out.grade,
            passed: out.passed,
            state: out.state,
          };
        }),
        totals: {
          totalObtained: frozen?.totalObtained ?? outcome.totalObtained,
          totalMax: frozen?.totalMax ?? outcome.totalMax,
          percentage: frozen ? frozen.percentage : outcome.percentage,
          grade: frozen ? frozen.grade : outcome.grade,
          passed: frozen ? frozen.passed : outcome.passed,
          position: frozen?.position ?? null,
        },
        remarks: {
          classTeacher: stored?.classTeacherRemarks ?? null,
          principal: stored?.principalRemarks ?? null,
        },
      };
    });

    // The term is graded by the scheme its examinations share; mixed schemes fall back to the
    // school default and are flagged, rather than silently grading with one of them.
    const schemeIds = new Set(sat.map((e) => e.gradingSchemeId));
    const mixedGradingSchemes = schemeIds.size > 1;
    const termBands = mixedGradingSchemes
      ? defaultBands
      : (data.bandsByScheme.get([...schemeIds][0]) ?? defaultBands);
    const term = termOutcome(
      cards.map(
        (c): TermExamInput => ({
          examId: c.id,
          // Finalized exams carry their frozen totals; a live one is complete once graded.
          complete: c.totals.percentage != null,
          totalObtained: c.totals.totalObtained ?? 0,
          totalMax: c.totals.totalMax ?? 0,
          passed: c.totals.passed,
          subjects: c.subjects.map((s) => ({
            key: s.key,
            label: s.label,
            obtained: s.obtained,
            maxScore: s.maxScore,
            state: s.state,
            grade: s.grade,
            passed: s.passed,
          })),
        }),
      ),
      termBands,
    );
    const last = cards[cards.length - 1];
    return {
      school,
      student: identity,
      placement: {
        className: last.className,
        sectionName: last.sectionName,
        academicYear: last.academicYear,
      },
      exams: cards,
      overall: { ...term, mixedGradingSchemes },
      gradingBands: termBands,
      provisional: cards.some((c) => c.provisional),
      generatedAt: new Date(),
    };
  }

  private async finalizedResultsFor(sid: string) {
    const placements = await this.prisma.enrollment.findMany({
      where: { studentId: sid, status: { in: HISTORY_ENROLLMENT } },
      select: { sectionId: true, academicYearId: true },
    });
    if (!placements.length) return [];
    const exams = await this.prisma.examination.findMany({
      where: {
        status: 'PUBLISHED',
        resultStatus: 'FINALIZED',
        OR: placements.map((p) => ({
          sectionId: p.sectionId,
          academicYearId: p.academicYearId,
        })),
      },
      orderBy: [{ finalizedAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        title: true,
        className: true,
        sectionName: true,
        finalizedAt: true,
        academicYear: { select: { id: true, name: true } },
        term: { select: { id: true, name: true } },
        studentResults: {
          where: { studentId: sid },
          select: {
            totalObtained: true,
            totalMax: true,
            percentage: true,
            grade: true,
            passed: true,
            position: true,
            finalizedAt: true,
          },
        },
      },
    });

    const rows: FinalizedResultRow[] = [];
    for (const e of exams) {
      const snap = e.studentResults[0];
      let result = snap?.finalizedAt ? snap : null;
      if (!result) {
        // Legacy exams migrated as finalized have no snapshot; compute this student's row live.
        const sheet = await this.buildSheet(this.prisma, e.id);
        const student = sheet.students.find((s) => s.id === sid);
        if (!student) continue;
        const row = this.rowFor(sheet, student);
        result = {
          totalObtained: row.totalObtained,
          totalMax: row.totalMax,
          percentage: row.percentage,
          grade: row.grade,
          passed: row.passed,
          position: row.position,
          finalizedAt: e.finalizedAt,
        };
      }
      rows.push({
        examination: {
          id: e.id,
          title: e.title,
          className: e.className,
          sectionName: e.sectionName,
          academicYear: e.academicYear,
          term: e.term,
          finalizedAt: e.finalizedAt,
        },
        ...result,
      });
    }
    return rows;
  }

  private schoolHeader(schoolId: string): Promise<SchoolHeaderRow> {
    return this.prisma.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: schoolHeaderSelect,
    });
  }

  private async loadSubject(examinationId: string, subjectId: string) {
    const subject = await this.prisma.exam.findFirst({
      where: { id: subjectId, examinationId },
      select: {
        id: true,
        maxScore: true,
        passingMarks: true,
        heldAt: true,
        createdByTeacherId: true,
        sectionSubject: {
          select: { teacherId: true, subject: { select: { name: true } } },
        },
      },
    });
    if (!subject)
      throw new NotFoundException('Subject not found on this examination');
    return subject;
  }

  private mayEnterMarks(
    actor: Actor,
    core: ExamCore,
    subject: {
      createdByTeacherId: string | null;
      sectionSubject: { teacherId: string | null };
    },
    teacherId: string | null,
  ): boolean {
    if (actor.role === Role.SCHOOL_ADMIN) return true;
    if (actor.role !== Role.TEACHER || !teacherId) return false;
    return (
      subject.sectionSubject.teacherId === teacherId ||
      subject.createdByTeacherId === teacherId ||
      core.createdByTeacherId === teacherId
    );
  }

  private async buildSheet(db: Db, examinationId: string): Promise<Sheet> {
    const exam = await db.examination.findUnique({
      where: { id: examinationId },
      select: sheetExamSelect,
    });
    if (!exam) throw new NotFoundException('Examination not found');
    const bands = await this.settings.bandsFor(
      db,
      exam.schoolId,
      exam.gradingSchemeId,
    );
    const examIds = exam.subjects.map((s) => s.id);
    const studentIds = await this.access.rosterStudentIds(db, exam, examIds);

    const students = (
      await db.studentProfile.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, fullName: true, rollNo: true, admissionNo: true },
      })
    ).sort(
      (a, b) =>
        (a.rollNo ?? '￿').localeCompare(b.rollNo ?? '￿', undefined, {
          numeric: true,
        }) || a.fullName.localeCompare(b.fullName),
    );
    const results = examIds.length
      ? await db.examResult.findMany({
          where: { examId: { in: examIds } },
          select: {
            examId: true,
            studentId: true,
            score: true,
            isAbsent: true,
            remarks: true,
            grade: true,
          },
        })
      : [];
    const stored = await db.examinationResult.findMany({
      where: { examinationId },
    });

    const marks = new Map(
      results.map((r) => [markKey(r.examId, r.studentId), r]),
    );
    const outcomes = new Map<string, StudentOutcome>();
    for (const st of students) {
      outcomes.set(
        st.id,
        studentOutcome(
          exam.subjects.map((s) => {
            const m = marks.get(markKey(s.id, st.id));
            return {
              examId: s.id,
              label: s.sectionSubject.subject.name,
              maxScore: s.maxScore,
              passingMarks: s.passingMarks,
              score: m?.score ?? null,
              isAbsent: m?.isAbsent ?? false,
            };
          }),
          bands,
        ),
      );
    }
    const positions = assignPositions(
      [...outcomes.entries()].map(([studentId, o]) => ({
        studentId,
        totalObtained: o.totalObtained,
        totalMax: o.totalMax,
        complete: o.complete,
      })),
    );
    return {
      exam,
      bands,
      students,
      marks,
      outcomes,
      positions,
      stored: new Map(stored.map((r) => [r.studentId, r])),
    };
  }

  /** Finalized rows read from the frozen snapshot; everything else is derived live. */
  private rowFor(sheet: Sheet, student: SheetStudent) {
    const o = sheet.outcomes.get(student.id)!;
    const stored = sheet.stored.get(student.id);
    const frozen =
      sheet.exam.resultStatus === 'FINALIZED' && stored?.finalizedAt
        ? stored
        : null;
    return {
      student,
      subjects: sheet.exam.subjects.map((s, i) => {
        const out = o.subjects[i];
        const m = sheet.marks.get(markKey(s.id, student.id));
        return {
          examId: s.id,
          label: out.label,
          maxScore: out.maxScore,
          passingMarks: s.passingMarks,
          obtained: out.obtained,
          isAbsent: m?.isAbsent ?? false,
          percentage: out.percentage,
          grade: frozen && m?.grade ? m.grade : out.grade,
          passed: out.passed,
          state: out.state,
          issue: out.issue,
          remarks: m?.remarks ?? null,
        };
      }),
      complete: o.complete,
      totalObtained: frozen?.totalObtained ?? o.totalObtained,
      totalMax: frozen?.totalMax ?? o.totalMax,
      percentage: frozen ? frozen.percentage : o.percentage,
      grade: frozen ? frozen.grade : o.grade,
      passed: frozen ? frozen.passed : o.passed,
      position: frozen
        ? frozen.position
        : (sheet.positions.get(student.id) ?? null),
      failedSubjects: o.failedSubjects,
      belowPassMark: o.belowPassMark,
      classTeacherRemarks: stored?.classTeacherRemarks ?? null,
      principalRemarks: stored?.principalRemarks ?? null,
    };
  }

  /** One teacher's own columns, with the class-wide outcome fields withheld. */
  private narrowRow<R extends { subjects: { examId: string }[] }>(
    row: R,
    own: Set<string>,
  ) {
    return {
      ...row,
      subjects: row.subjects.filter((s) => own.has(s.examId)),
      totalObtained: null,
      totalMax: null,
      percentage: null,
      grade: null,
      passed: null,
      position: null,
      classTeacherRemarks: null,
      principalRemarks: null,
    };
  }

  private header(exam: SheetExam) {
    return {
      id: exam.id,
      title: exam.title,
      className: exam.className,
      sectionName: exam.sectionName,
      status: exam.status,
      resultStatus: exam.resultStatus,
      publishedAt: exam.publishedAt,
      finalizedAt: exam.finalizedAt,
      academicYear: { id: exam.academicYear.id, name: exam.academicYear.name },
      term: exam.term ? { id: exam.term.id, name: exam.term.name } : null,
    };
  }
}
