import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateTeacherDto } from './dto/create-teacher.dto';
import { UpdateTeacherDto } from './dto/update-teacher.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { CacheService } from '../../common/services/cache.service';

type UpdateTeacherInput = UpdateTeacherDto & Partial<CreateTeacherDto>;

@Injectable()
export class TeachersService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService, cache: CacheService) {
    super(prisma, cache);
  }

  async create(dto: CreateTeacherDto, actor: Actor) {
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);
    await this.ensureSchoolExists(schoolId);
    const userId = dto.userId
      ? await this.validateUserLink(dto.userId, schoolId)
      : null;
    const created = await this.prisma.teacherProfile.create({
      data: {
        schoolId,
        userId,
        fullName: dto.fullName,
        employeeCode: dto.employeeCode,
        designation: dto.designation ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        phoneSecondary: dto.phoneSecondary ?? null,
        addressLine1: dto.addressLine1 ?? null,
        addressLine2: dto.addressLine2 ?? null,
        city: dto.city ?? null,
        state: dto.state ?? null,
        postalCode: dto.postalCode ?? null,
        country: dto.country ?? null,
        emergencyContactName: dto.emergencyContactName ?? null,
        emergencyContactPhone: dto.emergencyContactPhone ?? null,
        hireDate: this.toDate(dto.hireDate),
        about: dto.about ?? null,
        isActive: dto.isActive ?? true,
      } as any,
      include: this.defaultInclude(),
    });
    await this.invalidateSchoolCache(schoolId, 'teachers');
    return created;
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

  async update(id: string, dto: UpdateTeacherInput, actor: Actor) {
    const teacher = await this.getOrThrow(id, actor);
    let targetSchoolId = teacher.schoolId;
    if (dto.schoolId && dto.schoolId !== teacher.schoolId) {
      if (actor.role !== Role.SUPER_ADMIN) {
        throw new ForbiddenException(
          'Only SUPER_ADMIN can move teachers across schools',
        );
      }
      await this.ensureSchoolExists(dto.schoolId);
      targetSchoolId = dto.schoolId;
    }
    let userId = teacher.userId;
    if (dto.userId !== undefined) {
      if (!dto.userId) {
        userId = null;
      } else if (dto.userId !== teacher.userId) {
        userId = await this.validateUserLink(
          dto.userId,
          targetSchoolId,
          teacher.id,
        );
      }
    }
    const updated = await this.prisma.teacherProfile.update({
      where: { id },
      data: {
        ...(dto.fullName !== undefined && { fullName: dto.fullName }),
        ...(dto.employeeCode !== undefined && {
          employeeCode: dto.employeeCode,
        }),
        ...(dto.designation !== undefined && { designation: dto.designation }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.phoneSecondary !== undefined && {
          phoneSecondary: dto.phoneSecondary,
        }),
        ...(dto.addressLine1 !== undefined && {
          addressLine1: dto.addressLine1,
        }),
        ...(dto.addressLine2 !== undefined && {
          addressLine2: dto.addressLine2,
        }),
        ...(dto.city !== undefined && { city: dto.city }),
        ...(dto.state !== undefined && { state: dto.state }),
        ...(dto.postalCode !== undefined && { postalCode: dto.postalCode }),
        ...(dto.country !== undefined && { country: dto.country }),
        ...(dto.emergencyContactName !== undefined && {
          emergencyContactName: dto.emergencyContactName,
        }),
        ...(dto.emergencyContactPhone !== undefined && {
          emergencyContactPhone: dto.emergencyContactPhone,
        }),
        ...(dto.about !== undefined && { about: dto.about }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.hireDate !== undefined && {
          hireDate: this.toDate(dto.hireDate),
        }),
        ...(dto.schoolId !== undefined &&
          actor.role === Role.SUPER_ADMIN &&
          dto.schoolId !== teacher.schoolId && {
            schoolId: targetSchoolId,
          }),
        userId,
      },
      include: this.defaultInclude(),
    });
    await this.invalidateSchoolCache(teacher.schoolId, 'teachers');
    if (targetSchoolId !== teacher.schoolId) {
      await this.invalidateSchoolCache(targetSchoolId, 'teachers');
    }
    return updated;
  }

  async remove(id: string, actor: Actor) {
    const teacher = await this.getOrThrow(id, actor);
    const removed = await this.prisma.teacherProfile.delete({ where: { id } });
    await this.invalidateSchoolCache(teacher.schoolId, 'teachers');
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

  async listStudents(teacherId: string, actor: Actor) {
    const teacher = await this.getOrThrow(teacherId, actor);
    const sectionTeachers = (this.prisma as any).sectionTeacher;
    const sectionSubjects = (this.prisma as any).sectionSubject;

    // Get all sections where teacher is assigned (SectionTeacher)
    const sectionTeacherAssignments = await sectionTeachers.findMany({
      where: { teacherId: teacher.id },
      select: { sectionId: true },
    });

    // Get all sections where teacher teaches subjects (SectionSubject) with subject details
    const sectionSubjectAssignments = await sectionSubjects.findMany({
      where: { teacherId: teacher.id },
      select: {
        sectionId: true,
        subject: true,
        schedule: true,
        isPrimary: true,
      },
    });

    // Combine and get unique section IDs
    const sectionIds = [
      ...new Set([
        ...sectionTeacherAssignments.map((st: any) => st.sectionId),
        ...sectionSubjectAssignments.map((ss: any) => ss.sectionId),
      ]),
    ];

    if (sectionIds.length === 0) {
      return [];
    }

    // Get all enrollments for these sections
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        sectionId: { in: sectionIds },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        student: true,
        section: {
          include: {
            classGrade: true,
          },
        },
        academicYear: true,
      },
    });

    // Build map of subjects taught by this teacher per section
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

    // Enrich enrollments with subjects taught by this teacher
    return enrollments.map((enrollment) => ({
      ...enrollment,
      subjectsTaughtByTeacher:
        sectionSubjectMap.get(enrollment.sectionId) || [],
    }));
  }

  private async getOrThrow(id: string, actor: Actor) {
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id },
      include: this.defaultInclude(),
    });
    if (!teacher) {
      throw new NotFoundException('Teacher not found');
    }

    // If actor is a TEACHER, they can only access their own profile
    if (actor.role === Role.TEACHER) {
      if (teacher.userId !== actor.userId) {
        throw new ForbiddenException('Teachers can only access their own data');
      }
    } else {
      // For admins, enforce school scope
      this.enforceScope(actor, teacher.schoolId);
    }

    return teacher;
  }

  private async validateUserLink(
    userId: string,
    schoolId: string,
    teacherId?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Linked user not found');
    }
    if (user.role !== Role.TEACHER) {
      throw new BadRequestException('Linked user must be a TEACHER');
    }
    if (user.schoolId && user.schoolId !== schoolId) {
      throw new BadRequestException('Linked user belongs to another school');
    }
    const existing = await this.prisma.teacherProfile.findUnique({
      where: { userId },
    });
    if (existing && existing.id !== teacherId) {
      throw new BadRequestException(
        'User is already linked to another teacher',
      );
    }
    return userId;
  }

  private toDate(value?: string | null) {
    return value ? new Date(value) : null;
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
