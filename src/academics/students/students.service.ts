import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseSchoolScopedService } from '../../common/services/base-school.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { resolvePagination } from '../../common/dto/pagination-query.dto';
import { CacheService } from '../../common/services/cache.service';

type UpdateStudentInput = UpdateStudentDto & Partial<CreateStudentDto>;

@Injectable()
export class StudentsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService, cache: CacheService) {
    super(prisma, cache);
  }

  async create(dto: CreateStudentDto, actor: Actor) {
    const schoolId = this.resolveSchoolId(actor, dto.schoolId);
    await this.ensureSchoolExists(schoolId);
    const userId = dto.userId
      ? await this.validateUserLink(dto.userId, schoolId)
      : null;
    await this.assertDiscountInSchool(dto.discountId, schoolId);
    const created = await this.prisma.studentProfile.create({
      data: {
        schoolId,
        userId,
        fullName: dto.fullName,
        admissionNo: dto.admissionNo,
        rollNo: dto.rollNo ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        alternatePhone: dto.alternatePhone ?? null,
        dob: this.toDate(dto.dob),
        dateOfJoining: this.toDate(dto.dateOfJoining),
        address: dto.address ?? null,
        addressLine1: dto.addressLine1 ?? null,
        addressLine2: dto.addressLine2 ?? null,
        city: dto.city ?? null,
        state: dto.state ?? null,
        postalCode: dto.postalCode ?? null,
        country: dto.country ?? null,
        guardianName: dto.guardianName ?? null,
        guardianPhone: dto.guardianPhone ?? null,
        emergencyContactName: dto.emergencyContactName ?? null,
        emergencyContactPhone: dto.emergencyContactPhone ?? null,
        // Mandatory at admission (enforced by CreateStudentDto); 0 is valid.
        monthlyFeeAmount: dto.monthlyFeeAmount ?? 0,
        discountId: dto.discountId ?? null,
        isActive: dto.isActive ?? true,
      } as any,
      include: this.defaultInclude(),
    });
    await this.invalidateSchoolCache(schoolId, 'students');
    return created;
  }

  async findAll(
    actor: Actor,
    schoolId?: string,
    pagination?: { page?: number; pageSize?: number },
  ) {
    this.ensureAdmin(actor);
    const scopedSchoolId =
      actor.role === Role.SUPER_ADMIN
        ? (schoolId ?? undefined)
        : actor.schoolId!;
    const variant = {
      page: pagination?.page ?? null,
      pageSize: pagination?.pageSize ?? null,
    };
    return this.cachedSchoolList(
      scopedSchoolId,
      'students',
      variant,
      async () => {
        const where: any = {};
        if (scopedSchoolId) where.schoolId = scopedSchoolId;

        // Backward-compatible: paginated envelope when `page` is supplied, plain
        // array otherwise (zero blast radius for existing count/dropdown callers).
        if (pagination?.page != null) {
          const { page, pageSize, skip, take } = resolvePagination(pagination);
          return this.prisma
            .$transaction([
              this.prisma.studentProfile.count({ where }),
              this.prisma.studentProfile.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                include: this.defaultInclude(),
                skip,
                take,
              }),
            ])
            .then(([total, items]) => ({ items, total, page, pageSize }));
        }

        return this.prisma.studentProfile.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          include: this.defaultInclude(),
        });
      },
    );
  }

  async findOne(id: string, actor: Actor) {
    return this.getOrThrow(id, actor);
  }

  async update(id: string, dto: UpdateStudentInput, actor: Actor) {
    const student = await this.getOrThrow(id, actor);
    let userId = student.userId;
    if (dto.userId !== undefined) {
      if (!dto.userId) {
        userId = null;
      } else if (dto.userId !== student.userId) {
        userId = await this.validateUserLink(
          dto.userId,
          student.schoolId,
          student.id,
        );
      }
    }
    if (dto.schoolId && dto.schoolId !== student.schoolId) {
      throw new ForbiddenException(
        'Use a dedicated transfer flow to move students across schools',
      );
    }
    if (dto.discountId !== undefined) {
      await this.assertDiscountInSchool(dto.discountId, student.schoolId);
    }
    const updated = await this.prisma.studentProfile.update({
      where: { id },
      data: {
        ...(dto.fullName !== undefined && { fullName: dto.fullName }),
        ...(dto.admissionNo !== undefined && { admissionNo: dto.admissionNo }),
        ...(dto.rollNo !== undefined && { rollNo: dto.rollNo }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.alternatePhone !== undefined && {
          alternatePhone: dto.alternatePhone,
        }),
        ...(dto.address !== undefined && { address: dto.address }),
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
        ...(dto.guardianName !== undefined && {
          guardianName: dto.guardianName,
        }),
        ...(dto.guardianPhone !== undefined && {
          guardianPhone: dto.guardianPhone,
        }),
        ...(dto.emergencyContactName !== undefined && {
          emergencyContactName: dto.emergencyContactName,
        }),
        ...(dto.emergencyContactPhone !== undefined && {
          emergencyContactPhone: dto.emergencyContactPhone,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        // `!== undefined` (not truthiness) so an explicit 0 writes.
        ...(dto.monthlyFeeAmount !== undefined && {
          monthlyFeeAmount: dto.monthlyFeeAmount,
        }),
        ...(dto.discountId !== undefined && {
          discountId: dto.discountId || null,
        }),
        ...(dto.dob !== undefined && { dob: this.toDate(dto.dob) }),
        ...(dto.dateOfJoining !== undefined && {
          dateOfJoining: this.toDate(dto.dateOfJoining),
        }),
        userId,
      },
      include: this.defaultInclude(),
    });
    await this.invalidateSchoolCache(student.schoolId, 'students');
    return updated;
  }

  async remove(id: string, actor: Actor) {
    const student = await this.getOrThrow(id, actor);
    const removed = await this.prisma.studentProfile.delete({
      where: { id },
    });
    await this.invalidateSchoolCache(student.schoolId, 'students');
    return removed;
  }

  async listParents(studentId: string, actor: Actor) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      include: {
        parents: {
          include: {
            parent: {
              include: {
                user: true,
                socialLinks: true,
              },
            },
          },
        } as any,
      },
    });
    if (!student) {
      throw new NotFoundException('Student not found');
    }
    this.enforceScope(actor, student.schoolId);
    return (student as any).parents.map((link: any) => link.parent);
  }

  async linkParent(studentId: string, parentProfileId: string, actor: Actor) {
    this.ensureAdmin(actor);
    const student = await this.getOrThrow(studentId, actor);
    const parent = await this.prisma.parentProfile.findUnique({
      where: { id: parentProfileId },
      include: { user: true },
    });
    if (!parent) {
      throw new NotFoundException('Parent not found');
    }
    if (!parent.user || !parent.user.schoolId) {
      throw new BadRequestException('Parent is not associated with a school');
    }
    if (parent.user.schoolId !== student.schoolId) {
      throw new BadRequestException('Parent belongs to a different school');
    }
    await this.prisma.parentStudent.upsert({
      where: {
        parentId_studentId: {
          parentId: parentProfileId,
          studentId,
        },
      },
      update: {},
      create: {
        parentId: parentProfileId,
        studentId,
      },
    });
    await this.invalidateSchoolCache(student.schoolId, 'students');
    return this.listParents(studentId, actor);
  }

  async unlinkParent(studentId: string, parentProfileId: string, actor: Actor) {
    this.ensureAdmin(actor);
    // validates existence + tenant scope
    const student = await this.getOrThrow(studentId, actor);
    const link = await this.prisma.parentStudent.findUnique({
      where: {
        parentId_studentId: {
          parentId: parentProfileId,
          studentId,
        },
      },
    });
    if (!link) {
      throw new NotFoundException('Parent link not found');
    }
    await this.prisma.parentStudent.delete({
      where: {
        parentId_studentId: {
          parentId: parentProfileId,
          studentId,
        },
      },
    });
    await this.invalidateSchoolCache(student.schoolId, 'students');
    return this.listParents(studentId, actor);
  }

  private async getOrThrow(id: string, actor: Actor) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id },
      include: this.defaultInclude(),
    });
    if (!student) {
      throw new NotFoundException('Student not found');
    }
    this.enforceScope(actor, student.schoolId);
    return student;
  }

  private async validateUserLink(
    userId: string,
    schoolId: string,
    studentId?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Linked user not found');
    }
    if (user.role !== Role.STUDENT) {
      throw new BadRequestException('Linked user must be a STUDENT');
    }
    if (user.schoolId && user.schoolId !== schoolId) {
      throw new BadRequestException('Linked user belongs to another school');
    }
    const existing = await this.prisma.studentProfile.findUnique({
      where: { userId },
    });
    if (existing && existing.id !== studentId) {
      throw new BadRequestException(
        'User is already linked to another student',
      );
    }
    return userId;
  }

  /** A student's discount must belong to their own school (cross-tenant guard). */
  private async assertDiscountInSchool(
    discountId: string | null | undefined,
    schoolId: string,
  ): Promise<void> {
    if (!discountId) return;
    const discount = await this.prisma.discount.findUnique({
      where: { id: discountId },
      select: { schoolId: true },
    });
    if (!discount || discount.schoolId !== schoolId) {
      throw new BadRequestException('Invalid discount for this school');
    }
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
      enrollments: {
        include: {
          section: true,
          academicYear: true,
        },
      },
      parents: {
        include: {
          parent: {
            include: {
              socialLinks: true,
              user: true,
            },
          },
        },
      },
      socialLinks: true,
    };
  }
}
