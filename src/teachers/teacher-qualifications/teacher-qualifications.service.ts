import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateTeacherQualificationDto } from './dto/create-teacher-qualification.dto';
import { UpdateTeacherQualificationDto } from './dto/update-teacher-qualification.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { FindQualificationsQueryDto } from './dto/find-qualifications-query.dto';

type UpdateTeacherQualificationInput = UpdateTeacherQualificationDto &
  Partial<CreateTeacherQualificationDto>;

@Injectable()
export class TeacherQualificationsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async create(dto: CreateTeacherQualificationDto, actor: Actor) {
    const teacher = await this.ensureTeacher(dto.teacherId, actor);
    return this.prisma.teacherQualification.create({
      data: {
        teacherId: teacher.id,
        title: dto.title,
        institution: dto.institution ?? null,
        completionYear: dto.completionYear ?? null,
        description: dto.description ?? null,
      },
      include: { teacher: true },
    });
  }

  async findAll(actor: Actor, query: FindQualificationsQueryDto) {
    this.ensureAdmin(actor);
    const where: any = {};

    if (query.teacherId) {
      // Try to find teacher by TeacherProfile ID first
      const teacherById = await this.prisma.teacherProfile.findUnique({
        where: { id: query.teacherId },
      });

      if (teacherById) {
        where.teacherId = teacherById.id;
      } else {
        // If not found, try by userId
        const teacherByUserId = await this.prisma.teacherProfile.findUnique({
          where: { userId: query.teacherId },
        });
        if (teacherByUserId) {
          where.teacherId = teacherByUserId.id;
        } else {
          // Teacher not found, return empty array
          return [];
        }
      }
    }

    if (actor.role === Role.SUPER_ADMIN) {
      if (query.schoolId) {
        where.teacher = { schoolId: query.schoolId };
      }
    } else {
      where.teacher = { schoolId: actor.schoolId! };
    }
    return this.prisma.teacherQualification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { teacher: true },
    });
  }

  async findOne(id: string, actor: Actor) {
    return this.getOrThrow(id, actor);
  }

  async update(id: string, dto: UpdateTeacherQualificationInput, actor: Actor) {
    const qualification = await this.getOrThrow(id, actor);
    let teacherId = qualification.teacherId;
    if (dto.teacherId && dto.teacherId !== qualification.teacherId) {
      const teacher = await this.ensureTeacher(dto.teacherId, actor);
      teacherId = teacher.id;
    }
    return this.prisma.teacherQualification.update({
      where: { id },
      data: {
        teacherId,
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.institution !== undefined && { institution: dto.institution }),
        ...(dto.completionYear !== undefined && {
          completionYear: dto.completionYear,
        }),
        ...(dto.description !== undefined && { description: dto.description }),
      },
      include: { teacher: true },
    });
  }

  async remove(id: string, actor: Actor) {
    await this.getOrThrow(id, actor);
    return this.prisma.teacherQualification.delete({ where: { id } });
  }

  private async ensureTeacher(teacherId: string, actor: Actor) {
    // Try to find by TeacherProfile ID first
    let teacher = await this.prisma.teacherProfile.findUnique({
      where: { id: teacherId },
    });

    // If not found, try to find by userId
    if (!teacher) {
      teacher = await this.prisma.teacherProfile.findUnique({
        where: { userId: teacherId },
      });
    }

    if (!teacher) {
      throw new NotFoundException('Teacher not found');
    }
    this.enforceScope(actor, teacher.schoolId);
    return teacher;
  }

  private async getOrThrow(id: string, actor: Actor) {
    const qualification = await this.prisma.teacherQualification.findUnique({
      where: { id },
      include: { teacher: true },
    });
    if (!qualification) {
      throw new NotFoundException('Teacher qualification not found');
    }
    this.enforceScope(actor, qualification.teacher.schoolId);
    return qualification;
  }
}
