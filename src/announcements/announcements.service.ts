import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AnnouncementTargetKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BaseSchoolScopedService } from '../common/services/base-school.service';
import { S3PresignService } from '../common/services/s3-presign.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import {
  NOTIFICATION_CREATE,
  NotificationCreateEvent,
} from '../common/events/notification.events';
import {
  assertAttachmentAllowed,
  MAX_ATTACHMENT_BYTES,
} from '../common/upload/attachment-rules';
import { resolvePagination } from '../common/dto/pagination-query.dto';
import {
  CreateAnnouncementDto,
  AnnouncementTargetDto,
} from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { ListAnnouncementsQueryDto } from './dto/list-announcements-query.dto';
import { PresignAttachmentDto } from './dto/presign-attachment.dto';

const announcementInclude = {
  attachments: true,
  author: { select: { id: true, fullName: true, email: true, role: true } },
  section: { select: { id: true, name: true } },
  targets: { select: { kind: true, refId: true } },
} satisfies Prisma.AnnouncementInclude;

/** Target kinds that carry no refId (whole role/school) — refId is forced null. */
const NON_REF_KINDS = new Set<AnnouncementTargetKind>([
  AnnouncementTargetKind.SCHOOL,
  AnnouncementTargetKind.ALL_TEACHERS,
  AnnouncementTargetKind.ALL_STUDENTS,
  AnnouncementTargetKind.ALL_PARENTS,
]);

type TargetInput = { kind: AnnouncementTargetKind; refId: string | null };

@Injectable()
export class AnnouncementsService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    private readonly s3: S3PresignService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma);
  }

  // ---- create ------------------------------------------------------------

  async create(dto: CreateAnnouncementDto, actor: Actor) {
    if (
      ![Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN].includes(actor.role)
    ) {
      throw new ForbiddenException('Not allowed to post announcements');
    }

    const schoolId = this.resolveTargetSchool(actor, dto.schoolId);

    const targets = this.normalizeTargets(dto.targets);
    if (!targets.length) {
      throw new BadRequestException('At least one audience target is required');
    }
    await this.validateTargets(targets, actor, schoolId);

    const attachments = dto.attachments ?? [];
    for (const a of attachments) {
      assertAttachmentAllowed({ mimeType: a.mimeType, sizeBytes: a.sizeBytes });
    }

    const publishAt = dto.publishAt ? new Date(dto.publishAt) : null;
    const isImmediate = !publishAt || publishAt.getTime() <= Date.now();

    const announcement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.announcement.create({
        data: {
          schoolId,
          authorUserId: actor.userId,
          title: dto.title,
          body: dto.body,
          type: dto.type, // undefined => Prisma applies @default(GENERAL)
          publishAt,
          // Immediate announcements are "notified" right away (below); scheduled
          // ones wait for the cron so notifications fire at PUBLISH time, not now.
          publishedNotified: isImmediate,
          targets: {
            create: targets.map((t) => ({ kind: t.kind, refId: t.refId })),
          },
        },
      });
      if (attachments.length) {
        await tx.announcementAttachment.createMany({
          data: attachments.map((a) => ({
            announcementId: created.id,
            s3Key: a.s3Key,
            fileName: a.fileName,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
          })),
        });
      }
      return created;
    });

    // Announcements are NOT pushed to the notification bell — they have their
    // own dashboard container (emitAnnouncementNotification is left unwired).
    return this.get(announcement.id, actor);
  }

  // ---- reads -------------------------------------------------------------

  async list(actor: Actor, query: ListAnnouncementsQueryDto) {
    const { page, pageSize, skip, take } = resolvePagination(query);
    const base = await this.visibilityWhere(actor, query.schoolId);
    const notDismissed = this.notDismissedFilter(actor.userId);
    const notRead = this.notReadFilter(actor.userId);

    const filters: Prisma.AnnouncementWhereInput[] = [base, notDismissed];
    if (query.type) filters.push({ type: query.type });
    if (query.unreadOnly) filters.push(notRead);
    const where: Prisma.AnnouncementWhereInput = { AND: filters };

    // Reads don't need a transaction; Promise.all runs the two counts + the page
    // in parallel instead of serialized round-trips over the remote DB.
    const [total, unread, rows] = await Promise.all([
      this.prisma.announcement.count({ where }),
      this.prisma.announcement.count({
        where: { AND: [base, notDismissed, notRead] },
      }),
      this.prisma.announcement.findMany({
        where,
        orderBy: [{ publishAt: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
        include: {
          ...announcementInclude,
          reads: { where: { userId: actor.userId }, select: { readAt: true } },
        },
      }),
    ]);

    const labelMap = await this.buildTargetLabelMap(rows);
    const items = await Promise.all(rows.map((r) => this.present(r, labelMap)));
    return { page, pageSize, total, unread, items };
  }

  async get(id: string, actor: Actor) {
    const a = await this.prisma.announcement.findUnique({
      where: { id },
      include: {
        ...announcementInclude,
        reads: { where: { userId: actor.userId }, select: { readAt: true } },
      },
    });
    if (!a) throw new NotFoundException('Announcement not found');
    await this.assertCanView(a, actor);
    const labelMap = await this.buildTargetLabelMap([a]);
    return this.present(a, labelMap);
  }

  // ---- read / dismiss state ---------------------------------------------

  async unreadCount(actor: Actor) {
    const base = await this.visibilityWhere(actor);
    const unread = await this.prisma.announcement.count({
      where: {
        AND: [
          base,
          this.notDismissedFilter(actor.userId),
          this.notReadFilter(actor.userId),
        ],
      },
    });
    return { unread };
  }

  async markRead(id: string, actor: Actor) {
    const a = await this.prisma.announcement.findUnique({
      where: { id },
      select: {
        schoolId: true,
        authorUserId: true,
        publishAt: true,
        targets: { select: { kind: true, refId: true } },
      },
    });
    if (!a) throw new NotFoundException('Announcement not found');
    await this.assertCanView(a, actor);
    await this.upsertReadState(id, actor.userId, { readAt: new Date() });
    return { id, isRead: true };
  }

  async markAllRead(actor: Actor) {
    const base = await this.visibilityWhere(actor);
    const rows = await this.prisma.announcement.findMany({
      where: {
        AND: [
          base,
          this.notDismissedFilter(actor.userId),
          this.notReadFilter(actor.userId),
        ],
      },
      select: { id: true },
    });
    const now = new Date();
    if (rows.length) {
      await this.prisma.announcementRead.createMany({
        data: rows.map((r) => ({
          announcementId: r.id,
          userId: actor.userId,
          readAt: now,
        })),
        skipDuplicates: true,
      });
    }
    // Read-sync: clear the bell for this user's announcement notifications.
    await this.prisma.notification.updateMany({
      where: {
        userId: actor.userId,
        type: 'NEW_ANNOUNCEMENT',
        entityType: 'Announcement',
        isRead: false,
      },
      data: { isRead: true },
    });
    return { updated: rows.length };
  }

  async bulkMarkRead(ids: string[], actor: Actor) {
    const visible = await this.visibleAmong(ids, actor);
    const now = new Date();
    for (const id of visible) {
      await this.upsertReadState(id, actor.userId, { readAt: now });
    }
    return { updated: visible.length };
  }

  async bulkDismiss(ids: string[], actor: Actor) {
    const visible = await this.visibleAmong(ids, actor);
    const now = new Date();
    for (const id of visible) {
      await this.upsertReadState(id, actor.userId, { dismissedAt: now });
    }
    return { dismissed: visible.length };
  }

  // ---- update / delete ---------------------------------------------------

  async update(id: string, dto: UpdateAnnouncementDto, actor: Actor) {
    const a = await this.loadForManage(id, actor);
    const publishAt =
      dto.publishAt !== undefined
        ? dto.publishAt
          ? new Date(dto.publishAt)
          : null
        : a.publishAt;

    // If rescheduled to the future, re-arm notification (it will fire at the new
    // publish time via the cron); if moved to now/past, notify immediately.
    let publishedNotified = a.publishedNotified;
    if (dto.publishAt !== undefined) {
      const isImmediate = !publishAt || publishAt.getTime() <= Date.now();
      publishedNotified = isImmediate ? a.publishedNotified : false;
    }

    const updated = await this.prisma.announcement.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.body !== undefined && { body: dto.body }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.publishAt !== undefined && { publishAt }),
        publishedNotified,
      },
      include: announcementInclude,
    });
    const labelMap = await this.buildTargetLabelMap([updated]);
    return this.present(updated, labelMap);
  }

  async remove(id: string, actor: Actor) {
    await this.loadForManage(id, actor);
    await this.prisma.$transaction([
      this.prisma.announcementAttachment.deleteMany({
        where: { announcementId: id },
      }),
      this.prisma.announcement.delete({ where: { id } }),
    ]);
    return { id, deleted: true };
  }

  // ---- attachments -------------------------------------------------------

  async presignAttachment(dto: PresignAttachmentDto, actor: Actor) {
    if (
      ![Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN].includes(actor.role)
    ) {
      throw new ForbiddenException('Not allowed');
    }
    assertAttachmentAllowed({
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
    });

    const safeName = dto.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = await this.s3.keyFor(
      actor.schoolId,
      'announcements',
      actor.userId,
      safeName,
    );

    const { url } = await this.s3.presignPutObject({
      key,
      contentType: dto.mimeType,
    });
    return {
      s3Key: key,
      fileName: dto.fileName,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      maxBytes: MAX_ATTACHMENT_BYTES,
      upload: { method: 'PUT', url },
    };
  }

  // ---- scheduled publish (cron body) ------------------------------------

  /**
   * Notify scheduled announcements whose publish time has arrived (runs from a
   * cron). Flips publishedNotified BEFORE emitting so a second tick can't double-notify.
   */
  async publishDueScheduledAnnouncements(): Promise<number> {
    const now = new Date();
    const due = await this.prisma.announcement.findMany({
      where: { publishedNotified: false, publishAt: { lte: now } },
    });

    let processed = 0;
    for (const a of due) {
      const claimed = await this.prisma.announcement.updateMany({
        where: { id: a.id, publishedNotified: false },
        data: { publishedNotified: true },
      });
      if (claimed.count === 0) continue; // another tick won the race
      // No bell notification — announcements live in the dashboard container.
      processed += 1;
    }
    return processed;
  }

  // ---- helpers -----------------------------------------------------------

  private resolveTargetSchool(actor: Actor, schoolId?: string): string {
    if (actor.role === Role.SUPER_ADMIN) {
      if (!schoolId) throw new BadRequestException('schoolId is required');
      return schoolId;
    }
    if (!actor.schoolId) throw new ForbiddenException('No school context');
    return actor.schoolId;
  }

  /** De-dupe targets and force refId to null for whole-role/school kinds. */
  private normalizeTargets(
    raw: AnnouncementTargetDto[] | undefined,
  ): TargetInput[] {
    const seen = new Set<string>();
    const out: TargetInput[] = [];
    for (const t of raw ?? []) {
      const refId = NON_REF_KINDS.has(t.kind) ? null : (t.refId ?? null);
      const key = `${t.kind}:${refId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: t.kind, refId });
    }
    return out;
  }

  /** Enforce who may target what: teachers → only their own sections. */
  private async validateTargets(
    targets: TargetInput[],
    actor: Actor,
    schoolId: string,
  ) {
    const isAdmin =
      actor.role === Role.SCHOOL_ADMIN || actor.role === Role.SUPER_ADMIN;
    const teacherSectionIds =
      actor.role === Role.TEACHER
        ? new Set(await this.actorSectionIds(actor))
        : null;

    for (const t of targets) {
      if (t.kind === AnnouncementTargetKind.SECTION) {
        if (!t.refId)
          throw new BadRequestException('SECTION target requires a section id');
        await this.assertSectionInSchool(t.refId, schoolId);
        if (actor.role === Role.TEACHER && !teacherSectionIds!.has(t.refId)) {
          throw new ForbiddenException('You do not teach this section');
        }
        continue;
      }
      // Everything else (SCHOOL / ALL_* / CLASS) is admin-only.
      if (!isAdmin) {
        throw new ForbiddenException(
          'Teachers can only post to their own sections',
        );
      }
      if (t.kind === AnnouncementTargetKind.CLASS) {
        if (!t.refId)
          throw new BadRequestException('CLASS target requires a class id');
        await this.assertClassGradeInSchool(t.refId, schoolId);
      }
    }
  }

  private async assertSectionInSchool(sectionId: string, schoolId: string) {
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      select: { schoolId: true },
    });
    if (!section) throw new BadRequestException('Invalid sectionId');
    if (section.schoolId !== schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }
  }

  private async assertClassGradeInSchool(
    classGradeId: string,
    schoolId: string,
  ) {
    const cg = await this.prisma.classGrade.findUnique({
      where: { id: classGradeId },
      select: { schoolId: true },
    });
    if (!cg) throw new BadRequestException('Invalid classGradeId');
    if (cg.schoolId !== schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }
  }

  private async loadForManage(id: string, actor: Actor) {
    const a = await this.prisma.announcement.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Announcement not found');
    this.enforceScope(actor, a.schoolId);
    const isAdmin =
      actor.role === Role.SCHOOL_ADMIN || actor.role === Role.SUPER_ADMIN;
    if (!isAdmin && a.authorUserId !== actor.userId) {
      throw new ForbiddenException(
        'Only the author or a school admin can modify this',
      );
    }
    return a;
  }

  private notDismissedFilter(userId: string): Prisma.AnnouncementWhereInput {
    return { NOT: { reads: { some: { userId, dismissedAt: { not: null } } } } };
  }

  private notReadFilter(userId: string): Prisma.AnnouncementWhereInput {
    return { NOT: { reads: { some: { userId, readAt: { not: null } } } } };
  }

  private async upsertReadState(
    announcementId: string,
    userId: string,
    data: { readAt?: Date; dismissedAt?: Date },
  ) {
    await this.prisma.announcementRead.upsert({
      where: { announcementId_userId: { announcementId, userId } },
      create: { announcementId, userId, ...data },
      update: data,
    });
    // Read-sync: reading OR dismissing an announcement clears its bell notification.
    if (data.readAt || data.dismissedAt) {
      await this.prisma.notification.updateMany({
        where: {
          userId,
          entityType: 'Announcement',
          entityId: announcementId,
          isRead: false,
        },
        data: { isRead: true },
      });
    }
  }

  /** Of the given ids, the ones the actor may see (tenant + scope enforced). */
  private async visibleAmong(ids: string[], actor: Actor): Promise<string[]> {
    const idList = [...new Set((ids ?? []).filter(Boolean))];
    if (!idList.length) return [];
    const base = await this.visibilityWhere(actor);
    const rows = await this.prisma.announcement.findMany({
      where: { AND: [base, { id: { in: idList } }] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Section ids relevant to a non-admin actor (teach / enrolled / parent-of). */
  private async actorSectionIds(actor: Actor): Promise<string[]> {
    if (actor.role === Role.TEACHER) {
      const teacher = await this.prisma.teacherProfile.findFirst({
        where: { userId: actor.userId },
        select: { id: true },
      });
      if (!teacher) return [];
      const [assigned, taught] = await Promise.all([
        this.prisma.sectionTeacher.findMany({
          where: { teacherId: teacher.id },
          select: { sectionId: true },
        }),
        this.prisma.sectionSubject.findMany({
          where: { teacherId: teacher.id },
          select: { sectionId: true },
        }),
      ]);
      return [...new Set([...assigned, ...taught].map((s) => s.sectionId))];
    }
    if (actor.role === Role.STUDENT) {
      const student = await this.prisma.studentProfile.findFirst({
        where: { userId: actor.userId },
        select: { id: true },
      });
      if (!student) return [];
      const rows = await this.prisma.enrollment.findMany({
        where: { studentId: student.id, status: 'ACTIVE' },
        select: { sectionId: true },
      });
      return [...new Set(rows.map((r) => r.sectionId))];
    }
    if (actor.role === Role.PARENT) {
      const parent = await this.prisma.parentProfile.findFirst({
        where: { userId: actor.userId },
        select: { id: true },
      });
      if (!parent) return [];
      const children = await this.prisma.parentStudent.findMany({
        where: { parentId: parent.id },
        select: { studentId: true },
      });
      if (!children.length) return [];
      const rows = await this.prisma.enrollment.findMany({
        where: {
          studentId: { in: children.map((c) => c.studentId) },
          status: 'ACTIVE',
        },
        select: { sectionId: true },
      });
      return [...new Set(rows.map((r) => r.sectionId))];
    }
    return [];
  }

  /** Class/Grade ids the actor's sections belong to (for CLASS-target visibility). */
  private async actorClassGradeIds(
    actor: Actor,
    sectionIds?: string[],
  ): Promise<string[]> {
    const sids = sectionIds ?? (await this.actorSectionIds(actor));
    if (!sids.length) return [];
    const rows = await this.prisma.section.findMany({
      where: { id: { in: sids } },
      select: { classGradeId: true },
    });
    return [...new Set(rows.map((r) => r.classGradeId))];
  }

  private roleAllKind(role: Role): AnnouncementTargetKind | null {
    if (role === Role.STUDENT) return AnnouncementTargetKind.ALL_STUDENTS;
    if (role === Role.TEACHER) return AnnouncementTargetKind.ALL_TEACHERS;
    if (role === Role.PARENT) return AnnouncementTargetKind.ALL_PARENTS;
    return null;
  }

  private async visibilityWhere(
    actor: Actor,
    schoolId?: string,
  ): Promise<Prisma.AnnouncementWhereInput> {
    const now = new Date();
    const notFuture: Prisma.AnnouncementWhereInput = {
      OR: [{ publishAt: null }, { publishAt: { lte: now } }],
    };

    if (actor.role === Role.SUPER_ADMIN) {
      return schoolId ? { schoolId, AND: [notFuture] } : notFuture;
    }
    if (!actor.schoolId) throw new ForbiddenException('No school context');

    if (actor.role === Role.SCHOOL_ADMIN) {
      return { schoolId: actor.schoolId, AND: [notFuture] };
    }

    // Teacher / student / parent: any target matching the actor.
    const sectionIds = await this.actorSectionIds(actor);
    const classGradeIds = await this.actorClassGradeIds(actor, sectionIds);
    const roleKind = this.roleAllKind(actor.role);
    const targetOr: Prisma.AnnouncementTargetWhereInput[] = [
      { kind: AnnouncementTargetKind.SCHOOL },
    ];
    if (roleKind) targetOr.push({ kind: roleKind });
    if (sectionIds.length)
      targetOr.push({
        kind: AnnouncementTargetKind.SECTION,
        refId: { in: sectionIds },
      });
    if (classGradeIds.length)
      targetOr.push({
        kind: AnnouncementTargetKind.CLASS,
        refId: { in: classGradeIds },
      });

    return {
      schoolId: actor.schoolId,
      AND: [notFuture, { targets: { some: { OR: targetOr } } }],
    };
  }

  private async assertCanView(
    a: {
      schoolId: string;
      authorUserId: string;
      publishAt: Date | null;
      targets: { kind: AnnouncementTargetKind; refId: string | null }[];
    },
    actor: Actor,
  ) {
    this.enforceScope(actor, a.schoolId);
    const isAdmin =
      actor.role === Role.SCHOOL_ADMIN || actor.role === Role.SUPER_ADMIN;
    const isAuthor = a.authorUserId === actor.userId;

    // Future (scheduled) announcements are only visible to the author/admin.
    const isFuture = a.publishAt !== null && a.publishAt.getTime() > Date.now();
    if (isFuture && !isAdmin && !isAuthor) {
      throw new NotFoundException('Announcement not found');
    }
    if (isAdmin || isAuthor) return;

    const roleKind = this.roleAllKind(actor.role);
    const sectionIds = new Set(await this.actorSectionIds(actor));
    const classGradeIds = new Set(await this.actorClassGradeIds(actor));
    const ok = a.targets.some(
      (t) =>
        t.kind === AnnouncementTargetKind.SCHOOL ||
        (roleKind !== null && t.kind === roleKind) ||
        (t.kind === AnnouncementTargetKind.SECTION &&
          !!t.refId &&
          sectionIds.has(t.refId)) ||
        (t.kind === AnnouncementTargetKind.CLASS &&
          !!t.refId &&
          classGradeIds.has(t.refId)),
    );
    if (!ok) throw new ForbiddenException('Not allowed');
  }

  /** Batch-resolve Section/ClassGrade names for target labels across rows. */
  private async buildTargetLabelMap(
    rows: {
      targets?: { kind: AnnouncementTargetKind; refId: string | null }[];
    }[],
  ): Promise<Map<string, string>> {
    const sectionIds = new Set<string>();
    const classIds = new Set<string>();
    for (const r of rows) {
      for (const t of r.targets ?? []) {
        if (t.kind === AnnouncementTargetKind.SECTION && t.refId)
          sectionIds.add(t.refId);
        if (t.kind === AnnouncementTargetKind.CLASS && t.refId)
          classIds.add(t.refId);
      }
    }
    const [sections, classes] = await Promise.all([
      sectionIds.size
        ? this.prisma.section.findMany({
            where: { id: { in: [...sectionIds] } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      classIds.size
        ? this.prisma.classGrade.findMany({
            where: { id: { in: [...classIds] } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    const map = new Map<string, string>();
    for (const s of sections) map.set(s.id, s.name);
    for (const c of classes) map.set(c.id, c.name);
    return map;
  }

  private targetLabel(
    t: { kind: AnnouncementTargetKind; refId: string | null },
    names: Map<string, string>,
  ): string {
    switch (t.kind) {
      case AnnouncementTargetKind.SCHOOL:
        return 'School-wide';
      case AnnouncementTargetKind.ALL_TEACHERS:
        return 'All teachers';
      case AnnouncementTargetKind.ALL_STUDENTS:
        return 'All students';
      case AnnouncementTargetKind.ALL_PARENTS:
        return 'All parents';
      case AnnouncementTargetKind.CLASS:
        return names.get(t.refId ?? '') ?? 'Class';
      case AnnouncementTargetKind.SECTION:
        return names.get(t.refId ?? '') ?? 'Section';
      default:
        return String(t.kind);
    }
  }

  private async present(a: any, labelMap: Map<string, string>) {
    const attachments = await Promise.all(
      (a.attachments ?? []).map(async (att: any) => ({
        id: att.id,
        fileName: att.fileName,
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
        downloadUrl: (await this.s3.presignGetObject({ key: att.s3Key })).url,
      })),
    );
    const targets = (a.targets ?? []).map((t: any) => ({
      kind: t.kind,
      refId: t.refId ?? null,
      label: this.targetLabel(t, labelMap),
    }));
    return {
      id: a.id,
      schoolId: a.schoolId,
      title: a.title,
      body: a.body,
      type: a.type,
      targets,
      section: a.section ?? null,
      author: a.author ?? null,
      publishAt: a.publishAt,
      createdAt: a.createdAt,
      isRead: Array.isArray(a.reads) && a.reads[0]?.readAt != null,
      attachments,
    };
  }

  // ---- notification fan-out ---------------------------------------------

  private async emitAnnouncementNotification(a: {
    id: string;
    schoolId: string;
    title: string;
    body: string;
    authorUserId: string;
  }) {
    const targets = await this.prisma.announcementTarget.findMany({
      where: { announcementId: a.id },
      select: { kind: true, refId: true },
    });
    const userIds = await this.resolveRecipients(
      a.schoolId,
      a.authorUserId,
      targets,
    );
    if (!userIds.length) return;

    const preview = a.body.length > 140 ? `${a.body.slice(0, 137)}...` : a.body;
    const event: NotificationCreateEvent = {
      userIds,
      type: 'NEW_ANNOUNCEMENT',
      title: `Announcement: ${a.title}`,
      body: preview,
      link: `/announcements?open=${a.id}`,
      entityType: 'Announcement',
      entityId: a.id,
      notifyPreferenceKey: 'notifyAnnouncements',
    };
    // The listener fans out (createMany in-app rows + batched, non-blocking email).
    this.eventEmitter.emit(NOTIFICATION_CREATE, event);
  }

  private async resolveRecipients(
    schoolId: string,
    authorUserId: string,
    targets: { kind: AnnouncementTargetKind; refId: string | null }[],
  ): Promise<string[]> {
    const userIds = new Set<string>();

    const addRole = async (roles: Role[]) => {
      const users = await this.prisma.user.findMany({
        where: { schoolId, isActive: true, role: { in: roles } },
        select: { id: true },
      });
      for (const u of users) userIds.add(u.id);
    };

    for (const t of targets) {
      switch (t.kind) {
        case AnnouncementTargetKind.SCHOOL:
          await addRole([
            Role.STUDENT,
            Role.PARENT,
            Role.TEACHER,
            Role.SCHOOL_ADMIN,
          ]);
          break;
        case AnnouncementTargetKind.ALL_STUDENTS:
          await addRole([Role.STUDENT]);
          break;
        case AnnouncementTargetKind.ALL_TEACHERS:
          await addRole([Role.TEACHER]);
          break;
        case AnnouncementTargetKind.ALL_PARENTS:
          await addRole([Role.PARENT]);
          break;
        case AnnouncementTargetKind.SECTION:
          if (t.refId)
            for (const id of await this.sectionRecipientUserIds(t.refId))
              userIds.add(id);
          break;
        case AnnouncementTargetKind.CLASS:
          if (t.refId) {
            const sections = await this.prisma.section.findMany({
              where: { classGradeId: t.refId },
              select: { id: true },
            });
            for (const s of sections)
              for (const id of await this.sectionRecipientUserIds(s.id))
                userIds.add(id);
          }
          break;
      }
    }

    userIds.delete(authorUserId);
    return [...userIds];
  }

  /** Enrolled students + their linked parents + assigned teachers, as User ids. */
  private async sectionRecipientUserIds(
    sectionId: string,
  ): Promise<Set<string>> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { sectionId, status: 'ACTIVE' },
      select: { student: { select: { id: true, userId: true } } },
    });
    const studentProfileIds = enrollments.map((e) => e.student.id);

    const [parents, sectionTeachers, subjectTeachers] = await Promise.all([
      studentProfileIds.length
        ? this.prisma.parentStudent.findMany({
            where: { studentId: { in: studentProfileIds } },
            select: { parent: { select: { userId: true } } },
          })
        : Promise.resolve([]),
      this.prisma.sectionTeacher.findMany({
        where: { sectionId },
        select: { teacher: { select: { userId: true } } },
      }),
      this.prisma.sectionSubject.findMany({
        where: { sectionId, teacherId: { not: null } },
        select: { teacher: { select: { userId: true } } },
      }),
    ]);

    const userIds = new Set<string>();
    for (const e of enrollments)
      if (e.student.userId) userIds.add(e.student.userId);
    for (const p of parents) if (p.parent?.userId) userIds.add(p.parent.userId);
    for (const t of sectionTeachers)
      if (t.teacher?.userId) userIds.add(t.teacher.userId);
    for (const t of subjectTeachers)
      if (t.teacher?.userId) userIds.add(t.teacher.userId);
    return userIds;
  }
}
