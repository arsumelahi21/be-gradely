import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ThreadType } from '@prisma/client';
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
import { canMessage } from './permission-matrix';
import { AuditLogService } from '../audit/audit.service';
import { CreateThreadDto } from './dto/create-thread.dto';
import { BroadcastMessageDto } from './dto/broadcast-message.dto';
import { ReportUserDto } from './dto/report-user.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { ReactionDto } from './dto/reaction.dto';
import { PresignAttachmentDto } from './dto/presign-attachment.dto';

type UserContext = {
  id: string;
  role: Role;
  schoolId: string | null;
  fullName: string | null;
  email: string;
  isActive: boolean;
  teacherProfileId: string | null;
  studentProfileId: string | null;
  parentProfileId: string | null;
};

const participantUserSelect = {
  select: {
    id: true,
    fullName: true,
    email: true,
    role: true,
    userCode: true,
    studentProfile: {
      select: {
        id: true,
        fullName: true,
        rollNo: true,
        photoMimeType: true,
      },
    },
    teacherProfile: { select: { fullName: true } },
    parentProfile: { select: { fullName: true } },
  },
} as const;

/** Best display name: User.fullName → the role profile's name → email (last resort). */
function resolveUserName(u: {
  fullName: string | null;
  email: string;
  studentProfile?: { fullName: string } | null;
  teacherProfile?: { fullName: string } | null;
  parentProfile?: { fullName: string } | null;
}): string {
  return (
    u.fullName ||
    u.studentProfile?.fullName ||
    u.teacherProfile?.fullName ||
    u.parentProfile?.fullName ||
    u.email
  );
}

/** Public shape for a person shown in messaging (list, header, sender). Carries
 * enough for an avatar + a read-only "basic info" card. */
function presentUser(u: any) {
  return {
    id: u.id,
    fullName: resolveUserName(u),
    email: u.email,
    role: u.role,
    userCode: u.userCode ?? null,
    rollNo: u.studentProfile?.rollNo ?? null,
    studentProfileId: u.studentProfile?.id ?? null,
    hasPhoto: !!u.studentProfile?.photoMimeType,
  };
}

@Injectable()
export class MessagingService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    private readonly s3: S3PresignService,
    private readonly eventEmitter: EventEmitter2,
    private readonly audit: AuditLogService,
  ) {
    super(prisma);
  }

  // ---- user / relationship helpers --------------------------------------

  private async loadUserContext(userId: string): Promise<UserContext | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        schoolId: true,
        fullName: true,
        email: true,
        isActive: true,
        teacherProfile: { select: { id: true } },
        studentProfile: { select: { id: true } },
        parentProfile: { select: { id: true } },
      },
    });
    if (!user) return null;
    return {
      id: user.id,
      role: user.role as Role,
      schoolId: user.schoolId,
      fullName: user.fullName,
      email: user.email,
      isActive: user.isActive,
      teacherProfileId: user.teacherProfile?.id ?? null,
      studentProfileId: user.studentProfile?.id ?? null,
      parentProfileId: user.parentProfile?.id ?? null,
    };
  }

  private async teacherSectionIds(
    teacherProfileId: string,
  ): Promise<Set<string>> {
    const [assigned, taught] = await Promise.all([
      this.prisma.sectionTeacher.findMany({
        where: { teacherId: teacherProfileId },
        select: { sectionId: true },
      }),
      this.prisma.sectionSubject.findMany({
        where: { teacherId: teacherProfileId },
        select: { sectionId: true },
      }),
    ]);
    return new Set([
      ...assigned.map((s) => s.sectionId),
      ...taught.map((s) => s.sectionId),
    ]);
  }

  /**
   * Authorization to open a DIRECT thread: open within a school (any role, students
   * included); the one cross-school pair is super-admin<->school-admin, gated by the role matrix.
   */
  private async assertCanReach(actor: Actor, recipient: UserContext) {
    if (!canMessage(actor.role, recipient.role)) {
      throw new ForbiddenException('You are not allowed to message this user');
    }
    // Super-admin has no school; the role matrix limits this branch to the
    // super-admin ↔ school-admin pair, allowed across schools.
    if (
      actor.role === Role.SUPER_ADMIN ||
      recipient.role === Role.SUPER_ADMIN
    ) {
      return;
    }
    // Everyone else must share a school.
    if (!recipient.schoolId || recipient.schoolId !== actor.schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }
    // Within a school, student↔parent is the one gated pair: only a guardian
    // link (their own child / their own parent). Every other pair is open.
    if (
      (actor.role === Role.STUDENT && recipient.role === Role.PARENT) ||
      (actor.role === Role.PARENT && recipient.role === Role.STUDENT)
    ) {
      const actorCtx = await this.loadUserContext(actor.userId);
      const studentProfileId =
        actor.role === Role.STUDENT
          ? actorCtx?.studentProfileId
          : recipient.studentProfileId;
      const parentProfileId =
        actor.role === Role.PARENT
          ? actorCtx?.parentProfileId
          : recipient.parentProfileId;
      const link =
        studentProfileId && parentProfileId
          ? await this.prisma.parentStudent.findFirst({
              where: { studentId: studentProfileId, parentId: parentProfileId },
              select: { studentId: true },
            })
          : null;
      if (!link) {
        throw new ForbiddenException(
          'You can only message a linked parent or child',
        );
      }
    }
  }

  private async assertParticipant(threadId: string, userId: string) {
    const p = await this.prisma.threadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId } },
      select: { id: true },
    });
    if (!p)
      throw new ForbiddenException('You are not a participant of this thread');
  }

  // ---- thread creation ---------------------------------------------------

  async createThread(dto: CreateThreadDto, actor: Actor) {
    if (dto.type === ThreadType.DIRECT) {
      return this.createDirectThread(dto.recipientUserId!, actor);
    }
    if (dto.type === ThreadType.CLASS) {
      return this.createClassThread(dto.sectionId!, actor);
    }
    return this.createGroupThread(
      dto.participantIds!,
      dto.title ?? null,
      actor,
    );
  }

  private async createDirectThread(recipientUserId: string, actor: Actor) {
    if (recipientUserId === actor.userId) {
      throw new BadRequestException('Cannot open a thread with yourself');
    }
    const recipient = await this.loadUserContext(recipientUserId);
    if (!recipient || !recipient.isActive) {
      throw new NotFoundException('Recipient not found');
    }
    await this.assertCanReach(actor, recipient);

    const schoolId = actor.schoolId ?? recipient.schoolId;
    if (!schoolId) throw new BadRequestException('No school context');

    // Dedupe: reuse an existing 1:1 thread between exactly these two users.
    const existing = await this.prisma.messageThread.findFirst({
      where: {
        type: ThreadType.DIRECT,
        schoolId,
        AND: [
          { participants: { some: { userId: actor.userId } } },
          { participants: { some: { userId: recipientUserId } } },
        ],
      },
    });
    if (existing) return this.getThread(existing.id, actor);

    const thread = await this.prisma.$transaction(async (tx) => {
      const created = await tx.messageThread.create({
        data: { schoolId, type: ThreadType.DIRECT },
      });
      await tx.threadParticipant.createMany({
        data: [
          { threadId: created.id, userId: actor.userId },
          { threadId: created.id, userId: recipientUserId },
        ],
      });
      return created;
    });
    void this.audit.record(actor.userId, 'THREAD_CREATE', {
      schoolId,
      entityType: 'MessageThread',
      entityId: thread.id,
      metadata: { type: ThreadType.DIRECT },
    });
    return this.getThread(thread.id, actor);
  }

  private async createClassThread(sectionId: string, actor: Actor) {
    if (
      ![Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN].includes(actor.role)
    ) {
      throw new ForbiddenException(
        'Only teachers or admins can start a class thread',
      );
    }
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      select: { id: true, schoolId: true },
    });
    if (!section) throw new NotFoundException('Section not found');
    this.enforceScope(actor, section.schoolId);

    if (actor.role === Role.TEACHER) {
      const actorCtx = await this.loadUserContext(actor.userId);
      const mySections = actorCtx?.teacherProfileId
        ? await this.teacherSectionIds(actorCtx.teacherProfileId)
        : new Set<string>();
      if (!mySections.has(sectionId)) {
        throw new ForbiddenException('You do not teach this section');
      }
    }

    const existing = await this.prisma.messageThread.findFirst({
      where: { type: ThreadType.CLASS, sectionId, schoolId: section.schoolId },
    });
    if (existing) return this.getThread(existing.id, actor);

    const participantUserIds = await this.deriveClassParticipants(sectionId);
    // Always include the creator (e.g. an admin not otherwise on the roster).
    participantUserIds.add(actor.userId);
    if (participantUserIds.size === 0) {
      throw new BadRequestException('Section has no participants to message');
    }

    const thread = await this.prisma.$transaction(async (tx) => {
      const created = await tx.messageThread.create({
        data: { schoolId: section.schoolId, type: ThreadType.CLASS, sectionId },
      });
      await tx.threadParticipant.createMany({
        data: [...participantUserIds].map((userId) => ({
          threadId: created.id,
          userId,
        })),
        skipDuplicates: true,
      });
      return created;
    });
    void this.audit.record(actor.userId, 'THREAD_CREATE', {
      schoolId: section.schoolId,
      entityType: 'MessageThread',
      entityId: thread.id,
      metadata: { type: ThreadType.CLASS, sectionId },
    });
    return this.getThread(thread.id, actor);
  }

  /** Enrolled students + their linked parents + assigned teachers, as User ids. */
  private async deriveClassParticipants(
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

  /** Group threads and the "message individually" broadcast are staff-only. */
  private assertCanCreateGroup(actor: Actor) {
    if (
      ![Role.TEACHER, Role.SCHOOL_ADMIN, Role.SUPER_ADMIN].includes(actor.role)
    ) {
      throw new ForbiddenException(
        'Only teachers or admins can create group threads',
      );
    }
  }

  /**
   * Ad-hoc group thread; "message a section" also lands here (roster pre-fills the picker).
   * Each participant is re-checked with assertCanReach; no dedupe — groups are intentionally ad-hoc.
   */
  private async createGroupThread(
    participantIds: string[],
    title: string | null,
    actor: Actor,
  ) {
    this.assertCanCreateGroup(actor);
    const ids = [...new Set(participantIds)].filter(
      (id) => id !== actor.userId,
    );
    if (ids.length === 0) {
      throw new BadRequestException('Pick at least one other participant');
    }

    let schoolId = actor.schoolId ?? null;
    for (const id of ids) {
      const recipient = await this.loadUserContext(id);
      if (!recipient || !recipient.isActive) {
        throw new NotFoundException('A selected recipient was not found');
      }
      await this.assertCanReach(actor, recipient);
      schoolId = schoolId ?? recipient.schoolId;
    }
    if (!schoolId) throw new BadRequestException('No school context');

    const allIds = [...new Set([actor.userId, ...ids])];
    const cleanTitle = title?.trim() || null;
    const thread = await this.prisma.$transaction(async (tx) => {
      const created = await tx.messageThread.create({
        data: { schoolId, type: ThreadType.GROUP, title: cleanTitle },
      });
      await tx.threadParticipant.createMany({
        data: allIds.map((userId) => ({ threadId: created.id, userId })),
        skipDuplicates: true,
      });
      return created;
    });
    void this.audit.record(actor.userId, 'THREAD_CREATE', {
      schoolId,
      entityType: 'MessageThread',
      entityId: thread.id,
      metadata: { type: ThreadType.GROUP, participants: allIds.length },
    });
    return this.getThread(thread.id, actor);
  }

  /**
   * "Message individually": sends the same body to each recipient as a separate 1:1
   * thread (reuses createDirectThread + sendMessage). Staff-only, text-only.
   */
  async broadcast(dto: BroadcastMessageDto, actor: Actor) {
    this.assertCanCreateGroup(actor);
    const body = dto.body?.trim() ?? '';
    if (!body) throw new BadRequestException('Message body is required');
    const ids = [...new Set(dto.recipientUserIds)].filter(
      (id) => id !== actor.userId,
    );
    if (ids.length === 0) {
      throw new BadRequestException('Pick at least one recipient');
    }
    const threadIds: string[] = [];
    for (const id of ids) {
      const thread = await this.createDirectThread(id, actor);
      await this.sendMessage(thread.id, { body } as SendMessageDto, actor);
      threadIds.push(thread.id);
    }
    return { sent: threadIds.length, threadIds };
  }

  /** Load a GROUP thread the actor may edit: staff + a participant, in-scope. */
  private async loadManageableGroup(threadId: string, actor: Actor) {
    this.assertCanCreateGroup(actor); // teachers/admins only
    const thread = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: { id: true, schoolId: true, type: true },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    if (thread.type !== ThreadType.GROUP) {
      throw new BadRequestException('Only group threads can be edited');
    }
    this.enforceScope(actor, thread.schoolId);
    await this.assertParticipant(threadId, actor.userId);
    return thread;
  }

  async addGroupParticipants(
    threadId: string,
    userIds: string[],
    actor: Actor,
  ) {
    const thread = await this.loadManageableGroup(threadId, actor);
    const existing = new Set(
      (
        await this.prisma.threadParticipant.findMany({
          where: { threadId },
          select: { userId: true },
        })
      ).map((p) => p.userId),
    );
    const toAdd: string[] = [];
    for (const id of [...new Set(userIds)]) {
      if (existing.has(id)) continue;
      const recipient = await this.loadUserContext(id);
      if (!recipient || !recipient.isActive) {
        throw new NotFoundException('A selected user was not found');
      }
      await this.assertCanReach(actor, recipient); // same rules as a 1:1
      toAdd.push(id);
    }
    if (toAdd.length) {
      await this.prisma.threadParticipant.createMany({
        data: toAdd.map((userId) => ({ threadId, userId })),
        skipDuplicates: true,
      });
      void this.audit.record(actor.userId, 'THREAD_PARTICIPANTS_ADD', {
        schoolId: thread.schoolId,
        entityType: 'MessageThread',
        entityId: threadId,
        metadata: { added: toAdd.length },
      });
    }
    return this.getThread(threadId, actor);
  }

  async removeGroupParticipant(threadId: string, userId: string, actor: Actor) {
    const thread = await this.loadManageableGroup(threadId, actor);
    const participants = await this.prisma.threadParticipant.findMany({
      where: { threadId },
      select: { userId: true },
    });
    if (!participants.some((p) => p.userId === userId)) {
      throw new NotFoundException('User is not in this group');
    }
    if (participants.length <= 2) {
      throw new BadRequestException('A group must keep at least two members');
    }
    await this.prisma.threadParticipant.delete({
      where: { threadId_userId: { threadId, userId } },
    });
    void this.audit.record(actor.userId, 'THREAD_PARTICIPANTS_REMOVE', {
      schoolId: thread.schoolId,
      entityType: 'MessageThread',
      entityId: threadId,
      metadata: { removed: userId },
    });
    return this.getThread(threadId, actor);
  }

  /** Rename a GROUP thread (staff + participant). */
  async renameGroup(threadId: string, title: string, actor: Actor) {
    const thread = await this.loadManageableGroup(threadId, actor);
    const clean = title.trim();
    await this.prisma.messageThread.update({
      where: { id: threadId },
      data: { title: clean || null },
    });
    void this.audit.record(actor.userId, 'THREAD_RENAME', {
      schoolId: thread.schoolId,
      entityType: 'MessageThread',
      entityId: threadId,
      metadata: { title: clean },
    });
    return this.getThread(threadId, actor);
  }

  /**
   * "Delete chat" for the caller only: soft-hides the thread + sets `clearedAt` (participant
   * row kept). A new message un-hides it, resurfacing as fresh for the deleter, unchanged for the other side.
   */
  async leaveThread(threadId: string, actor: Actor) {
    await this.assertParticipant(threadId, actor.userId);
    await this.prisma.threadParticipant.update({
      where: { threadId_userId: { threadId, userId: actor.userId } },
      data: { hidden: true, clearedAt: new Date() },
    });
    return { threadId, left: true };
  }

  /**
   * Reports a user to the school's admins (or the super-admin, if reporter is an admin);
   * writes a notification + audit entry.
   */
  async reportUser(dto: ReportUserDto, actor: Actor) {
    if (dto.reportedUserId === actor.userId) {
      throw new BadRequestException('You cannot report yourself');
    }
    const reported = await this.loadUserContext(dto.reportedUserId);
    if (!reported) throw new NotFoundException('User not found');

    const escalatingAdmin =
      actor.role === Role.SCHOOL_ADMIN || actor.role === Role.SUPER_ADMIN;
    if (!escalatingAdmin && !actor.schoolId) {
      throw new BadRequestException('No school context');
    }
    const adminWhere: any = escalatingAdmin
      ? { role: Role.SUPER_ADMIN, isActive: true }
      : { role: Role.SCHOOL_ADMIN, schoolId: actor.schoolId, isActive: true };
    const [admins, reporter] = await Promise.all([
      this.prisma.user.findMany({ where: adminWhere, select: { id: true } }),
      this.loadUserContext(actor.userId),
    ]);
    const reason = dto.reason.trim().slice(0, 1000);
    const reporterName = reporter
      ? reporter.fullName || reporter.email
      : 'A user';
    const reportedName = reported.fullName || reported.email;

    const recipientIds = admins
      .map((a) => a.id)
      .filter((id) => id !== actor.userId);
    if (recipientIds.length) {
      const event: NotificationCreateEvent = {
        userIds: recipientIds,
        type: 'USER_REPORT',
        title: `Report: ${reportedName}`,
        body: `${reporterName} reported ${reportedName}${
          reason ? ` — ${reason}` : ''
        }`,
        link: '/messages',
        notifyPreferenceKey: 'notifyMessages',
      };
      this.eventEmitter.emit(NOTIFICATION_CREATE, event);
    }
    void this.audit.record(actor.userId, 'USER_REPORT', {
      schoolId: actor.schoolId ?? reported.schoolId ?? undefined,
      entityType: 'User',
      entityId: dto.reportedUserId,
      metadata: { reason, reportedRole: reported.role, threadId: dto.threadId },
    });
    return { reported: true };
  }

  // ---- recipient discovery (for the "new message" picker) ----------------

  /**
   * Users the actor may open a DIRECT thread with — exactly the set assertCanReach accepts,
   * so the picker never offers an unreachable recipient.
   */
  async listRecipients(actor: Actor) {
    // rollNo/photo live on StudentProfile; null for non-students.
    const select = {
      id: true,
      fullName: true,
      email: true,
      role: true,
      studentProfile: {
        select: { id: true, rollNo: true, photoMimeType: true, fullName: true },
      },
      teacherProfile: { select: { fullName: true } },
      parentProfile: { select: { fullName: true } },
    } as const;
    type Row = {
      id: string;
      fullName: string | null;
      email: string;
      role: string;
      studentProfile: {
        id: string;
        rollNo: string | null;
        photoMimeType: string | null;
        fullName: string;
      } | null;
      teacherProfile: { fullName: string } | null;
      parentProfile: { fullName: string } | null;
    };
    const toRecipient = (u: Row) => ({
      id: u.id,
      fullName: resolveUserName(u),
      email: u.email,
      role: u.role as Role,
      rollNo: u.studentProfile?.rollNo ?? null,
      studentProfileId: u.studentProfile?.id ?? null,
      hasPhoto: !!u.studentProfile?.photoMimeType,
    });

    const sortByName = (rows: Row[]) =>
      rows
        .map((u) => toRecipient(u))
        .sort((a, b) =>
          (a.fullName || a.email).localeCompare(b.fullName || b.email),
        );

    // Super-admin only corresponds with school admins (across all schools).
    if (actor.role === Role.SUPER_ADMIN) {
      const admins = await this.prisma.user.findMany({
        where: {
          isActive: true,
          id: { not: actor.userId },
          role: Role.SCHOOL_ADMIN as any,
        },
        select,
      });
      return sortByName(admins as Row[]);
    }

    if (!actor.schoolId) return [];
    const schoolId = actor.schoolId;

    // Teacher / school-admin: everyone in the school (admin also reaches the
    // super-admin above them).
    if (actor.role === Role.TEACHER || actor.role === Role.SCHOOL_ADMIN) {
      const where: any = {
        isActive: true,
        id: { not: actor.userId },
        OR: [{ schoolId }],
      };
      if (actor.role === Role.SCHOOL_ADMIN) {
        where.OR.push({ role: Role.SUPER_ADMIN });
      }
      const rows = await this.prisma.user.findMany({ where, select });
      return sortByName(rows as Row[]);
    }

    // Student / parent: their own role + teachers + admins openly, but the
    // opposite role (parent/student) only across a guardian link.
    const ctx = await this.loadUserContext(actor.userId);
    let linkedUserIds: string[] = [];
    if (actor.role === Role.STUDENT && ctx?.studentProfileId) {
      const links = await this.prisma.parentStudent.findMany({
        where: { studentId: ctx.studentProfileId },
        select: { parent: { select: { userId: true } } },
      });
      linkedUserIds = links
        .map((l) => l.parent?.userId)
        .filter((x): x is string => !!x);
    } else if (actor.role === Role.PARENT && ctx?.parentProfileId) {
      const links = await this.prisma.parentStudent.findMany({
        where: { parentId: ctx.parentProfileId },
        select: { student: { select: { userId: true } } },
      });
      linkedUserIds = links
        .map((l) => l.student?.userId)
        .filter((x): x is string => !!x);
    }
    const openRoles =
      actor.role === Role.STUDENT
        ? [Role.STUDENT, Role.TEACHER, Role.SCHOOL_ADMIN]
        : [Role.PARENT, Role.TEACHER, Role.SCHOOL_ADMIN];
    const rows = await this.prisma.user.findMany({
      where: {
        schoolId,
        isActive: true,
        id: { not: actor.userId },
        OR: [
          { role: { in: openRoles as any } },
          ...(linkedUserIds.length ? [{ id: { in: linkedUserIds } }] : []),
        ],
      },
      select,
    });
    return sortByName(rows as Row[]);
  }

  // ---- class/section targets (for the "message a section" flow) -----------

  /**
   * Sections the actor may broadcast to: a teacher's own sections, or every section
   * in a school-admin's school. Staff-only.
   */
  async listMessagingSections(actor: Actor) {
    const toItem = (s: {
      id: string;
      name: string;
      classGrade: { name: string } | null;
    }) => ({ id: s.id, name: s.name, gradeName: s.classGrade?.name ?? null });
    const sectionSelect = {
      id: true,
      name: true,
      classGrade: { select: { name: true } },
    } as const;
    const orderBy = [
      { classGrade: { name: 'asc' as const } },
      { name: 'asc' as const },
    ];

    if (actor.role === Role.TEACHER) {
      const ctx = await this.loadUserContext(actor.userId);
      const set = ctx?.teacherProfileId
        ? await this.teacherSectionIds(ctx.teacherProfileId)
        : new Set<string>();
      if (set.size === 0) return [];
      const sections = await this.prisma.section.findMany({
        where: { id: { in: [...set] } },
        select: sectionSelect,
        orderBy,
      });
      return sections.map(toItem);
    }
    if (actor.role === Role.SCHOOL_ADMIN && actor.schoolId) {
      const sections = await this.prisma.section.findMany({
        where: { schoolId: actor.schoolId },
        select: sectionSelect,
        orderBy,
      });
      return sections.map(toItem);
    }
    return [];
  }

  /**
   * Section roster split into students/parents/co-teachers, for the group composer to
   * pre-select. Gated to the actor's own sections (teacher) or school (admin); excludes the actor.
   */
  async getSectionRoster(sectionId: string, actor: Actor) {
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      select: {
        id: true,
        schoolId: true,
        name: true,
        classGrade: { select: { name: true } },
      },
    });
    if (!section) throw new NotFoundException('Section not found');
    this.enforceScope(actor, section.schoolId);
    if (actor.role === Role.TEACHER) {
      const ctx = await this.loadUserContext(actor.userId);
      const mine = ctx?.teacherProfileId
        ? await this.teacherSectionIds(ctx.teacherProfileId)
        : new Set<string>();
      if (!mine.has(sectionId)) {
        throw new ForbiddenException('You do not teach this section');
      }
    } else if (
      actor.role !== Role.SCHOOL_ADMIN &&
      actor.role !== Role.SUPER_ADMIN
    ) {
      throw new ForbiddenException(
        'Only teachers or admins can message a section',
      );
    }

    const enrollments = await this.prisma.enrollment.findMany({
      where: { sectionId, status: 'ACTIVE' },
      select: { student: { select: { id: true, userId: true } } },
    });
    const studentProfileIds = enrollments.map((e) => e.student.id);
    const studentUserIds = enrollments
      .map((e) => e.student.userId)
      .filter((x): x is string => !!x);

    const [parentLinks, sectionTeachers, subjectTeachers] = await Promise.all([
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
    const parentUserIds = parentLinks
      .map((p) => p.parent?.userId)
      .filter((x): x is string => !!x);
    const teacherUserIds = [
      ...sectionTeachers.map((t) => t.teacher?.userId),
      ...subjectTeachers.map((t) => t.teacher?.userId),
    ].filter((x): x is string => !!x);

    const wantIds = [
      ...new Set([...studentUserIds, ...parentUserIds, ...teacherUserIds]),
    ].filter((id) => id !== actor.userId);
    const users = wantIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: wantIds }, isActive: true },
          select: participantUserSelect.select,
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, presentUser(u)]));
    const pick = (ids: string[]) =>
      [...new Set(ids)]
        .filter((id) => id !== actor.userId)
        .map((id) => byId.get(id))
        .filter((u): u is ReturnType<typeof presentUser> => !!u);

    return {
      section: {
        id: section.id,
        name: section.name,
        gradeName: section.classGrade?.name ?? null,
      },
      students: pick(studentUserIds),
      parents: pick(parentUserIds),
      teachers: pick(teacherUserIds),
    };
  }

  // ---- reads -------------------------------------------------------------

  async listThreads(actor: Actor, query: { page?: number; pageSize?: number }) {
    const { page, pageSize, skip, take } = resolvePagination(query);
    // Excludes threads the caller "deleted" (hidden) until a new message un-hides them;
    // keeps pagination exact since it's a plain participant predicate.
    const where = {
      participants: { some: { userId: actor.userId, hidden: false } },
    };

    const [total, threads] = await this.prisma.$transaction([
      this.prisma.messageThread.count({ where }),
      this.prisma.messageThread.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip,
        take,
        include: {
          participants: { include: { user: participantUserSelect } },
          section: { select: { id: true, name: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      items: threads.map((t) => this.presentThread(t, actor.userId)),
    };
  }

  /** Count of the caller's threads that currently read as unread — the SAME
   * predicate `presentThread` uses, selecting only the fields the count needs
   * (my participant row + the latest message) so no user/body rows are loaded. */
  async getUnreadCount(actor: Actor): Promise<{ unread: number }> {
    const threads = await this.prisma.messageThread.findMany({
      where: {
        participants: { some: { userId: actor.userId, hidden: false } },
      },
      select: {
        participants: {
          where: { userId: actor.userId },
          select: { lastReadAt: true, clearedAt: true },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { senderId: true, createdAt: true },
        },
      },
    });
    let unread = 0;
    for (const t of threads) {
      const mine = t.participants[0];
      const raw = t.messages[0];
      const latest =
        raw && mine?.clearedAt && raw.createdAt <= mine.clearedAt
          ? undefined
          : raw;
      if (
        latest &&
        latest.senderId !== actor.userId &&
        (!mine?.lastReadAt || latest.createdAt > mine.lastReadAt)
      ) {
        unread++;
      }
    }
    return { unread };
  }

  async getThread(threadId: string, actor: Actor) {
    const thread = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      include: {
        participants: { include: { user: participantUserSelect } },
        section: { select: { id: true, name: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    if (!thread.participants.some((p) => p.userId === actor.userId)) {
      throw new ForbiddenException('You are not a participant of this thread');
    }
    return this.presentThread(thread, actor.userId);
  }

  private presentThread(thread: any, userId: string) {
    const mine = thread.participants.find((p: any) => p.userId === userId);
    // The deleter only sees messages after their own `clearedAt`, so a message
    // from before their delete never counts as this thread's preview/unread.
    const rawLatest = thread.messages[0];
    const latest =
      rawLatest && mine?.clearedAt && rawLatest.createdAt <= mine.clearedAt
        ? undefined
        : rawLatest;
    const unread =
      !!latest &&
      latest.senderId !== userId &&
      (!mine?.lastReadAt || latest.createdAt > mine.lastReadAt);
    return {
      id: thread.id,
      type: thread.type,
      title: thread.title ?? null,
      schoolId: thread.schoolId,
      section: thread.section,
      lastMessageAt: thread.lastMessageAt,
      unread,
      participants: thread.participants.map((p: any) => ({
        userId: p.userId,
        lastReadAt: p.lastReadAt,
        user: presentUser(p.user),
      })),
      lastMessage: latest
        ? {
            id: latest.id,
            body: latest.body,
            senderId: latest.senderId,
            createdAt: latest.createdAt,
          }
        : null,
    };
  }

  async getMessages(
    threadId: string,
    actor: Actor,
    query: { page?: number; pageSize?: number },
  ) {
    const mine = await this.prisma.threadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId: actor.userId } },
      select: { clearedAt: true },
    });
    if (!mine)
      throw new ForbiddenException('You are not a participant of this thread');
    const { page, pageSize, skip, take } = resolvePagination(query);

    // The caller doesn't see: messages before they cleared the chat, nor any
    // single message they deleted from their own end.
    const where = {
      threadId,
      ...(mine.clearedAt ? { createdAt: { gt: mine.clearedAt } } : {}),
      deletions: { none: { userId: actor.userId } },
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.message.count({ where }),
      this.prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          sender: participantUserSelect,
          attachments: true,
          reactions: true,
          replyTo: {
            select: {
              id: true,
              body: true,
              deletedAt: true,
              sender: {
                select: {
                  fullName: true,
                  email: true,
                  studentProfile: { select: { fullName: true } },
                  teacherProfile: { select: { fullName: true } },
                  parentProfile: { select: { fullName: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    const items = await Promise.all(
      rows.map(async (m) => {
        // Unsent (deleted-for-everyone) → tombstone: no body/attachments/etc.
        if (m.deletedAt) {
          return {
            id: m.id,
            threadId: m.threadId,
            senderId: m.senderId,
            sender: presentUser(m.sender),
            body: '',
            createdAt: m.createdAt,
            editedAt: null,
            deleted: true,
            replyTo: null,
            reactions: [] as { emoji: string; count: number; mine: boolean }[],
            attachments: [] as unknown[],
          };
        }
        // One reaction per user → group by emoji with counts + whether I reacted.
        const byEmoji = new Map<
          string,
          { emoji: string; count: number; mine: boolean }
        >();
        for (const r of m.reactions) {
          const e = byEmoji.get(r.emoji) ?? {
            emoji: r.emoji,
            count: 0,
            mine: false,
          };
          e.count += 1;
          if (r.userId === actor.userId) e.mine = true;
          byEmoji.set(r.emoji, e);
        }
        return {
          id: m.id,
          threadId: m.threadId,
          senderId: m.senderId,
          sender: presentUser(m.sender),
          body: m.body,
          createdAt: m.createdAt,
          editedAt: m.editedAt,
          deleted: false,
          replyTo: m.replyTo
            ? {
                id: m.replyTo.id,
                body: m.replyTo.deletedAt ? '' : m.replyTo.body,
                deleted: !!m.replyTo.deletedAt,
                senderName: resolveUserName(m.replyTo.sender),
              }
            : null,
          reactions: Array.from(byEmoji.values()),
          attachments: await Promise.all(
            m.attachments.map(async (a) => ({
              id: a.id,
              fileName: a.fileName,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              downloadUrl: (await this.s3.presignGetObject({ key: a.s3Key }))
                .url,
            })),
          ),
        };
      }),
    );

    return { page, pageSize, total, items };
  }

  // ---- writes ------------------------------------------------------------

  async sendMessage(threadId: string, dto: SendMessageDto, actor: Actor) {
    await this.assertParticipant(threadId, actor.userId);

    // A student may message a school admin only on their turn (open, or after the
    // admin replies). ponytail: turn-taking over the existing thread, no separate request/ticket entity.
    if (actor.role === Role.STUDENT) {
      const thread = await this.prisma.messageThread.findUnique({
        where: { id: threadId },
        select: {
          type: true,
          participants: {
            select: { userId: true, user: { select: { role: true } } },
          },
        },
      });
      const toAdmin =
        thread?.type === ThreadType.DIRECT &&
        thread.participants.some(
          (p) =>
            p.userId !== actor.userId &&
            (p.user.role as Role) === Role.SCHOOL_ADMIN,
        );
      if (toAdmin) {
        const last = await this.prisma.message.findFirst({
          where: { threadId },
          orderBy: { createdAt: 'desc' },
          select: { senderId: true },
        });
        if (last && last.senderId === actor.userId) {
          throw new ForbiddenException(
            'Please wait for the school admin to reply before sending another message.',
          );
        }
      }
    }

    const body = dto.body?.trim() ?? '';
    const attachments = dto.attachments ?? [];
    if (!body && attachments.length === 0) {
      throw new BadRequestException('Message must have text or an attachment');
    }
    // Re-validate every attachment server-side (never trust the client).
    for (const a of attachments) {
      assertAttachmentAllowed({ mimeType: a.mimeType, sizeBytes: a.sizeBytes });
    }

    // A reply must quote a message that lives in this same thread.
    if (dto.replyToId) {
      const target = await this.prisma.message.findUnique({
        where: { id: dto.replyToId },
        select: { threadId: true },
      });
      if (!target || target.threadId !== threadId) {
        throw new BadRequestException('Reply target not found in this thread');
      }
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          threadId,
          senderId: actor.userId,
          body,
          replyToId: dto.replyToId ?? null,
        },
      });
      if (attachments.length) {
        await tx.messageAttachment.createMany({
          data: attachments.map((a) => ({
            messageId: created.id,
            s3Key: a.s3Key,
            fileName: a.fileName,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
          })),
        });
      }
      await tx.messageThread.update({
        where: { id: threadId },
        data: { lastMessageAt: created.createdAt },
      });
      // Sender has implicitly read their own message; sending also un-hides the
      // thread for them (keeping their own clearedAt, so their view stays fresh).
      await tx.threadParticipant.update({
        where: { threadId_userId: { threadId, userId: actor.userId } },
        data: { lastReadAt: created.createdAt, hidden: false },
      });
      // A new message resurfaces the thread for anyone who "deleted" it — it
      // reappears as a fresh thread (only messages after their clearedAt).
      await tx.threadParticipant.updateMany({
        where: { threadId, userId: { not: actor.userId }, hidden: true },
        data: { hidden: false },
      });
      return created;
    });

    // Fire-and-forget: notifying recipients must not pad the send response's critical path.
    // ponytail: log on failure, never block the sender.
    void this.notifyThreadRecipients(
      threadId,
      actor,
      body || 'Sent an attachment',
    ).catch((err) =>
      console.error('notifyThreadRecipients failed', threadId, err),
    );

    return { id: message.id, threadId, body, createdAt: message.createdAt };
  }

  /**
   * Edits the body of a message you sent; sets `editedAt` for the "edited" label.
   * Cannot edit an unsent (deleted) message.
   */
  async editMessage(
    threadId: string,
    messageId: string,
    dto: EditMessageDto,
    actor: Actor,
  ) {
    await this.assertParticipant(threadId, actor.userId);
    const msg = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { threadId: true, senderId: true, deletedAt: true },
    });
    if (!msg || msg.threadId !== threadId) {
      throw new NotFoundException('Message not found');
    }
    if (msg.senderId !== actor.userId) {
      throw new ForbiddenException('You can only edit your own messages');
    }
    if (msg.deletedAt) {
      throw new BadRequestException('This message was deleted');
    }
    const body = dto.body?.trim() ?? '';
    if (!body) throw new BadRequestException('Message cannot be empty');
    return this.prisma.message.update({
      where: { id: messageId },
      data: { body, editedAt: new Date() },
      select: { id: true, body: true, editedAt: true },
    });
  }

  /**
   * Unsends a message (delete for everyone): keeps a tombstone row ("This message was
   * deleted") and drops its attachments + reactions.
   */
  async unsendMessage(threadId: string, messageId: string, actor: Actor) {
    await this.assertParticipant(threadId, actor.userId);
    const msg = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { threadId: true, senderId: true, deletedAt: true },
    });
    if (!msg || msg.threadId !== threadId) {
      throw new NotFoundException('Message not found');
    }
    if (msg.senderId !== actor.userId) {
      throw new ForbiddenException('You can only unsend your own messages');
    }
    if (!msg.deletedAt) {
      await this.prisma.$transaction([
        this.prisma.messageAttachment.deleteMany({ where: { messageId } }),
        this.prisma.messageReaction.deleteMany({ where: { messageId } }),
        this.prisma.message.update({
          where: { id: messageId },
          data: { deletedAt: new Date(), body: '' },
        }),
      ]);
    }
    return { messageId, unsent: true };
  }

  /** Hide a single message from the caller's own view only ("delete for me"). */
  async deleteMessageForMe(threadId: string, messageId: string, actor: Actor) {
    await this.assertParticipant(threadId, actor.userId);
    const msg = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { threadId: true },
    });
    if (!msg || msg.threadId !== threadId) {
      throw new NotFoundException('Message not found');
    }
    await this.prisma.messageDeletion.upsert({
      where: { messageId_userId: { messageId, userId: actor.userId } },
      create: { messageId, userId: actor.userId },
      update: {},
    });
    return { messageId, deleted: true };
  }

  /** Add or replace the caller's emoji reaction on a message (one per person). */
  async reactToMessage(
    threadId: string,
    messageId: string,
    dto: ReactionDto,
    actor: Actor,
  ) {
    await this.assertParticipant(threadId, actor.userId);
    const msg = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { threadId: true, deletedAt: true, senderId: true, body: true },
    });
    if (!msg || msg.threadId !== threadId) {
      throw new NotFoundException('Message not found');
    }
    if (msg.deletedAt) {
      throw new BadRequestException('This message was deleted');
    }
    await this.prisma.messageReaction.upsert({
      where: { messageId_userId: { messageId, userId: actor.userId } },
      create: { messageId, userId: actor.userId, emoji: dto.emoji },
      update: { emoji: dto.emoji },
    });

    // A reaction bumps the thread to re-sort it to top (listThreads orders by
    // lastMessageAt) and notifies the message's author — never yourself.
    if (msg.senderId && msg.senderId !== actor.userId) {
      await this.prisma.messageThread.update({
        where: { id: threadId },
        data: { lastMessageAt: new Date() },
      });
      void this.notifyReaction(
        threadId,
        msg.senderId,
        msg.body,
        dto.emoji,
        actor,
      ).catch((err) => console.error('notifyReaction failed', threadId, err));
    }
    return { messageId, emoji: dto.emoji };
  }

  /** Notify a message's author that someone reacted to it. */
  private async notifyReaction(
    threadId: string,
    authorUserId: string,
    msgBody: string,
    emoji: string,
    actor: Actor,
  ) {
    const reactor = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      select: {
        fullName: true,
        email: true,
        studentProfile: { select: { fullName: true } },
        teacherProfile: { select: { fullName: true } },
        parentProfile: { select: { fullName: true } },
      },
    });
    const reactorName = reactor ? resolveUserName(reactor) : 'Someone';
    const preview = (msgBody ?? '').trim().slice(0, 60);
    this.eventEmitter.emit(NOTIFICATION_CREATE, {
      userIds: [authorUserId],
      type: 'NEW_MESSAGE',
      title: `${reactorName} reacted ${emoji}`,
      body: preview ? `Reacted to: "${preview}"` : 'Reacted to your message.',
      link: `/messages?thread=${threadId}`,
      notifyPreferenceKey: 'notifyMessages',
    } as NotificationCreateEvent);
  }

  /** Remove the caller's reaction from a message (idempotent). */
  async unreactMessage(threadId: string, messageId: string, actor: Actor) {
    await this.assertParticipant(threadId, actor.userId);
    await this.prisma.messageReaction.deleteMany({
      where: { messageId, userId: actor.userId },
    });
    return { messageId, removed: true };
  }

  private async notifyThreadRecipients(
    threadId: string,
    actor: Actor,
    preview: string,
  ) {
    const [participants, sender] = await Promise.all([
      this.prisma.threadParticipant.findMany({
        where: { threadId, userId: { not: actor.userId } },
        select: { userId: true },
      }),
      this.prisma.user.findUnique({
        where: { id: actor.userId },
        select: {
          fullName: true,
          email: true,
          studentProfile: { select: { fullName: true } },
          teacherProfile: { select: { fullName: true } },
          parentProfile: { select: { fullName: true } },
        },
      }),
    ]);
    const userIds = participants.map((p) => p.userId);
    if (!userIds.length) return;

    const senderName = sender ? resolveUserName(sender) : 'Someone';
    const event: NotificationCreateEvent = {
      userIds,
      type: 'NEW_MESSAGE',
      title: `New message from ${senderName}`,
      body: preview.length > 140 ? `${preview.slice(0, 137)}...` : preview,
      link: `/messages?thread=${threadId}`,
      notifyPreferenceKey: 'notifyMessages',
    };
    this.eventEmitter.emit(NOTIFICATION_CREATE, event);
  }

  async markRead(threadId: string, actor: Actor) {
    await this.assertParticipant(threadId, actor.userId);
    await this.prisma.threadParticipant.update({
      where: { threadId_userId: { threadId, userId: actor.userId } },
      data: { lastReadAt: new Date() },
    });
    return { threadId, readAt: new Date() };
  }

  // ---- attachments (presigned upload) ------------------------------------

  async presignAttachment(
    threadId: string,
    dto: PresignAttachmentDto,
    actor: Actor,
  ) {
    await this.assertParticipant(threadId, actor.userId);
    assertAttachmentAllowed({
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
    });

    const safeName = dto.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = await this.s3.keyFor(
      actor.schoolId,
      'messages',
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
}
