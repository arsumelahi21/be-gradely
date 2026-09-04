import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AuditLogService } from '../audit/audit.service';
import { Role } from '../common/types/role.type';
import { GuardianRelationship } from '../common/types/student.type';
import * as bcrypt from 'bcrypt';
import { Actor } from '../common/types/actor.type';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { notifyFeeAllocationUpdated } from '../fees/fee-notifications';
import { formatMinorUnits } from '../fees/money.util';
import { CacheService } from '../common/services/cache.service';
import {
  SCHOOL_CACHE_TTL_SECONDS,
  schoolCacheEntityForRole,
  schoolCacheKey,
  schoolCachePrefix,
} from '../common/cache/school-cache';
import {
  schoolStatsExactKeys,
  schoolStatsPrefixes,
} from '../common/cache/stats-cache';
import { S3PresignService } from '../common/services/s3-presign.service';
import { compressImage } from '../common/upload/image-compress';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NOTIFICATION_CREATE,
  NotificationCreateEvent,
} from '../common/events/notification.events';
import { schoolAdminUserIds } from '../common/notifications/recipients';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditLogService,
    private cache: CacheService,
    private s3: S3PresignService,
    private eventEmitter: EventEmitter2,
  ) {}

  /** The school's ISO currency, for money shown inside notification copy. */
  private async schoolCurrency(schoolId: string | null | undefined) {
    if (!schoolId) return 'PKR';
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { currency: true },
    });
    return school?.currency ?? 'PKR';
  }

  /** Wipe cached lists/dashboard aggregates a user write affects; call after the transaction commits. */
  private async invalidateRoleCache(
    role: string,
    schoolId: string | null | undefined,
  ) {
    // A cross-school-only user (super-admin, no schoolId): just the admin overview.
    if (!schoolId) {
      await this.cache.del('dashboard:admin-overview');
      return;
    }
    // One del (exact keys) + one prefix scan covers everything a user write
    // affects — not 8 separate cache scans.
    const entity = schoolCacheEntityForRole(role); // 'students' | 'teachers' | null
    await Promise.all([
      this.cache.del(
        'dashboard:admin-overview',
        ...schoolStatsExactKeys(schoolId),
      ),
      this.cache.delByPrefixes(
        ...schoolStatsPrefixes(schoolId),
        schoolCachePrefix(schoolId, 'users'),
        ...(entity ? [schoolCachePrefix(schoolId, entity)] : []),
      ),
    ]);
  }

  private async ensureSchoolExists(schoolId: string) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });
    if (!school || !school.isActive)
      throw new BadRequestException('Invalid schoolId');
  }

  async create(dto: CreateUserDto, actor: Actor) {
    // Permissions
    if (actor.role === Role.SUPER_ADMIN) {
      // SUPER_ADMIN can create anyone, but only SUPER_ADMIN can have null schoolId
      if (dto.role !== Role.SUPER_ADMIN) {
        if (!dto.schoolId)
          throw new BadRequestException('schoolId is required');
        await this.ensureSchoolExists(dto.schoolId);
      } else {
        // creating another SUPER_ADMIN: schoolId must be null/undefined
        if (dto.schoolId)
          throw new BadRequestException('SUPER_ADMIN must not have schoolId');
      }
    } else if (actor.role === Role.SCHOOL_ADMIN) {
      // School admin can only create stakeholders under their school
      if (!actor.schoolId)
        throw new ForbiddenException('School Admin has no school context');
      if (![Role.TEACHER, Role.PARENT, Role.STUDENT].includes(dto.role)) {
        throw new ForbiddenException(
          'School Admin can only create Teacher/Parent/Student',
        );
      }
    } else {
      throw new ForbiddenException('Not allowed');
    }

    // Determine final schoolId
    const finalSchoolId =
      actor.role === Role.SCHOOL_ADMIN
        ? actor.schoolId!
        : (dto.schoolId ?? null);

    // Duplicate checks — fail fast with 409 Conflict before writing anything,
    // so an admin never silently overwrites or duplicates an existing record.
    const exists = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (exists) throw new ConflictException('Email already exists');

    if (dto.role === Role.STUDENT) {
      const manualRollNo = dto.rollNo?.trim();
      if (manualRollNo) {
        const dup = await this.prisma.studentProfile.findFirst({
          where: { schoolId: finalSchoolId!, rollNo: manualRollNo },
          select: { id: true },
        });
        if (dup) throw new ConflictException('Roll number already exists');
      }
      const manualAdmissionNo = dto.admissionNo?.trim();
      if (manualAdmissionNo) {
        const dup = await this.prisma.studentProfile.findFirst({
          where: { schoolId: finalSchoolId!, admissionNo: manualAdmissionNo },
          select: { id: true },
        });
        if (dup) throw new ConflictException('Admission number already exists');
      }
      // A discount from another school would be a cross-tenant leak.
      await this.assertDiscountInSchool(dto.discountId, finalSchoolId);
    }

    // Manual user-code override (teacher/parent/admin) must be unique per school.
    if (
      dto.role === Role.TEACHER ||
      dto.role === Role.PARENT ||
      dto.role === Role.SCHOOL_ADMIN
    ) {
      const manualCode = dto.userCode?.trim();
      if (manualCode && finalSchoolId) {
        const dup = await this.prisma.user.findFirst({
          where: { schoolId: finalSchoolId, userCode: manualCode },
          select: { id: true },
        });
        if (dup) throw new ConflictException('User ID already exists');
      }
    }
    // NOTE: phone/guardianPhone are intentionally NOT unique-checked — siblings
    // share a guardian's number (demo seed relies on it). Don't add this constraint.

    // Guardian for a new STUDENT: exactly one of an existing parent to link or a
    // new parent to create. Checked here (pre-tx) to fail fast; writes happen in the tx.
    let resolvedParent: {
      id: string;
      fullName: string;
      phone: string | null;
      phoneDialCode: string | null;
    } | null = null;
    let newParentHash: string | null = null;

    if (dto.role === Role.STUDENT) {
      const hasExisting = !!dto.parentProfileId;
      const hasNew = !!dto.newParent;
      if (hasExisting === hasNew) {
        throw new BadRequestException(
          'A student requires exactly one guardian: provide either parentProfileId or newParent.',
        );
      }
      if (hasExisting) {
        const parent = await this.prisma.parentProfile.findUnique({
          where: { id: dto.parentProfileId! },
          include: { user: { select: { schoolId: true } } },
        });
        if (!parent) throw new NotFoundException('Parent not found');
        if (parent.user?.schoolId !== finalSchoolId) {
          throw new ForbiddenException('Cross-school linking denied');
        }
        resolvedParent = {
          id: parent.id,
          fullName: parent.fullName,
          phone: parent.phone,
          phoneDialCode: parent.phoneDialCode,
        };
      } else {
        const dupParent = await this.prisma.user.findUnique({
          where: { email: dto.newParent!.email },
        });
        if (dupParent) {
          throw new ConflictException('Parent email already exists');
        }
        newParentHash = await bcrypt.hash(dto.newParent!.password, 10);
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    // Whether admission/roll number was auto-generated — decides if a unique
    // collision should retry vs. surface to the caller.
    const admissionNoWasAutoGenerated =
      dto.role === Role.STUDENT && !dto.admissionNo?.trim();
    const rollNoWasAutoGenerated =
      dto.role === Role.STUDENT && !dto.rollNo?.trim();
    const userCodeWasAutoGenerated =
      (dto.role === Role.TEACHER ||
        dto.role === Role.PARENT ||
        dto.role === Role.SCHOOL_ADMIN) &&
      !dto.userCode?.trim();

    // User + role profile must be created atomically — a failed profile-create
    // would otherwise orphan the User row (PLAN.md P0-13d).
    const runCreate = () =>
      this.prisma.$transaction(async (tx) => {
        // Per-school searchable id for staff/parents/admins (e.g. TCH-0001).
        // Manual value wins, else auto-generated; students/super-admins get none.
        const isCodeRole =
          dto.role === Role.TEACHER ||
          dto.role === Role.PARENT ||
          dto.role === Role.SCHOOL_ADMIN;
        const manualCode = dto.userCode?.trim();
        const userCode = isCodeRole
          ? manualCode ||
            (finalSchoolId
              ? await this.generateUserCode(tx, finalSchoolId, dto.role)
              : null)
          : null;

        // Create base user
        const user = await tx.user.create({
          data: {
            email: dto.email,
            passwordHash,
            role: dto.role as any,
            schoolId: finalSchoolId,
            isActive: true,
            userCode,
            // For SCHOOL_ADMIN and SUPER_ADMIN, store fullName/phone on User
            ...((dto.role === Role.SCHOOL_ADMIN ||
              dto.role === Role.SUPER_ADMIN) && {
              fullName: dto.fullName,
              phone: dto.phone ?? null,
              phoneDialCode: dto.phoneDialCode ?? null,
            }),
          },
        });

        // Create profile based on role (mandatory fullName)
        if (dto.role === Role.TEACHER) {
          await tx.teacherProfile.create({
            data: {
              userId: user.id,
              fullName: dto.fullName,
              email: dto.profileEmail ?? dto.email,
              phone: dto.phone ?? null,
              phoneDialCode: dto.phoneDialCode ?? null,
              phoneSecondary: dto.phoneSecondary ?? null,
              addressLine1: dto.addressLine1 ?? null,
              addressLine2: dto.addressLine2 ?? null,
              city: dto.city ?? null,
              state: dto.state ?? null,
              postalCode: dto.postalCode ?? null,
              country: dto.country ?? null,
              emergencyContactName: dto.emergencyContactName ?? null,
              emergencyContactPhone: dto.emergencyContactPhone ?? null,
              schoolId: finalSchoolId!, // guaranteed for TEACHER
              isActive: true,
            } as any,
          });
        } else if (dto.role === Role.PARENT) {
          await tx.parentProfile.create({
            data: {
              userId: user.id,
              fullName: dto.fullName,
              phone: dto.phone ?? null,
              phoneDialCode: dto.phoneDialCode ?? null,
              alternatePhone: dto.alternatePhone ?? null,
              whatsapp: dto.whatsapp ?? null,
              whatsappDialCode: dto.whatsappDialCode ?? null,
              email: dto.personalEmail ?? dto.profileEmail ?? dto.email,
              nationalId: dto.nationalId ?? null,
              occupation: dto.occupation ?? null,
              academicStatus: dto.academicStatus ?? null,
              addressLine1: dto.addressLine1 ?? null,
              addressLine2: dto.addressLine2 ?? null,
              city: dto.city ?? null,
              state: dto.state ?? null,
              postalCode: dto.postalCode ?? null,
              country: dto.country ?? null,
            } as any,
          });
        } else if (dto.role === Role.STUDENT) {
          // Admission/roll number: use the admin-supplied value if given
          // (manual override), else auto-generate a per-school sequential number.
          const admissionNo = dto.admissionNo?.trim()
            ? dto.admissionNo.trim()
            : await this.generateAdmissionNo(tx, finalSchoolId!);
          const rollNo = dto.rollNo?.trim()
            ? dto.rollNo.trim()
            : await this.generateRollNo(tx, finalSchoolId!);

          // Resolve the guardian; a new parent (User+ParentProfile) is created
          // here so student/parent/link commit atomically. Guardian name/phone snapshot from it.
          let parentProfileId: string;
          let guardianName: string | null;
          let guardianPhone: string | null;

          if (resolvedParent) {
            parentProfileId = resolvedParent.id;
            guardianName = resolvedParent.fullName;
            guardianPhone = this.composeGuardianPhone(
              resolvedParent.phoneDialCode,
              resolvedParent.phone,
            );
          } else {
            const np = dto.newParent!;
            const parentUser = await tx.user.create({
              data: {
                email: np.email,
                passwordHash: newParentHash!,
                role: Role.PARENT as any,
                schoolId: finalSchoolId,
                isActive: true,
              },
            });
            const parentProfile = await tx.parentProfile.create({
              data: {
                userId: parentUser.id,
                fullName: np.fullName,
                phone: np.phone ?? null,
                phoneDialCode: np.phoneDialCode ?? null,
                alternatePhone: np.alternatePhone ?? null,
                whatsapp: np.whatsapp ?? null,
                whatsappDialCode: np.whatsappDialCode ?? null,
                email: np.personalEmail ?? np.email,
                nationalId: np.nationalId ?? null,
                occupation: np.occupation ?? null,
                academicStatus: np.academicStatus ?? null,
                addressLine1: np.addressLine1 ?? null,
                addressLine2: np.addressLine2 ?? null,
                city: np.city ?? null,
                state: np.state ?? null,
                postalCode: np.postalCode ?? null,
                country: np.country ?? null,
              } as any,
            });
            parentProfileId = parentProfile.id;
            guardianName = np.fullName;
            guardianPhone = this.composeGuardianPhone(
              np.phoneDialCode ?? null,
              np.phone ?? null,
            );
          }

          const studentProfile = await tx.studentProfile.create({
            data: {
              userId: user.id,
              fullName: dto.fullName.trim(),
              email: dto.personalEmail ?? dto.profileEmail ?? dto.email,
              rollNo,
              admissionNo,
              phoneDialCode: dto.phoneDialCode ?? null,
              whatsapp: dto.whatsapp ?? null,
              whatsappDialCode: dto.whatsappDialCode ?? null,
              nationalId: dto.nationalId ?? null,
              dob: dto.dob ? new Date(dto.dob) : null,
              dateOfJoining: dto.dateOfJoining
                ? new Date(dto.dateOfJoining)
                : null,
              gender: (dto.gender as any) ?? null,
              bloodGroup: dto.bloodGroup?.trim() ?? null,
              guardianName,
              guardianPhone,
              emergencyContactName: dto.emergencyContactName ?? null,
              emergencyContactPhone: dto.emergencyContactPhone ?? null,
              phone: dto.phone ?? null,
              alternatePhone: dto.alternatePhone ?? null,
              address: dto.addressLine1 ?? null,
              addressLine1: dto.addressLine1 ?? null,
              addressLine2: dto.addressLine2 ?? null,
              city: dto.city ?? null,
              state: dto.state ?? null,
              postalCode: dto.postalCode ?? null,
              country: dto.country ?? null,
              prevInstituteName: dto.prevInstituteName ?? null,
              prevAdmissionNo: dto.prevAdmissionNo ?? null,
              prevLeavingReason: dto.prevLeavingReason ?? null,
              entryTestObtainedMarks: dto.entryTestObtainedMarks ?? null,
              entryTestTotalMarks: dto.entryTestTotalMarks ?? null,
              // Mandatory at admission (enforced by CreateUserDto); 0 is valid.
              monthlyFeeAmount: dto.monthlyFeeAmount ?? 0,
              discountId: dto.discountId ?? null,
              schoolId: finalSchoolId!, // guaranteed for STUDENT
              isActive: true,
            } as any,
          });

          // Link the guardian ↔ student inside the same transaction.
          await tx.parentStudent.create({
            data: {
              parentId: parentProfileId,
              studentId: studentProfile.id,
              relationship: (dto.relationship as any) ?? null,
            },
          });
        }

        return user;
      });

    // Auto-generated numbers can collide under a concurrent create (unique
    // constraint) — retry a few times; a manual-override collision surfaces as 409.
    let user: { id: string };
    let attempt = 0;

    while (true) {
      try {
        user = await runCreate();
        break;
      } catch (e: any) {
        const target = e?.meta?.target;
        const isP2002 = e?.code === 'P2002';
        const isAdmissionCollision =
          isP2002 && (target?.includes?.('admissionNo') ?? false);
        const isRollCollision =
          isP2002 && (target?.includes?.('rollNo') ?? false);
        const isCodeCollision =
          isP2002 && (target?.includes?.('userCode') ?? false);
        const retryable =
          (admissionNoWasAutoGenerated && isAdmissionCollision) ||
          (rollNoWasAutoGenerated && isRollCollision) ||
          (userCodeWasAutoGenerated && isCodeCollision);
        if (retryable && attempt < 5) {
          attempt++;
          continue;
        }
        if (isAdmissionCollision) {
          throw new ConflictException('Admission number already exists');
        }
        if (isRollCollision) {
          throw new ConflictException('Roll number already exists');
        }
        if (isCodeCollision) {
          throw new ConflictException('User ID already exists');
        }
        // Race on a User.email (student or the inline-created parent) that the
        // pre-flight check missed.
        if (isP2002 && (target?.includes?.('email') ?? false)) {
          throw new ConflictException('Email already exists');
        }
        throw e;
      }
    }

    void this.audit.record(actor.userId, 'USER_CREATE', {
      schoolId: finalSchoolId ?? actor.schoolId ?? null,
      entityType: 'User',
      entityId: user.id,
      metadata: { role: dto.role },
    });
    await this.invalidateRoleCache(dto.role, finalSchoolId);

    // Notify the school's admins that a new student/teacher was added.
    if (
      finalSchoolId &&
      (dto.role === Role.STUDENT || dto.role === Role.TEACHER)
    ) {
      const admins = (
        await schoolAdminUserIds(this.prisma, finalSchoolId)
      ).filter((id) => id !== actor.userId);
      if (admins.length) {
        this.eventEmitter.emit(NOTIFICATION_CREATE, {
          userIds: admins,
          type: 'USER_ENROLLED',
          title: `New ${dto.role === Role.TEACHER ? 'teacher' : 'student'} added`,
          body: `${dto.fullName ?? 'A new user'} was added to your school.`,
          link: dto.role === Role.TEACHER ? '/teacher' : '/student',
          notifyPreferenceKey: 'notifyGrades',
        } as NotificationCreateEvent);
      }
    }

    return this.findById(user.id, actor);
  }

  /**
   * A student's discount must belong to their own school — assigning another
   * tenant's discount would be a cross-school leak. No-op when unset/cleared.
   */
  private async assertDiscountInSchool(
    discountId: string | null | undefined,
    schoolId: string | null | undefined,
  ): Promise<void> {
    if (!discountId) return;
    const discount = await this.prisma.discount.findUnique({
      where: { id: discountId },
      select: { schoolId: true },
    });
    if (!discount || !schoolId || discount.schoolId !== schoolId) {
      throw new BadRequestException('Invalid discount for this school');
    }
  }

  /** Compose a display phone from a dial code + number (null when no number). */
  private composeGuardianPhone(
    dial?: string | null,
    number?: string | null,
  ): string | null {
    const d = (dial ?? '').trim();
    const n = (number ?? '').trim();
    return n ? (d ? `${d} ${n}` : n) : null;
  }

  /**
   * Generate a per-school sequential admission number `{schoolCode}-{year}-{0001}`.
   * Runs inside the create tx for a consistent read+insert; caller retries on collision.
   */
  private async generateAdmissionNo(
    tx: any,
    schoolId: string,
  ): Promise<string> {
    const school = await tx.school.findUnique({
      where: { id: schoolId },
      select: { code: true },
    });
    const schoolCode = (school?.code ?? 'SCH').toUpperCase();
    const year = new Date().getFullYear();
    const prefix = `${schoolCode}-${year}-`;

    // Find the highest existing sequence for this school + year prefix.
    const latest = await tx.studentProfile.findFirst({
      where: { schoolId, admissionNo: { startsWith: prefix } },
      orderBy: { admissionNo: 'desc' },
      select: { admissionNo: true },
    });

    let nextSeq = 1;
    if (latest?.admissionNo) {
      const suffix = latest.admissionNo.slice(prefix.length);
      const parsed = parseInt(suffix, 10);
      if (!Number.isNaN(parsed)) nextSeq = parsed + 1;
    }

    return `${prefix}${String(nextSeq).padStart(4, '0')}`;
  }

  /**
   * Generate a school-wide sequential roll number, zero-padded (e.g. `0007`).
   * Only numeric legacy values count toward the sequence; caller retries on collision.
   */
  private async generateRollNo(tx: any, schoolId: string): Promise<string> {
    const rows = await tx.studentProfile.findMany({
      where: { schoolId, rollNo: { not: null } },
      select: { rollNo: true },
    });

    // Only purely-numeric roll numbers drive the sequence — a manual
    // alphanumeric override (e.g. "A-42") never advances or stalls it.
    let max = 0;
    for (const r of rows) {
      const value = String(r.rollNo);
      if (/^\d+$/.test(value)) {
        const parsed = parseInt(value, 10);
        if (parsed > max) max = parsed;
      }
    }

    return String(max + 1).padStart(4, '0');
  }

  private static readonly USER_CODE_PREFIX: Partial<Record<Role, string>> = {
    [Role.TEACHER]: 'TCH',
    [Role.PARENT]: 'PAR',
    [Role.SCHOOL_ADMIN]: 'ADM',
  };

  /**
   * Generate a per-school, role-prefixed sequential user id (e.g. `TCH-0001`).
   * Caller retries on collision; returns null for roles without a prefix.
   */
  private async generateUserCode(
    tx: any,
    schoolId: string,
    role: Role,
  ): Promise<string | null> {
    const prefix = UsersService.USER_CODE_PREFIX[role];
    if (!prefix) return null;
    const rows = await tx.user.findMany({
      where: { schoolId, userCode: { startsWith: `${prefix}-` } },
      select: { userCode: true },
    });
    let max = 0;
    for (const r of rows) {
      const suffix = String(r.userCode).slice(prefix.length + 1);
      if (/^\d+$/.test(suffix)) {
        const parsed = parseInt(suffix, 10);
        if (parsed > max) max = parsed;
      }
    }
    return `${prefix}-${String(max + 1).padStart(4, '0')}`;
  }

  async findAll(
    actor: Actor,
    roleFilter?: Role,
    opts?: {
      page?: number;
      pageSize?: number;
      search?: string;
      classGradeId?: string;
      sectionId?: string;
    },
  ) {
    // Cache only the tenant-scoped (SCHOOL_ADMIN) view — SUPER_ADMIN's cross-school
    // list must not live under a school key. Variant keys on role/page/search.
    const schoolId =
      actor.role === Role.SCHOOL_ADMIN ? actor.schoolId : undefined;
    if (schoolId && this.cache) {
      const variant = {
        role: roleFilter ?? null,
        page: opts?.page ?? null,
        pageSize: opts?.pageSize ?? null,
        search: opts?.search?.trim() || null,
        classGradeId: opts?.classGradeId ?? null,
        sectionId: opts?.sectionId ?? null,
      };
      return this.cache.wrap(
        schoolCacheKey(schoolId, 'users', variant),
        SCHOOL_CACHE_TTL_SECONDS,
        () => this.computeFindAll(actor, roleFilter, opts),
      );
    }
    return this.computeFindAll(actor, roleFilter, opts);
  }

  private async computeFindAll(
    actor: Actor,
    roleFilter?: Role,
    opts?: {
      page?: number;
      pageSize?: number;
      search?: string;
      classGradeId?: string;
      sectionId?: string;
    },
  ) {
    const where: any = {};

    if (actor.role === Role.SUPER_ADMIN) {
      // SUPER_ADMIN can see all users
      if (roleFilter) {
        where.role = roleFilter;
      }
    } else if (actor.role === Role.SCHOOL_ADMIN) {
      // SCHOOL_ADMIN can only see users in their school
      if (!actor.schoolId) throw new ForbiddenException('No school context');
      where.schoolId = actor.schoolId;
      if (roleFilter) {
        where.role = roleFilter;
      }
    } else {
      throw new ForbiddenException('Not allowed');
    }

    // Class/section filter (students only — nothing else carries an enrollment).
    // Both narrow via the SAME ACTIVE enrollment, so a stale past-year row in
    // the requested class can't pull a student who has since moved on.
    if (opts?.classGradeId || opts?.sectionId) {
      where.studentProfile = {
        is: {
          enrollments: {
            some: {
              status: EnrollmentStatus.ACTIVE,
              ...(opts.sectionId ? { sectionId: opts.sectionId } : {}),
              ...(opts.classGradeId
                ? { section: { classGradeId: opts.classGradeId } }
                : {}),
            },
          },
        },
      };
    }

    // Optional cross-field search (email + any profile fullName + rollNo).
    if (opts?.search?.trim()) {
      const s = opts.search.trim();
      where.OR = [
        { email: { contains: s, mode: 'insensitive' } },
        { fullName: { contains: s, mode: 'insensitive' } },
        { userCode: { contains: s, mode: 'insensitive' } },
        {
          studentProfile: {
            is: { fullName: { contains: s, mode: 'insensitive' } },
          },
        },
        {
          studentProfile: {
            is: { rollNo: { contains: s, mode: 'insensitive' } },
          },
        },
        {
          teacherProfile: {
            is: { fullName: { contains: s, mode: 'insensitive' } },
          },
        },
        {
          parentProfile: {
            is: { fullName: { contains: s, mode: 'insensitive' } },
          },
        },
      ];
    }

    const include = this.defaultUserInclude();
    const orderBy = { createdAt: 'desc' as const };

    // Paginate when a page is requested; otherwise return the full array
    // (back-compatible with callers that use the list for counts/dropdowns).
    let rows: any[];
    let envelope: { total: number; page: number; pageSize: number } | null =
      null;
    if (opts?.page != null) {
      const { skip, take, page, pageSize } = resolvePagination(opts);
      // Reads don't need a transaction; Promise.all runs count + page in parallel
      // (2 round-trips) instead of a serialized tx over the remote DB.
      const [total, paged] = await Promise.all([
        this.prisma.user.count({ where }),
        this.prisma.user.findMany({
          where,
          orderBy,
          include,
          skip,
          take,
          relationLoadStrategy: 'join',
        }),
      ]);
      rows = paged;
      envelope = { total, page, pageSize };
    } else {
      rows = await this.prisma.user.findMany({
        where,
        orderBy,
        include,
        relationLoadStrategy: 'join',
      });
    }

    // Return safe shape (no passwordHash/refreshTokenHash) and include fullName/phone at root level
    const items = rows.map((user: any) => {
      const { passwordHash, refreshTokenHash, ...safe } = user;

      // Include fullName and phone at root level from profile if not already present
      if (!safe.fullName) {
        if (safe.teacherProfile) {
          safe.fullName = safe.teacherProfile.fullName;
          safe.phone = safe.teacherProfile.phone;
        } else if (safe.parentProfile) {
          safe.fullName = safe.parentProfile.fullName;
          safe.phone = safe.parentProfile.phone;
        } else if (safe.studentProfile) {
          safe.fullName = safe.studentProfile.fullName;
        }
      }

      // Include students array at root level for parents
      if (safe.parentProfile && safe.parentProfile.children) {
        safe.students = safe.parentProfile.children.map(
          (child: any) => child.student,
        );
      }

      // Include parents array at root level for students
      if (safe.studentProfile && safe.studentProfile.parents) {
        safe.parents = safe.studentProfile.parents.map((parentLink: any) => {
          const parent = parentLink.parent;
          // Include email from User table if parentProfile email is null
          const parentData: any = {
            ...parent,
            email: parent.email || parent.user?.email || null,
          };
          // Include userId if user relation exists
          if (parent.user) {
            parentData.userId = parent.user.id;
          }
          // Remove nested user object to avoid duplication
          delete parentData.user;
          return parentData;
        });
      }

      // Include assigned classes (sections) at root level for teachers
      if (safe.teacherProfile && safe.teacherProfile.sections) {
        safe.assignedClasses = safe.teacherProfile.sections.map((st: any) => ({
          id: st.id,
          sectionId: st.sectionId,
          assignmentRole: st.assignmentRole,
          isPrimary: st.isPrimary,
          startDate: st.startDate,
          endDate: st.endDate,
          section: {
            id: st.section.id,
            name: st.section.name,
            room: st.section.room,
            classGrade: st.section.classGrade,
          },
        }));
      }

      return safe;
    });

    return envelope ? { items, ...envelope } : items;
  }

  async findById(id: string, actor: Actor) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.defaultUserInclude(),
      // Resolve the deep profile include in one SQL join instead of ~10 separate
      // round-trips (identical result shape). Critical against the remote DB.
      relationLoadStrategy: 'join',
    });

    if (!user) throw new NotFoundException('User not found');

    // Teachers, Students, and Parents can only access their own profile
    if ([Role.TEACHER, Role.STUDENT, Role.PARENT].includes(actor.role)) {
      // Verify the requested user ID matches the logged-in user's ID
      // actor.userId comes from JWT token's 'sub' field
      if (!actor.userId) {
        throw new ForbiddenException(
          'User ID not found in authentication token',
        );
      }

      // Check if the requested ID matches the logged-in user's ID
      if (actor.userId !== id) {
        throw new ForbiddenException(
          `You can only access your own profile. Your userId: ${actor.userId}, Requested userId: ${id}`,
        );
      }

      // Also verify the found user matches (should always be true if above passes)
      if (actor.userId !== user.id) {
        throw new ForbiddenException('User ID mismatch');
      }
    }

    // Scoping: school admin can only view within their school
    if (actor.role === Role.SCHOOL_ADMIN && actor.schoolId !== user.schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }

    // Return safe shape (no passwordHash/refreshTokenHash)
    const { passwordHash, refreshTokenHash, ...safe } = user as any;

    // Include fullName and phone at root level from profile if not already present
    if (!safe.fullName) {
      if (safe.teacherProfile) {
        safe.fullName = safe.teacherProfile.fullName;
        safe.phone = safe.teacherProfile.phone;
      } else if (safe.parentProfile) {
        safe.fullName = safe.parentProfile.fullName;
        safe.phone = safe.parentProfile.phone;
      } else if (safe.studentProfile) {
        safe.fullName = safe.studentProfile.fullName;
      }
    }

    // Include students array at root level for parents
    if (safe.parentProfile && safe.parentProfile.children) {
      safe.students = safe.parentProfile.children.map(
        (child: any) => child.student,
      );
    }

    // Include parents array at root level for students
    if (safe.studentProfile && safe.studentProfile.parents) {
      safe.parents = safe.studentProfile.parents.map((parentLink: any) => {
        const parent = parentLink.parent;
        // Include email from User table if parentProfile email is null
        const parentData: any = {
          ...parent,
          email: parent.email || parent.user?.email || null,
        };
        // Include userId if user relation exists
        if (parent.user) {
          parentData.userId = parent.user.id;
        }
        // Remove nested user object to avoid duplication
        delete parentData.user;
        return parentData;
      });
    }

    // Include assigned classes (sections) at root level for teachers
    if (safe.teacherProfile && safe.teacherProfile.sections) {
      safe.assignedClasses = safe.teacherProfile.sections.map((st: any) => ({
        id: st.id,
        sectionId: st.sectionId,
        assignmentRole: st.assignmentRole,
        isPrimary: st.isPrimary,
        startDate: st.startDate,
        endDate: st.endDate,
        section: {
          id: st.section.id,
          name: st.section.name,
          room: st.section.room,
          classGrade: st.section.classGrade,
        },
      }));
    }

    return safe;
  }

  async setActive(id: string, isActive: boolean, actor: Actor) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    if (actor.role === Role.SCHOOL_ADMIN) {
      if (!actor.schoolId || user.schoolId !== actor.schoolId)
        throw new ForbiddenException('Cross-school access denied');
      if (user.role === Role.SCHOOL_ADMIN || user.role === Role.SUPER_ADMIN)
        throw new ForbiddenException('Cannot modify admins');
    }

    if (actor.role !== Role.SUPER_ADMIN && actor.role !== Role.SCHOOL_ADMIN) {
      throw new ForbiddenException('Not allowed');
    }

    return this.prisma.user.update({
      where: { id },
      data: { isActive },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        schoolId: true,
      },
    });
  }

  async update(id: string, dto: UpdateUserDto, actor: Actor) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        teacherProfile: true,
        parentProfile: true,
        studentProfile: true,
      },
    });

    if (!user) throw new NotFoundException('User not found');

    // Permission checks
    if (actor.role === Role.SCHOOL_ADMIN) {
      if (!actor.schoolId || user.schoolId !== actor.schoolId) {
        throw new ForbiddenException('Cross-school access denied');
      }
      // School admin cannot modify admins — except their own profile (self).
      if (
        (user.role === Role.SCHOOL_ADMIN || user.role === Role.SUPER_ADMIN) &&
        id !== actor.userId
      ) {
        throw new ForbiddenException('Cannot modify admins');
      }
      // School admin cannot change schoolId (move users between schools)
      if (dto.schoolId !== undefined && dto.schoolId !== user.schoolId) {
        throw new ForbiddenException('Cannot change user school');
      }
    }

    // Validate email uniqueness if email is being updated
    if (dto.email && dto.email !== user.email) {
      const exists = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (exists) throw new ConflictException('Email already exists');
    }

    // Validate rollNo/admissionNo uniqueness for students only when changing —
    // an edit can't collide with another student in the school.
    if (user.role === Role.STUDENT && user.studentProfile) {
      const schoolId = user.schoolId!;
      if (dto.rollNo !== undefined) {
        const newRoll = dto.rollNo?.trim() || null;
        if (newRoll && newRoll !== user.studentProfile.rollNo) {
          const dup = await this.prisma.studentProfile.findFirst({
            where: {
              schoolId,
              rollNo: newRoll,
              NOT: { id: user.studentProfile.id },
            },
            select: { id: true },
          });
          if (dup) throw new ConflictException('Roll number already exists');
        }
      }
      if (dto.admissionNo !== undefined) {
        const newAdm = dto.admissionNo?.trim() || null;
        if (newAdm && newAdm !== user.studentProfile.admissionNo) {
          const dup = await this.prisma.studentProfile.findFirst({
            where: {
              schoolId,
              admissionNo: newAdm,
              NOT: { id: user.studentProfile.id },
            },
            select: { id: true },
          });
          if (dup)
            throw new ConflictException('Admission number already exists');
        }
      }
      if (dto.discountId !== undefined) {
        await this.assertDiscountInSchool(dto.discountId, schoolId);
      }
    }

    // userCode uniqueness for staff/parents/admins, only when actually changing.
    if (
      dto.userCode !== undefined &&
      (user.role === Role.TEACHER ||
        user.role === Role.PARENT ||
        user.role === Role.SCHOOL_ADMIN) &&
      user.schoolId
    ) {
      const newCode = dto.userCode?.trim() || null;
      if (newCode && newCode !== user.userCode) {
        const dup = await this.prisma.user.findFirst({
          where: { schoolId: user.schoolId, userCode: newCode, NOT: { id } },
          select: { id: true },
        });
        if (dup) throw new ConflictException('User ID already exists');
      }
    }

    // Validate school exists if schoolId is being updated (only SUPER_ADMIN can do this)
    if (dto.schoolId !== undefined && dto.schoolId !== user.schoolId) {
      if (actor.role !== Role.SUPER_ADMIN) {
        throw new ForbiddenException('Only SUPER_ADMIN can change user school');
      }
      // SUPER_ADMIN cannot assign schoolId to another SUPER_ADMIN
      if (user.role === Role.SUPER_ADMIN && dto.schoolId !== null) {
        throw new BadRequestException('SUPER_ADMIN must not have schoolId');
      }
      if (dto.schoolId) {
        await this.ensureSchoolExists(dto.schoolId);
      }
    }

    // Update User model fields (email, schoolId)
    const userUpdateData: any = {};
    if (dto.email !== undefined && dto.email !== user.email) {
      userUpdateData.email = dto.email;
    }
    if (dto.schoolId !== undefined && dto.schoolId !== user.schoolId) {
      userUpdateData.schoolId = dto.schoolId ?? null;
    }
    if (dto.userCode !== undefined) {
      userUpdateData.userCode = dto.userCode?.trim() || null;
    }

    if (Object.keys(userUpdateData).length > 0) {
      await this.prisma.user.update({
        where: { id },
        data: userUpdateData,
      });
    }

    // Update profile based on role
    if (user.role === Role.TEACHER && user.teacherProfile) {
      await this.prisma.teacherProfile.update({
        where: { id: user.teacherProfile.id },
        data: {
          ...(dto.fullName !== undefined && { fullName: dto.fullName }),
          ...(dto.profileEmail !== undefined && {
            email: dto.profileEmail ?? null,
          }),
          ...(dto.phone !== undefined && { phone: dto.phone ?? null }),
          ...(dto.phoneDialCode !== undefined && {
            phoneDialCode: dto.phoneDialCode ?? null,
          }),
          ...(dto.phoneSecondary !== undefined && {
            phoneSecondary: dto.phoneSecondary ?? null,
          }),
          ...(dto.addressLine1 !== undefined && {
            addressLine1: dto.addressLine1 ?? null,
          }),
          ...(dto.addressLine2 !== undefined && {
            addressLine2: dto.addressLine2 ?? null,
          }),
          ...(dto.city !== undefined && { city: dto.city ?? null }),
          ...(dto.state !== undefined && { state: dto.state ?? null }),
          ...(dto.postalCode !== undefined && {
            postalCode: dto.postalCode ?? null,
          }),
          ...(dto.country !== undefined && { country: dto.country ?? null }),
          ...(dto.emergencyContactName !== undefined && {
            emergencyContactName: dto.emergencyContactName ?? null,
          }),
          ...(dto.emergencyContactPhone !== undefined && {
            emergencyContactPhone: dto.emergencyContactPhone ?? null,
          }),
        },
      });
    } else if (user.role === Role.PARENT && user.parentProfile) {
      await this.prisma.parentProfile.update({
        where: { id: user.parentProfile.id },
        data: {
          ...(dto.fullName !== undefined && { fullName: dto.fullName }),
          ...(dto.phone !== undefined && { phone: dto.phone ?? null }),
          ...(dto.phoneDialCode !== undefined && {
            phoneDialCode: dto.phoneDialCode ?? null,
          }),
          ...(dto.alternatePhone !== undefined && {
            alternatePhone: dto.alternatePhone ?? null,
          }),
          ...(dto.addressLine1 !== undefined && {
            addressLine1: dto.addressLine1 ?? null,
          }),
          ...(dto.addressLine2 !== undefined && {
            addressLine2: dto.addressLine2 ?? null,
          }),
          ...(dto.city !== undefined && { city: dto.city ?? null }),
          ...(dto.state !== undefined && { state: dto.state ?? null }),
          ...(dto.postalCode !== undefined && {
            postalCode: dto.postalCode ?? null,
          }),
          ...(dto.country !== undefined && { country: dto.country ?? null }),
          ...(dto.profileEmail !== undefined && {
            email: dto.profileEmail ?? null,
          }),
          ...(dto.whatsapp !== undefined && {
            whatsapp: dto.whatsapp ?? null,
          }),
          ...(dto.whatsappDialCode !== undefined && {
            whatsappDialCode: dto.whatsappDialCode ?? null,
          }),
          ...(dto.nationalId !== undefined && {
            nationalId: dto.nationalId ?? null,
          }),
          ...(dto.occupation !== undefined && {
            occupation: dto.occupation ?? null,
          }),
          ...(dto.academicStatus !== undefined && {
            academicStatus: dto.academicStatus ?? null,
          }),
        },
      });
    } else if (user.role === Role.STUDENT && user.studentProfile) {
      await this.prisma.studentProfile.update({
        where: { id: user.studentProfile.id },
        data: {
          ...(dto.fullName !== undefined && { fullName: dto.fullName }),
          ...(dto.rollNo !== undefined && {
            rollNo: dto.rollNo?.trim() || null,
          }),
          ...(dto.dob !== undefined && {
            dob: dto.dob ? new Date(dto.dob) : null,
          }),
          ...(dto.profileEmail !== undefined && {
            email: dto.profileEmail ?? null,
          }),
          ...(dto.phone !== undefined && { phone: dto.phone ?? null }),
          ...(dto.phoneDialCode !== undefined && {
            phoneDialCode: dto.phoneDialCode ?? null,
          }),
          ...(dto.alternatePhone !== undefined && {
            alternatePhone: dto.alternatePhone ?? null,
          }),
          ...(dto.addressLine1 !== undefined && {
            addressLine1: dto.addressLine1 ?? null,
          }),
          ...(dto.addressLine2 !== undefined && {
            addressLine2: dto.addressLine2 ?? null,
          }),
          ...(dto.city !== undefined && { city: dto.city ?? null }),
          ...(dto.state !== undefined && { state: dto.state ?? null }),
          ...(dto.postalCode !== undefined && {
            postalCode: dto.postalCode ?? null,
          }),
          ...(dto.country !== undefined && { country: dto.country ?? null }),
          ...(dto.guardianName !== undefined && {
            guardianName: dto.guardianName ?? null,
          }),
          ...(dto.guardianPhone !== undefined && {
            guardianPhone: dto.guardianPhone ?? null,
          }),
          ...(dto.emergencyContactName !== undefined && {
            emergencyContactName: dto.emergencyContactName ?? null,
          }),
          ...(dto.emergencyContactPhone !== undefined && {
            emergencyContactPhone: dto.emergencyContactPhone ?? null,
          }),
          ...(dto.admissionNo !== undefined && {
            admissionNo: dto.admissionNo?.trim() || null,
          }),
          ...(dto.dateOfJoining !== undefined && {
            dateOfJoining: dto.dateOfJoining
              ? new Date(dto.dateOfJoining)
              : null,
          }),
          ...(dto.gender !== undefined && {
            gender: (dto.gender as any) ?? null,
          }),
          ...(dto.bloodGroup !== undefined && {
            bloodGroup: dto.bloodGroup?.trim() || null,
          }),
          ...(dto.whatsapp !== undefined && {
            whatsapp: dto.whatsapp ?? null,
          }),
          ...(dto.whatsappDialCode !== undefined && {
            whatsappDialCode: dto.whatsappDialCode ?? null,
          }),
          ...(dto.nationalId !== undefined && {
            nationalId: dto.nationalId ?? null,
          }),
          ...(dto.prevInstituteName !== undefined && {
            prevInstituteName: dto.prevInstituteName ?? null,
          }),
          ...(dto.prevAdmissionNo !== undefined && {
            prevAdmissionNo: dto.prevAdmissionNo ?? null,
          }),
          ...(dto.prevLeavingReason !== undefined && {
            prevLeavingReason: dto.prevLeavingReason ?? null,
          }),
          ...(dto.entryTestObtainedMarks !== undefined && {
            entryTestObtainedMarks: dto.entryTestObtainedMarks ?? null,
          }),
          ...(dto.entryTestTotalMarks !== undefined && {
            entryTestTotalMarks: dto.entryTestTotalMarks ?? null,
          }),
          // `!== undefined` (not a truthiness check) so an explicit 0 writes.
          ...(dto.monthlyFeeAmount !== undefined && {
            monthlyFeeAmount: dto.monthlyFeeAmount,
          }),
          ...(dto.discountId !== undefined && {
            discountId: dto.discountId || null,
          }),
        },
      });

      // Notify only on a REAL change — a resubmitted edit with the same values
      // writes the same row and must not fire a second notification.
      const feeChanged =
        (dto.monthlyFeeAmount !== undefined &&
          dto.monthlyFeeAmount !== user.studentProfile.monthlyFeeAmount) ||
        (dto.discountId !== undefined &&
          (dto.discountId || null) !== user.studentProfile.discountId);

      if (feeChanged) {
        const amount =
          dto.monthlyFeeAmount ?? user.studentProfile.monthlyFeeAmount;
        const name = user.studentProfile.fullName ?? 'This student';
        await notifyFeeAllocationUpdated(
          this.prisma,
          this.eventEmitter,
          user.studentProfile.id,
          name,
          'Fee updated',
          `${name}'s monthly fee is now ${formatMinorUnits(amount, await this.schoolCurrency(user.schoolId))}. Open Fees to review.`,
        );
      }
    } else if (
      user.role === Role.SCHOOL_ADMIN ||
      user.role === Role.SUPER_ADMIN
    ) {
      // For SCHOOL_ADMIN and SUPER_ADMIN, update fullName and phone directly on User
      const updateData: any = {};
      if (dto.fullName !== undefined) updateData.fullName = dto.fullName;
      if (dto.phone !== undefined) updateData.phone = dto.phone ?? null;
      if (dto.phoneDialCode !== undefined)
        updateData.phoneDialCode = dto.phoneDialCode ?? null;

      if (Object.keys(updateData).length > 0) {
        await this.prisma.user.update({
          where: { id },
          data: updateData,
        });
      }
    }

    void this.audit.record(actor.userId, 'USER_UPDATE', {
      schoolId: user.schoolId ?? actor.schoolId ?? null,
      entityType: 'User',
      entityId: id,
      metadata: { role: user.role },
    });
    await this.invalidateRoleCache(user.role, user.schoolId);

    // Return updated user with full profile
    return this.findById(id, actor);
  }

  /**
   * Self-service profile update (PATCH /users/me); delegates to update() with
   * the actor editing their own id. Immutable fields are rejected by UpdateMeDto's whitelist.
   */
  async updateMe(actor: Actor, dto: UpdateMeDto) {
    return this.update(actor.userId, dto, actor);
  }

  // Self-service password change: verify current password, set the new hash, and
  // null refreshTokenHash so other sessions must re-login (mirrors resetPassword).
  async changeMyPassword(actor: Actor, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!ok) throw new BadRequestException('Current password is incorrect');
    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, refreshTokenHash: null },
    });
    return { success: true };
  }

  async linkParentStudent(
    parentProfileId: string,
    studentProfileId: string,
    actor: Actor,
    relationship?: GuardianRelationship,
  ) {
    // only school admin can link (for MVP)
    if (actor.role !== Role.SCHOOL_ADMIN)
      throw new ForbiddenException('Not allowed');
    if (!actor.schoolId) throw new ForbiddenException('No school context');

    const parent = await this.prisma.parentProfile.findUnique({
      where: { id: parentProfileId },
      include: { user: true },
    });

    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentProfileId },
      include: { user: true },
    });

    if (!parent || !student)
      throw new NotFoundException('Parent/Student not found');

    if (!parent.user || !student.user) {
      throw new NotFoundException('Parent/Student user not found');
    }

    if (
      parent.user.schoolId !== actor.schoolId ||
      student.user.schoolId !== actor.schoolId
    ) {
      throw new ForbiddenException('Cross-school linking denied');
    }

    // ✅ Correct way: create/upsert join table row
    await this.prisma.parentStudent.upsert({
      where: {
        parentId_studentId: {
          parentId: parentProfileId,
          studentId: studentProfileId,
        },
      },
      update: {
        ...(relationship !== undefined && {
          relationship: relationship as any,
        }),
      },
      create: {
        parentId: parentProfileId,
        studentId: studentProfileId,
        relationship: (relationship as any) ?? null,
      },
    });

    // Return parent with linked children
    return this.prisma.parentProfile.findUnique({
      where: { id: parentProfileId },
      include: {
        user: true,
        children: {
          include: {
            student: true,
          },
        },
      },
    });
  }

  /**
   * Unlink a guardian (parent) from a student. A student must always keep at
   * least one guardian, so the last remaining link cannot be removed.
   */
  async unlinkParentStudent(
    parentProfileId: string,
    studentProfileId: string,
    actor: Actor,
  ) {
    if (actor.role !== Role.SCHOOL_ADMIN)
      throw new ForbiddenException('Not allowed');
    if (!actor.schoolId) throw new ForbiddenException('No school context');

    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentProfileId },
      include: { user: true },
    });
    if (!student || !student.user)
      throw new NotFoundException('Student not found');
    if (student.user.schoolId !== actor.schoolId)
      throw new ForbiddenException('Cross-school access denied');

    const link = await this.prisma.parentStudent.findUnique({
      where: {
        parentId_studentId: {
          parentId: parentProfileId,
          studentId: studentProfileId,
        },
      },
    });
    if (!link) throw new NotFoundException('Guardian link not found');

    // Enforce the minimum-one-guardian rule (backstop for the UI).
    const linkCount = await this.prisma.parentStudent.count({
      where: { studentId: studentProfileId },
    });
    if (linkCount <= 1)
      throw new BadRequestException(
        'A student must have at least one guardian',
      );

    await this.prisma.parentStudent.delete({
      where: {
        parentId_studentId: {
          parentId: parentProfileId,
          studentId: studentProfileId,
        },
      },
    });

    return { success: true };
  }

  // ---- Student photo (stored in the DB, isolated in StudentPhoto) ----

  private assertStudentPhotoWrite(
    actor: Actor,
    student: { schoolId: string; userId: string | null },
  ) {
    if (actor.role === Role.SUPER_ADMIN) return;
    if (actor.role === Role.SCHOOL_ADMIN && actor.schoolId === student.schoolId)
      return;
    // A student may set/update their own photo from their profile.
    if (actor.role === Role.STUDENT && student.userId === actor.userId) return;
    throw new ForbiddenException('Not allowed');
  }

  private async assertStudentPhotoRead(
    actor: Actor,
    student: { id: string; schoolId: string; userId: string | null },
  ) {
    if (actor.role === Role.SUPER_ADMIN) return;
    if (
      (actor.role === Role.SCHOOL_ADMIN || actor.role === Role.TEACHER) &&
      actor.schoolId === student.schoolId
    )
      return;
    if (actor.role === Role.STUDENT && student.userId === actor.userId) return;
    if (actor.role === Role.PARENT) {
      const link = await this.prisma.parentStudent.findFirst({
        where: {
          studentId: student.id,
          parent: { user: { id: actor.userId } },
        },
        select: { parentId: true },
      });
      if (link) return;
    }
    throw new ForbiddenException('Not allowed');
  }

  async uploadStudentPhoto(
    studentId: string,
    file: { buffer: Buffer; mimetype: string } | undefined,
    actor: Actor,
  ) {
    if (!file || !file.buffer?.length) {
      throw new BadRequestException('No photo file provided');
    }
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Unsupported image type');
    }
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { id: true, schoolId: true, userId: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    this.assertStudentPhotoWrite(actor, student);

    // Compress to KBs, then store in S3 under {school}/profile-pictures/{userId}/.
    const { buffer, mimeType } = await compressImage(
      file.buffer,
      file.mimetype,
      512, // profile pics don't need to be large
    );
    const ext = (mimeType ?? 'image/jpeg').split('/')[1] || 'jpg';
    const s3Key = await this.s3.keyFor(
      student.schoolId,
      'profile-pictures',
      student.userId ?? student.id,
      `photo.${ext}`,
    );
    await this.s3.putObject({
      key: s3Key,
      body: buffer,
      contentType: mimeType,
    });

    // Point the profile at the S3 object and drop any legacy DB-bytes row.
    await this.prisma.$transaction([
      this.prisma.studentProfile.update({
        where: { id: student.id },
        data: { photoS3Key: s3Key, photoMimeType: mimeType ?? file.mimetype },
      }),
      this.prisma.studentPhoto.deleteMany({
        where: { studentId: student.id },
      }),
    ]);
    return { success: true, mimeType: mimeType ?? file.mimetype };
  }

  async getStudentPhoto(studentId: string, actor: Actor) {
    // Metadata only — don't pull the photo BYTEA here. The S3 path never needs
    // it; the legacy DB-bytes path loads it lazily below.
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        schoolId: true,
        userId: true,
        photoMimeType: true,
        photoS3Key: true,
      },
    });
    if (!student) throw new NotFoundException('Student not found');
    await this.assertStudentPhotoRead(actor, student);
    if (!student.photoMimeType) throw new NotFoundException('No photo');

    // Prefer S3; fall back to legacy DB bytes for pre-migration rows.
    if (student.photoS3Key) {
      const data = await this.s3.getObjectBuffer(student.photoS3Key);
      return { data, mimeType: student.photoMimeType };
    }
    const legacy = await this.prisma.studentPhoto.findUnique({
      where: { studentId: student.id },
      select: { data: true },
    });
    if (legacy) {
      return {
        data: legacy.data as Buffer,
        mimeType: student.photoMimeType,
      };
    }
    throw new NotFoundException('No photo');
  }

  // ---- Generic self-service avatar (any role), stored as bytes in UserPhoto ----

  async uploadMyPhoto(
    file: { buffer: Buffer; mimetype: string } | undefined,
    actor: Actor,
  ) {
    if (!file || !file.buffer?.length) {
      throw new BadRequestException('No photo file provided');
    }
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Unsupported image type');
    }
    const { buffer, mimeType } = await compressImage(
      file.buffer,
      file.mimetype,
      512, // avatars don't need to be large
    );
    const mt = mimeType ?? file.mimetype;
    // Prisma Bytes wants Uint8Array<ArrayBuffer>; normalize the Node Buffer.
    const bytes = Uint8Array.from(buffer);
    await this.prisma.$transaction([
      this.prisma.userPhoto.upsert({
        where: { userId: actor.userId },
        create: { userId: actor.userId, data: bytes, mimeType: mt },
        update: { data: bytes, mimeType: mt },
      }),
      this.prisma.user.update({
        where: { id: actor.userId },
        data: { photoMimeType: mt },
      }),
    ]);
    return { success: true, mimeType: mt };
  }

  async deleteMyPhoto(actor: Actor) {
    await this.prisma.$transaction([
      this.prisma.userPhoto.deleteMany({ where: { userId: actor.userId } }),
      this.prisma.user.update({
        where: { id: actor.userId },
        data: { photoMimeType: null },
      }),
    ]);
    return { success: true };
  }

  async getUserPhoto(userId: string, actor: Actor) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, schoolId: true, photoMimeType: true },
    });
    if (!target) throw new NotFoundException('User not found');
    // Avatars are visible to the owner, super-admins, and same-school members.
    const sameSchool = !!actor.schoolId && actor.schoolId === target.schoolId;
    if (
      actor.userId !== target.id &&
      actor.role !== Role.SUPER_ADMIN &&
      !sameSchool
    ) {
      throw new ForbiddenException('Cross-school access denied');
    }
    if (!target.photoMimeType) throw new NotFoundException('No photo');
    const row = await this.prisma.userPhoto.findUnique({
      where: { userId: target.id },
      select: { data: true, mimeType: true },
    });
    if (!row) throw new NotFoundException('No photo');
    return { data: row.data as Buffer, mimeType: row.mimeType };
  }

  async remove(id: string, actor: Actor) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        teacherProfile: true,
        parentProfile: true,
        studentProfile: true,
      },
    });

    if (!user) throw new NotFoundException('User not found');

    // Permission checks
    if (actor.role === Role.SCHOOL_ADMIN) {
      if (!actor.schoolId || user.schoolId !== actor.schoolId) {
        throw new ForbiddenException('Cross-school access denied');
      }
      // School admin cannot delete admins
      if (user.role === Role.SCHOOL_ADMIN || user.role === Role.SUPER_ADMIN) {
        throw new ForbiddenException('Cannot delete admins');
      }
    }

    // Atomic: delete the role profile (+ parent-student links) then the user
    // in one transaction — separate awaits could orphan rows on a mid-sequence failure.
    await this.prisma.$transaction(async (tx) => {
      if (user.teacherProfile) {
        await tx.teacherProfile.delete({
          where: { id: user.teacherProfile.id },
        });
      } else if (user.parentProfile) {
        await tx.parentStudent.deleteMany({
          where: { parentId: user.parentProfile.id },
        });
        await tx.parentProfile.delete({
          where: { id: user.parentProfile.id },
        });
      } else if (user.studentProfile) {
        await tx.parentStudent.deleteMany({
          where: { studentId: user.studentProfile.id },
        });
        await tx.studentProfile.delete({
          where: { id: user.studentProfile.id },
        });
      }
      await tx.user.delete({ where: { id } });
    });

    void this.audit.record(actor.userId, 'USER_DELETE', {
      schoolId: user.schoolId ?? actor.schoolId ?? null,
      entityType: 'User',
      entityId: id,
      metadata: { role: user.role },
    });
    await this.invalidateRoleCache(user.role, user.schoolId);

    return { success: true, message: 'User deleted successfully' };
  }

  private defaultUserInclude(): any {
    return {
      socialLinks: true,
      teacherProfile: {
        include: {
          socialLinks: true,
          sections: {
            include: {
              section: {
                include: {
                  classGrade: true,
                },
              },
            },
          },
        },
      },
      parentProfile: {
        include: {
          socialLinks: true,
          children: {
            include: {
              student: {
                include: {
                  socialLinks: true,
                },
              },
            },
          },
        },
      },
      studentProfile: {
        include: {
          socialLinks: true,
          // Current placements for the list's Class/Section column. NOT capped to
          // one: ~20% of students hold several ACTIVE enrollments, and taking
          // just the newest would show a class that contradicts the filter.
          enrollments: {
            where: { status: EnrollmentStatus.ACTIVE },
            orderBy: { createdAt: 'desc' },
            include: { section: { include: { classGrade: true } } },
          },
          parents: {
            include: {
              parent: {
                include: {
                  socialLinks: true,
                  user: {
                    select: {
                      id: true,
                      email: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
      school: true,
    };
  }
}
