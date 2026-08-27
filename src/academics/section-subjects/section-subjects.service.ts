import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateSectionSubjectDto } from './dto/create-section-subject.dto';
import { UpdateSectionSubjectDto } from './dto/update-section-subject.dto';
import { Actor } from '../../common/types/actor.type';
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
    return this.prisma.sectionSubject.update({
      where: { id },
      data: {
        sectionId: section.id,
        subjectId: subject.id,
        teacherId: teacherId ? (teacher?.id ?? null) : null,
        ...(dto.isPrimary !== undefined && { isPrimary: dto.isPrimary }),
        ...(dto.schedule !== undefined && { schedule: dto.schedule }),
      },
      include: this.defaultInclude(),
    });
  }

  async remove(id: string, actor: Actor) {
    await this.getOrThrow(id, actor);
    return this.prisma.sectionSubject.delete({ where: { id } });
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
