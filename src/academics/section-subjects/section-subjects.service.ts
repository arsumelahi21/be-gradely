import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { uniqueConflict } from '../../common/utils/prisma-errors';
import { TEACHER_PUBLIC } from '../../common/utils/teacher-select';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateSectionSubjectDto } from './dto/create-section-subject.dto';
import { UpdateSectionSubjectDto } from './dto/update-section-subject.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { ensureOnRoster, pruneSectionRoster } from './section-roster';
import { FindSectionSubjectsQueryDto } from './dto/find-section-subjects-query.dto';
import { assertNoExaminationHistory } from '../../common/services/exam-history-guard';

type UpdateSectionSubjectInput = UpdateSectionSubjectDto &
  Partial<CreateSectionSubjectDto>;

@Injectable()
export class SectionSubjectsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService, cache: CacheService) {
    super(prisma, cache);
  }

  /** The sections/classes lists are cached WITH per-section counts, so any write
   *  that moves subjects or teachers has to drop them. */
  private invalidate(schoolId: string) {
    return this.invalidateSchoolCache(schoolId, 'sections', 'classes');
  }

  async create(dto: CreateSectionSubjectDto, actor: Actor) {
    const { section, subject, teacher } = await this.resolveEntities(
      dto.sectionId,
      dto.subjectId,
      dto.teacherId ?? undefined,
      actor,
    );
    const created = await this.prisma
      .$transaction(async (tx) => {
        const row = await tx.sectionSubject.create({
          data: {
            sectionId: section.id,
            subjectId: subject.id,
            teacherId: teacher?.id ?? null,
            isPrimary: dto.isPrimary ?? false,
            schedule: dto.schedule ?? null,
          },
          include: this.defaultInclude(),
        });
        if (teacher?.id) await ensureOnRoster(tx, section.id, teacher.id);
        return row;
      })
      // @@unique([sectionId, subjectId]) — allocating the same subject twice.
      .catch(
        uniqueConflict(
          `${subject.name} is already allocated to this section. Edit the existing allocation to change its teacher.`,
        ),
      );
    await this.invalidate(section.schoolId);
    return created;
  }

  async findAll(actor: Actor, query: FindSectionSubjectsQueryDto) {
    const where: any = {};

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

      if (query.sectionId) {
        if (!enrolledSectionIds.includes(query.sectionId)) {
          throw new ForbiddenException('You are not enrolled in this section');
        }
        where.sectionId = query.sectionId;
      }
      if (query.subjectId) where.subjectId = query.subjectId;
    } else if (actor.role === Role.PARENT) {
      if (!actor.schoolId) {
        throw new ForbiddenException('No school context');
      }

      const parent = await this.prisma.parentProfile.findFirst({
        where: { userId: actor.userId },
      });
      if (!parent) {
        throw new ForbiddenException('Parent profile not found');
      }

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

      if (query.sectionId) {
        if (!enrolledSectionIds.includes(query.sectionId)) {
          throw new ForbiddenException(
            'Your child is not enrolled in this section',
          );
        }
        where.sectionId = query.sectionId;
      }
      if (query.subjectId) where.subjectId = query.subjectId;
    } else if (actor.role === Role.TEACHER) {
      // Teachers can only see section-subjects they're assigned to
      if (!actor.schoolId) {
        throw new ForbiddenException('No school context');
      }

      const teacher = await this.prisma.teacherProfile.findFirst({
        where: { userId: actor.userId, schoolId: actor.schoolId },
      });
      if (!teacher) {
        throw new ForbiddenException('Teacher profile not found');
      }

      if (query.teacherId && query.teacherId !== teacher.id) {
        throw new ForbiddenException('Can only view your own assignments');
      }

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

    // This list is open to students and parents, and `teacher: true` is the whole
    // profile — phone, address, designation. Staff keep it; they run the admin screens.
    const teacherShape =
      actor.role === Role.STUDENT || actor.role === Role.PARENT
        ? TEACHER_PUBLIC
        : true;
    return this.prisma.sectionSubject.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { ...this.defaultInclude(), teacher: teacherShape },
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
    const result = await this.prisma.$transaction(async (tx) => {
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
      // Roster the teacher where the row now lives (a PATCH may move sections), then prune where it was.
      if (nextTeacherId) {
        await ensureOnRoster(tx, section.id, nextTeacherId);
      }
      await pruneSectionRoster(tx, current.sectionId);
      return updated;
    });
    await this.invalidate(current.section.schoolId);
    if (section.schoolId !== current.section.schoolId) {
      await this.invalidate(section.schoolId);
    }
    return result;
  }

  /** Attendance, assignments and timetable entries cascade with this row; exam papers
   *  Restrict it, so examination history refuses the delete. AuditLog holds no FK. */
  async remove(id: string, actor: Actor) {
    const current = await this.getOrThrow(id, actor);
    await assertNoExaminationHistory(this.prisma, 'sectionSubject', id);
    const result = await this.prisma.$transaction(async (tx) => {
      const removed = await tx.sectionSubject.delete({ where: { id } });
      await pruneSectionRoster(tx, current.sectionId);
      return removed;
    });
    await this.invalidate(current.section.schoolId);
    return result;
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
