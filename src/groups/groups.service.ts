import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit.service';
import { CacheService } from '../common/services/cache.service';
import { SchoolsService } from '../schools/schools.service';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import {
  CreateDirectorDto,
  GroupNameDto,
  ListGroupsQueryDto,
} from './dto/group.dto';

const DIRECTOR_SELECT = {
  id: true,
  email: true,
  fullName: true,
  isActive: true,
  mustChangePassword: true,
} as const;

@Injectable()
export class GroupsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditLogService,
    private cache: CacheService,
    private schools: SchoolsService,
  ) {}

  async create(dto: GroupNameDto, actor: Actor) {
    const group = await this.prisma.schoolGroup.create({
      data: { name: dto.name },
      select: { id: true, name: true, createdAt: true },
    });
    void this.audit.record(actor.userId, 'GROUP_CREATE', {
      entityType: 'SchoolGroup',
      entityId: group.id,
      metadata: { name: group.name },
    });
    return group;
  }

  async findAll(query: ListGroupsQueryDto) {
    const search = query.search?.trim();
    const where = search
      ? { name: { contains: search, mode: 'insensitive' as const } }
      : {};
    const select = {
      id: true,
      name: true,
      createdAt: true,
      _count: { select: { schools: true, directors: true } },
    } as const;
    const toRow = <
      T extends { _count: { schools: number; directors: number } },
    >({
      _count,
      ...g
    }: T) => ({
      ...g,
      schoolCount: _count.schools,
      directorCount: _count.directors,
    });

    if (query.page === undefined) {
      const rows = await this.prisma.schoolGroup.findMany({
        where,
        select,
        orderBy: { name: 'asc' },
      });
      return rows.map(toRow);
    }
    const { page, pageSize, skip, take } = resolvePagination(query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.schoolGroup.findMany({
        where,
        select,
        orderBy: { name: 'asc' },
        skip,
        take,
      }),
      this.prisma.schoolGroup.count({ where }),
    ]);
    return { items: rows.map(toRow), total, page, pageSize };
  }

  async findOne(id: string) {
    const group = await this.prisma.schoolGroup.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        schools: {
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            code: true,
            city: true,
            currency: true,
            isActive: true,
          },
        },
        directors: { orderBy: { fullName: 'asc' }, select: DIRECTOR_SELECT },
      },
    });
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  async rename(id: string, dto: GroupNameDto, actor: Actor) {
    await this.assertGroup(id);
    const group = await this.prisma.schoolGroup.update({
      where: { id },
      data: { name: dto.name },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
    void this.audit.record(actor.userId, 'GROUP_UPDATE', {
      entityType: 'SchoolGroup',
      entityId: id,
      metadata: { name: group.name },
    });
    return group;
  }

  async attachSchool(id: string, schoolId: string, actor: Actor) {
    await this.assertGroup(id);
    // The groupId: null guard makes the claim atomic: two groups racing for one school
    // cannot both win.
    const { count } = await this.prisma.school.updateMany({
      where: { id: schoolId, groupId: null },
      data: { groupId: id },
    });
    if (count === 0) {
      const school = await this.prisma.school.findUnique({
        where: { id: schoolId },
        select: { groupId: true },
      });
      if (!school) throw new NotFoundException('School not found');
      if (school.groupId === id) return { attached: true };
      throw new ConflictException(
        'This school is already in another group. Detach it there first.',
      );
    }

    await this.schools.invalidateSchoolsCaches();
    void this.audit.record(actor.userId, 'GROUP_SCHOOL_ATTACH', {
      schoolId,
      entityType: 'SchoolGroup',
      entityId: id,
      metadata: { schoolId },
    });
    return { attached: true };
  }

  async detachSchool(id: string, schoolId: string, actor: Actor) {
    const threadParticipantsRemoved = await this.prisma.$transaction(
      async (tx) => {
        const { count } = await tx.school.updateMany({
          where: { id: schoolId, groupId: id },
          data: { groupId: null },
        });
        if (count === 0)
          throw new NotFoundException('School is not in this group');
        // Directors leave the branch's conversations; the principal keeps their copy.
        const removed = await tx.threadParticipant.deleteMany({
          where: {
            user: { groupId: id, role: Role.DIRECTOR },
            thread: { schoolId },
          },
        });
        return removed.count;
      },
    );

    await this.schools.invalidateSchoolsCaches();
    void this.audit.record(actor.userId, 'GROUP_SCHOOL_DETACH', {
      schoolId,
      entityType: 'SchoolGroup',
      entityId: id,
      metadata: { schoolId, threadParticipantsRemoved },
    });
    return { detached: true, threadParticipantsRemoved };
  }

  async createDirector(id: string, dto: CreateDirectorDto, actor: Actor) {
    await this.assertGroup(id);
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
        groupId: id,
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
      metadata: { role: Role.DIRECTOR, groupId: id },
    });
    return { director };
  }

  private async assertGroup(id: string) {
    const group = await this.prisma.schoolGroup.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found');
  }
}
