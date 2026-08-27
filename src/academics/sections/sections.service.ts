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
    const created = await this.prisma.section.create({
      data: {
        classGradeId: dto.classGradeId,
        schoolId: grade.schoolId,
        name: dto.name,
        room: dto.room ?? null,
      },
    });
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
    return this.cachedSchoolList(scopedSchoolId, 'sections', variant, () => {
      const where: any = {};
      if (query.classGradeId) where.classGradeId = query.classGradeId;
      if (scopedSchoolId) where.schoolId = scopedSchoolId;
      // Include per-section counts so cards render subject/teacher/student
      // numbers without firing 3 requests each (was 1+3N per class page).
      return this.prisma.section.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { subjects: true, teachers: true, enrollments: true },
          },
        },
      });
    });
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
            teacher: true,
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
    const updated = await this.prisma.section.update({
      where: { id },
      data: {
        classGradeId,
        schoolId,
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.room !== undefined && { room: dto.room }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
    // Invalidate the original and (if moved) the destination school.
    await this.invalidateSchoolCache(section.schoolId, 'sections', 'classes');
    if (schoolId !== section.schoolId) {
      await this.invalidateSchoolCache(schoolId, 'sections', 'classes');
    }
    return updated;
  }

  async remove(id: string, actor: Actor) {
    const section = await this.getOrThrow(id, actor);
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
    if (dto.isPrimary) {
      await this.clearPrimary(section.id);
    }
    // Idempotent on (sectionId, teacherId): re-assigning updates rather than
    // 409s, and never silently demotes an existing class teacher (isPrimary only set, never cleared).
    return this.sectionTeachers.upsert({
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
        ...(dto.endDate !== undefined && { endDate: this.toDate(dto.endDate) }),
      },
      include: this.assignmentInclude(),
    });
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
    if (dto.isPrimary) {
      await this.clearPrimary(section.id, assignment.id);
    }
    return this.sectionTeachers.update({
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
        ...(dto.endDate !== undefined && { endDate: this.toDate(dto.endDate) }),
      },
      include: this.assignmentInclude(),
    });
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
    return { success: true };
  }

  private async getOrThrow(id: string, actor: Actor) {
    const section = await this.prisma.section.findUnique({ where: { id } });
    if (!section) {
      throw new NotFoundException('Section not found');
    }

    // If actor is a teacher, check if they are assigned to this section
    if (actor.role === Role.TEACHER) {
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

      // Check if teacher is assigned to this section (via SectionTeacher or SectionSubject)
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
      // For admins, enforce school scope
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

  private async clearPrimary(sectionId: string, excludeId?: string) {
    const where: any = { sectionId };
    if (excludeId) {
      where.id = { not: excludeId };
    }
    await this.sectionTeachers.updateMany({
      where,
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
