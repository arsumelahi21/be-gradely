import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EnrollmentStatus, Prisma } from '@prisma/client';
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
import {
  clearSelections,
  recordedSubjects,
  selectAllElectives,
} from '../section-subjects/subject-takers';

type UpdateEnrollmentInput = UpdateEnrollmentDto & Partial<CreateEnrollmentDto>;

// A defensive ceiling, not a page size: callers use the result as a SET ("already
// placed?"), so paginating would let a page-2 student back into the picker.
const PLACEMENT_LIMIT = 20000;

export interface StudentPlacement {
  studentId: string;
  sectionId: string;
  sectionName: string;
  classGradeId: string | null;
  className: string | null;
  /** "Grade 6 A", ready to print. */
  label: string;
}

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

  // `users`/`students` too: those lists filter by enrollment, so without this the
  // "Available students" picker served stale placements for the whole cache TTL.
  private invalidate(schoolId: string) {
    return this.invalidateSchoolCache(
      schoolId,
      'sections',
      'classes',
      'users',
      'students',
    );
  }

  // One ACTIVE class per year is enforced by the raw-SQL partial index `Enrollment_one_active_per_year`;
  // this read stays so the 409 can name the student's current class, which its P2002 cannot.
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
      select: {
        studentId: true,
        sectionId: true,
        section: {
          select: { name: true, classGrade: { select: { name: true } } },
        },
      },
    });

    for (const row of rows) {
      placements.set(row.studentId, {
        sectionId: row.sectionId,
        label: sectionLabel(row.section),
      });
    }
    return placements;
  }

  // Deliberately not findAll(): that is unbounded with a full nested include, where the
  // enrol picker only needs two ids and a label to hide already-placed students.
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

    return rows.map((row) => ({
      studentId: row.studentId,
      sectionId: row.sectionId,
      sectionName: row.section.name,
      classGradeId: row.section.classGrade?.id ?? null,
      className: row.section.classGrade?.name ?? null,
      label: sectionLabel(row.section),
    }));
  }

  async create(dto: CreateEnrollmentDto, actor: Actor) {
    const status = dto.status ?? EnrollmentStatus.ACTIVE;
    if (dto.sectionSubjectIds && status !== EnrollmentStatus.ACTIVE) {
      throw new BadRequestException(
        'Subjects can only be chosen for an active enrollment',
      );
    }
    const { student, section, academicYear } = await this.resolveEntities(
      dto.studentId,
      dto.sectionId,
      dto.academicYearId,
      actor,
    );
    const picks = dto.sectionSubjectIds
      ? await this.resolvePicks(section, dto.sectionSubjectIds)
      : null;
    if (status === EnrollmentStatus.ACTIVE) {
      const placed = (
        await this.findActivePlacements([student.id], academicYear.id)
      ).get(student.id);
      if (placed) {
        throw new ConflictException(
          `${student.fullName} is already enrolled in ${placed.label} for this academic year. A student can only be in one class at a time — move them instead of adding a second placement.`,
        );
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.enrollment.create({
        data: {
          studentId: student.id,
          sectionId: section.id,
          academicYearId: academicYear.id,
          status,
          startDate: this.toDate(dto.startDate),
          endDate: this.toDate(dto.endDate),
        },
        include: this.defaultInclude(),
      });
      if (picks) {
        // Replace, not add: a closed placement in this class keeps its picks.
        await this.replacePicks(tx, row, section.classGradeId, academicYear, {
          name: student.fullName,
          picks,
        });
      } else if (row.status === EnrollmentStatus.ACTIVE) {
        await selectAllElectives(tx, [row]);
      }
      return row;
    });
    await this.invalidate(section.schoolId);
    return created;
  }

  /**
   * The StudentSubject rows a subject choice writes. Any section of the
   * placement's class may supply a subject; only the placement's own compulsory
   * subjects need no row, since everyone placed there takes them already.
   */
  private async resolvePicks(
    section: { id: string; classGradeId: string; schoolId: string },
    sectionSubjectIds: string[],
  ) {
    const [chosen, ownCompulsory] = await Promise.all([
      this.prisma.sectionSubject.findMany({
        where: {
          id: { in: sectionSubjectIds },
          section: {
            classGradeId: section.classGradeId,
            schoolId: section.schoolId,
          },
        },
        select: {
          id: true,
          isElective: true,
          sectionId: true,
          subjectId: true,
          subject: { select: { name: true } },
        },
      }),
      this.prisma.sectionSubject.findMany({
        where: { sectionId: section.id, isElective: false },
        select: {
          id: true,
          subjectId: true,
          subject: { select: { name: true } },
        },
      }),
    ]);
    if (chosen.length !== sectionSubjectIds.length) {
      throw new BadRequestException(
        'One or more of the chosen subjects are not taught in this class',
      );
    }

    // ponytail: enforced here rather than by a constraint — StudentSubject has
    // no subjectId column to key one on; a concurrent enrolment of the same
    // student is already stopped by the one-ACTIVE-placement index.
    const offeringsOf = new Map<string, { name: string; ids: Set<string> }>();
    for (const o of [...chosen, ...ownCompulsory]) {
      const entry = offeringsOf.get(o.subjectId) ?? {
        name: o.subject.name,
        ids: new Set<string>(),
      };
      entry.ids.add(o.id);
      offeringsOf.set(o.subjectId, entry);
    }
    const repeated = [...offeringsOf.values()].filter((s) => s.ids.size > 1);
    if (repeated.length) {
      throw new BadRequestException(
        `${repeated.map((s) => s.name).join(', ')} can only be taken from one section`,
      );
    }
    return chosen.filter((o) => o.isElective || o.sectionId !== section.id);
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

    // A student ACTIVE in ANOTHER class is dropped (reported as `blocked`), not fatal: it can
    // only be a stale tab or direct API call, and must not cost the rest of the batch.
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

    // A student who sat here before still has the row, so `skipDuplicates` alone would
    // skip them and re-open nothing. One transaction, so a batch can't half-apply.
    const created = eligible.length
      ? await this.prisma.$transaction(async (tx) => {
          const reopened =
            status === EnrollmentStatus.ACTIVE
              ? await tx.enrollment.updateMany({
                  where: {
                    sectionId: section.id,
                    academicYearId: academicYear.id,
                    studentId: { in: eligible },
                    status: { not: EnrollmentStatus.ACTIVE },
                  },
                  data: {
                    status: EnrollmentStatus.ACTIVE,
                    startDate: new Date(),
                    endDate: null,
                  },
                })
              : { count: 0 };
          const inserted = await tx.enrollment.createMany({
            data: eligible.map((studentId) => ({
              studentId,
              sectionId: section.id,
              academicYearId: academicYear.id,
              status,
            })),
            skipDuplicates: true,
          });
          if (status === EnrollmentStatus.ACTIVE) {
            await selectAllElectives(
              tx,
              eligible
                .filter((studentId) => !placements.has(studentId))
                .map((studentId) => ({
                  studentId,
                  sectionId: section.id,
                  academicYearId: academicYear.id,
                })),
            );
          }
          return reopened.count + inserted.count;
        })
      : 0;

    await this.invalidate(section.schoolId);
    // The three are disjoint and sum to studentIds.length: `skipped` is only students
    // already ACTIVE in THIS section, so it never double-counts `blocked`.
    return { created, skipped: eligible.length - created, blocked };
  }

  async findAll(actor: Actor, query: FindEnrollmentsQueryDto) {
    const where: any = {};

    // ACTIVE by default: promotion marks the old placement COMPLETED rather than deleting it,
    // so unfiltered lists showed students in classes they had left. Pass `status` for history.
    where.status = query.status ?? EnrollmentStatus.ACTIVE;

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

      where.studentId = student.id;
      where.student = { schoolId: actor.schoolId };

      if (query.sectionId) where.sectionId = query.sectionId;
      if (query.academicYearId) where.academicYearId = query.academicYearId;
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

      where.studentId = { in: childStudentIds };
      where.student = { schoolId: actor.schoolId };

      if (query.studentId) {
        if (!childStudentIds.includes(query.studentId)) {
          throw new ForbiddenException('Student is not your child');
        }
        where.studentId = query.studentId;
      }

      if (query.sectionId) where.sectionId = query.sectionId;
      if (query.academicYearId) where.academicYearId = query.academicYearId;
    } else if (actor.role === Role.TEACHER) {
      if (!actor.schoolId) {
        throw new ForbiddenException('No school context');
      }

      const teacher = await this.prisma.teacherProfile.findFirst({
        where: { userId: actor.userId, schoolId: actor.schoolId },
      });
      if (!teacher) {
        throw new ForbiddenException('Teacher profile not found');
      }

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

      if (query.sectionId) {
        if (!assignedSectionIds.includes(query.sectionId)) {
          throw new ForbiddenException('You are not assigned to this section');
        }
        where.sectionId = query.sectionId;
      } else {
        where.sectionId = { in: assignedSectionIds };
      }

      if (query.studentId) where.studentId = query.studentId;
      if (query.academicYearId) where.academicYearId = query.academicYearId;

      where.student = { schoolId: actor.schoolId };
    } else {
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

      const enrollment = await this.prisma.enrollment.findUnique({
        where: { id },
        include: this.defaultInclude(),
      });

      if (!enrollment) {
        throw new NotFoundException('Enrollment not found');
      }

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
    if (dto.sectionSubjectIds && nextStatus !== EnrollmentStatus.ACTIVE) {
      throw new BadRequestException(
        'Subjects can only be chosen for an active enrollment',
      );
    }
    const picks = dto.sectionSubjectIds
      ? await this.resolvePicks(section, dto.sectionSubjectIds)
      : null;
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

    const moved =
      student.id !== enrollment.studentId ||
      section.id !== enrollment.sectionId ||
      academicYear.id !== enrollment.academicYearId;
    // Picks within the same class and session are diffed by replacePicks, which
    // keeps a recorded subject from being dropped by a move.
    const repicksInClass =
      !!picks &&
      student.id === enrollment.studentId &&
      academicYear.id === enrollment.academicYearId &&
      section.classGradeId === enrollment.section.classGradeId;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Selections hang off the old section's subjects, so they leave with it.
      if (moved && !repicksInClass) await clearSelections(tx, enrollment);
      const row = await tx.enrollment.update({
        where: { id },
        data: {
          studentId: student.id,
          sectionId: section.id,
          academicYearId: academicYear.id,
          ...(dto.status !== undefined && { status: dto.status }),
          ...(dto.startDate !== undefined && {
            startDate: this.toDate(dto.startDate),
          }),
          ...(dto.endDate !== undefined && {
            endDate: this.toDate(dto.endDate),
          }),
        },
        include: this.defaultInclude(),
      });
      if (picks) {
        await this.replacePicks(tx, row, section.classGradeId, academicYear, {
          name: student.fullName,
          picks,
        });
      } else if (
        // Only a new placement gets the default; re-saving one must not re-tick
        // subjects the admin unticked.
        row.status === EnrollmentStatus.ACTIVE &&
        (moved || enrollment.status !== EnrollmentStatus.ACTIVE)
      ) {
        await selectAllElectives(tx, [row]);
      }
      return row;
    });
    await this.invalidate(section.schoolId);
    return updated;
  }

  /**
   * Makes the placement's picks for the session exactly `picks`, across every
   * section of the class. A subject with marks or attendance this session can't
   * be dropped here — the same rule the section subject grid applies.
   */
  private async replacePicks(
    tx: Prisma.TransactionClient,
    placement: { studentId: string; academicYearId: string; sectionId: string },
    classGradeId: string,
    year: { id: string; startDate: Date; endDate: Date; schoolId: string },
    choice: {
      name: string;
      picks: { id: string; subject: { name: string } }[];
    },
  ) {
    const held = await tx.studentSubject.findMany({
      where: {
        studentId: placement.studentId,
        academicYearId: placement.academicYearId,
        sectionSubject: { section: { classGradeId } },
      },
      select: {
        sectionSubjectId: true,
        sectionSubject: {
          select: {
            sectionId: true,
            isElective: true,
            subject: { select: { name: true } },
          },
        },
      },
    });
    const wanted = new Set(choice.picks.map((p) => p.id));
    const dropped = held.filter((h) => !wanted.has(h.sectionSubjectId));
    // A row on the placement's own compulsory subject goes, but isn't a loss:
    // the student still takes it (after a move into that section).
    const lost = dropped.filter(
      (d) =>
        d.sectionSubject.isElective ||
        d.sectionSubject.sectionId !== placement.sectionId,
    );
    const kept = (
      await recordedSubjects(
        tx,
        [placement.studentId],
        lost.map((d) => d.sectionSubjectId),
        year,
      )
    ).get(placement.studentId);
    if (kept?.size) {
      const names = lost
        .filter((d) => kept.has(d.sectionSubjectId))
        .map((d) => d.sectionSubject.subject.name)
        .join(', ');
      throw new ConflictException(
        `Marks or attendance are already recorded for ${choice.name} in ${names} this session. Keep those subjects, or remove the records first.`,
      );
    }
    await tx.studentSubject.deleteMany({
      where: {
        studentId: placement.studentId,
        academicYearId: placement.academicYearId,
        sectionSubjectId: { in: dropped.map((d) => d.sectionSubjectId) },
      },
    });
    await tx.studentSubject.createMany({
      data: choice.picks.map((p) => ({
        schoolId: year.schoolId,
        academicYearId: placement.academicYearId,
        studentId: placement.studentId,
        sectionSubjectId: p.id,
      })),
      skipDuplicates: true,
    });
  }

  async remove(id: string, actor: Actor) {
    const existing = await this.getOrThrow(id, actor);
    const removed = await this.prisma.$transaction(async (tx) => {
      await clearSelections(tx, existing);
      return tx.enrollment.delete({ where: { id } });
    });
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

      if (enrollment.student.schoolId !== actor.schoolId) {
        throw new ForbiddenException('Cross-school access denied');
      }
    } else {
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
      // Enrolment rows are read by teachers too, so this carries only what a roster
      // renders — never the national id, guardian phone or address on the profile.
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
    };
  }
}
