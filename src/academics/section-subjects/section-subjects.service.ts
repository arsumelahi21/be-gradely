import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateSectionSubjectDto } from './dto/create-section-subject.dto';
import { UpdateSectionSubjectDto } from './dto/update-section-subject.dto';
import { Actor } from '../../common/types/actor.type';

/** Role stamped on roster rows created automatically alongside a subject
 *  allocation. Only these are pruned — a human-set role is left alone. */
const SUBJECT_TEACHER_ROLE = 'Subject Teacher';
import { Role } from '../../common/types/role.type';
import { FindSectionSubjectsQueryDto } from './dto/find-section-subjects-query.dto';

type UpdateSectionSubjectInput = UpdateSectionSubjectDto &
  Partial<CreateSectionSubjectDto>;

@Injectable()
export class SectionSubjectsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async create(dto: CreateSectionSubjectDto, actor: Actor) {
    const { section, subject, teacher } = await this.resolveEntities(
      dto.sectionId,
      dto.subjectId,
      dto.teacherId ?? undefined,
      actor,
    );
    return this.prisma.sectionSubject.create({
      data: {
        sectionId: section.id,
        subjectId: subject.id,
        teacherId: teacher?.id ?? null,
        isPrimary: dto.isPrimary ?? false,
        schedule: dto.schedule ?? null,
      },
      include: this.defaultInclude(),
    });
  }

  async findAll(actor: Actor, query: FindSectionSubjectsQueryDto) {
    const where: any = {};

    // If actor is a student, they can see section-subjects for sections they're enrolled in
    if (actor.role === Role.STUDENT) {
      if (!actor.schoolId) {
        throw new ForbiddenException('No school context');
      }

      const student = await this.prisma.studentProfile.findFirst({
        where: { userId: actor.userId, schoolId: actor.schoolId },
      });
      if (!student) {
        throw new ForbiddenException('Student profile not found');
      }

      // Get all sections student is enrolled in
      const enrollments = await this.prisma.enrollment.findMany({
        where: {
          studentId: student.id,
          status: 'ACTIVE',
        },
        select: { sectionId: true },
      });

      const enrolledSectionIds = enrollments.map((e) => e.sectionId);

      if (enrolledSectionIds.length === 0) {
        return [];
      }

      where.sectionId = { in: enrolledSectionIds };
      where.section = { schoolId: actor.schoolId };

      // Apply filters
      if (query.sectionId) {
        if (!enrolledSectionIds.includes(query.sectionId)) {
          throw new ForbiddenException('You are not enrolled in this section');
        }
        where.sectionId = query.sectionId;
      }
      if (query.subjectId) where.subjectId = query.subjectId;
    }
    // If actor is a parent, they can see section-subjects for sections their children are enrolled in
    else if (actor.role === Role.PARENT) {
      if (!actor.schoolId) {
        throw new ForbiddenException('No school context');
      }

      const parent = await this.prisma.parentProfile.findFirst({
        where: { userId: actor.userId },
      });
      if (!parent) {
        throw new ForbiddenException('Parent profile not found');
      }

      // Get all children's student IDs
      const parentStudentLinks = await (
        this.prisma as any
      ).parentStudent.findMany({
        where: { parentId: parent.id },
        select: { studentId: true },
      });

      const childStudentIds = parentStudentLinks.map(
        (link: any) => link.studentId,
      );

      if (childStudentIds.length === 0) {
        return [];
      }

      // Get all sections children are enrolled in
      const enrollments = await this.prisma.enrollment.findMany({
        where: {
          studentId: { in: childStudentIds },
          status: 'ACTIVE',
        },
        select: { sectionId: true },
      });

      const enrolledSectionIds = Array.from(
        new Set(enrollments.map((e) => e.sectionId)),
      );

      if (enrolledSectionIds.length === 0) {
        return [];
      }

      where.sectionId = { in: enrolledSectionIds };
      where.section = { schoolId: actor.schoolId };

      // Apply filters
      if (query.sectionId) {
        if (!enrolledSectionIds.includes(query.sectionId)) {
          throw new ForbiddenException(
            'Your child is not enrolled in this section',
          );
        }
        where.sectionId = query.sectionId;
      }
      if (query.subjectId) where.subjectId = query.subjectId;
    }
    // If actor is a teacher, they can only see section-subjects they're assigned to
    else if (actor.role === Role.TEACHER) {
      // Teachers can only see section-subjects they're assigned to
      if (!actor.schoolId) {
        throw new ForbiddenException('No school context');
      }

      // Get teacher profile
      const teacher = await this.prisma.teacherProfile.findFirst({
        where: { userId: actor.userId, schoolId: actor.schoolId },
      });
      if (!teacher) {
        throw new ForbiddenException('Teacher profile not found');
      }

      // If teacherId is provided in query, ensure it matches the logged-in teacher
      if (query.teacherId && query.teacherId !== teacher.id) {
        throw new ForbiddenException('Can only view your own assignments');
      }

      // Filter by teacher's assignments (either directly assigned or via section-teacher)
      const sectionTeacherAssignments = await (
        this.prisma as any
      ).sectionTeacher.findMany({
        where: { teacherId: teacher.id },
        select: { sectionId: true },
      });

      const sectionSubjectAssignments =
        await this.prisma.sectionSubject.findMany({
          where: { teacherId: teacher.id },
          select: { sectionId: true },
        });

      const assignedSectionIds = [
        ...new Set([
          ...sectionTeacherAssignments.map((st: any) => st.sectionId),
          ...sectionSubjectAssignments.map((ss) => ss.sectionId),
        ]),
      ];

      if (assignedSectionIds.length === 0) {
        return [];
      }

      where.sectionId = { in: assignedSectionIds };
      where.section = { schoolId: actor.schoolId };

      // Apply additional filters
      if (query.sectionId) {
        if (!assignedSectionIds.includes(query.sectionId)) {
          throw new ForbiddenException('Not assigned to this section');
        }
        where.sectionId = query.sectionId;
      }
      if (query.subjectId) where.subjectId = query.subjectId;
      if (query.teacherId) where.teacherId = query.teacherId;
    } else {
      // Admin access
      this.ensureAdmin(actor);
      if (query.sectionId) where.sectionId = query.sectionId;
      if (query.subjectId) where.subjectId = query.subjectId;
      if (query.teacherId) where.teacherId = query.teacherId;
      if (actor.role === Role.SUPER_ADMIN) {
        if (query.schoolId) {
          where.section = { schoolId: query.schoolId };
        }
      } else {
        where.section = { schoolId: actor.schoolId! };
      }
    }

    return this.prisma.sectionSubject.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: this.defaultInclude(),
    });
  }

  async findOne(id: string, actor: Actor) {
    return this.getOrThrow(id, actor);
  }

  async update(id: string, dto: UpdateSectionSubjectInput, actor: Actor) {
    const current = await this.getOrThrow(id, actor);
    const sectionId = dto.sectionId ?? current.sectionId;
    const subjectId = dto.subjectId ?? current.subjectId;
    const teacherId =
      dto.teacherId === undefined ? current.teacherId : dto.teacherId;
    const { section, subject, teacher } = await this.resolveEntities(
      sectionId,
      subjectId,
      teacherId ?? undefined,
      actor,
    );
    const nextTeacherId = teacherId ? (teacher?.id ?? null) : null;
    const previousTeacherId = current.teacherId;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.sectionSubject.update({
        where: { id },
        data: {
          sectionId: section.id,
          subjectId: subject.id,
          teacherId: nextTeacherId,
          ...(dto.isPrimary !== undefined && { isPrimary: dto.isPrimary }),
          ...(dto.schedule !== undefined && { schedule: dto.schedule }),
        },
        include: this.defaultInclude(),
      });
      // Replacing a subject's teacher used to leave the old one on the section
      // roster forever, inflating the class card's teacher count and keeping the
      // class on a dashboard for someone who teaches nothing in it.
      if (previousTeacherId && previousTeacherId !== nextTeacherId) {
        await this.pruneRosterIfUnused(
          tx,
          current.sectionId,
          previousTeacherId,
        );
      }
      return updated;
    });
  }

  async remove(id: string, actor: Actor) {
    const current = await this.getOrThrow(id, actor);
    return this.prisma.$transaction(async (tx) => {
      const removed = await tx.sectionSubject.delete({ where: { id } });
      if (current.teacherId) {
        await this.pruneRosterIfUnused(
          tx,
          current.sectionId,
          current.teacherId,
        );
      }
      return removed;
    });
  }

  /**
   * Drop a teacher's auto-created SectionTeacher row once they teach no subject
   * in the section. A CLASS TEACHER (isPrimary) is a deliberate assignment and is
   * always kept, as is any row a human gave a different role.
   */
  private async pruneRosterIfUnused(
    tx: Prisma.TransactionClient,
    sectionId: string,
    teacherId: string,
  ) {
    const stillTeaches = await tx.sectionSubject.count({
      where: { sectionId, teacherId },
    });
    if (stillTeaches > 0) return;
    await tx.sectionTeacher.deleteMany({
      where: {
        sectionId,
        teacherId,
        isPrimary: false,
        assignmentRole: SUBJECT_TEACHER_ROLE,
      },
    });
  }

  private async getOrThrow(id: string, actor: Actor) {
    const record = await this.prisma.sectionSubject.findUnique({
      where: { id },
      include: this.defaultInclude(),
    });
    if (!record) {
      throw new NotFoundException('Section subject not found');
    }
    this.enforceScope(actor, record.section.schoolId);
    return record;
  }

  private async resolveEntities(
    sectionId: string,
    subjectId: string,
    teacherId: string | undefined,
    actor: Actor,
  ) {
    // Fetch the independent rows in one round-trip; the checks below keep their
    // original order so the same error surfaces for the same bad input.
    const [section, subject, teacher] = await Promise.all([
      this.prisma.section.findUnique({ where: { id: sectionId } }),
      this.prisma.subject.findUnique({ where: { id: subjectId } }),
      teacherId
        ? this.prisma.teacherProfile.findUnique({ where: { id: teacherId } })
        : Promise.resolve(null),
    ]);

    if (!section) {
      throw new NotFoundException('Section not found');
    }
    this.enforceScope(actor, section.schoolId);

    if (!subject) {
      throw new NotFoundException('Subject not found');
    }
    if (subject.schoolId !== section.schoolId) {
      throw new BadRequestException(
        'Subject must belong to the same school as the section',
      );
    }

    if (teacherId) {
      if (!teacher) {
        throw new NotFoundException('Teacher not found');
      }
      if (teacher.schoolId !== section.schoolId) {
        throw new BadRequestException(
          'Teacher must belong to the same school as the section',
        );
      }
    }

    return { section, subject, teacher };
  }

  private defaultInclude() {
    return {
      section: {
        include: {
          classGrade: true,
        },
      },
      subject: true,
      teacher: true,
    };
  }
}
