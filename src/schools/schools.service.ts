import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/services/cache.service';
import { CreateSchoolDto } from './dto/create-school.dto';
import { UpdateSchoolDto } from './dto/update-school.dto';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { compressImage } from '../common/upload/image-compress';

type ListOpts = { page?: number; pageSize?: number; search?: string };

/** All school-list cache keys share this prefix so writes can wipe them at once. */
const SCHOOLS_LIST_PREFIX = 'schools:list:';

@Injectable()
export class SchoolsService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  private listKey(opts?: ListOpts): string {
    const search = (opts?.search ?? '').trim().toLowerCase();
    return `${SCHOOLS_LIST_PREFIX}${opts?.page ?? 'all'}:${opts?.pageSize ?? '-'}:${search}`;
  }

  /** Wipe both the schools list and the super-admin dashboard overview (which
   *  embeds that list + school count) after any school write. */
  private async invalidateSchoolsCaches(): Promise<void> {
    await Promise.all([
      // Variant-keyed list (page/pageSize/search) → one keyspace scan.
      this.cache.delByPrefix(SCHOOLS_LIST_PREFIX),
      // Exact key → O(1) del, no scan.
      this.cache.del('dashboard:admin-overview'),
    ]);
  }

  async create(dto: CreateSchoolDto) {
    // unique code check
    const exists = await (this.prisma as any).school.findUnique({
      where: { code: dto.code },
    });
    if (exists) throw new BadRequestException('School code already exists');

    const created = await (this.prisma as any).school.create({
      data: {
        name: dto.name,
        code: dto.code,
        address: dto.address ?? null,
        addressLine1: dto.addressLine1 ?? null,
        addressLine2: dto.addressLine2 ?? null,
        city: dto.city ?? null,
        state: dto.state ?? null,
        postalCode: dto.postalCode ?? null,
        country: dto.country ?? null,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        website: dto.website ?? null,
      },
    });
    await this.invalidateSchoolsCaches();
    return created;
  }

  async findAll(opts?: ListOpts) {
    // Cached (60s) + wiped on any school write. Super-admin-only global data, so
    // no tenant key needed. Backs the admin dashboard's schools list/count.
    return this.cache.wrap(this.listKey(opts), 60, async () => {
      const where: any = {};
      if (opts?.search?.trim()) {
        const s = opts.search.trim();
        where.OR = [
          { name: { contains: s, mode: 'insensitive' } },
          { code: { contains: s, mode: 'insensitive' } },
          { city: { contains: s, mode: 'insensitive' } },
        ];
      }
      const orderBy = { createdAt: 'desc' as const };
      const prisma = this.prisma as any;
      if (opts?.page != null) {
        const { skip, take, page, pageSize } = resolvePagination(opts);
        // Reads don't need a transaction; Promise.all runs count + page in
        // parallel instead of a serialized tx over the remote DB.
        const [total, items] = await Promise.all([
          prisma.school.count({ where }),
          prisma.school.findMany({ where, orderBy, skip, take }),
        ]);
        return { items, total, page, pageSize };
      }
      return prisma.school.findMany({ where, orderBy });
    });
  }

  async findOne(id: string) {
    const school = await (this.prisma as any).school.findUnique({
      where: { id },
    });
    if (!school) throw new NotFoundException('School not found');
    return school;
  }

  async update(id: string, dto: UpdateSchoolDto) {
    const school = await (this.prisma as any).school.findUnique({
      where: { id },
    });
    if (!school) throw new NotFoundException('School not found');

    // If code is being updated, check for uniqueness
    if (dto.code && dto.code !== school.code) {
      const exists = await (this.prisma as any).school.findUnique({
        where: { code: dto.code },
      });
      if (exists) throw new BadRequestException('School code already exists');
    }

    const updated = await (this.prisma as any).school.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.code !== undefined && { code: dto.code }),
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
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.website !== undefined && { website: dto.website }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
    await this.invalidateSchoolsCaches();
    return updated;
  }

  async remove(id: string) {
    const school = await (this.prisma as any).school.findUnique({
      where: { id },
    });
    if (!school) throw new NotFoundException('School not found');

    const deleted = await (this.prisma as any).school.delete({
      where: { id },
    });
    await this.invalidateSchoolsCaches();
    return deleted;
  }

  // ---- School branding logo (bytes isolated in SchoolLogo, like UserPhoto) ----

  async uploadLogo(
    schoolId: string | undefined,
    file: { buffer: Buffer; mimetype: string } | undefined,
  ) {
    if (!schoolId) throw new BadRequestException('No school for this account');
    if (!file || !file.buffer?.length) {
      throw new BadRequestException('No logo file provided');
    }
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Unsupported image type');
    }
    const { buffer, mimeType } = await compressImage(
      file.buffer,
      file.mimetype,
      512, // a logo doesn't need to be large
    );
    const mt = mimeType ?? file.mimetype;
    // Prisma Bytes wants Uint8Array; normalize the Node Buffer.
    const bytes = Uint8Array.from(buffer);
    const prisma = this.prisma as any;
    await prisma.$transaction([
      prisma.schoolLogo.upsert({
        where: { schoolId },
        create: { schoolId, data: bytes, mimeType: mt },
        update: { data: bytes, mimeType: mt },
      }),
      prisma.school.update({
        where: { id: schoolId },
        data: { logoMimeType: mt },
      }),
    ]);
    await this.invalidateSchoolsCaches();
    return { success: true, mimeType: mt };
  }

  async getLogo(
    schoolId: string | undefined,
  ): Promise<{ data: Buffer; mimeType: string }> {
    if (!schoolId) throw new NotFoundException('No logo');
    const logo = await (this.prisma as any).schoolLogo.findUnique({
      where: { schoolId },
    });
    if (!logo) throw new NotFoundException('No logo');
    return { data: Buffer.from(logo.data), mimeType: logo.mimeType };
  }

  async deleteLogo(schoolId: string | undefined) {
    if (!schoolId) throw new BadRequestException('No school for this account');
    const prisma = this.prisma as any;
    await prisma.$transaction([
      prisma.schoolLogo.deleteMany({ where: { schoolId } }),
      prisma.school.update({
        where: { id: schoolId },
        data: { logoMimeType: null },
      }),
    ]);
    await this.invalidateSchoolsCaches();
    return { success: true };
  }
}
