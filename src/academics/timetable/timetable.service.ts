import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import {
  DayOfWeek,
  NON_CLASS_KINDS,
  PeriodKind,
} from '../../common/types/timetable.type';
import {
  NOTIFICATION_CREATE_BATCH,
  NotificationCreateBatchEvent,
} from '../../common/events/notification.events';
import {
  parentUserIdsByStudent,
  sectionStudentIds,
  studentUserIdByStudent,
} from '../../common/notifications/recipients';
import { UpsertConfigDto } from './dto/upsert-config.dto';
import { SetupTimetableDto } from './dto/setup-timetable.dto';
import { ReplacePeriodsDto } from './dto/replace-periods.dto';
import { CreatePeriodSlotDto } from './dto/create-period-slot.dto';
import { UpdatePeriodSlotDto } from './dto/update-period-slot.dto';
import { CreateEntryDto } from './dto/create-entry.dto';
import { UpdateEntryDto } from './dto/update-entry.dto';
import { ApplyTemplateDto } from './dto/apply-template.dto';
import { TeacherOptionsQueryDto } from './dto/teacher-options-query.dto';
import {
  FindTimetableQueryDto,
  MyTimetableQueryDto,
} from './dto/find-timetable-query.dto';
import {
  generatePeriodSlots,
  minToHHMM,
  overlaps,
  periodMinutesForCount,
  validatePeriodSet,
} from './timetable-time';
import { PublishTimetableDto } from './dto/publish-timetable.dto';

export interface EntryConflict {
  type: 'TEACHER' | 'SECTION' | 'ROOM';
  message: string;
  entryId?: string;
}

interface CandidateSlot {
  timetableId: string;
  schoolId: string;
  sectionId: string;
  academicYearId: string;
  dayOfWeek: DayOfWeek;
  startMin: number;
  endMin: number;
  teacherId: string;
  effectiveRoom: string | null;
  excludeEntryId?: string;
}

type Tx = Prisma.TransactionClient | PrismaService;

@Injectable()
export class TimetableService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma);
  }

  // ---- scoping / resolution helpers -------------------------------------

  private schoolIdFor(actor: Actor, schoolId?: string): string {
    if (actor.role === Role.SUPER_ADMIN) {
      if (!schoolId) throw new BadRequestException('schoolId is required');
      return schoolId;
    }
    if (!actor.schoolId) throw new ForbiddenException('No school context');
    return actor.schoolId;
  }

  private async resolveAcademicYearId(
    schoolId: string,
    academicYearId?: string,
  ): Promise<string> {
    if (academicYearId) {
      const ay = await this.prisma.academicYear.findUnique({
        where: { id: academicYearId },
      });
      if (!ay || ay.schoolId !== schoolId) {
        throw new BadRequestException('Invalid academicYearId');
      }
      return ay.id;
    }
    const active = await this.prisma.academicYear.findFirst({
      where: { schoolId, isActive: true },
      orderBy: { startDate: 'desc' },
    });
    if (!active) {
      throw new BadRequestException('No active academic year for this school');
    }
    return active.id;
  }

  private assertTimezone(tz: string) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw new BadRequestException(`Invalid timezone: ${tz}`);
    }
  }

  private entryInclude() {
    return {
      period: true,
      sectionSubject: {
        include: { subject: { select: { id: true, name: true, code: true } } },
      },
      teacher: { select: { id: true, fullName: true } },
      section: {
        select: {
          id: true,
          name: true,
          room: true,
          classGrade: { select: { id: true, name: true } },
        },
      },
    } satisfies Prisma.TimetableEntryInclude;
  }

  private async loadSection(sectionId: string) {
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      select: {
        id: true,
        name: true,
        room: true,
        schoolId: true,
        classGrade: { select: { id: true, name: true } },
      },
    });
    if (!section) throw new NotFoundException('Section not found');
    return section;
  }

  private async loadTimetableForSection(
    sectionId: string,
    academicYearId: string,
  ) {
    return this.prisma.timetable.findUnique({
      where: { sectionId_academicYearId: { sectionId, academicYearId } },
    });
  }

  // ---- config (school defaults) -----------------------------------------

  async getConfig(actor: Actor, schoolId?: string) {
    this.ensureAdmin(actor);
    const sid = this.resolveSchoolId(actor, schoolId);
    const config = await this.prisma.timetableConfig.findUnique({
      where: { schoolId: sid },
    });
    return (
      config ?? {
        id: null,
        schoolId: sid,
        timezone: 'Asia/Karachi',
        workingDays: [
          DayOfWeek.MONDAY,
          DayOfWeek.TUESDAY,
          DayOfWeek.WEDNESDAY,
          DayOfWeek.THURSDAY,
          DayOfWeek.FRIDAY,
          DayOfWeek.SATURDAY,
        ],
        dayStartMin: 480,
        dayEndMin: 840,
        periodMinutes: 45,
      }
    );
  }

  async upsertConfig(dto: UpsertConfigDto, actor: Actor) {
    this.ensureAdmin(actor);
    const sid = this.resolveSchoolId(actor, dto.schoolId);
    await this.ensureSchoolExists(sid);
    if (dto.dayStartMin >= dto.dayEndMin) {
      throw new BadRequestException('dayStartMin must be before dayEndMin');
    }
    if (dto.timezone) this.assertTimezone(dto.timezone);
    if (dto.workingDays.length === 0) {
      throw new BadRequestException('At least one working day is required');
    }
    return this.prisma.timetableConfig.upsert({
      where: { schoolId: sid },
      update: {
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
        workingDays: dto.workingDays as any,
        dayStartMin: dto.dayStartMin,
        dayEndMin: dto.dayEndMin,
        periodMinutes: dto.periodMinutes,
      },
      create: {
        schoolId: sid,
        timezone: dto.timezone ?? 'Asia/Karachi',
        workingDays: dto.workingDays as any,
        dayStartMin: dto.dayStartMin,
        dayEndMin: dto.dayEndMin,
        periodMinutes: dto.periodMinutes,
      },
    });
  }

  private async schoolTimezone(schoolId: string): Promise<string> {
    const c = await this.prisma.timetableConfig.findUnique({
      where: { schoolId },
      select: { timezone: true },
    });
    return c?.timezone ?? 'Asia/Karachi';
  }

  // ---- setup + periods ---------------------------------------------------

  /** Create the section's timetable and generate its bell schedule (per-section). */
  async setupTimetable(sectionId: string, dto: SetupTimetableDto, actor: Actor) {
    this.ensureAdmin(actor);
    const section = await this.loadSection(sectionId);
    this.enforceScope(actor, section.schoolId);
    const schoolId = section.schoolId;
    const academicYearId = await this.resolveAcademicYearId(
      schoolId,
      dto.academicYearId,
    );

    if (dto.dayStartMin >= dto.dayEndMin) {
      throw new BadRequestException('Start time must be before end time');
    }
    if (dto.workingDays.length === 0) {
      throw new BadRequestException('Select at least one working day');
    }

    const existing = await this.loadTimetableForSection(
      sectionId,
      academicYearId,
    );
    if (existing) {
      const count = await this.prisma.timetablePeriod.count({
        where: { timetableId: existing.id },
      });
      if (count > 0) {
        throw new ConflictException(
          'This section already has a timetable. Edit its periods instead.',
        );
      }
    }

    const breaks = (dto.breaks ?? []).map((b) => ({
      startMin: b.startMin,
      durationMin: b.durationMin,
      label: b.label,
      kind: (b.kind as any) ?? 'BREAK',
    }));
    const periodMinutes = dto.periodCount
      ? periodMinutesForCount(
          dto.dayStartMin,
          dto.dayEndMin,
          breaks,
          dto.periodCount,
        )
      : (dto.periodMinutes ?? 45);
    if (periodMinutes <= 0) {
      throw new BadRequestException('Computed period length is not positive');
    }

    const slots = generatePeriodSlots({
      dayStartMin: dto.dayStartMin,
      dayEndMin: dto.dayEndMin,
      periodMinutes,
      breaks,
    });
    if (slots.length === 0) {
      throw new BadRequestException(
        'The day range and settings produced no periods',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const timetable = await tx.timetable.upsert({
        where: { sectionId_academicYearId: { sectionId, academicYearId } },
        update: {
          workingDays: dto.workingDays as any,
          dayStartMin: dto.dayStartMin,
          dayEndMin: dto.dayEndMin,
          periodMinutes,
        },
        create: {
          schoolId,
          sectionId,
          academicYearId,
          status: 'DRAFT',
          workingDays: dto.workingDays as any,
          dayStartMin: dto.dayStartMin,
          dayEndMin: dto.dayEndMin,
          periodMinutes,
        },
      });
      await tx.timetablePeriod.deleteMany({
        where: { timetableId: timetable.id },
      });
      await tx.timetablePeriod.createMany({
        data: slots.map((s) => ({
          timetableId: timetable.id,
          schoolId,
          index: s.index,
          label: s.label,
          startMin: s.startMin,
          endMin: s.endMin,
          kind: s.kind as any,
        })),
      });
      return timetable;
    });
  }

  /** The authoring payload for a section (setup screen when null; builder+grid otherwise). */
  async getSectionTimetable(
    sectionId: string,
    actor: Actor,
    query: FindTimetableQueryDto,
  ) {
    this.ensureAdmin(actor);
    const section = await this.loadSection(sectionId);
    this.enforceScope(actor, section.schoolId);
    const academicYearId = await this.resolveAcademicYearId(
      section.schoolId,
      query.academicYearId,
    );
    const timezone = await this.schoolTimezone(section.schoolId);
    const config = await this.prisma.timetableConfig.findUnique({
      where: { schoolId: section.schoolId },
    });
    const timetable = await this.loadTimetableForSection(
      sectionId,
      academicYearId,
    );

    if (!timetable) {
      return {
        section: { id: section.id, name: section.name, room: section.room, classGrade: section.classGrade },
        academicYearId,
        timetable: null,
        timezone,
        // Setup-screen defaults from the school config.
        defaults: {
          workingDays: config?.workingDays ?? [
            DayOfWeek.MONDAY,
            DayOfWeek.TUESDAY,
            DayOfWeek.WEDNESDAY,
            DayOfWeek.THURSDAY,
            DayOfWeek.FRIDAY,
            DayOfWeek.SATURDAY,
          ],
          dayStartMin: config?.dayStartMin ?? 480,
          dayEndMin: config?.dayEndMin ?? 840,
          periodMinutes: config?.periodMinutes ?? 45,
        },
        periods: [],
        entries: [],
        validation: null,
      };
    }

    const [periods, entries] = await Promise.all([
      this.prisma.timetablePeriod.findMany({
        where: { timetableId: timetable.id },
        orderBy: { index: 'asc' },
      }),
      this.prisma.timetableEntry.findMany({
        where: { timetableId: timetable.id },
        include: this.entryInclude(),
      }),
    ]);
    const validation = await this.computeValidation(timetable, periods, entries);

    // Everything the draft editor needs to run fully client-side: which teachers
    // may be assigned to each subject, and where each of those teachers is
    // already booked in OTHER sections (so cross-section conflicts show as red
    // dots without any per-edit request).
    const sectionSubjects = await this.prisma.sectionSubject.findMany({
      where: { sectionId },
      select: {
        id: true,
        subjectId: true,
        teacherId: true,
        subject: { select: { name: true, code: true } },
      },
    });
    // Teachers ALLOCATED to this class = whoever is assigned to teach one of its
    // subjects. The dropdowns never show a school-wide specialist who doesn't
    // teach in this class.
    const allocatedTeacherIds = new Set(
      sectionSubjects
        .map((ss) => ss.teacherId)
        .filter((id): id is string => !!id),
    );
    const candidateTeacherIds = new Set<string>();
    const assignableTeachers = await Promise.all(
      sectionSubjects.map(async (ss) => {
        const qualified = await this.qualifiedTeachers(
          section.schoolId,
          ss.subjectId,
          ss.teacherId,
        );
        const teachers = qualified.filter((t) => allocatedTeacherIds.has(t.id));
        for (const t of teachers) candidateTeacherIds.add(t.id);
        return {
          sectionSubjectId: ss.id,
          subjectId: ss.subjectId,
          subjectName: ss.subject.name,
          subjectCode: ss.subject.code,
          teachers,
        };
      }),
    );
    const busyRows = candidateTeacherIds.size
      ? await this.prisma.timetableEntry.findMany({
          where: {
            academicYearId,
            teacherId: { in: [...candidateTeacherIds] },
            timetableId: { not: timetable.id },
          },
          select: {
            teacherId: true,
            dayOfWeek: true,
            startMin: true,
            endMin: true,
            section: {
              select: { name: true, classGrade: { select: { name: true } } },
            },
            sectionSubject: { select: { subject: { select: { name: true } } } },
          },
        })
      : [];
    const teacherBusy: Record<
      string,
      Array<{
        dayOfWeek: string;
        startMin: number;
        endMin: number;
        className: string;
        subjectName: string;
      }>
    > = {};
    for (const b of busyRows) {
      (teacherBusy[b.teacherId] ??= []).push({
        dayOfWeek: b.dayOfWeek,
        startMin: b.startMin,
        endMin: b.endMin,
        className: this.classLabel(b.section),
        subjectName: b.sectionSubject?.subject?.name ?? 'Class',
      });
    }

    return {
      section: { id: section.id, name: section.name, room: section.room, classGrade: section.classGrade },
      academicYearId,
      timetable: {
        id: timetable.id,
        status: timetable.status,
        publishedAt: timetable.publishedAt,
        workingDays: timetable.workingDays,
        dayStartMin: timetable.dayStartMin,
        dayEndMin: timetable.dayEndMin,
        periodMinutes: timetable.periodMinutes,
      },
      timezone,
      periods,
      entries,
      validation,
      assignableTeachers,
      teacherBusy,
    };
  }

  /** Broad read of a section's bell schedule (members need times to render). */
  async listPeriods(
    sectionId: string,
    actor: Actor,
    query: FindTimetableQueryDto,
  ) {
    const section = await this.loadSection(sectionId);
    await this.assertSectionReadAccess(actor, section);
    const academicYearId = await this.resolveAcademicYearId(
      section.schoolId,
      query.academicYearId,
    );
    const timetable = await this.loadTimetableForSection(
      sectionId,
      academicYearId,
    );
    if (!timetable) return [];
    return this.prisma.timetablePeriod.findMany({
      where: { timetableId: timetable.id },
      orderBy: { index: 'asc' },
    });
  }

  private async requireDraftTimetable(sectionId: string, actor: Actor) {
    const section = await this.loadSection(sectionId);
    this.enforceScope(actor, section.schoolId);
    const academicYearId = await this.resolveAcademicYearId(section.schoolId);
    const timetable = await this.loadTimetableForSection(
      sectionId,
      academicYearId,
    );
    if (!timetable) {
      throw new BadRequestException('Set up the timetable first');
    }
    return { section, timetable };
  }

  /**
   * Index-preserving edits (a period's TIME / LABEL / KIND keep the same
   * `index`, so historical Attendance — keyed by the period number — still
   * aligns). Only an archived timetable blocks these.
   */
  private assertNotArchived(status: string) {
    if (status === 'ARCHIVED') {
      throw new ConflictException('This timetable is archived');
    }
  }

  /**
   * Structural changes that ADD, REMOVE, or RENUMBER periods (create / delete /
   * bulk-replace) are draft-only, so a live published grid is never reshaped
   * underneath its viewers. Time/label edits use assertNotArchived instead.
   */
  private assertDraft(status: string) {
    if (status === 'PUBLISHED') {
      throw new ConflictException(
        'Published timetable: archive it to add, remove, or reshape periods',
      );
    }
    if (status === 'ARCHIVED') {
      throw new ConflictException('This timetable is archived');
    }
  }

  async replacePeriods(
    sectionId: string,
    dto: ReplacePeriodsDto,
    actor: Actor,
  ) {
    this.ensureAdmin(actor);
    const { timetable } = await this.requireDraftTimetable(sectionId, actor);
    this.assertDraft(timetable.status);

    const errors = validatePeriodSet(
      dto.periods.map((p) => ({
        index: p.index,
        startMin: p.startMin,
        endMin: p.endMin,
        kind: p.kind,
      })),
      { dayStartMin: timetable.dayStartMin, dayEndMin: timetable.dayEndMin },
    );
    if (errors.length) throw new BadRequestException(errors.join('; '));

    return this.prisma.$transaction(async (tx) => {
      await tx.timetablePeriod.deleteMany({
        where: { timetableId: timetable.id },
      });
      await tx.timetablePeriod.createMany({
        data: dto.periods.map((p) => ({
          timetableId: timetable.id,
          schoolId: timetable.schoolId,
          index: p.index,
          label: p.label ?? null,
          startMin: p.startMin,
          endMin: p.endMin,
          kind: (p.kind ?? PeriodKind.CLASS) as any,
        })),
      });
      return tx.timetablePeriod.findMany({
        where: { timetableId: timetable.id },
        orderBy: { index: 'asc' },
      });
    });
  }

  async createPeriod(
    sectionId: string,
    dto: CreatePeriodSlotDto,
    actor: Actor,
  ) {
    this.ensureAdmin(actor);
    const { timetable } = await this.requireDraftTimetable(sectionId, actor);
    this.assertDraft(timetable.status);
    if (dto.startMin >= dto.endMin) {
      throw new BadRequestException('startMin must be before endMin');
    }
    const existing = await this.prisma.timetablePeriod.findMany({
      where: { timetableId: timetable.id },
    });
    const candidate = [
      ...existing.map((p) => ({ index: p.index, startMin: p.startMin, endMin: p.endMin })),
      { index: dto.index, startMin: dto.startMin, endMin: dto.endMin },
    ];
    const errors = validatePeriodSet(candidate, {
      dayStartMin: timetable.dayStartMin,
      dayEndMin: timetable.dayEndMin,
    });
    if (errors.length) throw new BadRequestException(errors.join('; '));

    return this.prisma.timetablePeriod.create({
      data: {
        timetableId: timetable.id,
        schoolId: timetable.schoolId,
        index: dto.index,
        label: dto.label ?? null,
        startMin: dto.startMin,
        endMin: dto.endMin,
        kind: (dto.kind ?? PeriodKind.CLASS) as any,
      },
    });
  }

  async updatePeriod(id: string, dto: UpdatePeriodSlotDto, actor: Actor) {
    this.ensureAdmin(actor);
    const period = await this.prisma.timetablePeriod.findUnique({
      where: { id },
      include: { timetable: true },
    });
    if (!period) throw new NotFoundException('Period not found');
    this.enforceScope(actor, period.schoolId);
    // Time/label/kind keep the period's index, so this is allowed even after
    // attendance exists (index-preserving); only an archived grid is frozen.
    this.assertNotArchived(period.timetable.status);

    const startMin = dto.startMin ?? period.startMin;
    const endMin = dto.endMin ?? period.endMin;
    const kind = (dto.kind ?? period.kind) as PeriodKind;
    if (startMin >= endMin) {
      throw new BadRequestException('startMin must be before endMin');
    }

    const others = await this.prisma.timetablePeriod.findMany({
      where: { timetableId: period.timetableId, id: { not: id } },
    });
    const candidate = [
      ...others.map((p) => ({ index: p.index, startMin: p.startMin, endMin: p.endMin })),
      { index: period.index, startMin, endMin },
    ];
    const errors = validatePeriodSet(candidate, {
      dayStartMin: period.timetable.dayStartMin,
      dayEndMin: period.timetable.dayEndMin,
    });
    if (errors.length) throw new BadRequestException(errors.join('; '));

    // If a CLASS period becomes non-CLASS while it still holds assignments, block it.
    if (NON_CLASS_KINDS.includes(kind)) {
      const entryCount = await this.prisma.timetableEntry.count({
        where: { periodId: id },
      });
      if (entryCount > 0) {
        throw new ConflictException(
          'This period has class assignments; remove them before changing its type',
        );
      }
    }

    // Retime + reconcile entries' denormalized times, then re-check their conflicts. Atomic.
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.timetablePeriod.update({
        where: { id },
        data: {
          ...(dto.label !== undefined && { label: dto.label }),
          startMin,
          endMin,
          kind: kind as any,
        },
      });
      if (startMin !== period.startMin || endMin !== period.endMin) {
        const affected = await tx.timetableEntry.findMany({
          where: { periodId: id },
        });
        for (const e of affected) {
          await tx.timetableEntry.update({
            where: { id: e.id },
            data: { startMin, endMin },
          });
          const conflicts = await this.findConflicts(tx, {
            timetableId: e.timetableId,
            schoolId: e.schoolId,
            sectionId: e.sectionId,
            academicYearId: e.academicYearId,
            dayOfWeek: e.dayOfWeek as DayOfWeek,
            startMin,
            endMin,
            teacherId: e.teacherId,
            effectiveRoom: await this.effectiveRoomOf(e.room, e.sectionId),
            excludeEntryId: e.id,
          });
          if (conflicts.length) {
            throw new ConflictException({
              message: `Re-timing this period conflicts: ${conflicts
                .map((c) => c.message)
                .join('; ')}`,
              conflicts,
            });
          }
        }
      }
      return updated;
    });
  }

  async deletePeriod(id: string, actor: Actor, force = false) {
    this.ensureAdmin(actor);
    const period = await this.prisma.timetablePeriod.findUnique({
      where: { id },
      include: { timetable: true },
    });
    if (!period) throw new NotFoundException('Period not found');
    this.enforceScope(actor, period.schoolId);
    // Removing a period is draft-only (don't reshape a live published grid).
    this.assertDraft(period.timetable.status);

    const affected = await this.prisma.timetableEntry.findMany({
      where: { periodId: id },
      include: this.entryInclude(),
    });
    if (affected.length > 0 && !force) {
      // Report the affected cells so the UI can confirm before destroying them.
      throw new ConflictException({
        message: 'This period contains timetable assignments',
        affected: affected.map((e) => ({
          id: e.id,
          dayOfWeek: e.dayOfWeek,
          subject: e.sectionSubject?.subject.name,
          teacher: e.teacher?.fullName,
        })),
      });
    }
    // force=true: assignments in this period cascade-delete with it.
    await this.prisma.timetablePeriod.delete({ where: { id } });
    return { id };
  }

  // ---- teacher options (subject -> qualified teachers + availability) ----

  async getTeacherOptions(
    sectionId: string,
    query: TeacherOptionsQueryDto,
    actor: Actor,
  ) {
    this.ensureAdmin(actor);
    const section = await this.loadSection(sectionId);
    this.enforceScope(actor, section.schoolId);
    const schoolId = section.schoolId;
    const academicYearId = await this.resolveAcademicYearId(schoolId);

    const ss = await this.loadSectionSubject(query.sectionSubjectId);
    if (ss.section.schoolId !== schoolId || ss.sectionId !== sectionId) {
      throw new BadRequestException('Subject-class does not belong to this section');
    }
    const period = await this.loadPeriod(query.periodId, schoolId);
    if (period.kind !== PeriodKind.CLASS) {
      throw new BadRequestException('Not a class period');
    }

    // Only teachers allocated to this class (assigned to one of its subjects).
    const allocatedRows = await this.prisma.sectionSubject.findMany({
      where: { sectionId },
      select: { teacherId: true },
    });
    const allocated = new Set(
      allocatedRows.map((r) => r.teacherId).filter((id): id is string => !!id),
    );
    const teachers = (
      await this.qualifiedTeachers(schoolId, ss.subjectId, ss.teacherId)
    ).filter((t) => allocated.has(t.id));

    const options = await Promise.all(
      teachers.map(async (t) => {
        const clash = await this.teacherClashAt(this.prisma, {
          academicYearId,
          teacherId: t.id,
          dayOfWeek: query.dayOfWeek,
          startMin: period.startMin,
          endMin: period.endMin,
          excludeEntryId: query.excludeEntryId,
        });
        return {
          teacherId: t.id,
          fullName: t.fullName,
          available: !clash,
          conflict: clash
            ? {
                className: this.classLabel(clash.section),
                dayOfWeek: clash.dayOfWeek,
                startMin: clash.startMin,
                endMin: clash.endMin,
              }
            : undefined,
        };
      }),
    );
    // Available first, then by name.
    options.sort(
      (a, b) =>
        Number(b.available) - Number(a.available) ||
        a.fullName.localeCompare(b.fullName),
    );
    return { sectionSubjectId: ss.id, periodId: period.id, options };
  }

  /** Teachers who CAN teach the subject: specialty holders ∪ the section-subject's default. */
  private async qualifiedTeachers(
    schoolId: string,
    subjectId: string,
    defaultTeacherId: string | null,
  ) {
    return this.prisma.teacherProfile.findMany({
      where: {
        schoolId,
        isActive: true,
        OR: [
          { specialties: { some: { subjectId } } },
          ...(defaultTeacherId ? [{ id: defaultTeacherId }] : []),
        ],
      },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });
  }

  // ---- entries (assignments) --------------------------------------------

  async createEntry(sectionId: string, dto: CreateEntryDto, actor: Actor) {
    this.ensureAdmin(actor);
    const { section, timetable } = await this.requireDraftTimetable(
      sectionId,
      actor,
    );
    // DRAFT-only structural rule doesn't apply to assignments; published allows safe adds.
    if (timetable.status === 'ARCHIVED') {
      throw new ConflictException('This timetable is archived');
    }

    const resolved = await this.resolveAssignment(
      dto.sectionSubjectId,
      dto.teacherId,
      sectionId,
      section.schoolId,
    );
    const period = await this.loadPeriod(dto.periodId, section.schoolId);
    if (period.timetableId !== timetable.id) {
      throw new BadRequestException('Period belongs to another timetable');
    }
    if (period.kind !== PeriodKind.CLASS) {
      throw new BadRequestException('Only CLASS periods are assignable');
    }
    this.assertWorkingDay(timetable.workingDays as string[], dto.dayOfWeek);

    const effectiveRoom = (dto.room ?? section.room)?.trim() || null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const conflicts = await this.findConflicts(tx, {
          timetableId: timetable.id,
          schoolId: section.schoolId,
          sectionId,
          academicYearId: timetable.academicYearId,
          dayOfWeek: dto.dayOfWeek,
          startMin: period.startMin,
          endMin: period.endMin,
          teacherId: resolved.teacherId,
          effectiveRoom,
        });
        this.throwIfConflicts(conflicts);
        return tx.timetableEntry.create({
          data: {
            timetableId: timetable.id,
            schoolId: section.schoolId,
            sectionId,
            academicYearId: timetable.academicYearId,
            dayOfWeek: dto.dayOfWeek as any,
            periodId: period.id,
            startMin: period.startMin,
            endMin: period.endMin,
            sectionSubjectId: resolved.sectionSubjectId,
            teacherId: resolved.teacherId,
            room: dto.room?.trim() || null,
            note: dto.note?.trim() || null,
          },
          include: this.entryInclude(),
        });
      });
    } catch (e) {
      throw this.translateWriteError(e);
    }
  }

  async updateEntry(id: string, dto: UpdateEntryDto, actor: Actor) {
    this.ensureAdmin(actor);
    const current = await this.prisma.timetableEntry.findUnique({
      where: { id },
      include: { timetable: true, section: { select: { room: true, schoolId: true } } },
    });
    if (!current) throw new NotFoundException('Assignment not found');
    this.enforceScope(actor, current.schoolId);
    if (current.timetable.status === 'ARCHIVED') {
      throw new ConflictException('This timetable is archived');
    }

    const dayOfWeek = (dto.dayOfWeek ?? current.dayOfWeek) as DayOfWeek;
    this.assertWorkingDay(current.timetable.workingDays as string[], dayOfWeek);

    let periodId = current.periodId;
    let startMin = current.startMin;
    let endMin = current.endMin;
    if (dto.periodId && dto.periodId !== current.periodId) {
      const period = await this.loadPeriod(dto.periodId, current.schoolId);
      if (period.timetableId !== current.timetableId) {
        throw new BadRequestException('Period belongs to another timetable');
      }
      if (period.kind !== PeriodKind.CLASS) {
        throw new BadRequestException('Only CLASS periods are assignable');
      }
      periodId = period.id;
      startMin = period.startMin;
      endMin = period.endMin;
    }

    const sectionSubjectId = dto.sectionSubjectId ?? current.sectionSubjectId;
    const teacherId = dto.teacherId ?? current.teacherId;
    const resolved = await this.resolveAssignment(
      sectionSubjectId,
      teacherId,
      current.sectionId,
      current.schoolId,
    );

    const nextRoom = dto.room === undefined ? current.room : dto.room || null;
    const effectiveRoom =
      (nextRoom ?? current.section.room)?.trim() || null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const conflicts = await this.findConflicts(tx, {
          timetableId: current.timetableId,
          schoolId: current.schoolId,
          sectionId: current.sectionId,
          academicYearId: current.academicYearId,
          dayOfWeek,
          startMin,
          endMin,
          teacherId: resolved.teacherId,
          effectiveRoom,
          excludeEntryId: id,
        });
        this.throwIfConflicts(conflicts);
        return tx.timetableEntry.update({
          where: { id },
          data: {
            dayOfWeek: dayOfWeek as any,
            periodId,
            startMin,
            endMin,
            sectionSubjectId: resolved.sectionSubjectId,
            teacherId: resolved.teacherId,
            room: nextRoom,
            note: dto.note === undefined ? current.note : dto.note || null,
          },
          include: this.entryInclude(),
        });
      });
    } catch (e) {
      throw this.translateWriteError(e);
    }
  }

  async deleteEntry(id: string, actor: Actor) {
    this.ensureAdmin(actor);
    const entry = await this.prisma.timetableEntry.findUnique({
      where: { id },
      select: { id: true, schoolId: true },
    });
    if (!entry) throw new NotFoundException('Assignment not found');
    this.enforceScope(actor, entry.schoolId);
    await this.prisma.timetableEntry.delete({ where: { id } });
    return { id };
  }

  /** Live pre-check for the editor — same engine, returns instead of throwing. */
  async checkConflicts(sectionId: string, dto: CreateEntryDto & { excludeEntryId?: string }, actor: Actor) {
    this.ensureAdmin(actor);
    const section = await this.loadSection(sectionId);
    this.enforceScope(actor, section.schoolId);
    const academicYearId = await this.resolveAcademicYearId(section.schoolId);
    const timetable = await this.loadTimetableForSection(sectionId, academicYearId);
    if (!timetable) return { conflicts: [] as EntryConflict[] };
    const period = await this.loadPeriod(dto.periodId, section.schoolId);
    const resolved = await this.resolveAssignment(
      dto.sectionSubjectId,
      dto.teacherId,
      sectionId,
      section.schoolId,
    );
    const effectiveRoom = (dto.room ?? section.room)?.trim() || null;
    const conflicts = await this.findConflicts(this.prisma, {
      timetableId: timetable.id,
      schoolId: section.schoolId,
      sectionId,
      academicYearId,
      dayOfWeek: dto.dayOfWeek,
      startMin: period.startMin,
      endMin: period.endMin,
      teacherId: resolved.teacherId,
      effectiveRoom,
      excludeEntryId: dto.excludeEntryId,
    });
    return { conflicts };
  }

  /**
   * Replicate a single-day template across every working day (the "Save & Apply
   * to Week" step). Replaces all existing entries atomically; per-day conflict
   * checks run for each replicated cell so a teacher busy in another section on
   * some day fails the whole apply with a clear message.
   */
  async applyTemplate(
    sectionId: string,
    dto: ApplyTemplateDto,
    actor: Actor,
  ) {
    this.ensureAdmin(actor);
    const { section, timetable } = await this.requireDraftTimetable(sectionId, actor);
    if (timetable.status !== 'DRAFT') {
      throw new ConflictException('Only a draft timetable can be (re)generated from a template');
    }
    const workingDays = (timetable.workingDays as DayOfWeek[]) ?? [];
    if (workingDays.length === 0) {
      throw new BadRequestException('This timetable has no working days');
    }

    // Validate every assignment once (period is CLASS + belongs here; subject/teacher qualified).
    const resolved = await Promise.all(
      dto.assignments.map(async (a) => {
        const period = await this.loadPeriod(a.periodId, section.schoolId);
        if (period.timetableId !== timetable.id) {
          throw new BadRequestException('Period belongs to another timetable');
        }
        if (period.kind !== PeriodKind.CLASS) {
          throw new BadRequestException('Only CLASS periods can hold a class');
        }
        const r = await this.resolveAssignment(
          a.sectionSubjectId,
          a.teacherId,
          sectionId,
          section.schoolId,
        );
        return { period, sectionSubjectId: r.sectionSubjectId, teacherId: r.teacherId, room: a.room?.trim() || null };
      }),
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.timetableEntry.deleteMany({ where: { timetableId: timetable.id } });
        let count = 0;
        for (const day of workingDays) {
          for (const r of resolved) {
            const effectiveRoom = (r.room ?? section.room)?.trim() || null;
            const conflicts = await this.findConflicts(tx, {
              timetableId: timetable.id,
              schoolId: section.schoolId,
              sectionId,
              academicYearId: timetable.academicYearId,
              dayOfWeek: day,
              startMin: r.period.startMin,
              endMin: r.period.endMin,
              teacherId: r.teacherId,
              effectiveRoom,
            });
            if (conflicts.length) {
              throw new ConflictException({
                message: `${this.dayLabel(day)}: ${conflicts.map((c) => c.message).join('; ')}`,
                day,
                conflicts,
              });
            }
            await tx.timetableEntry.create({
              data: {
                timetableId: timetable.id,
                schoolId: section.schoolId,
                sectionId,
                academicYearId: timetable.academicYearId,
                dayOfWeek: day as any,
                periodId: r.period.id,
                startMin: r.period.startMin,
                endMin: r.period.endMin,
                sectionSubjectId: r.sectionSubjectId,
                teacherId: r.teacherId,
                room: r.room,
              },
            });
            count++;
          }
        }
        return { count, days: workingDays.length };
      });
    } catch (e) {
      throw this.translateWriteError(e);
    }
  }

  private dayLabel(day: DayOfWeek): string {
    return day.charAt(0) + day.slice(1).toLowerCase();
  }

  // ---- conflict engine (time overlap) -----------------------------------

  private async findConflicts(
    tx: Tx,
    slot: CandidateSlot,
  ): Promise<EntryConflict[]> {
    const conflicts: EntryConflict[] = [];
    const notSelf = slot.excludeEntryId
      ? { id: { not: slot.excludeEntryId } }
      : {};

    // SECTION — one assignment per (section, day, period). DB unique backstops; check for a friendly message.
    const sectionClash = await tx.timetableEntry.findFirst({
      where: {
        timetableId: slot.timetableId,
        dayOfWeek: slot.dayOfWeek as any,
        startMin: { lt: slot.endMin },
        endMin: { gt: slot.startMin },
        ...notSelf,
      },
      select: { id: true },
    });
    if (sectionClash) {
      conflicts.push({
        type: 'SECTION',
        message: 'This class already has a period in that slot',
        entryId: sectionClash.id,
      });
    }

    // TEACHER — real clock-time overlap across sections in the same year.
    const teacherClash = await this.teacherClashAt(tx, {
      academicYearId: slot.academicYearId,
      teacherId: slot.teacherId,
      dayOfWeek: slot.dayOfWeek,
      startMin: slot.startMin,
      endMin: slot.endMin,
      excludeEntryId: slot.excludeEntryId,
    });
    if (teacherClash) {
      conflicts.push({
        type: 'TEACHER',
        message: `That teacher is already assigned to ${this.classLabel(
          teacherClash.section,
        )} from ${minToHHMM(teacherClash.startMin)} to ${minToHHMM(
          teacherClash.endMin,
        )}`,
        entryId: teacherClash.id,
      });
    }

    // ROOM — effective-room overlap across sections in the same year.
    if (slot.effectiveRoom) {
      const target = slot.effectiveRoom.trim().toLowerCase();
      const sameTime = await tx.timetableEntry.findMany({
        where: {
          academicYearId: slot.academicYearId,
          dayOfWeek: slot.dayOfWeek as any,
          startMin: { lt: slot.endMin },
          endMin: { gt: slot.startMin },
          ...notSelf,
        },
        select: {
          id: true,
          room: true,
          section: {
            select: { name: true, room: true, classGrade: { select: { name: true } } },
          },
        },
      });
      const clash = sameTime.find((e) => {
        const eff = (e.room ?? e.section.room ?? '').trim().toLowerCase();
        return eff !== '' && eff === target;
      });
      if (clash) {
        conflicts.push({
          type: 'ROOM',
          message: `Room "${slot.effectiveRoom}" is already used by ${this.classLabel(
            clash.section,
          )} in this slot`,
          entryId: clash.id,
        });
      }
    }

    return conflicts;
  }

  private async teacherClashAt(
    tx: Tx,
    p: {
      academicYearId: string;
      teacherId: string;
      dayOfWeek: DayOfWeek;
      startMin: number;
      endMin: number;
      excludeEntryId?: string;
    },
  ) {
    return tx.timetableEntry.findFirst({
      where: {
        academicYearId: p.academicYearId,
        teacherId: p.teacherId,
        dayOfWeek: p.dayOfWeek as any,
        startMin: { lt: p.endMin },
        endMin: { gt: p.startMin },
        ...(p.excludeEntryId ? { id: { not: p.excludeEntryId } } : {}),
      },
      select: {
        id: true,
        startMin: true,
        endMin: true,
        dayOfWeek: true,
        section: {
          select: { name: true, classGrade: { select: { name: true } } },
        },
      },
    });
  }

  private classLabel(section: {
    name: string;
    classGrade: { name: string } | null;
  }): string {
    return `${section.classGrade?.name ?? ''} ${section.name}`.trim();
  }

  private throwIfConflicts(conflicts: EntryConflict[]) {
    if (conflicts.length) {
      throw new ConflictException({
        message: conflicts.map((c) => c.message).join('; '),
        conflicts,
      });
    }
  }

  private translateWriteError(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new ConflictException('This class already has a period in that slot');
    }
    return e as Error;
  }

  private async effectiveRoomOf(
    entryRoom: string | null,
    sectionId: string,
  ): Promise<string | null> {
    if (entryRoom?.trim()) return entryRoom.trim();
    const s = await this.prisma.section.findUnique({
      where: { id: sectionId },
      select: { room: true },
    });
    return s?.room?.trim() || null;
  }

  // ---- validation / completion ------------------------------------------

  async getValidation(sectionId: string, actor: Actor, query: FindTimetableQueryDto) {
    this.ensureAdmin(actor);
    const section = await this.loadSection(sectionId);
    this.enforceScope(actor, section.schoolId);
    const academicYearId = await this.resolveAcademicYearId(
      section.schoolId,
      query.academicYearId,
    );
    const timetable = await this.loadTimetableForSection(sectionId, academicYearId);
    if (!timetable) {
      return {
        blocking: [],
        warnings: [],
        completion: { classCells: 0, assigned: 0, emptyCells: 0, unassignedSubjects: [], percent: 0 },
      };
    }
    const [periods, entries] = await Promise.all([
      this.prisma.timetablePeriod.findMany({ where: { timetableId: timetable.id }, orderBy: { index: 'asc' } }),
      this.prisma.timetableEntry.findMany({ where: { timetableId: timetable.id }, include: this.entryInclude() }),
    ]);
    return this.computeValidation(timetable, periods, entries);
  }

  private async computeValidation(
    timetable: {
      id: string;
      schoolId: string;
      sectionId: string;
      academicYearId: string;
      workingDays: string[];
      dayStartMin: number;
      dayEndMin: number;
    },
    periods: Array<{ index: number; startMin: number; endMin: number; kind: string }>,
    entries: Array<any>,
  ) {
    const blocking: { type: string; message: string }[] = [];
    const warnings: { type: string; message: string }[] = [];

    // Invalid period structure.
    const periodErrors = validatePeriodSet(
      periods.map((p) => ({ index: p.index, startMin: p.startMin, endMin: p.endMin, kind: p.kind })),
      { dayStartMin: timetable.dayStartMin, dayEndMin: timetable.dayEndMin },
    );
    for (const e of periodErrors) {
      blocking.push({ type: 'INVALID_PERIOD', message: e });
    }

    // Per-entry teacher + room conflicts (small grid; a scan each).
    const seenTeacher = new Set<string>();
    const seenRoom = new Set<string>();
    for (const e of entries) {
      const clash = await this.teacherClashAt(this.prisma, {
        academicYearId: e.academicYearId,
        teacherId: e.teacherId,
        dayOfWeek: e.dayOfWeek,
        startMin: e.startMin,
        endMin: e.endMin,
        excludeEntryId: e.id,
      });
      if (clash) {
        const key = `${e.teacherId}|${e.dayOfWeek}|${e.startMin}`;
        if (!seenTeacher.has(key)) {
          seenTeacher.add(key);
          blocking.push({
            type: 'TEACHER_CONFLICT',
            message: `${e.teacher?.fullName ?? 'A teacher'} has overlapping classes (${this.classLabel(e.section)} vs ${this.classLabel(clash.section)})`,
          });
        }
      }
      const effRoom = (e.room ?? e.section?.room ?? '').trim();
      if (effRoom) {
        const roomClash = await this.prisma.timetableEntry.findFirst({
          where: {
            academicYearId: e.academicYearId,
            dayOfWeek: e.dayOfWeek,
            startMin: { lt: e.endMin },
            endMin: { gt: e.startMin },
            id: { not: e.id },
          },
          select: { room: true, section: { select: { room: true, name: true, classGrade: { select: { name: true } } } } },
        });
        if (roomClash) {
          const otherEff = (roomClash.room ?? roomClash.section.room ?? '').trim();
          if (otherEff && otherEff.toLowerCase() === effRoom.toLowerCase()) {
            const key = `${effRoom.toLowerCase()}|${e.dayOfWeek}|${e.startMin}`;
            if (!seenRoom.has(key)) {
              seenRoom.add(key);
              blocking.push({ type: 'ROOM_CONFLICT', message: `Room "${effRoom}" is double-booked` });
            }
          }
        }
      }
    }

    // Completion + unassigned subjects.
    const classPeriods = periods.filter((p) => p.kind === PeriodKind.CLASS).length;
    const classCells = classPeriods * (timetable.workingDays?.length ?? 0);
    const assigned = entries.length;
    const emptyCells = Math.max(0, classCells - assigned);
    const percent = classCells === 0 ? 0 : Math.round((assigned / classCells) * 100);

    const sectionSubjects = await this.prisma.sectionSubject.findMany({
      where: { sectionId: timetable.sectionId },
      select: { id: true, subjectId: true, teacherId: true, subject: { select: { name: true } } },
    });
    const placed = new Set(entries.map((e) => e.sectionSubjectId));
    const unassignedSubjects = sectionSubjects
      .filter((ss) => !placed.has(ss.id))
      .map((ss) => ({ id: ss.id, name: ss.subject.name }));
    for (const u of unassignedSubjects) {
      warnings.push({ type: 'UNASSIGNED_SUBJECT', message: `${u.name} is not placed in the timetable yet` });
    }
    // Subjects with no qualified teacher at all.
    for (const ss of sectionSubjects) {
      const qualified = await this.qualifiedTeachers(timetable.schoolId, ss.subjectId, ss.teacherId);
      if (qualified.length === 0) {
        warnings.push({ type: 'NO_QUALIFIED_TEACHER', message: `${ss.subject.name} has no qualified teacher` });
      }
    }
    if (emptyCells > 0) {
      warnings.push({ type: 'EMPTY_CELLS', message: `${emptyCells} class slot(s) are still empty` });
    }

    return {
      blocking,
      warnings,
      completion: { classCells, assigned, emptyCells, unassignedSubjects, percent },
    };
  }

  // ---- lifecycle ---------------------------------------------------------

  async publish(
    sectionId: string,
    actor: Actor,
    query: FindTimetableQueryDto,
    body?: PublishTimetableDto,
  ) {
    this.ensureAdmin(actor);
    const section = await this.loadSection(sectionId);
    this.enforceScope(actor, section.schoolId);
    const academicYearId = await this.resolveAcademicYearId(section.schoolId, query.academicYearId);
    const timetable = await this.loadTimetableForSection(sectionId, academicYearId);
    if (!timetable) throw new NotFoundException('No timetable to publish');

    // Batch mode: the draft editor sends the FULL desired grid, which we
    // validate and reconcile atomically. Legacy mode (no `entries`) just flips
    // the already-saved rows to PUBLISHED.
    if (body?.entries) {
      return this.publishBatch(section, timetable, academicYearId, body);
    }

    const [periods, entries] = await Promise.all([
      this.prisma.timetablePeriod.findMany({ where: { timetableId: timetable.id }, orderBy: { index: 'asc' } }),
      this.prisma.timetableEntry.findMany({ where: { timetableId: timetable.id }, include: this.entryInclude() }),
    ]);
    if (entries.length === 0) {
      throw new BadRequestException('Cannot publish an empty timetable');
    }
    const validation = await this.computeValidation(timetable, periods, entries);
    if (validation.blocking.length > 0) {
      throw new ConflictException({
        message: 'Resolve blocking issues before publishing',
        blocking: validation.blocking,
      });
    }

    const updated = await this.prisma.timetable.update({
      where: { id: timetable.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    await this.notifyPublished(section, timetable.id);
    return updated;
  }

  /**
   * Reconcile the whole draft grid in one transaction, then PUBLISH. Everything
   * the frontend checks locally is re-validated here (subject in class, teacher
   * qualified for the subject, valid period, no teacher/class overlap) — the
   * client is never trusted. Entries are replaced wholesale (they anchor no
   * other data — Attendance keys on SectionSubject + period index, not entry id).
   */
  private async publishBatch(
    section: { id: string; name: string; schoolId: string; classGrade: { id: string; name: string } | null },
    timetable: { id: string; workingDays: string[]; dayStartMin: number; dayEndMin: number; status: string },
    academicYearId: string,
    body: PublishTimetableDto,
  ) {
    if (timetable.status === 'ARCHIVED') {
      throw new ConflictException('An archived timetable cannot be republished');
    }
    const entriesIn = body.entries ?? [];
    if (entriesIn.length === 0) {
      throw new BadRequestException('Cannot publish an empty timetable');
    }

    // ---- periods: start from DB, apply the payload's retimes ----
    const dbPeriods = await this.prisma.timetablePeriod.findMany({
      where: { timetableId: timetable.id },
      orderBy: { index: 'asc' },
    });
    const retimes = new Map<string, { startMin: number; endMin: number; label?: string }>();
    for (const p of body.periods ?? []) {
      if (!dbPeriods.some((d) => d.id === p.id)) {
        throw new BadRequestException('Payload references an unknown period');
      }
      retimes.set(p.id, { startMin: p.startMin, endMin: p.endMin, label: p.label });
    }
    const effPeriods = dbPeriods.map((p) => {
      const r = retimes.get(p.id);
      return r ? { ...p, startMin: r.startMin, endMin: r.endMin, label: r.label ?? p.label } : p;
    });
    const periodErrs = validatePeriodSet(
      effPeriods.map((p) => ({ index: p.index, startMin: p.startMin, endMin: p.endMin, kind: p.kind })),
      { dayStartMin: timetable.dayStartMin, dayEndMin: timetable.dayEndMin },
    );
    if (periodErrs.length) {
      throw new ConflictException({ message: 'Invalid period times', blocking: periodErrs });
    }
    const periodById = new Map(effPeriods.map((p) => [p.id, p]));

    // ---- lookups for in-memory validation (no per-entry queries) ----
    const ssRows = await this.prisma.sectionSubject.findMany({
      where: { sectionId: section.id },
      select: { id: true, subjectId: true, teacherId: true },
    });
    const ssMap = new Map(ssRows.map((s) => [s.id, s]));
    // Teachers allocated to this class (assigned to one of its subjects).
    const allocatedTeacherIds = new Set(
      ssRows.map((s) => s.teacherId).filter((id): id is string => !!id),
    );
    const teacherIds = [...new Set(entriesIn.map((e) => e.teacherId))];
    const teachers = await this.prisma.teacherProfile.findMany({
      where: { id: { in: teacherIds } },
      select: { id: true, schoolId: true, isActive: true, specialties: { select: { subjectId: true } } },
    });
    const teacherMap = new Map(
      teachers.map((t) => [t.id, { ...t, specialtySet: new Set(t.specialties.map((s) => s.subjectId)) }]),
    );
    const workingDays = new Set(timetable.workingDays);

    const built = entriesIn.map((e, i) => {
      const at = `Lecture ${i + 1}`;
      const ss = ssMap.get(e.sectionSubjectId);
      if (!ss) throw new BadRequestException(`${at}: that subject is not in this class`);
      if (!workingDays.has(e.dayOfWeek)) throw new BadRequestException(`${at}: ${e.dayOfWeek} is not a working day`);
      const period = periodById.get(e.periodId);
      if (!period) throw new BadRequestException(`${at}: unknown period`);
      if (period.kind !== PeriodKind.CLASS) throw new BadRequestException(`${at}: not a class period`);
      const t = teacherMap.get(e.teacherId);
      if (!t) throw new BadRequestException(`${at}: teacher not found`);
      if (t.schoolId !== section.schoolId) throw new ForbiddenException('Cross-school access denied');
      if (!t.isActive) throw new BadRequestException(`${at}: that teacher is inactive`);
      // The teacher must be ALLOCATED to this class (assigned to one of its
      // subjects) AND qualified for this subject (specialty, or this
      // section-subject's own teacher). Never trust the client's dropdown.
      const qualified = t.specialtySet.has(ss.subjectId) || ss.teacherId === e.teacherId;
      if (!allocatedTeacherIds.has(e.teacherId)) {
        throw new BadRequestException(`${at}: that teacher is not allocated to this class`);
      }
      if (!qualified) throw new BadRequestException(`${at}: teacher is not qualified for that subject`);
      return {
        dayOfWeek: e.dayOfWeek,
        periodId: e.periodId,
        sectionSubjectId: e.sectionSubjectId,
        teacherId: e.teacherId,
        room: e.room ?? null,
        startMin: period.startMin,
        endMin: period.endMin,
      };
    });

    // ---- conflict re-validation ----
    // Class: one lecture per (day, period).
    const slot = new Set<string>();
    for (const e of built) {
      const key = `${e.dayOfWeek}|${e.periodId}`;
      if (slot.has(key)) throw new ConflictException({ message: 'This class has two lectures in the same slot' });
      slot.add(key);
    }
    // Teacher: no overlap inside the payload.
    for (let i = 0; i < built.length; i++) {
      for (let j = i + 1; j < built.length; j++) {
        const a = built[i];
        const b = built[j];
        if (a.teacherId === b.teacherId && a.dayOfWeek === b.dayOfWeek && overlaps(a.startMin, a.endMin, b.startMin, b.endMin)) {
          throw new ConflictException({ message: 'A teacher is double-booked within this timetable' });
        }
      }
    }
    // Teacher: no overlap with OTHER sections this year.
    const otherBusy = await this.prisma.timetableEntry.findMany({
      where: { academicYearId, teacherId: { in: teacherIds }, timetableId: { not: timetable.id } },
      select: {
        teacherId: true, dayOfWeek: true, startMin: true, endMin: true,
        section: { select: { name: true, classGrade: { select: { name: true } } } },
      },
    });
    for (const e of built) {
      const clash = otherBusy.find(
        (b) => b.teacherId === e.teacherId && b.dayOfWeek === e.dayOfWeek && overlaps(e.startMin, e.endMin, b.startMin, b.endMin),
      );
      if (clash) {
        throw new ConflictException({
          message: `A teacher already teaches ${this.classLabel(clash.section)} at an overlapping time`,
        });
      }
    }

    // ---- atomic reconcile + publish ----
    const updated = await this.prisma.$transaction(async (tx) => {
      for (const [id, r] of retimes) {
        await tx.timetablePeriod.update({
          where: { id },
          data: { startMin: r.startMin, endMin: r.endMin, ...(r.label !== undefined ? { label: r.label } : {}) },
        });
      }
      await tx.timetableEntry.deleteMany({ where: { timetableId: timetable.id } });
      await tx.timetableEntry.createMany({
        data: built.map((e) => ({
          timetableId: timetable.id,
          schoolId: section.schoolId,
          sectionId: section.id,
          academicYearId,
          dayOfWeek: e.dayOfWeek,
          periodId: e.periodId,
          startMin: e.startMin,
          endMin: e.endMin,
          sectionSubjectId: e.sectionSubjectId,
          teacherId: e.teacherId,
          room: e.room,
        })),
      });
      return tx.timetable.update({
        where: { id: timetable.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    });
    await this.notifyPublished(section, timetable.id);
    return updated;
  }

  async archive(sectionId: string, actor: Actor, query: FindTimetableQueryDto) {
    this.ensureAdmin(actor);
    const section = await this.loadSection(sectionId);
    this.enforceScope(actor, section.schoolId);
    const academicYearId = await this.resolveAcademicYearId(section.schoolId, query.academicYearId);
    const timetable = await this.loadTimetableForSection(sectionId, academicYearId);
    if (!timetable) throw new NotFoundException('No timetable to archive');
    return this.prisma.timetable.update({
      where: { id: timetable.id },
      data: { status: 'ARCHIVED' },
    });
  }

  /**
   * Delete a section's timetable (before it's published). Cascades its periods
   * and assignments. A PUBLISHED (submitted) grid must be archived first.
   */
  async deleteTimetable(
    sectionId: string,
    actor: Actor,
    query: FindTimetableQueryDto,
  ) {
    this.ensureAdmin(actor);
    const section = await this.loadSection(sectionId);
    this.enforceScope(actor, section.schoolId);
    const academicYearId = await this.resolveAcademicYearId(
      section.schoolId,
      query.academicYearId,
    );
    const timetable = await this.loadTimetableForSection(
      sectionId,
      academicYearId,
    );
    if (!timetable) throw new NotFoundException('No timetable to delete');
    if (timetable.status === 'PUBLISHED') {
      throw new ConflictException(
        'Archive the published timetable before deleting it',
      );
    }
    // Timetable -> periods/entries cascade on delete.
    await this.prisma.timetable.delete({ where: { id: timetable.id } });
    return { id: timetable.id };
  }

  async getOverview(actor: Actor, query: FindTimetableQueryDto) {
    this.ensureAdmin(actor);
    const schoolId = this.resolveSchoolId(actor, query.schoolId);
    const academicYearId = await this.resolveAcademicYearId(schoolId, query.academicYearId);

    const [sections, timetables] = await Promise.all([
      this.prisma.section.findMany({
        where: { schoolId, isActive: true },
        select: { id: true, name: true, room: true, classGrade: { select: { id: true, name: true } } },
        orderBy: [{ classGrade: { name: 'asc' } }, { name: 'asc' }],
      }),
      this.prisma.timetable.findMany({
        where: { schoolId, academicYearId },
        select: {
          sectionId: true,
          status: true,
          workingDays: true,
          _count: { select: { entries: true } },
          periods: { select: { kind: true } },
        },
      }),
    ]);
    const bySection = new Map(timetables.map((t) => [t.sectionId, t]));
    const rows = sections.map((s) => {
      const tt = bySection.get(s.id);
      const classPeriods = tt ? tt.periods.filter((p) => p.kind === 'CLASS').length : 0;
      const classCells = classPeriods * (tt?.workingDays.length ?? 0);
      const assigned = tt?._count.entries ?? 0;
      const percent = classCells === 0 ? 0 : Math.round((assigned / classCells) * 100);
      return {
        sectionId: s.id,
        sectionName: s.name,
        room: s.room,
        classGradeId: s.classGrade?.id ?? null,
        className: s.classGrade?.name ?? '',
        status: (tt?.status ?? null) as string | null,
        completionPercent: percent,
      };
    });
    const counts = {
      total: rows.length,
      published: rows.filter((r) => r.status === 'PUBLISHED').length,
      draft: rows.filter((r) => r.status === 'DRAFT').length,
      archived: rows.filter((r) => r.status === 'ARCHIVED').length,
      unscheduled: rows.filter((r) => r.status === null).length,
    };
    return { academicYearId, counts, sections: rows };
  }

  // ---- consumer reads ----------------------------------------------------

  async getMyTimetable(actor: Actor, query: MyTimetableQueryDto) {
    if (actor.role === Role.TEACHER) {
      const teacher = await this.prisma.teacherProfile.findUnique({
        where: { userId: actor.userId },
        select: { id: true },
      });
      if (!teacher) throw new ForbiddenException('Teacher profile not found');
      return this.getTeacherTimetable(teacher.id, actor, query);
    }
    if (actor.role === Role.STUDENT) {
      const student = await this.prisma.studentProfile.findUnique({
        where: { userId: actor.userId },
        select: { id: true, schoolId: true },
      });
      if (!student) throw new ForbiddenException('Student profile not found');
      const sectionId = await this.activeSectionFor(student.id, query.academicYearId, student.schoolId);
      if (!sectionId) return this.emptyTimetable(student.schoolId);
      return this.getClassTimetable(sectionId, actor, query);
    }
    if (actor.role === Role.PARENT) {
      const studentId = await this.resolveParentChild(actor, query.studentId);
      const student = await this.prisma.studentProfile.findUnique({
        where: { id: studentId },
        select: { id: true, schoolId: true },
      });
      if (!student) throw new NotFoundException('Student not found');
      const sectionId = await this.activeSectionFor(student.id, query.academicYearId, student.schoolId);
      if (!sectionId) return this.emptyTimetable(student.schoolId);
      return this.getClassTimetable(sectionId, actor, query);
    }
    throw new ForbiddenException('Not allowed');
  }

  async getTeacherTimetable(teacherId: string, actor: Actor, query: FindTimetableQueryDto) {
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id: teacherId },
      select: { id: true, userId: true, schoolId: true },
    });
    if (!teacher) throw new NotFoundException('Teacher not found');
    this.enforceScope(actor, teacher.schoolId);
    if (actor.role === Role.TEACHER && teacher.userId !== actor.userId) {
      throw new ForbiddenException('You can only view your own timetable');
    }
    const academicYearId = await this.resolveAcademicYearId(teacher.schoolId, query.academicYearId);
    const timezone = await this.schoolTimezone(teacher.schoolId);

    const entries = await this.prisma.timetableEntry.findMany({
      where: { teacherId, academicYearId, timetable: { status: 'PUBLISHED' } },
      include: this.entryInclude(),
    });
    // Days + periods vary per section; expose the union of periods the teacher appears in.
    const periods = this.periodsFromEntries(entries);
    const workingDays = this.workingDaysFromEntries(entries);
    return { scope: 'TEACHER' as const, teacherId, timezone, workingDays, periods, entries };
  }

  async getClassTimetable(sectionId: string, actor: Actor, query: FindTimetableQueryDto) {
    const section = await this.loadSection(sectionId);
    await this.assertSectionReadAccess(actor, section);
    const academicYearId = await this.resolveAcademicYearId(section.schoolId, query.academicYearId);
    const timezone = await this.schoolTimezone(section.schoolId);
    const timetable = await this.loadTimetableForSection(sectionId, academicYearId);
    const isAdmin = actor.role === Role.SUPER_ADMIN || actor.role === Role.SCHOOL_ADMIN;
    const visible = timetable && (isAdmin || timetable.status === 'PUBLISHED');

    const [entries, periods] = await Promise.all([
      visible
        ? this.prisma.timetableEntry.findMany({ where: { timetableId: timetable!.id }, include: this.entryInclude() })
        : Promise.resolve([]),
      visible
        ? this.prisma.timetablePeriod.findMany({ where: { timetableId: timetable!.id }, orderBy: { index: 'asc' } })
        : Promise.resolve([]),
    ]);
    return {
      scope: 'CLASS' as const,
      section: { id: section.id, name: section.name, room: section.room, classGrade: section.classGrade },
      academicYearId,
      status: visible ? timetable!.status : null,
      timezone,
      workingDays: visible ? (timetable!.workingDays as DayOfWeek[]) : [],
      periods,
      entries,
    };
  }

  /** For a teacher's cross-section view, derive a distinct sorted period list. */
  private periodsFromEntries(entries: Array<any>) {
    const map = new Map<string, any>();
    for (const e of entries) {
      if (e.period) map.set(`${e.period.startMin}-${e.period.endMin}`, e.period);
    }
    return [...map.values()].sort((a, b) => a.startMin - b.startMin);
  }

  private workingDaysFromEntries(entries: Array<any>): DayOfWeek[] {
    const order: DayOfWeek[] = [
      DayOfWeek.MONDAY, DayOfWeek.TUESDAY, DayOfWeek.WEDNESDAY, DayOfWeek.THURSDAY,
      DayOfWeek.FRIDAY, DayOfWeek.SATURDAY, DayOfWeek.SUNDAY,
    ];
    const present = new Set(entries.map((e) => e.dayOfWeek));
    const days = order.filter((d) => present.has(d));
    return days.length ? days : order.slice(0, 5);
  }

  private async emptyTimetable(schoolId: string) {
    const timezone = await this.schoolTimezone(schoolId);
    return {
      scope: 'CLASS' as const,
      section: null,
      academicYearId: null,
      status: null,
      timezone,
      workingDays: [] as DayOfWeek[],
      periods: [] as any[],
      entries: [] as any[],
    };
  }

  // ---- private: entity resolution ---------------------------------------

  private async loadSectionSubject(sectionSubjectId: string) {
    const ss = await this.prisma.sectionSubject.findUnique({
      where: { id: sectionSubjectId },
      include: { section: { select: { id: true, schoolId: true } } },
    });
    if (!ss) throw new NotFoundException('Subject-class not found');
    return ss;
  }

  private async loadPeriod(periodId: string, schoolId: string) {
    const period = await this.prisma.timetablePeriod.findUnique({ where: { id: periodId } });
    if (!period) throw new NotFoundException('Period not found');
    if (period.schoolId !== schoolId) {
      throw new BadRequestException('Period belongs to another school');
    }
    return period;
  }

  private assertWorkingDay(workingDays: string[], day: DayOfWeek) {
    if (workingDays.length > 0 && !workingDays.includes(day)) {
      throw new BadRequestException(`${day} is not a working day for this section`);
    }
  }

  /**
   * Validate a CLASS assignment: the SectionSubject belongs to the section (same
   * school), and the chosen teacher is qualified for its subject (specialty or the
   * SectionSubject's own default) + same school + active.
   */
  private async resolveAssignment(
    sectionSubjectId: string,
    teacherId: string,
    sectionId: string,
    schoolId: string,
  ): Promise<{ sectionSubjectId: string; subjectId: string; teacherId: string }> {
    const ss = await this.prisma.sectionSubject.findUnique({
      where: { id: sectionSubjectId },
      include: { section: { select: { id: true, schoolId: true } } },
    });
    if (!ss) throw new NotFoundException('Subject-class not found');
    if (ss.section.schoolId !== schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }
    if (ss.sectionId !== sectionId) {
      throw new BadRequestException('That subject-class belongs to a different section');
    }

    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id: teacherId },
      select: {
        id: true,
        schoolId: true,
        isActive: true,
        specialties: { where: { subjectId: ss.subjectId }, select: { id: true } },
      },
    });
    if (!teacher) throw new NotFoundException('Teacher not found');
    if (teacher.schoolId !== schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }
    if (!teacher.isActive) {
      throw new BadRequestException('That teacher is inactive');
    }
    const qualified = teacher.specialties.length > 0 || ss.teacherId === teacherId;
    if (!qualified) {
      throw new BadRequestException('That teacher is not qualified for this subject');
    }
    return { sectionSubjectId: ss.id, subjectId: ss.subjectId, teacherId };
  }

  private async activeSectionFor(
    studentId: string,
    academicYearId: string | undefined,
    schoolId: string,
  ): Promise<string | null> {
    const yearId = await this.resolveAcademicYearId(schoolId, academicYearId);
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { studentId, academicYearId: yearId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      select: { sectionId: true },
    });
    return enrollment?.sectionId ?? null;
  }

  private async resolveParentChild(actor: Actor, studentId?: string): Promise<string> {
    const parent = await this.prisma.parentProfile.findUnique({
      where: { userId: actor.userId },
      select: { id: true },
    });
    if (!parent) throw new ForbiddenException('Parent profile not found');
    if (studentId) {
      const link = await this.prisma.parentStudent.findFirst({
        where: { parentId: parent.id, studentId },
        select: { studentId: true },
      });
      if (!link) throw new ForbiddenException('That student is not linked to you');
      return studentId;
    }
    const first = await this.prisma.parentStudent.findFirst({
      where: { parentId: parent.id },
      select: { studentId: true },
    });
    if (!first) throw new NotFoundException('No linked children');
    return first.studentId;
  }

  private async assertSectionReadAccess(
    actor: Actor,
    section: { id: string; schoolId: string },
  ) {
    this.enforceScope(actor, section.schoolId);
    if (actor.role === Role.SUPER_ADMIN || actor.role === Role.SCHOOL_ADMIN) return;
    if (actor.role === Role.TEACHER) {
      const teacher = await this.prisma.teacherProfile.findUnique({
        where: { userId: actor.userId },
        select: { id: true },
      });
      if (!teacher) throw new ForbiddenException('Teacher profile not found');
      const teaches = await this.prisma.sectionSubject.findFirst({
        where: { sectionId: section.id, teacherId: teacher.id },
        select: { id: true },
      });
      const homeroom = await this.prisma.sectionTeacher.findFirst({
        where: { sectionId: section.id, teacherId: teacher.id },
        select: { id: true },
      });
      const scheduled = await this.prisma.timetableEntry.findFirst({
        where: { sectionId: section.id, teacherId: teacher.id },
        select: { id: true },
      });
      if (!teaches && !homeroom && !scheduled) {
        throw new ForbiddenException('You do not teach this section');
      }
      return;
    }
    if (actor.role === Role.STUDENT) {
      const student = await this.prisma.studentProfile.findUnique({
        where: { userId: actor.userId },
        select: { id: true },
      });
      if (!student) throw new ForbiddenException('Student profile not found');
      const enrolled = await this.prisma.enrollment.findFirst({
        where: { sectionId: section.id, studentId: student.id },
        select: { id: true },
      });
      if (!enrolled) throw new ForbiddenException('You are not enrolled in this section');
      return;
    }
    if (actor.role === Role.PARENT) {
      const link = await this.prisma.enrollment.findFirst({
        where: {
          sectionId: section.id,
          student: { parents: { some: { parent: { userId: actor.userId } } } },
        },
        select: { id: true },
      });
      if (!link) throw new ForbiddenException('You have no child enrolled in this section');
      return;
    }
    throw new ForbiddenException('Not allowed');
  }

  // ---- notifications -----------------------------------------------------

  private async notifyPublished(
    section: { id: string; name: string; classGrade: { name: string } | null },
    timetableId: string,
  ) {
    const label = this.classLabel(section) || 'your class';
    const studentIds = await sectionStudentIds(this.prisma, section.id);
    const [ownByStudent, parentsByStudent] = await Promise.all([
      studentUserIdByStudent(this.prisma, studentIds),
      parentUserIdsByStudent(this.prisma, studentIds),
    ]);

    const teacherEntries = await this.prisma.timetableEntry.findMany({
      where: { timetableId },
      select: { teacherId: true },
      distinct: ['teacherId'],
    });
    const teacherIds = teacherEntries.map((e) => e.teacherId).filter((id): id is string => !!id);
    const teacherUserIds = teacherIds.length
      ? (
          await this.prisma.teacherProfile.findMany({
            where: { id: { in: teacherIds } },
            select: { userId: true },
          })
        )
          .map((t) => t.userId)
          .filter((id): id is string => !!id)
      : [];

    const items: NotificationCreateBatchEvent['items'] = [];
    for (const sid of studentIds) {
      const recipients = [
        ...(ownByStudent.get(sid) ? [ownByStudent.get(sid)!] : []),
        ...(parentsByStudent.get(sid) ?? []),
      ];
      if (!recipients.length) continue;
      items.push({
        userIds: recipients,
        title: 'Timetable published',
        body: `The timetable for ${label} has been published.`,
        link: '/timetable',
        entityType: 'Timetable',
        entityId: timetableId,
      });
    }
    if (teacherUserIds.length) {
      items.push({
        userIds: teacherUserIds,
        title: 'Timetable published',
        body: `The timetable for ${label} has been published.`,
        link: '/timetable',
        entityType: 'Timetable',
        entityId: timetableId,
      });
    }
    if (!items.length) return;
    this.eventEmitter.emit(NOTIFICATION_CREATE_BATCH, {
      type: 'TIMETABLE_PUBLISHED',
      notifyPreferenceKey: 'notifyAnnouncements',
      items,
    } as NotificationCreateBatchEvent);
  }
}
