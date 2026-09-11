import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EnrollmentStatus, Prisma, TimetableStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { AuditLogService } from '../../audit/audit.service';
import { Actor } from '../../common/types/actor.type';
import { FindPromotionStudentsQueryDto } from './dto/find-promotion-students-query.dto';
import { FindDestinationQueryDto } from './dto/find-destination-query.dto';
import { PromotionPlanDto } from './dto/promotion-plan.dto';
import {
  DestinationSection,
  PromotionPlan,
  PromotionPlanItem,
  SourceEnrollment,
  TargetEnrollment,
  buildPromotionPlan,
  placementLabel,
  sectionKey,
  suggestNextClass,
  suggestSectionName,
} from './promotion-planner';

/**
 * A defensive ceiling on the source roster read, not a page size: the dialog
 * needs the whole class at once to offer Select All, and a promotion run is
 * bounded by a class, not by a school.
 */
const MAX_SOURCE_STUDENTS = 2000;

@Injectable()
export class PromotionsService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    cache: CacheService,
    private readonly audit: AuditLogService,
  ) {
    super(prisma, cache);
  }

  /**
   * Section cards and class lists carry enrollment counts — and the user /
   * student lists can be filtered BY enrollment, so a promotion changes who
   * they return too.
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
   * The source roster plus a suggested destination.
   *
   * Every student is returned — including one who already holds a place in the
   * target session — with a flag, so the dialog can show *why* someone is not
   * promotable instead of silently dropping them.
   */
  async listSourceStudents(query: FindPromotionStudentsQueryDto, actor: Actor) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, query.schoolId);

    const [sourceYear, classGrade, targetYear, classes] = await Promise.all([
      this.prisma.academicYear.findUnique({
        where: { id: query.academicYearId },
        select: { id: true, name: true, code: true, schoolId: true },
      }),
      this.prisma.classGrade.findUnique({
        where: { id: query.classGradeId },
        select: {
          id: true,
          name: true,
          schoolId: true,
          sections: { select: { id: true, name: true } },
        },
      }),
      query.targetAcademicYearId
        ? this.prisma.academicYear.findUnique({
            where: { id: query.targetAcademicYearId },
            select: { id: true, name: true, code: true, schoolId: true },
          })
        : Promise.resolve(null),
      this.prisma.classGrade.findMany({
        where: { schoolId, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    if (!sourceYear) throw new NotFoundException('Academic year not found');
    this.enforceScope(actor, sourceYear.schoolId);
    if (!classGrade) throw new NotFoundException('Class not found');
    this.enforceScope(actor, classGrade.schoolId);
    if (query.targetAcademicYearId) {
      if (!targetYear) {
        throw new NotFoundException('Destination academic year not found');
      }
      this.enforceScope(actor, targetYear.schoolId);
    }
    if (
      query.sectionId &&
      !classGrade.sections.some((s) => s.id === query.sectionId)
    ) {
      throw new BadRequestException(
        'Section does not belong to the selected class',
      );
    }

    const rows = await this.prisma.enrollment.findMany({
      where: {
        academicYearId: sourceYear.id,
        status: EnrollmentStatus.ACTIVE,
        student: { schoolId },
        section: {
          classGradeId: classGrade.id,
          ...(query.sectionId && { id: query.sectionId }),
        },
      },
      // Newest placement wins, the same tiebreak the enrolment picker uses, so
      // both name the same class for a student with a legacy double placement.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_SOURCE_STUDENTS + 1,
      select: {
        id: true,
        studentId: true,
        sectionId: true,
        student: {
          select: {
            id: true,
            fullName: true,
            rollNo: true,
            admissionNo: true,
            photoMimeType: true,
          },
        },
        section: {
          select: {
            id: true,
            name: true,
            classGrade: { select: { name: true } },
          },
        },
      },
    });

    if (rows.length > MAX_SOURCE_STUDENTS) {
      throw new BadRequestException(
        `This class holds over ${MAX_SOURCE_STUDENTS} active students, which is more than one promotion run can load. Promote it section by section.`,
      );
    }

    // ONE row per student — the one-class-per-year rule is a service check, not
    // a DB constraint, so legacy doubles exist and would list a student twice.
    const seen = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!seen.has(row.studentId)) seen.set(row.studentId, row);
    }
    const unique = [...seen.values()];
    const studentIds = unique.map((r) => r.studentId);

    // What each student already holds in the destination session — the
    // duplicate-promotion guard, surfaced before anything is submitted.
    const targetRows =
      targetYear && studentIds.length
        ? await this.prisma.enrollment.findMany({
            where: {
              studentId: { in: studentIds },
              academicYearId: targetYear.id,
              status: EnrollmentStatus.ACTIVE,
            },
            select: {
              studentId: true,
              sectionId: true,
              section: {
                select: { name: true, classGrade: { select: { name: true } } },
              },
            },
          })
        : [];

    const placed = new Map<string, { sectionId: string; label: string }>();
    for (const row of targetRows) {
      if (placed.has(row.studentId)) continue;
      placed.set(row.studentId, {
        sectionId: row.sectionId,
        label: placementLabel(
          row.section.classGrade?.name ?? '',
          row.section.name,
        ),
      });
    }

    // Suggested destination: next class up, and the same-named section in it.
    const nextClass = suggestNextClass(
      { id: classGrade.id, name: classGrade.name },
      classes,
    );
    const destinationSections = nextClass
      ? await this.prisma.section.findMany({
          where: { classGradeId: nextClass.id, schoolId },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        })
      : [];

    // One suggestion per source section present in the roster, so a whole-class
    // run maps 5-A → 6-A and 5-B → 6-B in a single pass.
    const sourceSections = new Map<string, string>();
    for (const row of unique)
      sourceSections.set(row.sectionId, row.section.name);

    const sectionSuggestions = [...sourceSections.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([sourceSectionId, sourceSectionName]) => {
        const wanted = suggestSectionName(sourceSectionName);
        const match = destinationSections.find(
          (d) => d.name.toLowerCase() === wanted.toLowerCase(),
        );
        return {
          sourceSectionId,
          sourceSectionName,
          destinationSectionId: match?.id ?? null,
          destinationSectionName: match?.name ?? wanted,
          exists: !!match,
        };
      });

    return {
      source: {
        academicYear: sourceYear,
        classGrade: { id: classGrade.id, name: classGrade.name },
        sectionId: query.sectionId ?? null,
      },
      suggestion: {
        classGrade: nextClass,
        sections: sectionSuggestions,
        destinationSections,
      },
      students: unique.map((row) => ({
        studentId: row.studentId,
        enrollmentId: row.id,
        fullName: row.student.fullName,
        rollNo: row.student.rollNo,
        admissionNo: row.student.admissionNo,
        photoMimeType: row.student.photoMimeType,
        sectionId: row.sectionId,
        sectionName: row.section.name,
        label: placementLabel(
          row.section.classGrade?.name ?? '',
          row.section.name,
        ),
        alreadyPlaced: placed.get(row.studentId) ?? null,
      })),
      total: unique.length,
    };
  }

  /**
   * Who already sits in each section of a destination class, for the session
   * being promoted into.
   *
   * This is what makes "existing students stay put" visible BEFORE anyone
   * confirms. It is deliberately scoped to the TARGET academic year: the same
   * section holds a different roster each session, and a promotion adds to that
   * session's roster rather than replacing it.
   */
  async listDestination(query: FindDestinationQueryDto, actor: Actor) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, query.schoolId);

    const [year, classGrade] = await Promise.all([
      this.prisma.academicYear.findUnique({
        where: { id: query.academicYearId },
        select: { id: true, name: true, schoolId: true },
      }),
      // Scoped to the school, so a cross-tenant id is "not found" rather than
      // a row we then have to remember to reject.
      this.prisma.classGrade.findFirst({
        where: { id: query.classGradeId, schoolId },
        select: {
          id: true,
          name: true,
          schoolId: true,
          sections: { select: { id: true, name: true } },
        },
      }),
    ]);

    if (!year) throw new NotFoundException('Academic year not found');
    this.enforceScope(actor, year.schoolId);
    if (!classGrade) throw new NotFoundException('Class not found');
    this.enforceScope(actor, classGrade.schoolId);

    const sectionIds = classGrade.sections.map((s) => s.id);

    // One grouped count for the whole class — never a query per section.
    const counts = sectionIds.length
      ? await this.prisma.enrollment.groupBy({
          by: ['sectionId'],
          where: {
            sectionId: { in: sectionIds },
            academicYearId: year.id,
            status: EnrollmentStatus.ACTIVE,
          },
          _count: { _all: true },
        })
      : [];

    const bySection = new Map(
      counts.map((c) => [c.sectionId, c._count._all] as const),
    );

    const sections = classGrade.sections
      .map((s) => ({
        id: s.id,
        name: s.name,
        existingStudents: bySection.get(s.id) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      academicYear: { id: year.id, name: year.name },
      classGrade: { id: classGrade.id, name: classGrade.name },
      sections,
      existingStudents: sections.reduce(
        (sum, s) => sum + s.existingStudents,
        0,
      ),
    };
  }

  /**
   * Prepare sections this run left EMPTY for their next intake.
   *
   * "Emptied" is judged AFTER the placements have moved, and means zero ACTIVE
   * enrollments remain — so half-promoting a class never strips teachers from
   * the students still sitting in it.
   *
   * Runs automatically on every promotion — it used to be an opt-in checkbox,
   * but a section nobody is left sitting in should never keep last session's
   * teachers and live timetable attached.
   *
   * Deliberately non-destructive. Teachers are unassigned and the finished
   * session's timetable is archived; subjects, assignments, quizzes, attendance
   * and results are untouched. Removing a `SectionSubject` instead would cascade
   * into `Assignment` and `Exam` — destroying submissions and results — and is
   * the row `Attendance` is anchored to. Deleting is also unnecessary: neither
   * Assignment nor Quiz carries a student FK, so they are the CLASS's record,
   * and a student stops seeing them the moment their placement here closes.
   */
  private async resetEmptiedSections(
    tx: Prisma.TransactionClient,
    actionable: PromotionPlanItem[],
    sourceAcademicYearId: string,
  ): Promise<string[]> {
    const sourceSectionIds = [
      ...new Set(
        actionable
          .map((i) => i.sourceSectionId)
          .filter((id): id is string => !!id),
      ),
    ];
    if (!sourceSectionIds.length) return [];

    // One query for the whole set. A section still holding an ACTIVE placement
    // — in this session or any other — is still in use and is left alone.
    const occupiedRows = await tx.enrollment.findMany({
      where: {
        sectionId: { in: sourceSectionIds },
        status: EnrollmentStatus.ACTIVE,
      },
      select: { sectionId: true },
      distinct: ['sectionId'],
    });
    const occupied = new Set(occupiedRows.map((row) => row.sectionId));
    const emptied = sourceSectionIds.filter((id) => !occupied.has(id));
    if (!emptied.length) return [];

    await tx.sectionSubject.updateMany({
      where: { sectionId: { in: emptied } },
      data: { teacherId: null },
    });
    await tx.sectionTeacher.deleteMany({
      where: { sectionId: { in: emptied } },
    });
    // Only the session that just finished — a future session's grid is not
    // this run's business.
    await tx.timetable.updateMany({
      where: {
        sectionId: { in: emptied },
        academicYearId: sourceAcademicYearId,
        status: { not: TimetableStatus.ARCHIVED },
      },
      data: { status: TimetableStatus.ARCHIVED },
    });

    return emptied;
  }

  /**
   * The response shape preview and execute BOTH return.
   *
   * Shared because they drifted once: execute returned the bare plan, so a
   * caller reading `targetAcademicYear.name` off a successful run crashed.
   */
  private envelope(
    plan: PromotionPlan,
    sourceYear: { id: string; name: string; code: string },
    targetYear: { id: string; name: string; code: string },
  ) {
    return {
      sourceAcademicYear: {
        id: sourceYear.id,
        name: sourceYear.name,
        code: sourceYear.code,
      },
      targetAcademicYear: {
        id: targetYear.id,
        name: targetYear.name,
        code: targetYear.code,
      },
      ...plan,
    };
  }

  /** The confirmation summary. Loads state, decides, and writes NOTHING. */
  async preview(dto: PromotionPlanDto, actor: Actor) {
    const { plan, sourceYear, targetYear } = await this.loadPlan(dto, actor);
    return this.envelope(plan, sourceYear, targetYear);
  }

  /**
   * Commit the promotion.
   *
   * Re-decides from freshly-loaded state rather than trusting the previewed
   * summary, so a place taken between confirm and submit is caught here.
   */
  async execute(dto: PromotionPlanDto, actor: Actor) {
    const { plan, schoolId, targetYear, sourceYear } = await this.loadPlan(
      dto,
      actor,
    );

    if (!plan.canExecute) {
      throw new BadRequestException({
        message:
          'Some students have no destination section. Fix those rows and try again.',
        blocked: plan.items.filter((i) => i.outcome === 'NO_DESTINATION'),
      });
    }

    const actionable = plan.items.filter(
      (i) => i.outcome === 'PROMOTE' || i.outcome === 'REACTIVATE',
    );
    if (!actionable.length) {
      // Everyone was already promoted or already sits there — a no-op, not an
      // error: re-running a finished promotion must be safe.
      return {
        promoted: 0,
        reactivated: 0,
        sectionsCreated: 0,
        sectionsReset: 0,
        ...this.envelope(plan, sourceYear, targetYear),
      };
    }

    const now = new Date();
    let written: {
      promoted: number;
      reactivated: number;
      sectionsCreated: number;
      sectionsReset: number;
      resetSectionIds: string[];
    };

    try {
      written = await this.prisma.$transaction(async (tx) => {
        // 1. Destination sections that don't exist yet. Bounded by distinct
        //    destinations (usually one), never by student count.
        const createdSectionIds = new Map<string, string>();
        for (const section of plan.sectionsToCreate) {
          const created = await tx.section.create({
            data: {
              schoolId,
              classGradeId: section.classGradeId,
              name: section.name,
            },
            select: { id: true },
          });
          createdSectionIds.set(section.key, created.id);
        }

        // 2. Close the old placement FIRST. Within one session the old and new
        //    rows share an academic year, and the one-class-per-year rule would
        //    otherwise see two ACTIVE placements for the same student.
        const sourceIds = actionable
          .map((i) => i.sourceEnrollmentId)
          .filter((id): id is string => !!id);
        if (sourceIds.length) {
          await tx.enrollment.updateMany({
            where: { id: { in: sourceIds } },
            data: { status: EnrollmentStatus.COMPLETED, endDate: now },
          });
        }

        // 3. Revive a dormant row instead of inserting a duplicate — the
        //    enrollment unique key would reject the second insert.
        const reactivateIds = actionable
          .filter((i) => i.outcome === 'REACTIVATE')
          .map((i) => i.reactivateEnrollmentId)
          .filter((id): id is string => !!id);
        if (reactivateIds.length) {
          await tx.enrollment.updateMany({
            where: { id: { in: reactivateIds } },
            data: {
              status: EnrollmentStatus.ACTIVE,
              startDate: now,
              endDate: null,
            },
          });
        }

        // 4. The new placements, in one insert.
        const toCreate = actionable
          .filter((i) => i.outcome === 'PROMOTE')
          .map((i) => {
            const sectionId =
              i.destinationSectionId ??
              (i.destinationSectionKey
                ? createdSectionIds.get(i.destinationSectionKey)
                : undefined);
            if (!sectionId) {
              // Unreachable: the planner blocks on a missing destination.
              throw new BadRequestException(
                `No destination section resolved for ${i.fullName}.`,
              );
            }
            return {
              studentId: i.studentId,
              sectionId,
              academicYearId: targetYear.id,
              status: EnrollmentStatus.ACTIVE,
              startDate: now,
            };
          });

        const created = toCreate.length
          ? await tx.enrollment.createMany({ data: toCreate })
          : { count: 0 };

        // 5. Prepare any section this run left EMPTY for its next intake.
        //    Automatic: a section nobody is left sitting in should not keep
        //    last session's teachers and live timetable attached to it.
        const emptied = await this.resetEmptiedSections(
          tx,
          actionable,
          sourceYear.id,
        );

        return {
          promoted: created.count,
          reactivated: reactivateIds.length,
          sectionsCreated: createdSectionIds.size,
          sectionsReset: emptied.length,
          resetSectionIds: emptied,
        };
      });
    } catch (err) {
      // The whole transaction rolled back, so no student is half-promoted.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'Someone changed these placements while the promotion was being confirmed. Nothing was promoted — reopen the dialog and try again.',
        );
      }
      throw err;
    }

    await this.invalidate(schoolId);
    await this.audit.record(actor.userId, 'ENROLLMENT_PROMOTE', {
      schoolId,
      entityType: 'AcademicYear',
      entityId: targetYear.id,
      metadata: {
        sourceAcademicYearId: sourceYear.id,
        targetAcademicYearId: targetYear.id,
        ...written,
        skipped: plan.counts.ALREADY_PROMOTED + plan.counts.SAME_PLACEMENT,
      },
    });

    // The reset section ids are useful in the audit trail but noise in the
    // response, which reports the count.
    const { resetSectionIds: _reset, ...summary } = written;
    return { ...summary, ...this.envelope(plan, sourceYear, targetYear) };
  }

  /**
   * Everything preview and execute both need, in a constant number of queries
   * regardless of how many students are in the run. Shared deliberately: the
   * summary an admin confirms and the write that follows come from one decision.
   */
  private async loadPlan(dto: PromotionPlanDto, actor: Actor) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);

    const studentIds = [...new Set(dto.students.map((s) => s.studentId))];
    const classGradeIds = [
      ...new Set(dto.students.map((s) => s.destinationClassGradeId)),
    ];
    const yearIds = [
      ...new Set([dto.sourceAcademicYearId, dto.targetAcademicYearId]),
    ];

    const [years, students, destinationClasses] = await Promise.all([
      this.prisma.academicYear.findMany({
        where: { id: { in: yearIds } },
        select: { id: true, name: true, code: true, schoolId: true },
      }),
      this.prisma.studentProfile.findMany({
        where: { id: { in: studentIds }, schoolId },
        select: { id: true, fullName: true },
      }),
      this.prisma.classGrade.findMany({
        where: { id: { in: classGradeIds }, schoolId },
        select: { id: true, name: true },
      }),
    ]);

    const sourceYear = years.find((y) => y.id === dto.sourceAcademicYearId);
    const targetYear = years.find((y) => y.id === dto.targetAcademicYearId);
    if (!sourceYear || !targetYear) {
      throw new NotFoundException('Academic year not found');
    }
    this.enforceScope(actor, sourceYear.schoolId);
    this.enforceScope(actor, targetYear.schoolId);

    // One missing or cross-school id rejects the run rather than silently
    // promoting a subset — tenant safety, same as batch enrolment.
    if (students.length !== studentIds.length) {
      throw new BadRequestException(
        'One or more students were not found in this school',
      );
    }
    if (destinationClasses.length !== classGradeIds.length) {
      throw new BadRequestException(
        'One or more destination classes were not found in this school',
      );
    }

    // Both sessions in one read; when they are the same session this is also
    // the only query that could have been duplicated.
    const [enrollmentRows, sections] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: {
          studentId: { in: studentIds },
          academicYearId: { in: yearIds },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          studentId: true,
          sectionId: true,
          academicYearId: true,
          status: true,
          section: {
            select: { name: true, classGrade: { select: { name: true } } },
          },
        },
      }),
      this.prisma.section.findMany({
        where: { classGradeId: { in: classGradeIds }, schoolId },
        select: { id: true, name: true, classGradeId: true },
      }),
    ]);

    const label = (row: {
      section: { name: string; classGrade?: { name: string } | null };
    }) => placementLabel(row.section.classGrade?.name ?? '', row.section.name);

    const sourceEnrollments = new Map<string, SourceEnrollment>();
    const targetEnrollments: TargetEnrollment[] = [];
    for (const row of enrollmentRows) {
      if (
        row.academicYearId === sourceYear.id &&
        row.status === EnrollmentStatus.ACTIVE &&
        !sourceEnrollments.has(row.studentId)
      ) {
        sourceEnrollments.set(row.studentId, {
          enrollmentId: row.id,
          sectionId: row.sectionId,
          label: label(row),
        });
      }
      if (row.academicYearId === targetYear.id) {
        targetEnrollments.push({
          enrollmentId: row.id,
          studentId: row.studentId,
          sectionId: row.sectionId,
          isActive: row.status === EnrollmentStatus.ACTIVE,
          label: label(row),
        });
      }
    }

    const classNames = new Map(destinationClasses.map((c) => [c.id, c.name]));
    const existingSections = new Map<string, DestinationSection>();
    for (const section of sections) {
      existingSections.set(sectionKey(section.classGradeId, section.name), {
        id: section.id,
        name: section.name,
        classGradeId: section.classGradeId,
        label: placementLabel(
          classNames.get(section.classGradeId) ?? '',
          section.name,
        ),
      });
    }

    const plan: PromotionPlan = buildPromotionPlan({
      sourceAcademicYearId: sourceYear.id,
      targetAcademicYearId: targetYear.id,
      requests: dto.students,
      sourceEnrollments,
      targetEnrollments,
      existingSections,
      studentNames: new Map(students.map((s) => [s.id, s.fullName])),
      classNames,
      createMissingSections: dto.createMissingSections ?? false,
    });

    return { plan, schoolId, sourceYear, targetYear };
  }
}
