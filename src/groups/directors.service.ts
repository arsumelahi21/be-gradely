import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit.service';
import { CacheService } from '../common/services/cache.service';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import { uniqueConflict } from '../common/utils/prisma-errors';
import {
  CreateDirectorDto,
  ListDirectorsQueryDto,
  UpdateDirectorDto,
} from './dto/group.dto';

const DIRECTOR_SELECT = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  phoneDialCode: true,
  isActive: true,
  mustChangePassword: true,
  createdAt: true,
  directedGroups: {
    orderBy: { name: 'asc' },
    select: { id: true, name: true, _count: { select: { schools: true } } },
  },
} as const;

/**
 * Super Admin management of DIRECTOR accounts. Activation and password resets go through
 * the shared /users routes, which already serve every role.
 */
@Injectable()
export class DirectorsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditLogService,
    private cache: CacheService,
  ) {}

  async findAll(query: ListDirectorsQueryDto) {
    const search = query.search?.trim();
    const where = {
      role: Role.DIRECTOR,
      ...(search && {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };
    const orderBy = [{ fullName: 'asc' as const }, { email: 'asc' as const }];
    if (query.page === undefined)
      return this.prisma.user.findMany({
        where,
        select: DIRECTOR_SELECT,
        orderBy,
      });
    const { page, pageSize, skip, take } = resolvePagination(query);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: DIRECTOR_SELECT,
        orderBy,
        skip,
        take,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async findOne(id: string) {
    const director = await this.prisma.user.findFirst({
      where: { id, role: Role.DIRECTOR },
      select: DIRECTOR_SELECT,
    });
    if (!director) throw new NotFoundException('Director not found');
    return director;
  }

  async create(dto: CreateDirectorDto, actor: Actor) {
    const exists = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (exists) throw new ConflictException('Email already exists');

    const director = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, 10),
        role: Role.DIRECTOR,
        schoolId: null,
        fullName: dto.fullName,
        phone: dto.phone ?? null,
        phoneDialCode: dto.phoneDialCode ?? null,
      },
      select: DIRECTOR_SELECT,
    });

    await this.cache.del('dashboard:admin-overview');
    void this.audit.record(actor.userId, 'USER_CREATE', {
      schoolId: null,
      entityType: 'User',
      entityId: director.id,
      metadata: { role: Role.DIRECTOR },
    });
    return director;
  }

  async update(id: string, dto: UpdateDirectorDto, actor: Actor) {
    const current = await this.findOne(id);
    if (dto.email && dto.email !== current.email) {
      const taken = await this.prisma.user.findUnique({
        where: { email: dto.email },
        select: { id: true },
      });
      if (taken) throw new ConflictException('Email already exists');
    }
    const director = await this.prisma.user
      .update({
        where: { id },
        data: {
          email: dto.email,
          fullName: dto.fullName,
          phone: dto.phone,
          phoneDialCode: dto.phoneDialCode,
        },
        select: DIRECTOR_SELECT,
      })
      // A race with another account taking the same email.
      .catch(uniqueConflict('Email already exists'));
    void this.audit.record(actor.userId, 'USER_UPDATE', {
      schoolId: null,
      entityType: 'User',
      entityId: id,
      metadata: { role: Role.DIRECTOR },
    });
    return director;
  }

  /**
   * Refused while they direct a group, and once they have written anything: deleting the user
   * cascades to their messages, which would vanish from the principals' threads.
   */
  async remove(id: string, actor: Actor) {
    const director = await this.findOne(id);
    if (director.directedGroups.length > 0)
      throw new ConflictException(
        `This director still oversees ${director.directedGroups.map((g) => g.name).join(', ')}. Assign another director or delete the group first.`,
      );
    if (await this.prisma.message.count({ where: { senderId: id } }))
      throw new ConflictException(
        'This director has messages in principals’ conversations, which deleting would erase. Deactivate them instead.',
      );
    // A group assigned in between makes the FK refuse the delete (P2003 → 409).
    await this.prisma.user.delete({ where: { id } });
    await this.cache.del('dashboard:admin-overview');
    void this.audit.record(actor.userId, 'USER_DELETE', {
      schoolId: null,
      entityType: 'User',
      entityId: id,
      metadata: { role: Role.DIRECTOR },
    });
    return { deleted: true };
  }
}
