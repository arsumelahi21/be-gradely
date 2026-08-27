import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateTeacherSubjectSpecialtyDto } from './dto/create-teacher-subject-specialty.dto';
import { UpdateTeacherSubjectSpecialtyDto } from './dto/update-teacher-subject-specialty.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { FindSpecialtiesQueryDto } from './dto/find-specialties-query.dto';

type UpdateTeacherSubjectSpecialtyInput = UpdateTeacherSubjectSpecialtyDto &
  Partial<CreateTeacherSubjectSpecialtyDto>;

@Injectable()
export class TeacherSubjectSpecialtiesService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async create(dto: CreateTeacherSubjectSpecialtyDto, actor: Actor) {
    const { teacher, subject } = await this.resolveEntities(
      dto.teacherId,
      dto.subjectId,
      actor,
    );
    return this.prisma.teacherSubjectSpecialty.create({
      data: {
        teacherId: teacher.id,
        subjectId: subject.id,
        expertiseLevel: dto.expertiseLevel ?? 'GENERALIST',
        experienceYears: dto.experienceYears ?? null,
        notes: dto.notes ?? null,
      },
      include: this.defaultInclude(),
    });
  }

  async findAll(actor: Actor, query: FindSpecialtiesQueryDto) {
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

    if (query.subjectId) where.subjectId = query.subjectId;
    if (actor.role === Role.SUPER_ADMIN) {
      if (query.schoolId) {
        where.teacher = { schoolId: query.schoolId };
      }
    } else {
      where.teacher = { schoolId: actor.schoolId! };
    }
    return this.prisma.teacherSubjectSpecialty.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: this.defaultInclude(),
    });
  }

  async findOne(id: string, actor: Actor) {
    return this.getOrThrow(id, actor);
  }

  async update(
    id: string,
    dto: UpdateTeacherSubjectSpecialtyInput,
    actor: Actor,
  ) {
    const current = await this.getOrThrow(id, actor);
    const teacherId = dto.teacherId ?? current.teacherId;
    const subjectId = dto.subjectId ?? current.subjectId;
    const { teacher, subject } = await this.resolveEntities(
      teacherId,
      subjectId,
      actor,
    );
    return this.prisma.teacherSubjectSpecialty.update({
      where: { id },
      data: {
        teacherId: teacher.id,
        subjectId: subject.id,
        ...(dto.expertiseLevel !== undefined && {
          expertiseLevel: dto.expertiseLevel,
        }),
        ...(dto.experienceYears !== undefined && {
          experienceYears: dto.experienceYears,
        }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
      include: this.defaultInclude(),
    });
  }

  async remove(id: string, actor: Actor) {
    await this.getOrThrow(id, actor);
    return this.prisma.teacherSubjectSpecialty.delete({ where: { id } });
  }

  private async getOrThrow(id: string, actor: Actor) {
    const record = await this.prisma.teacherSubjectSpecialty.findUnique({
      where: { id },
      include: this.defaultInclude(),
    });
    if (!record) {
      throw new NotFoundException('Teacher subject specialty not found');
    }
    this.enforceScope(actor, record.teacher.schoolId);
    return record;
  }

  private async resolveEntities(
    teacherId: string,
    subjectId: string,
    actor: Actor,
  ) {
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

    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
    });
    if (!subject) {
      throw new NotFoundException('Subject not found');
    }
    if (subject.schoolId !== teacher.schoolId) {
      throw new BadRequestException(
        'Subject must belong to the same school as the teacher',
      );
    }

    return { teacher, subject };
  }

  private defaultInclude() {
    return {
      teacher: true,
      subject: true,
    };
  }
}
