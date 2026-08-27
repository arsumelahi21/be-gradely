import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { BatchCreateEnrollmentDto } from './dto/batch-create-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { FindEnrollmentsQueryDto } from './dto/find-enrollments-query.dto';

type UpdateEnrollmentInput = UpdateEnrollmentDto & Partial<CreateEnrollmentDto>;

@Injectable()
export class EnrollmentsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async create(dto: CreateEnrollmentDto, actor: Actor) {
    const { student, section, academicYear } = await this.resolveEntities(
      dto.studentId,
      dto.sectionId,
      dto.academicYearId,
      actor,
    );
    return this.prisma.enrollment.create({
      data: {
        studentId: student.id,
        sectionId: section.id,
        academicYearId: academicYear.id,
        status: dto.status ?? 'ACTIVE',
        startDate: this.toDate(dto.startDate),
        endDate: this.toDate(dto.endDate),
      },
      include: this.defaultInclude(),
    });
  }

  async createMany(dto: BatchCreateEnrollmentDto, actor: Actor) {
    this.ensureAdmin(actor);

    const section = await this.prisma.section.findUnique({
      where: { id: dto.sectionId },
    });
    if (!section) {
      throw new NotFoundException('Section not found');
    }
    this.enforceScope(actor, section.schoolId);

    const academicYear = await this.prisma.academicYear.findUnique({
      where: { id: dto.academicYearId },
    });
    if (!academicYear) {
      throw new NotFoundException('Academic year not found');
    }
    if (academicYear.schoolId !== section.schoolId) {
      throw new BadRequestException(
        'Academic year must belong to the same school as the section',
      );
    }

    const studentIds = [...new Set(dto.studentIds)];
    // All students must exist and belong to the section's school — one cross-school
    // or missing id rejects the whole batch (tenant safety).
    const students = await this.prisma.studentProfile.findMany({
      where: { id: { in: studentIds }, schoolId: section.schoolId },
      select: { id: true },
    });
    if (students.length !== studentIds.length) {
      throw new BadRequestException(
        'One or more students were not found in this school',
      );
    }

    // `skipDuplicates` tolerates already-enrolled students (unique
    // [studentId, sectionId, academicYearId]) instead of failing the batch.
    const { count } = await this.prisma.enrollment.createMany({
      data: studentIds.map((studentId) => ({
        studentId,
        sectionId: section.id,
        academicYearId: academicYear.id,
        status: dto.status ?? 'ACTIVE',
      })),
      skipDuplicates: true,
    });

    return { created: count, skipped: studentIds.length - count };
  }

  async findAll(actor: Actor, query: FindEnrollmentsQueryDto) {
    const where: any = {};

    // If actor is a student, they can only see their own enrollments
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

      // Students can only view their own enrollments
      where.studentId = student.id;
      where.student = { schoolId: actor.schoolId };

      // Apply filters
      if (query.sectionId) where.sectionId = query.sectionId;
      if (query.academicYearId) where.academicYearId = query.academicYearId;
    }
    // If actor is a parent, they can only see enrollments for their children
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

      // Filter by children's enrollments
      where.studentId = { in: childStudentIds };
      where.student = { schoolId: actor.schoolId };

      // If studentId is provided, validate it's a child
      if (query.studentId) {
        if (!childStudentIds.includes(query.studentId)) {
          throw new ForbiddenException('Student is not your child');
        }
        where.studentId = query.studentId;
      }

      // Apply filters
      if (query.sectionId) where.sectionId = query.sectionId;
      if (query.academicYearId) where.academicYearId = query.academicYearId;
    }
    // If actor is a teacher, they can only see enrollments for sections they are assigned to
    else if (actor.role === Role.TEACHER) {
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

      // Get all sections assigned to this teacher (via SectionTeacher or SectionSubject)
      const sectionTeacher = (this.prisma as any).sectionTeacher;
      const sectionTeachers = await sectionTeacher.findMany({
        where: { teacherId: teacher.id },
        select: { sectionId: true },
      });

      const sectionSubjects = await this.prisma.sectionSubject.findMany({
        where: { teacherId: teacher.id },
        select: { sectionId: true },
      });

      const assignedSectionIds = [
        ...new Set([
          ...sectionTeachers.map((st: any) => st.sectionId),
          ...sectionSubjects.map((ss) => ss.sectionId),
        ]),
      ];

      if (assignedSectionIds.length === 0) {
        return [];
      }

      // If sectionId is provided, validate it's assigned to the teacher
      if (query.sectionId) {
        if (!assignedSectionIds.includes(query.sectionId)) {
          throw new ForbiddenException('You are not assigned to this section');
        }
        where.sectionId = query.sectionId;
      } else {
        // Otherwise, filter by all assigned sections
        where.sectionId = { in: assignedSectionIds };
      }

      // Apply other filters
      if (query.studentId) where.studentId = query.studentId;
      if (query.academicYearId) where.academicYearId = query.academicYearId;

      // Enforce school scope
      where.student = { schoolId: actor.schoolId };
    } else {
      // For admins, use existing logic
      this.ensureAdmin(actor);
      if (query.studentId) where.studentId = query.studentId;
      if (query.sectionId) where.sectionId = query.sectionId;
      if (query.academicYearId) where.academicYearId = query.academicYearId;
      if (actor.role === Role.SUPER_ADMIN) {
        if (query.schoolId) {
          where.student = { schoolId: query.schoolId };
        }
      } else {
        where.student = { schoolId: actor.schoolId! };
      }
    }

    return this.prisma.enrollment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: this.defaultInclude(),
    });
  }

  async findOne(id: string, actor: Actor) {
    // If actor is a student, they can only see their own enrollment
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

      const enrollment = await this.prisma.enrollment.findUnique({
        where: { id },
        include: this.defaultInclude(),
      });

      if (!enrollment) {
        throw new NotFoundException('Enrollment not found');
      }

      if (enrollment.studentId !== student.id) {
        throw new ForbiddenException('You can only view your own enrollments');
      }

      return enrollment;
    }
    // If actor is a parent, they can only see enrollments for their children
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

      const enrollment = await this.prisma.enrollment.findUnique({
        where: { id },
        include: this.defaultInclude(),
      });

      if (!enrollment) {
        throw new NotFoundException('Enrollment not found');
      }

      // Check if enrollment belongs to a child
      const parentStudentLink = await (
        this.prisma as any
      ).parentStudent.findUnique({
        where: {
          parentId_studentId: {
            parentId: parent.id,
            studentId: enrollment.studentId,
          },
        },
      });

      if (!parentStudentLink) {
        throw new ForbiddenException(
          'Enrollment does not belong to your child',
        );
      }

      return enrollment;
    }

    // For teachers and admins, use existing logic
    return this.getOrThrow(id, actor);
  }

  async update(id: string, dto: UpdateEnrollmentInput, actor: Actor) {
    const enrollment = await this.getOrThrow(id, actor);
    const studentId = dto.studentId ?? enrollment.studentId;
    const sectionId = dto.sectionId ?? enrollment.sectionId;
    const academicYearId = dto.academicYearId ?? enrollment.academicYearId;
    const { student, section, academicYear } = await this.resolveEntities(
      studentId,
      sectionId,
      academicYearId,
      actor,
    );
    return this.prisma.enrollment.update({
      where: { id },
      data: {
        studentId: student.id,
        sectionId: section.id,
        academicYearId: academicYear.id,
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.startDate !== undefined && {
          startDate: this.toDate(dto.startDate),
        }),
        ...(dto.endDate !== undefined && { endDate: this.toDate(dto.endDate) }),
      },
      include: this.defaultInclude(),
    });
  }

  async remove(id: string, actor: Actor) {
    await this.getOrThrow(id, actor);
    return this.prisma.enrollment.delete({ where: { id } });
  }

  private async getOrThrow(id: string, actor: Actor) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id },
      include: this.defaultInclude(),
    });
    if (!enrollment) {
      throw new NotFoundException('Enrollment not found');
    }

    // If actor is a teacher, check if they are assigned to the section
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
      const sectionTeacher = (this.prisma as any).sectionTeacher;
      const teacherAssignment = await sectionTeacher.findFirst({
        where: { teacherId: teacher.id, sectionId: enrollment.sectionId },
      });

      const subjectAssignment = await this.prisma.sectionSubject.findFirst({
        where: { teacherId: teacher.id, sectionId: enrollment.sectionId },
      });

      if (!teacherAssignment && !subjectAssignment) {
        throw new ForbiddenException('You are not assigned to this section');
      }

      // Also enforce school scope
      if (enrollment.student.schoolId !== actor.schoolId) {
        throw new ForbiddenException('Cross-school access denied');
      }
    } else {
      // For admins, enforce school scope
      this.enforceScope(actor, enrollment.student.schoolId);
    }

    return enrollment;
  }

  private async resolveEntities(
    studentId: string,
    sectionId: string,
    academicYearId: string,
    actor: Actor,
  ) {
    // Fetch the three independent rows in one round-trip; checks below run in the
    // same order as before, so the same error surfaces for the same bad input.
    const [student, section, academicYear] = await Promise.all([
      this.prisma.studentProfile.findUnique({ where: { id: studentId } }),
      this.prisma.section.findUnique({ where: { id: sectionId } }),
      this.prisma.academicYear.findUnique({ where: { id: academicYearId } }),
    ]);

    if (!student) {
      throw new NotFoundException('Student not found');
    }
    this.enforceScope(actor, student.schoolId);

    if (!section) {
      throw new NotFoundException('Section not found');
    }
    if (section.schoolId !== student.schoolId) {
      throw new BadRequestException(
        'Section must belong to the same school as the student',
      );
    }

    if (!academicYear) {
      throw new NotFoundException('Academic year not found');
    }
    if (academicYear.schoolId !== student.schoolId) {
      throw new BadRequestException(
        'Academic year must belong to the same school as the student',
      );
    }

    return { student, section, academicYear };
  }

  private toDate(value?: string) {
    return value ? new Date(value) : null;
  }

  private defaultInclude() {
    return {
      student: true,
      section: {
        include: {
          classGrade: true,
        },
      },
      academicYear: true,
    };
  }
}
