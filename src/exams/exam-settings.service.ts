import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from '../common/types/actor.type';
import { ExamAccessService } from './exam-access.service';
import {
  DEFAULT_GRADE_BANDS,
  GradeBandInput,
  validateBands,
} from './result-calculator';
import {
  CreateGradingSchemeDto,
  CreateTermDto,
  UpdateGradingSchemeDto,
  UpdateTermDto,
} from './dto/exam-settings.dto';
import { cleanText } from './exam-mappers';

type Db = Prisma.TransactionClient;

const DEFAULT_SCHEME_NAME = 'Standard';

const bandSelect = {
  id: true,
  label: true,
  minPercent: true,
  isPassing: true,
  remark: true,
} satisfies Prisma.GradeBandSelect;

@Injectable()
export class ExamSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ExamAccessService,
  ) {}

  /** Schools created after the migration get their default scheme lazily. Call outside a transaction. */
  async ensureDefaultScheme(schoolId: string): Promise<string> {
    const existing = await this.prisma.gradingScheme.findFirst({
      where: { schoolId, isDefault: true },
      select: { id: true },
    });
    if (existing) return existing.id;
    try {
      const created = await this.prisma.gradingScheme.create({
        data: {
          schoolId,
          name: DEFAULT_SCHEME_NAME,
          isDefault: true,
          bands: {
            create: DEFAULT_GRADE_BANDS.map((b) => ({
              label: b.label,
              minPercent: b.minPercent,
              isPassing: b.isPassing,
              remark: b.remark ?? null,
            })),
          },
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      // A concurrent request created it first.
      const again = await this.prisma.gradingScheme.findFirst({
        where: { schoolId, OR: [{ isDefault: true }, { name: DEFAULT_SCHEME_NAME }] },
        select: { id: true },
      });
      if (again) return again.id;
      throw err;
    }
  }

  /** Bands for an examination; an exam without a scheme uses the school default. */
  async bandsFor(
    db: Db,
    schoolId: string,
    schemeId: string | null,
  ): Promise<GradeBandInput[]> {
    const where: Prisma.GradeBandWhereInput = schemeId
      ? { schemeId }
      : { scheme: { schoolId, isDefault: true } };
    const bands = await db.gradeBand.findMany({
      where,
      orderBy: { minPercent: 'desc' },
      select: { label: true, minPercent: true, isPassing: true, remark: true },
    });
    return bands.length ? bands : DEFAULT_GRADE_BANDS;
  }

  // ---- Terms ----

  async listTerms(actor: Actor, academicYearId?: string) {
    const schoolId = this.access.schoolOf(actor);
    return this.prisma.academicTerm.findMany({
      where: { schoolId, ...(academicYearId ? { academicYearId } : {}) },
      orderBy: [{ academicYearId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        academicYearId: true,
        name: true,
        sortOrder: true,
        startDate: true,
        endDate: true,
        academicYear: { select: { id: true, name: true } },
        _count: { select: { examinations: true } },
      },
    });
  }

  async createTerm(dto: CreateTermDto, actor: Actor) {
    const schoolId = this.access.schoolOf(actor);
    const year = await this.prisma.academicYear.findUnique({
      where: { id: dto.academicYearId },
      select: { schoolId: true },
    });
    if (!year || year.schoolId !== schoolId) {
      throw new BadRequestException('Choose an academic session from your school');
    }
    const name = dto.name.trim();
    await this.assertTermNameFree(dto.academicYearId, name);
    this.assertDateOrder(dto.startDate, dto.endDate);
    return this.prisma.academicTerm.create({
      data: {
        schoolId,
        academicYearId: dto.academicYearId,
        name,
        sortOrder: dto.sortOrder ?? 0,
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
      },
    });
  }

  async updateTerm(id: string, dto: UpdateTermDto, actor: Actor) {
    const term = await this.loadTerm(id, actor);
    const name = dto.name?.trim();
    if (name && name !== term.name) await this.assertTermNameFree(term.academicYearId, name);
    const startDate = dto.startDate !== undefined ? dto.startDate : term.startDate?.toISOString();
    const endDate = dto.endDate !== undefined ? dto.endDate : term.endDate?.toISOString();
    this.assertDateOrder(startDate, endDate);
    return this.prisma.academicTerm.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.startDate !== undefined
          ? { startDate: dto.startDate ? new Date(dto.startDate) : null }
          : {}),
        ...(dto.endDate !== undefined
          ? { endDate: dto.endDate ? new Date(dto.endDate) : null }
          : {}),
      },
    });
  }

  /** Examinations keep their history; their term link is cleared (SetNull). */
  async deleteTerm(id: string, actor: Actor) {
    await this.loadTerm(id, actor);
    await this.prisma.academicTerm.delete({ where: { id } });
    return { deleted: true };
  }

  private async loadTerm(id: string, actor: Actor) {
    const term = await this.prisma.academicTerm.findUnique({ where: { id } });
    if (!term) throw new NotFoundException('Term not found');
    this.access.assertSameSchool(actor, term.schoolId);
    return term;
  }

  private async assertTermNameFree(academicYearId: string, name: string) {
    const clash = await this.prisma.academicTerm.findFirst({
      where: { academicYearId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) throw new ConflictException(`This session already has a term named "${name}"`);
  }

  private assertDateOrder(start?: string | null, end?: string | null) {
    if (start && end && new Date(end) < new Date(start)) {
      throw new BadRequestException('Term end date must be on or after its start date');
    }
  }

  // ---- Grading schemes ----

  async listSchemes(actor: Actor) {
    const schoolId = this.access.schoolOf(actor);
    await this.ensureDefaultScheme(schoolId);
    return this.prisma.gradingScheme.findMany({
      where: { schoolId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        isDefault: true,
        updatedAt: true,
        bands: { orderBy: { minPercent: 'desc' }, select: bandSelect },
        _count: { select: { examinations: true } },
      },
    });
  }

  async createScheme(dto: CreateGradingSchemeDto, actor: Actor) {
    const schoolId = this.access.schoolOf(actor);
    const name = dto.name.trim();
    this.assertValidBands(dto.bands);
    await this.assertSchemeNameFree(schoolId, name);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.gradingScheme.updateMany({ where: { schoolId }, data: { isDefault: false } });
      }
      return tx.gradingScheme.create({
        data: {
          schoolId,
          name,
          isDefault: !!dto.isDefault,
          bands: { create: dto.bands.map((b) => this.bandData(b)) },
        },
        select: { id: true, name: true, isDefault: true, bands: { orderBy: { minPercent: 'desc' }, select: bandSelect } },
      });
    });
  }

  /** Finalized results are snapshotted, so editing bands never rewrites a locked result. */
  async updateScheme(id: string, dto: UpdateGradingSchemeDto, actor: Actor) {
    const scheme = await this.loadScheme(id, actor);
    const name = dto.name?.trim();
    if (name && name !== scheme.name) await this.assertSchemeNameFree(scheme.schoolId, name);
    if (dto.bands) this.assertValidBands(dto.bands);
    if (dto.isDefault === false && scheme.isDefault) {
      throw new ConflictException('Make another scheme the default instead of unsetting this one');
    }
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault && !scheme.isDefault) {
        await tx.gradingScheme.updateMany({
          where: { schoolId: scheme.schoolId },
          data: { isDefault: false },
        });
      }
      if (dto.bands) {
        await tx.gradeBand.deleteMany({ where: { schemeId: id } });
        await tx.gradeBand.createMany({
          data: dto.bands.map((b) => ({ schemeId: id, ...this.bandData(b) })),
        });
      }
      return tx.gradingScheme.update({
        where: { id },
        data: {
          ...(name ? { name } : {}),
          ...(dto.isDefault ? { isDefault: true } : {}),
        },
        select: { id: true, name: true, isDefault: true, bands: { orderBy: { minPercent: 'desc' }, select: bandSelect } },
      });
    });
  }

  async deleteScheme(id: string, actor: Actor) {
    const scheme = await this.loadScheme(id, actor);
    if (scheme.isDefault) {
      throw new ConflictException('The default grading scheme cannot be deleted');
    }
    const inUse = await this.prisma.examination.count({ where: { gradingSchemeId: id } });
    if (inUse) {
      throw new ConflictException(
        `This scheme is used by ${inUse} examination${inUse === 1 ? '' : 's'} and cannot be deleted`,
      );
    }
    await this.prisma.gradingScheme.delete({ where: { id } });
    return { deleted: true };
  }

  private async loadScheme(id: string, actor: Actor) {
    const scheme = await this.prisma.gradingScheme.findUnique({ where: { id } });
    if (!scheme) throw new NotFoundException('Grading scheme not found');
    this.access.assertSameSchool(actor, scheme.schoolId);
    return scheme;
  }

  private async assertSchemeNameFree(schoolId: string, name: string) {
    const clash = await this.prisma.gradingScheme.findFirst({
      where: { schoolId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) throw new ConflictException(`A grading scheme named "${name}" already exists`);
  }

  private assertValidBands(bands: GradeBandInput[]) {
    const problems = validateBands(bands);
    if (problems.length) {
      throw new BadRequestException({
        statusCode: 400,
        message: problems[0],
        problems,
      });
    }
  }

  private bandData(b: GradeBandInput) {
    return {
      label: b.label.trim(),
      minPercent: b.minPercent,
      isPassing: b.isPassing,
      remark: cleanText(b.remark),
    };
  }
}
