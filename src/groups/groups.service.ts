import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
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
import { UpdateTargetsDto } from './dto/targets.dto';
import { DirectorScope } from './director.service';
import { StoredTargets, TARGET_DEFAULTS, parseStoredTargets } from './targets';

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
        targets: true,
      },
    });
    if (!group) throw new NotFoundException('Group not found');
    return { ...group, targets: parseStoredTargets(group.targets) };
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
        // Otherwise the override would come back if the school rejoins this group.
        await this.editTargets(tx, id, (t) => delete t.branches[schoolId]);
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

  /** The director's own targets: the network level plus overrides for their current branches. */
  directorTargets(scope: DirectorScope) {
    return {
      defaults: TARGET_DEFAULTS,
      network: scope.targets.network,
      branches: scope.branches.map((b) => ({
        schoolId: b.id,
        name: b.name,
        targets: scope.targets.branches[b.id] ?? {},
      })),
    };
  }

  /**
   * The director's only write: their own group's targets row. The group comes from the scope
   * and a branch must be one of theirs, so no other group or any school row can be touched.
   */
  async updateTargets(scope: DirectorScope, dto: UpdateTargetsDto) {
    const { branchId } = dto;
    if (branchId && !scope.branches.some((b) => b.id === branchId))
      throw new NotFoundException('Branch not found');
    const values = Object.fromEntries(
      Object.entries(dto.targets).filter(([, v]) => v !== undefined),
    );
    const stored = await this.prisma.$transaction(async (tx) => {
      const edited = await this.editTargets(tx, scope.group.id, (t) => {
        if (!branchId) t.network = values;
        else if (Object.keys(values).length) t.branches[branchId] = values;
        else delete t.branches[branchId];
      });
      // Re-checked under the group lock: a detach that ran after the guard loaded the scope
      // has already dropped this override, and writing it back would revive it on rejoin.
      if (
        branchId &&
        !(await tx.school.count({
          where: { id: branchId, groupId: scope.group.id },
        }))
      )
        throw new NotFoundException('Branch not found');
      return edited;
    });
    // No schoolId: the targets are the director's, not the branch's, so they stay out of the principal's log.
    void this.audit.record(scope.directorId, 'DIRECTOR_TARGETS_UPDATE', {
      entityType: 'SchoolGroup',
      entityId: scope.group.id,
      metadata: { branchId: branchId ?? null, targets: values },
    });
    return this.directorTargets({ ...scope, targets: stored });
  }

  async resetTargets(id: string, actor: Actor) {
    await this.assertGroup(id);
    await this.prisma.schoolGroup.update({
      where: { id },
      data: { targets: Prisma.DbNull },
    });
    void this.audit.record(actor.userId, 'GROUP_TARGETS_RESET', {
      entityType: 'SchoolGroup',
      entityId: id,
    });
    return { reset: true };
  }

  /** Read-modify-write under a row lock, so two edits at once can't drop each other. */
  private async editTargets(
    tx: Prisma.TransactionClient,
    groupId: string,
    edit: (t: StoredTargets) => void,
  ) {
    const [row] = await tx.$queryRaw<{ targets: unknown }[]>`
      SELECT "targets" FROM "SchoolGroup" WHERE "id" = ${groupId} FOR UPDATE`;
    if (!row) throw new NotFoundException('Group not found');
    const stored = parseStoredTargets(row.targets);
    edit(stored);
    await tx.schoolGroup.update({
      where: { id: groupId },
      data: { targets: stored as unknown as Prisma.InputJsonValue },
    });
    return stored;
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
