import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit.service';
import { SchoolsService } from '../schools/schools.service';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import {
  CreateGroupDto,
  ListGroupsQueryDto,
  UpdateGroupDto,
} from './dto/group.dto';
import { UpdateTargetsDto } from './dto/targets.dto';
import { DirectorScope } from './director.service';
import { StoredTargets, TARGET_DEFAULTS, parseStoredTargets } from './targets';

const DIRECTOR_SELECT = {
  id: true,
  email: true,
  fullName: true,
  isActive: true,
} as const;

@Injectable()
export class GroupsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditLogService,
    private schools: SchoolsService,
  ) {}

  async create(dto: CreateGroupDto, actor: Actor) {
    await this.assertDirector(dto.directorId);
    const group = await this.prisma.schoolGroup.create({
      data: { name: dto.name, directorId: dto.directorId },
      select: { id: true, name: true, directorId: true, createdAt: true },
    });
    void this.audit.record(actor.userId, 'GROUP_CREATE', {
      entityType: 'SchoolGroup',
      entityId: group.id,
      metadata: { name: group.name, directorId: group.directorId },
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
      director: { select: DIRECTOR_SELECT },
      _count: { select: { schools: true } },
    } as const;
    const toRow = <T extends { _count: { schools: number } }>({
      _count,
      ...g
    }: T) => ({ ...g, schoolCount: _count.schools });

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
        director: { select: DIRECTOR_SELECT },
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
        targets: true,
      },
    });
    if (!group) throw new NotFoundException('Group not found');
    return { ...group, targets: parseStoredTargets(group.targets) };
  }

  async update(id: string, dto: UpdateGroupDto, actor: Actor) {
    if (dto.name === undefined && dto.directorId === undefined)
      throw new BadRequestException('Nothing to change');
    if (dto.directorId) await this.assertDirector(dto.directorId);
    const { group, previousDirectorId, threadParticipantsRemoved } =
      await this.prisma.$transaction(async (tx) => {
        // Locked, so two changes at once can't both clean up after the same outgoing director.
        const [before] = await tx.$queryRaw<{ directorId: string }[]>`
          SELECT "directorId" FROM "SchoolGroup" WHERE "id" = ${id} FOR UPDATE`;
        if (!before) throw new NotFoundException('Group not found');
        const group = await tx.schoolGroup.update({
          where: { id },
          data: { name: dto.name, directorId: dto.directorId },
          select: { id: true, name: true, directorId: true, updatedAt: true },
        });
        // The outgoing director leaves the branches' conversations, as on a detach.
        const changed = before.directorId !== group.directorId;
        const removed = changed
          ? await tx.threadParticipant.deleteMany({
              where: {
                userId: before.directorId,
                thread: { school: { groupId: id } },
              },
            })
          : { count: 0 };
        return {
          group,
          previousDirectorId: changed ? before.directorId : null,
          threadParticipantsRemoved: removed.count,
        };
      });
    void this.audit.record(actor.userId, 'GROUP_UPDATE', {
      entityType: 'SchoolGroup',
      entityId: id,
      metadata: {
        name: group.name,
        directorId: group.directorId,
        previousDirectorId,
        threadParticipantsRemoved,
      },
    });
    return group;
  }

  /** Only an empty group: its branches are detached first, deliberately (decided 2026-10-02). */
  async remove(id: string, actor: Actor) {
    const group = await this.prisma.schoolGroup.findUnique({
      where: { id },
      select: { name: true, _count: { select: { schools: true } } },
    });
    if (!group) throw new NotFoundException('Group not found');
    if (group._count.schools > 0)
      throw new ConflictException(
        `Detach this group's ${group._count.schools} branch(es) before deleting it.`,
      );
    // A branch attached in between makes the FK refuse the delete (P2003 → 409).
    await this.prisma.schoolGroup.delete({ where: { id } });
    void this.audit.record(actor.userId, 'GROUP_DELETE', {
      entityType: 'SchoolGroup',
      entityId: id,
      metadata: { name: group.name },
    });
    return { deleted: true };
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
        const { directorId } = await this.editTargets(
          tx,
          id,
          (t) => delete t.branches[schoolId],
        );
        // The director leaves the branch's conversations; the principal keeps their copy.
        const removed = await tx.threadParticipant.deleteMany({
          where: { userId: directorId, thread: { schoolId } },
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

  /** The director's own targets, one block per group, with overrides for current branches only. */
  directorTargets(scope: DirectorScope) {
    return {
      defaults: TARGET_DEFAULTS,
      groups: scope.groups.map((g) => ({
        id: g.id,
        name: g.name,
        network: g.targets.network,
        branches: scope.branches
          .filter((b) => b.groupId === g.id)
          .map((b) => ({
            schoolId: b.id,
            name: b.name,
            targets: g.targets.branches[b.id] ?? {},
          })),
      })),
    };
  }

  /**
   * The director's only write: the targets row of a group they direct. The group must be in
   * the scope and a branch must belong to it, so no other group or any school row is touched.
   */
  async updateTargets(scope: DirectorScope, dto: UpdateTargetsDto) {
    const { groupId, branchId } = dto;
    if (!scope.groups.some((g) => g.id === groupId))
      throw new NotFoundException('Group not found');
    if (
      branchId &&
      !scope.branches.some((b) => b.id === branchId && b.groupId === groupId)
    )
      throw new NotFoundException('Branch not found');
    const values = Object.fromEntries(
      Object.entries(dto.targets).filter(([, v]) => v !== undefined),
    );
    const stored = await this.prisma.$transaction(async (tx) => {
      const edited = await this.editTargets(tx, groupId, (t) => {
        if (!branchId) t.network = values;
        else if (Object.keys(values).length) t.branches[branchId] = values;
        else delete t.branches[branchId];
      });
      // Re-checked under the group lock: a detach or a change of director that ran after the
      // guard loaded the scope must win, not be written over.
      const stillTheirs = await tx.schoolGroup.count({
        where: { id: groupId, directorId: scope.directorId },
      });
      const branchStillIn =
        !branchId ||
        (await tx.school.count({ where: { id: branchId, groupId } }));
      if (!stillTheirs) throw new NotFoundException('Group not found');
      if (!branchStillIn) throw new NotFoundException('Branch not found');
      return edited.targets;
    });
    // No schoolId: the targets are the director's, not the branch's, so they stay out of the principal's log.
    void this.audit.record(scope.directorId, 'DIRECTOR_TARGETS_UPDATE', {
      entityType: 'SchoolGroup',
      entityId: groupId,
      metadata: { branchId: branchId ?? null, targets: values },
    });
    return this.directorTargets({
      ...scope,
      groups: scope.groups.map((g) =>
        g.id === groupId ? { ...g, targets: stored } : g,
      ),
    });
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
    const [row] = await tx.$queryRaw<
      { targets: unknown; directorId: string }[]
    >`
      SELECT "targets", "directorId" FROM "SchoolGroup" WHERE "id" = ${groupId} FOR UPDATE`;
    if (!row) throw new NotFoundException('Group not found');
    const targets = parseStoredTargets(row.targets);
    edit(targets);
    await tx.schoolGroup.update({
      where: { id: groupId },
      data: { targets: targets as unknown as Prisma.InputJsonValue },
    });
    return { targets, directorId: row.directorId };
  }

  private async assertGroup(id: string) {
    const group = await this.prisma.schoolGroup.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found');
  }

  /** A deactivated director may still be assigned: they see the group once reactivated. */
  private async assertDirector(id: string) {
    const director = await this.prisma.user.findFirst({
      where: { id, role: Role.DIRECTOR },
      select: { id: true },
    });
    if (!director) throw new NotFoundException('Director not found');
  }
}
