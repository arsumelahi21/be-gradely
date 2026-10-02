import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { CacheService } from '../../common/services/cache.service';
import { resolvePagination } from '../../common/dto/pagination-query.dto';

@Injectable()
export class TeachersService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService, cache: CacheService) {
    super(prisma, cache);
  }

  async findAll(actor: Actor, schoolId?: string) {
    this.ensureAdmin(actor);
    const scopedSchoolId =
      actor.role === Role.SUPER_ADMIN
        ? (schoolId ?? undefined)
        : actor.schoolId!;
    return this.cachedSchoolList(scopedSchoolId, 'teachers', 'all', () => {
      const where: any = {};
      if (scopedSchoolId) where.schoolId = scopedSchoolId;
      return this.prisma.teacherProfile.findMany({
        where,
        orderBy: { fullName: 'asc' },
        include: this.defaultInclude(),
      });
    });
  }

  async findOne(id: string, actor: Actor) {
    return this.getOrThrow(id, actor);
  }

  async remove(id: string, actor: Actor) {
    const teacher = await this.getOrThrow(id, actor);
    const removed = await this.prisma.teacherProfile.delete({ where: { id } });
    // The cascade drops their roster rows and unstaffs their subjects, so section cards change too.
    await this.invalidateSchoolCache(
      teacher.schoolId,
      'teachers',
      'sections',
      'classes',
    );
    return removed;
  }

  async listSections(teacherId: string, actor: Actor) {
    const teacher = await this.getOrThrow(teacherId, actor);
    const sectionTeachers = (this.prisma as any).sectionTeacher;
    return sectionTeachers.findMany({
      where: { teacherId: teacher.id },
      orderBy: { createdAt: 'asc' },
      include: {
        section: {
          include: {
            classGrade: true,
          },
        },
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
      },
    });
  }

  async listStudents(
    teacherId: string,
    actor: Actor,
    pagination: { page?: number; pageSize?: number } = {},
  ) {
    const teacher = await this.getOrThrow(teacherId, actor);
    const sectionTeachers = (this.prisma as any).sectionTeacher;
    const sectionSubjects = (this.prisma as any).sectionSubject;

    const sectionTeacherAssignments = await sectionTeachers.findMany({
      where: { teacherId: teacher.id },
      select: { sectionId: true },
    });

    const sectionSubjectAssignments = await sectionSubjects.findMany({
      where: { teacherId: teacher.id },
      select: {
        sectionId: true,
        subject: true,
        schedule: true,
        isPrimary: true,
      },
    });

    const sectionIds = [
      ...new Set([
        ...sectionTeacherAssignments.map((st: any) => st.sectionId),
        ...sectionSubjectAssignments.map((ss: any) => ss.sectionId),
      ]),
    ];

    // Backward-compatible: a plain array unless `page` is supplied, matching every other
    // list endpoint — count/dropdown callers keep working untouched.
    const paginate = pagination.page != null;
    const { page, pageSize, skip, take } = resolvePagination(pagination);

    if (sectionIds.length === 0) {
      return paginate ? { items: [], total: 0, page, pageSize } : [];
    }

    const where = {
      sectionId: { in: sectionIds },
      status: 'ACTIVE' as const,
    };
    const total = paginate
      ? await this.prisma.enrollment.count({ where })
      : undefined;

    const enrollments = await this.prisma.enrollment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...(paginate ? { skip, take } : {}),
      include: {
        // A teacher needs the roster, not the file: the profile also carries national id,
        // guardian phone, address, blood group, fee amount and the photo key.
        student: {
          select: {
            id: true,
            userId: true,
            schoolId: true,
            fullName: true,
            rollNo: true,
            admissionNo: true,
            email: true,
            gender: true,
            isActive: true,
            photoMimeType: true,
          },
        },
        section: {
          include: {
            classGrade: true,
          },
        },
        academicYear: true,
      },
    });

    const sectionSubjectMap = new Map<string, any[]>();
    sectionSubjectAssignments.forEach((ss: any) => {
      const sectionId = ss.sectionId;
      if (!sectionSubjectMap.has(sectionId)) {
        sectionSubjectMap.set(sectionId, []);
      }
      sectionSubjectMap.get(sectionId)!.push({
        subject: ss.subject,
        schedule: ss.schedule,
        isPrimary: ss.isPrimary,
      });
    });

    const items = enrollments.map((enrollment) => ({
      ...enrollment,
      subjectsTaughtByTeacher:
        sectionSubjectMap.get(enrollment.sectionId) || [],
    }));

    return paginate ? { items, total, page, pageSize } : items;
  }

  private async getOrThrow(id: string, actor: Actor) {
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id },
      include: this.defaultInclude(),
    });
    if (!teacher) {
      throw new NotFoundException('Teacher not found');
    }

    if (actor.role === Role.TEACHER) {
      if (teacher.userId !== actor.userId) {
        throw new ForbiddenException('Teachers can only access their own data');
      }
    } else {
      this.enforceScope(actor, teacher.schoolId);
    }

    return teacher;
  }

  private defaultInclude(): any {
    return {
      user: {
        include: {
          socialLinks: true,
        },
      },
      qualifications: true,
      specialties: {
        include: {
          subject: true,
        },
      },
      sections: {
        include: {
          section: true,
        },
      },
      socialLinks: true,
    };
  }
}
