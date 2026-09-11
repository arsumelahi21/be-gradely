import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { BatchCreateEnrollmentDto } from './dto/batch-create-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { FindEnrollmentsQueryDto } from './dto/find-enrollments-query.dto';
import { FindPlacementsQueryDto } from './dto/find-placements-query.dto';

type UpdateEnrollmentInput = UpdateEnrollmentDto & Partial<CreateEnrollmentDto>;

/**
 * A defensive ceiling, not a page size.
 *
 * Paginating this would be wrong: the caller uses it as a SET — "is this
 * student already placed?" — so a student on page 2 would simply not be
 * excluded from the picker. It is bounded by the domain instead (one row per
 * enrolled student per year), and this is the guard for a school that is
 * somehow past that.
 */
const PLACEMENT_LIMIT = 20000;

/** Where one student sits this year. The shape the enrol picker types against. */
export interface StudentPlacement {
  studentId: string;
  sectionId: string;
  sectionName: string;
  classGradeId: string | null;
  className: string | null;
  /** "Grade 6 A", ready to print. */
  label: string;
}

/** "Grade 6 A" — what an admin calls the placement, from its two rows. */
function sectionLabel(section: {
  name: string;
  classGrade?: { name: string } | null;
}) {
  return `${section.classGrade?.name ?? ''} ${section.name}`.trim();
}

@Injectable()
export class EnrollmentsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService, cache: CacheService) {
    super(prisma, cache);
  }

  /**
   * Section cards show a student count from the cached sections list.
   *
   * `users`/`students` too: those lists can be FILTERED by enrollment
   * (`classGradeId`, `sectionId`, `unassignedAcademicYearId`), so placing or
   * removing a student changes who they return. Without this, the "Available
   * students" picker kept offering someone for the whole 5-minute TTL after
   * they were enrolled — and kept hiding them after they were removed.
   */
  private invalidate(schoolId: string) {
    return this.invalidateSchoolCache(
      schoolId,
      'sections',
      'classes',
      'users',
      'students',
    );
  }

  /**
   * A student sits in ONE class per academic year.
   *
   * The DB can't hold this line: its unique key is
   * [studentId, sectionId, academicYearId], which only stops the SAME section
   * twice — nothing there prevents Grade 6 A and Grade 10 B in the same year,
   * and 20 students had drifted into exactly that. A partial unique index
   * (ACTIVE rows only) is what this wants and Prisma cannot express one, so the
   * rule lives here. Note the consequence: two SIMULTANEOUS enrols of the same
   * student can both pass this read under READ COMMITTED. Admins enrol
   * interactively, so that window is theoretical — but this is a check, not a
   * constraint.
   *
   * Only ACTIVE rows count: a COMPLETED or INACTIVE placement is history and
   * must not block the student's next class.
   */
  private async findActivePlacements(
    studentIds: string[],
    academicYearId: string,
    excludeEnrollmentId?: string,
  ) {
    const placements = new Map<string, { sectionId: string; label: string }>();
    if (!studentIds.length) return placements;

    const rows = await this.prisma.enrollment.findMany({
      where: {
        studentId: { in: studentIds },
        academicYearId,
        status: EnrollmentStatus.ACTIVE,
        ...(excludeEnrollmentId && { id: { not: excludeEnrollmentId } }),
      },
      // Newest placement wins for a student who already holds several — the
      // same rule the fee roster uses, so both name the same class. `id` breaks
      // the tie: rows written in one transaction share a `createdAt` (Postgres
      // now() is transaction-start), and without it "newest" falls back to
      // whatever order the DB happens to return.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        studentId: true,
        sectionId: true,
        section: {
          select: { name: true, classGrade: { select: { name: true } } },
        },
      },
    });

    for (const row of rows) {
      if (placements.has(row.studentId)) continue;
      placements.set(row.studentId, {
        sectionId: row.sectionId,
        label: sectionLabel(row.section),
      });
    }
    return placements;
  }

  /**
   * Who already holds a class this year — the minimum the enrol picker needs in
   * order to leave a student out of the "available" pool.
   *
   * Deliberately not findAll(): that is unbounded and carries the full nested
   * include per row, where the picker wants two ids and a label.
   */
  async listPlacements(
    query: FindPlacementsQueryDto,
    actor: Actor,
  ): Promise<StudentPlacement[]> {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, query.schoolId);

    const rows = await this.prisma.enrollment.findMany({
      where: {
        academicYearId: query.academicYearId,
        status: EnrollmentStatus.ACTIVE,
        student: { schoolId },
      },
      // Same tiebreak as findActivePlacements: both have to name the same class
      // for a student who holds several, or the picker and the write path
      // disagree about where they already are.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PLACEMENT_LIMIT + 1,
      select: {
        studentId: true,
        sectionId: true,
        section: {
          select: {
            name: true,
            classGrade: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (rows.length > PLACEMENT_LIMIT) {
      throw new BadRequestException(
        `This academic year has over ${PLACEMENT_LIMIT} active enrollments, which is more than the enrolment picker can check at once.`,
      );
    }

    // ONE row per student. A legacy double placement would otherwise send the
    // same student down twice and the caller's lookup would keep DB order.
    const seen = new Map<string, StudentPlacement>();
    for (const row of rows) {
      if (seen.has(row.studentId)) continue;
      seen.set(row.studentId, {
        studentId: row.studentId,
        sectionId: row.sectionId,
        sectionName: row.section.name,
        classGradeId: row.section.classGrade?.id ?? null,
        className: row.section.classGrade?.name ?? null,
        label: sectionLabel(row.section),
      });
    }
    return [...seen.values()];
  }

  async create(dto: CreateEnrollmentDto, actor: Actor) {
    const { student, section, academicYear } = await this.resolveEntities(
      dto.studentId,
      dto.sectionId,
      dto.academicYearId,
      actor,
    );
    if ((dto.status ?? EnrollmentStatus.ACTIVE) === EnrollmentStatus.ACTIVE) {
      const placed = (
        await this.findActivePlacements([student.id], academicYear.id)
      ).get(student.id);
      if (placed) {
        throw new ConflictException(
          `${student.fullName} is already enrolled in ${placed.label} for this academic year. A student can only be in one class at a time — move them instead of adding a second placement.`,
        );
      }
    }

    const created = await this.prisma.enrollment.create({
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
    await this.invalidate(section.schoolId);
    return created;
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
      select: { id: true, fullName: true },
    });
    if (students.length !== studentIds.length) {
      throw new BadRequestException(
        'One or more students were not found in this school',
      );
    }

    // One class per student per year. A student already sitting in ANOTHER
    // class is dropped from the batch rather than failing it: the picker
    // filters them out, so anything arriving here is a stale tab or a direct
    // API call, and one of those must not cost the operator the other 29.
    // Already in THIS section stays the benign case skipDuplicates covered.
    const status = dto.status ?? EnrollmentStatus.ACTIVE;
    const placements =
      status === EnrollmentStatus.ACTIVE
        ? await this.findActivePlacements(studentIds, academicYear.id)
        : new Map<string, { sectionId: string; label: string }>();

    const nameById = new Map(students.map((s) => [s.id, s.fullName]));
    const blocked: {
      studentId: string;
      fullName: string;
      className: string;
    }[] = [];
    const eligible: string[] = [];
    for (const studentId of studentIds) {
      const placed = placements.get(studentId);
      if (placed && placed.sectionId !== section.id) {
        blocked.push({
          studentId,
          fullName: nameById.get(studentId) ?? 'Student',
          className: placed.label,
        });
        continue;
      }
      eligible.push(studentId);
    }

    // `skipDuplicates` still covers the same-section re-add (unique
    // [studentId, sectionId, academicYearId]) instead of failing the batch.
    const { count } = eligible.length
      ? await this.prisma.enrollment.createMany({
          data: eligible.map((studentId) => ({
            studentId,
            sectionId: section.id,
            academicYearId: academicYear.id,
            status,
          })),
          skipDuplicates: true,
        })
      : { count: 0 };

    await this.invalidate(section.schoolId);
    // The three are disjoint and sum to studentIds.length: `skipped` counts
    // only the ones the DB itself skipped (already in THIS section), so it no
    // longer double-reports the students `blocked` already names.
    return { created: count, skipped: eligible.length - count, blocked };
  }

  async findAll(actor: Actor, query: FindEnrollmentsQueryDto) {
    const where: any = {};

    // Current roster by default — every caller asks "who is in this section",
    // and promotion CLOSES the old placement (status COMPLETED) rather than
    // deleting it, so an unfiltered list kept showing promoted students in the
    // class they had already left. Pass `status` explicitly to read history.
    where.status = query.status ?? EnrollmentStatus.ACTIVE;

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
    // Re-activating or re-pointing a row is the other way into two classes.
    const nextStatus = dto.status ?? enrollment.status;
    if (nextStatus === EnrollmentStatus.ACTIVE) {
      const placed = (
        await this.findActivePlacements([student.id], academicYear.id, id)
      ).get(student.id);
      if (placed) {
        throw new ConflictException(
          `${student.fullName} is already enrolled in ${placed.label} for this academic year. A student can only be in one class at a time.`,
        );
      }
    }

    const updated = await this.prisma.enrollment.update({
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
    await this.invalidate(section.schoolId);
    return updated;
  }

  async remove(id: string, actor: Actor) {
    const existing = await this.getOrThrow(id, actor);
    const removed = await this.prisma.enrollment.delete({ where: { id } });
    await this.invalidate(existing.section.schoolId);
    return removed;
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
