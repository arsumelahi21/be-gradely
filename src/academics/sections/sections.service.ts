import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateSectionDto } from './dto/update-section.dto';
import { LinkTeacherSectionDto } from './dto/link-teacher-section.dto';
import { UpdateTeacherSectionDto } from './dto/update-teacher-section.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { FindSectionsQueryDto } from './dto/find-sections-query.dto';
import { CacheService } from '../../common/services/cache.service';
import { EnrollmentStatus, Prisma } from '@prisma/client';
import { uniqueConflict } from '../../common/utils/prisma-errors';
import { assertNoExaminationHistory } from '../../common/services/exam-history-guard';
import { pruneSectionRoster } from '../section-subjects/section-roster';

type UpdateSectionInput = UpdateSectionDto & Partial<CreateSectionDto>;

@Injectable()
export class SectionsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService, cache: CacheService) {
    super(prisma, cache);
  }

  private get sectionTeachers() {
    return (this.prisma as PrismaService & { sectionTeacher: any })
      .sectionTeacher;
  }

  async create(dto: CreateSectionDto, actor: Actor) {
    this.ensureAdmin(actor);
    const grade = await this.prisma.classGrade.findUnique({
      where: { id: dto.classGradeId },
    });
    if (!grade) {
      throw new NotFoundException('Class grade not found');
    }
    this.enforceScope(actor, grade.schoolId);
    const created = await this.prisma.section
      .create({
        data: {
          classGradeId: dto.classGradeId,
          schoolId: grade.schoolId,
          name: dto.name,
          room: dto.room ?? null,
        },
      })
      // @@unique([classGradeId, name]) — without this the form just says
      // "Internal server error" and the admin has no idea the name is taken.
      .catch(
        uniqueConflict(
          `${grade.name} already has a section named "${dto.name}". Section names must be unique within a class.`,
        ),
      );
    // Classes list embeds its sections, so invalidate both.
    await this.invalidateSchoolCache(grade.schoolId, 'sections', 'classes');
    return created;
  }

  async findAll(actor: Actor, query: FindSectionsQueryDto) {
    this.ensureAdmin(actor);
    const scopedSchoolId =
      actor.role === Role.SUPER_ADMIN
        ? (query.schoolId ?? undefined)
        : actor.schoolId!;
    const variant = { classGradeId: query.classGradeId ?? null };
    return this.cachedSchoolList(
      scopedSchoolId,
      'sections',
      variant,
      async () => {
        const where: any = {};
        if (query.classGradeId) where.classGradeId = query.classGradeId;
        if (scopedSchoolId) where.schoolId = scopedSchoolId;
        // Include per-section counts so cards render subject/teacher/student
        // numbers without firing 3 requests each (was 1+3N per class page).
        const sections = await this.prisma.section.findMany({
          where,
          // Class ladder first, then section name — so a whole-school list reads
          // PG A, PG B, Nursery A, … 10 B rather than in creation order.
          orderBy: [
            { classGrade: { level: { sort: 'asc', nulls: 'last' } } },
            { classGrade: { name: 'asc' } },
            { name: 'asc' },
          ],
          include: {
            _count: {
              select: {
                subjects: true,
                teachers: true,
                // Current students only, matching the enrolment lists; promotion keeps COMPLETED rows.
                enrollments: { where: { status: EnrollmentStatus.ACTIVE } },
              },
            },
          },
        });
        if (!sections.length) return sections;

        // `_count.teachers` is only the homeroom SectionTeacher, so it undercounts; Prisma `_count`
        // can't express the DISTINCT union of both routes, so one grouped query covers the whole list.
        const teacherCounts = await this.distinctTeacherCounts(
          sections.map((s) => s.id),
        );
        return sections.map((s) => ({
          ...s,
          teacherCount: teacherCounts.get(s.id) ?? 0,
        }));
      },
    );
  }

  /**
   * DISTINCT teachers per section across `SectionTeacher` and `SectionSubject.teacherId`.
   * UNION, not UNION ALL, so a class teacher who also teaches two subjects counts once.
   */
  private async distinctTeacherCounts(
    sectionIds: string[],
  ): Promise<Map<string, number>> {
    if (!sectionIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<
      Array<{ sectionId: string; count: number }>
    >`
      SELECT u."sectionId", COUNT(DISTINCT u."teacherId")::int AS count
      FROM (
        SELECT "sectionId", "teacherId" FROM "SectionTeacher"
        WHERE "sectionId" = ANY(${sectionIds})
        UNION
        SELECT "sectionId", "teacherId" FROM "SectionSubject"
        WHERE "sectionId" = ANY(${sectionIds}) AND "teacherId" IS NOT NULL
      ) u
      GROUP BY u."sectionId"
    `;
    return new Map(rows.map((r) => [r.sectionId, Number(r.count)]));
  }

  async findOne(id: string, actor: Actor) {
    return this.getOrThrow(id, actor);
  }

  /**
   * Everything the section-management card needs — subjects + teachers +
   * enrollments — in ONE query, replacing 3 per-section requests. Fresh (not cached), tenant-scoped.
   */
  async getSectionDetail(id: string, actor: Actor) {
    this.ensureAdmin(actor);
    // Slim include — only fields the class-detail card renders (verified
    // against class-grade/[id]/page.tsx); drops repeated section→classGrade and unused relations.
    const section = await this.prisma.section.findUnique({
      where: { id },
      include: {
        subjects: {
          include: {
            subject: true,
            // `user` too: the card links a teacher to their profile, and a subject teacher
            // who is not the class teacher has no other row here to source that id from.
            teacher: {
              include: { user: { select: { id: true, email: true } } },
            },
          },
        },
        teachers: {
          include: {
            teacher: {
              include: {
                user: { select: { id: true, email: true } },
              },
            },
          },
        },
        enrollments: {
          // Same students the card counts and the enrolment list shows.
          where: { status: EnrollmentStatus.ACTIVE },
          include: {
            student: true,
          },
        },
      },
    });
    if (!section) {
      throw new NotFoundException('Section not found');
    }
    this.enforceScope(actor, section.schoolId);
    return {
      subjects: section.subjects,
      teachers: section.teachers,
      enrollments: section.enrollments,
    };
  }

  async update(id: string, dto: UpdateSectionInput, actor: Actor) {
    const section = await this.getOrThrow(id, actor);
    let classGradeId = section.classGradeId;
    let schoolId = section.schoolId;
    if (dto.classGradeId && dto.classGradeId !== section.classGradeId) {
      const grade = await this.prisma.classGrade.findUnique({
        where: { id: dto.classGradeId },
      });
      if (!grade) {
        throw new NotFoundException('Class grade not found');
      }
      this.enforceScope(actor, grade.schoolId);
      classGradeId = grade.id;
      schoolId = grade.schoolId;
    }
    const updated = await this.prisma.section
      .update({
        where: { id },
        data: {
          classGradeId,
          schoolId,
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.room !== undefined && { room: dto.room }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
      })
      // Renaming, or moving into a class that already has this name.
      .catch(
        uniqueConflict(
          `That class already has a section named "${dto.name ?? section.name}".`,
        ),
      );
    await this.invalidateSchoolCache(section.schoolId, 'sections', 'classes');
    if (schoolId !== section.schoolId) {
      await this.invalidateSchoolCache(schoolId, 'sections', 'classes');
    }
    return updated;
  }

  async remove(id: string, actor: Actor) {
    const section = await this.getOrThrow(id, actor);
    // Enrollments, subjects, quizzes and timetables cascade; threads and announcements null it.
    // Only examination history refuses the delete (Restrict), so results outlive cleanup.
    await assertNoExaminationHistory(this.prisma, 'section', id);
    const removed = await this.prisma.section.delete({ where: { id } });
    await this.invalidateSchoolCache(section.schoolId, 'sections', 'classes');
    return removed;
  }

  async listTeachers(sectionId: string, actor: Actor) {
    const section = await this.getOrThrow(sectionId, actor);
    return this.sectionTeachers.findMany({
      where: { sectionId: section.id },
      orderBy: { createdAt: 'asc' },
      include: this.assignmentInclude(),
    });
  }

  async listSectionsForTeacher(teacherId: string, actor: Actor) {
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id: teacherId },
    });
    if (!teacher) {
      throw new NotFoundException('Teacher not found');
    }
    this.enforceScope(actor, teacher.schoolId);
    return this.sectionTeachers.findMany({
      where: { teacherId: teacher.id },
      orderBy: { createdAt: 'asc' },
      include: this.assignmentInclude(),
    });
  }

  async assignTeacher(
    sectionId: string,
    dto: LinkTeacherSectionDto,
    actor: Actor,
  ) {
    this.ensureAdmin(actor);
    const section = await this.getOrThrow(sectionId, actor);
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id: dto.teacherId },
    });
    if (!teacher) {
      throw new NotFoundException('Teacher not found');
    }
    if (teacher.schoolId !== section.schoolId) {
      throw new BadRequestException('Teacher belongs to a different school');
    }
    const assigned = await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await this.clearPrimary(tx, section.id);
      }
      // Idempotent on (sectionId, teacherId): re-assigning updates rather than
      // 409s, and never silently demotes an existing class teacher (isPrimary only set, never cleared).
      const row = await tx.sectionTeacher.upsert({
        where: {
          sectionId_teacherId: {
            sectionId: section.id,
            teacherId: teacher.id,
          },
        },
        create: {
          sectionId: section.id,
          teacherId: teacher.id,
          assignmentRole: dto.assignmentRole ?? null,
          isPrimary: dto.isPrimary ?? false,
          startDate: this.toDate(dto.startDate),
          endDate: this.toDate(dto.endDate),
        },
        update: {
          ...(dto.assignmentRole !== undefined && {
            assignmentRole: dto.assignmentRole,
          }),
          ...(dto.isPrimary ? { isPrimary: true } : {}),
          ...(dto.startDate !== undefined && {
            startDate: this.toDate(dto.startDate),
          }),
          ...(dto.endDate !== undefined && {
            endDate: this.toDate(dto.endDate),
          }),
        },
        include: this.assignmentInclude(),
      });
      // A demoted class teacher who teaches nothing here no longer belongs on the roster.
      await pruneSectionRoster(tx, section.id, row.id);
      return row;
    });
    await this.invalidateSchoolCache(section.schoolId, 'sections', 'classes');
    return assigned;
  }

  async updateTeacherAssignment(
    sectionId: string,
    assignmentId: string,
    dto: UpdateTeacherSectionDto,
    actor: Actor,
  ) {
    this.ensureAdmin(actor);
    const section = await this.getOrThrow(sectionId, actor);
    const assignment = await this.getAssignmentOrThrow(
      assignmentId,
      section.id,
    );
    let teacherId = assignment.teacherId;
    if (dto.teacherId && dto.teacherId !== assignment.teacherId) {
      const teacher = await this.prisma.teacherProfile.findUnique({
        where: { id: dto.teacherId },
      });
      if (!teacher) {
        throw new NotFoundException('Teacher not found');
      }
      if (teacher.schoolId !== section.schoolId) {
        throw new BadRequestException('Teacher belongs to a different school');
      }
      teacherId = teacher.id;
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await this.clearPrimary(tx, section.id, assignment.id);
      }
      const row = await tx.sectionTeacher.update({
        where: { id: assignment.id },
        data: {
          teacherId,
          ...(dto.assignmentRole !== undefined && {
            assignmentRole: dto.assignmentRole,
          }),
          ...(dto.isPrimary !== undefined && { isPrimary: dto.isPrimary }),
          ...(dto.startDate !== undefined && {
            startDate: this.toDate(dto.startDate),
          }),
          ...(dto.endDate !== undefined && {
            endDate: this.toDate(dto.endDate),
          }),
        },
        include: this.assignmentInclude(),
      });
      // Turning class teacher off can leave a teacher here who teaches nothing, including this row.
      await pruneSectionRoster(tx, section.id);
      return row;
    });
    await this.invalidateSchoolCache(section.schoolId, 'sections', 'classes');
    return updated;
  }

  async removeTeacherAssignment(
    sectionId: string,
    assignmentId: string,
    actor: Actor,
  ) {
    this.ensureAdmin(actor);
    const section = await this.getOrThrow(sectionId, actor);
    const assignment = await this.getAssignmentOrThrow(
      assignmentId,
      section.id,
    );
    await this.sectionTeachers.delete({ where: { id: assignment.id } });
    await this.invalidateSchoolCache(section.schoolId, 'sections', 'classes');
    return { success: true };
  }

  private async getOrThrow(id: string, actor: Actor) {
    const section = await this.prisma.section.findUnique({ where: { id } });
    if (!section) {
      throw new NotFoundException('Section not found');
    }

    if (actor.role === Role.TEACHER) {
      if (!actor.schoolId) {
        throw new ForbiddenException('No school context');
      }

      const teacher = await this.prisma.teacherProfile.findFirst({
        where: { userId: actor.userId, schoolId: actor.schoolId },
      });
      if (!teacher) {
        throw new ForbiddenException('Teacher profile not found');
      }

      const sectionTeacher = await this.sectionTeachers.findFirst({
        where: { teacherId: teacher.id, sectionId: section.id },
      });

      const sectionSubject = await this.prisma.sectionSubject.findFirst({
        where: { teacherId: teacher.id, sectionId: section.id },
      });

      if (!sectionTeacher && !sectionSubject) {
        throw new ForbiddenException('You are not assigned to this section');
      }
    } else {
      this.enforceScope(actor, section.schoolId);
    }

    return section;
  }

  private async getAssignmentOrThrow(id: string, sectionId: string) {
    const assignment = await this.sectionTeachers.findUnique({
      where: { id },
      include: this.assignmentInclude(),
    });
    if (!assignment || assignment.sectionId !== sectionId) {
      throw new NotFoundException('Teacher assignment not found');
    }
    return assignment;
  }

  private async clearPrimary(
    tx: Prisma.TransactionClient,
    sectionId: string,
    excludeId?: string,
  ) {
    await tx.sectionTeacher.updateMany({
      where: { sectionId, ...(excludeId && { id: { not: excludeId } }) },
      data: { isPrimary: false },
    });
  }

  private assignmentInclude() {
    return {
      teacher: {
        include: {
          socialLinks: true,
          user: {
            include: {
              socialLinks: true,
            },
          },
        },
      },
      section: { include: { classGrade: true } },
    };
  }

  private toDate(value?: string | null) {
    return value ? new Date(value) : null;
  }
}
