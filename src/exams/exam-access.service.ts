import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EnrollmentStatus, ExaminationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';

type Db = Prisma.TransactionClient;

// Promotion closes a placement as COMPLETED rather than deleting it, so history stays visible.
export const HISTORY_ENROLLMENT: EnrollmentStatus[] = [
  EnrollmentStatus.ACTIVE,
  EnrollmentStatus.COMPLETED,
];

export const examCoreSelect = {
  id: true,
  schoolId: true,
  academicYearId: true,
  classGradeId: true,
  sectionId: true,
  termId: true,
  title: true,
  className: true,
  sectionName: true,
  status: true,
  resultStatus: true,
  createdByUserId: true,
  createdByTeacherId: true,
} satisfies Prisma.ExaminationSelect;

export type ExamCore = Prisma.ExaminationGetPayload<{
  select: typeof examCoreSelect;
}>;

export interface TeacherSectionScope {
  classTeacher: boolean;
  sectionSubjectIds: Set<string>;
}

/** Object-level authorization shared by every exam service; tenant checks live here, not per method. */
@Injectable()
export class ExamAccessService {
  constructor(private readonly prisma: PrismaService) {}

  schoolOf(actor: Actor): string {
    if (!actor.schoolId) throw new ForbiddenException('No school context');
    return actor.schoolId;
  }

  assertSameSchool(actor: Actor, schoolId: string) {
    if (actor.role === Role.SUPER_ADMIN) return;
    if (!actor.schoolId || actor.schoolId !== schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }
  }

  async loadCore(id: string, db: Db = this.prisma): Promise<ExamCore> {
    const exam = await db.examination.findUnique({
      where: { id },
      select: examCoreSelect,
    });
    if (!exam) throw new NotFoundException('Examination not found');
    return exam;
  }

  async teacherId(actor: Actor): Promise<string> {
    const teacher = await this.prisma.teacherProfile.findFirst({
      where: {
        userId: actor.userId,
        schoolId: this.schoolOf(actor),
        isActive: true,
      },
      select: { id: true },
    });
    if (!teacher) throw new ForbiddenException('Teacher profile not found');
    return teacher.id;
  }

  /**
   * Refuses a deactivated account or a suspended school, as login and refresh now do, so an
   * access token issued before the switch-off cannot reach confidential material.
   */
  async assertActiveAccount(actor: Actor): Promise<void> {
    const account = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { isActive: true, school: { select: { isActive: true } } },
    });
    // Super admins have no school, so only an explicit `false` locks a user out.
    if (!account?.isActive || account.school?.isActive === false) {
      throw new ForbiddenException('Account is inactive');
    }
  }

  isCreator(
    actor: Actor,
    exam: Pick<ExamCore, 'createdByUserId' | 'createdByTeacherId'>,
    teacherId?: string | null,
  ): boolean {
    return (
      exam.createdByUserId === actor.userId ||
      (!!teacherId && exam.createdByTeacherId === teacherId)
    );
  }

  /** A teacher sees their own proposals, and published exams they teach, lead the class of, or invigilate. */
  teacherVisibility(teacherId: string): Prisma.ExaminationWhereInput {
    return {
      OR: [
        { createdByTeacherId: teacherId },
        {
          status: ExaminationStatus.PUBLISHED,
          OR: [
            { subjects: { some: { sectionSubject: { teacherId } } } },
            { subjects: { some: { invigilatorTeacherId: teacherId } } },
            { section: { teachers: { some: { teacherId, isPrimary: true } } } },
          ],
        },
      ],
    };
  }

  /** Staff read access. Returns the caller's teacher profile id when they are a teacher. */
  async assertStaffCanView(
    actor: Actor,
    exam: ExamCore,
  ): Promise<string | null> {
    if (actor.role === Role.SUPER_ADMIN) return null;
    this.assertSameSchool(actor, exam.schoolId);
    if (actor.role === Role.SCHOOL_ADMIN) return null;
    if (actor.role !== Role.TEACHER)
      throw new ForbiddenException('Not allowed');
    const teacherId = await this.teacherId(actor);
    const visible = await this.prisma.examination.count({
      where: { id: exam.id, ...this.teacherVisibility(teacherId) },
    });
    if (!visible) {
      throw new ForbiddenException(
        'You do not have access to this examination',
      );
    }
    return teacherId;
  }

  async teacherSectionScope(
    teacherId: string,
    sectionId: string,
  ): Promise<TeacherSectionScope> {
    const [primary, subjects] = await Promise.all([
      this.prisma.sectionTeacher.findFirst({
        where: { teacherId, sectionId, isPrimary: true },
        select: { id: true },
      }),
      this.prisma.sectionSubject.findMany({
        where: { teacherId, sectionId },
        select: { id: true },
      }),
    ]);
    return {
      classTeacher: !!primary,
      sectionSubjectIds: new Set(subjects.map((s) => s.id)),
    };
  }

  async isClassTeacher(teacherId: string, sectionId: string): Promise<boolean> {
    const row = await this.prisma.sectionTeacher.findFirst({
      where: { teacherId, sectionId, isPrimary: true },
      select: { id: true },
    });
    return !!row;
  }

  async resolveAudienceStudent(
    actor: Actor,
    studentId?: string,
  ): Promise<string> {
    if (actor.role === Role.STUDENT) {
      const own = await this.prisma.studentProfile.findFirst({
        where: { userId: actor.userId, schoolId: this.schoolOf(actor) },
        select: { id: true },
      });
      if (!own) throw new ForbiddenException('Student profile not found');
      if (studentId && studentId !== own.id)
        throw new ForbiddenException('Not allowed');
      return own.id;
    }
    if (actor.role === Role.PARENT) {
      if (!studentId) throw new BadRequestException('studentId is required');
      const link = await this.prisma.parentStudent.findFirst({
        where: { studentId, parent: { userId: actor.userId } },
        select: { studentId: true },
      });
      if (!link)
        throw new ForbiddenException('Student is not linked to this parent');
      return studentId;
    }
    throw new ForbiddenException('Not allowed');
  }

  /** Students/parents see only a PUBLISHED exam of a section + session the student belongs to. */
  async assertAudienceCanView(
    actor: Actor,
    exam: ExamCore,
    studentId?: string,
  ): Promise<string> {
    if (actor.role === Role.STUDENT)
      this.assertSameSchool(actor, exam.schoolId);
    const sid = await this.resolveAudienceStudent(actor, studentId);
    if (exam.status !== ExaminationStatus.PUBLISHED) {
      throw new ForbiddenException('This examination is not available');
    }
    const placed = await this.prisma.enrollment.findFirst({
      where: {
        studentId: sid,
        sectionId: exam.sectionId,
        academicYearId: exam.academicYearId,
        status: { in: HISTORY_ENROLLMENT },
      },
      select: { id: true },
    });
    if (!placed)
      throw new ForbiddenException('This examination is not available');
    return sid;
  }

  /**
   * The result sheet's students: placed in the section for that session (deduped), minus
   * mid-year transfers out, plus anyone who already has marks.
   */
  async rosterStudentIds(
    db: Db,
    exam: Pick<ExamCore, 'sectionId' | 'academicYearId'>,
    examIds: string[],
  ): Promise<string[]> {
    const placements = await db.enrollment.findMany({
      where: {
        sectionId: exam.sectionId,
        academicYearId: exam.academicYearId,
        status: { in: HISTORY_ENROLLMENT },
      },
      select: { studentId: true, status: true },
    });
    const active = new Set(
      placements
        .filter((p) => p.status === EnrollmentStatus.ACTIVE)
        .map((p) => p.studentId),
    );
    const closed = [
      ...new Set(
        placements
          .filter((p) => !active.has(p.studentId))
          .map((p) => p.studentId),
      ),
    ];
    let movedOut = new Set<string>();
    if (closed.length) {
      const moved = await db.enrollment.findMany({
        where: {
          studentId: { in: closed },
          academicYearId: exam.academicYearId,
          status: EnrollmentStatus.ACTIVE,
          sectionId: { not: exam.sectionId },
        },
        select: { studentId: true },
      });
      movedOut = new Set(moved.map((m) => m.studentId));
    }
    const marked = examIds.length
      ? await db.examResult.findMany({
          where: { examId: { in: examIds } },
          select: { studentId: true },
          distinct: ['studentId'],
        })
      : [];
    return [
      ...new Set([
        ...active,
        ...closed.filter((id) => !movedOut.has(id)),
        ...marked.map((m) => m.studentId),
      ]),
    ];
  }
}
