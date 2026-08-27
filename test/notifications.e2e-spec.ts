import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';
import { NotificationsService } from '../src/notifications/notifications.service';
import { EmailService } from '../src/notifications/email/email.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NOTIFICATION_CREATE } from '../src/common/events/notification.events';
import { AssignmentsService } from '../src/assignments/assignments.service';
import { ExamsService } from '../src/exams/exams.service';
import { AttendanceService } from '../src/attendance/attendance.service';
import { seedClass } from './utils/class-fixture';

/** The NOTIFICATION_CREATE events a spied emitter captured. */
function notifEvents(spy: jest.SpyInstance): any[] {
  return spy.mock.calls
    .filter((c) => c[0] === NOTIFICATION_CREATE)
    .map((c) => c[1]);
}

describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let schoolId: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDb();
    schoolId = (await createTestSchool()).id;
  });

  it('fans out one in-app row per recipient (batched createMany)', async () => {
    const users = await Promise.all(
      [0, 1, 2, 3].map(() => createTestUser({ role: Role.STUDENT, schoolId })),
    );
    const service = app.get(NotificationsService);

    await service.handleNotificationCreate({
      userIds: users.map((u) => u.id),
      type: 'NEW_ANNOUNCEMENT',
      title: 'Hello',
      body: 'Body',
      notifyPreferenceKey: 'notifyAnnouncements',
    });

    // Row count equals recipient count.
    expect(await prisma.notification.count()).toBe(4);
  });

  it('gates in-app and email rows per user preferences', async () => {
    const u1 = await createTestUser({ role: Role.STUDENT, schoolId }); // defaults: all on
    const u2 = await createTestUser({ role: Role.STUDENT, schoolId }); // email master off
    const u3 = await createTestUser({ role: Role.STUDENT, schoolId }); // this category off
    const u4 = await createTestUser({ role: Role.STUDENT, schoolId }); // in-app master off
    await prisma.userSettings.create({
      data: { userId: u2.id, emailNotifications: false },
    });
    await prisma.userSettings.create({
      data: { userId: u3.id, notifyAnnouncements: false },
    });
    await prisma.userSettings.create({
      data: { userId: u4.id, inAppNotifications: false },
    });

    const email = app.get(EmailService);
    const spy = jest.spyOn(email, 'send').mockResolvedValue();

    const service = app.get(NotificationsService);
    await service.handleNotificationCreate({
      userIds: [u1.id, u2.id, u3.id, u4.id],
      type: 'NEW_ANNOUNCEMENT',
      title: 'T',
      body: 'B',
      notifyPreferenceKey: 'notifyAnnouncements',
    });

    // In-app rows: only recipients whose in-app master AND this category are on.
    const inAppUserIds = (
      await prisma.notification.findMany({ select: { userId: true } })
    ).map((n) => n.userId);
    expect(inAppUserIds).toContain(u1.id); // all on
    expect(inAppUserIds).toContain(u2.id); // email off doesn't affect in-app
    expect(inAppUserIds).not.toContain(u3.id); // category off => no in-app
    expect(inAppUserIds).not.toContain(u4.id); // in-app master off
    expect(inAppUserIds).toHaveLength(2);

    // Email: independent master; category gates it too. u4 keeps email (only in-app off).
    const emailedTo = spy.mock.calls.map((c) => c[0].to);
    expect(emailedTo).toContain(u1.email);
    expect(emailedTo).not.toContain(u2.email); // email master off
    expect(emailedTo).not.toContain(u3.email); // category off
    expect(emailedTo).toContain(u4.email); // in-app off but email allowed
    spy.mockRestore();
  });

  it('only returns the caller’s own notifications', async () => {
    const u1 = await createTestUser({ role: Role.STUDENT, schoolId });
    const u2 = await createTestUser({ role: Role.STUDENT, schoolId });
    await prisma.notification.createMany({
      data: [
        { userId: u1.id, type: 'NEW_MESSAGE', title: 'a', body: 'a' },
        { userId: u1.id, type: 'NEW_MESSAGE', title: 'b', body: 'b' },
        { userId: u2.id, type: 'NEW_MESSAGE', title: 'c', body: 'c' },
      ],
    });

    const res = await request(app.getHttpServer())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${await tokenFor(app, u1)}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.unread).toBe(2);
    expect(res.body.items.every((n: any) => n.userId === u1.id)).toBe(true);
  });

  it('marks one and all as read, and blocks marking someone else’s', async () => {
    const u1 = await createTestUser({ role: Role.STUDENT, schoolId });
    const u2 = await createTestUser({ role: Role.STUDENT, schoolId });
    const mine = await prisma.notification.create({
      data: { userId: u1.id, type: 'NEW_MESSAGE', title: 'a', body: 'a' },
    });
    const theirs = await prisma.notification.create({
      data: { userId: u2.id, type: 'NEW_MESSAGE', title: 'c', body: 'c' },
    });
    const u1Token = await tokenFor(app, u1);

    const readMine = await request(app.getHttpServer())
      .patch(`/api/notifications/${mine.id}/read`)
      .set('Authorization', `Bearer ${u1Token}`);
    expect(readMine.status).toBe(200);
    expect(readMine.body.isRead).toBe(true);

    const readTheirs = await request(app.getHttpServer())
      .patch(`/api/notifications/${theirs.id}/read`)
      .set('Authorization', `Bearer ${u1Token}`);
    expect(readTheirs.status).toBe(403);

    // read-all clears the caller's remaining unread.
    await prisma.notification.create({
      data: { userId: u1.id, type: 'NEW_MESSAGE', title: 'd', body: 'd' },
    });
    const readAll = await request(app.getHttpServer())
      .patch('/api/notifications/read-all')
      .set('Authorization', `Bearer ${u1Token}`);
    expect(readAll.status).toBe(200);
    const count = await request(app.getHttpServer())
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${u1Token}`);
    expect(count.body.unread).toBe(0);
  });

  it('excludes legacy announcement notifications from the bell', async () => {
    const u = await createTestUser({ role: Role.STUDENT, schoolId });
    await prisma.notification.createMany({
      data: [
        { userId: u.id, type: 'NEW_ANNOUNCEMENT', title: 'ann', body: 'x' },
        { userId: u.id, type: 'NEW_MESSAGE', title: 'msg', body: 'y' },
      ],
    });
    const token = await tokenFor(app, u);
    const list = await request(app.getHttpServer())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);
    expect(list.body.total).toBe(1);
    expect(
      list.body.items.every((n: any) => n.type !== 'NEW_ANNOUNCEMENT'),
    ).toBe(true);
    const count = await request(app.getHttpServer())
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${token}`);
    expect(count.body.unread).toBe(1);
  });

  it('bulk-marks the given ids read (own rows only)', async () => {
    const u1 = await createTestUser({ role: Role.STUDENT, schoolId });
    const u2 = await createTestUser({ role: Role.STUDENT, schoolId });
    const mk = (userId: string, title: string) =>
      prisma.notification.create({
        data: { userId, type: 'NEW_MESSAGE', title, body: title },
      });
    const a = await mk(u1.id, 'a');
    const b = await mk(u1.id, 'b');
    const c = await mk(u1.id, 'c');
    const theirs = await mk(u2.id, 'd');

    const res = await request(app.getHttpServer())
      .patch('/api/notifications/read')
      .set('Authorization', `Bearer ${await tokenFor(app, u1)}`)
      .send({ ids: [a.id, b.id, theirs.id] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2); // theirs ignored (not owned)

    const isRead = async (id: string) =>
      (await prisma.notification.findUnique({ where: { id } }))!.isRead;
    expect(await isRead(a.id)).toBe(true);
    expect(await isRead(c.id)).toBe(false);
    expect(await isRead(theirs.id)).toBe(false);
  });

  it('notifies enrolled students when an assignment is published', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const assignment = await prisma.assignment.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: cls.academicYear.id,
        sectionSubjectId: cls.sectionSubject.id,
        createdByTeacherId: cls.teacherProfile.id,
        title: 'HW1',
        status: 'DRAFT',
      },
    });
    // Mock (no pass-through) — assert the producer emits; skip the async listener.
    const spy = jest
      .spyOn(app.get(EventEmitter2), 'emit')
      .mockReturnValue(true);
    await app.get(AssignmentsService).publish(assignment.id, {
      userId: cls.teacherUser.id,
      role: Role.TEACHER,
      schoolId: cls.school.id,
    } as any);
    const ev = notifEvents(spy).find((e) => e.type === 'ASSIGNMENT_PUBLISHED');
    expect(ev).toBeDefined();
    expect(ev.userIds).toEqual(
      expect.arrayContaining(cls.students.map((s) => s.user.id)),
    );
    spy.mockRestore();
  });

  it('notifies the student + parent when attendance is marked', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const s0 = cls.students[0];
    const parentUser = await createTestUser({
      role: Role.PARENT,
      schoolId: cls.school.id,
    });
    const parentProfile = await prisma.parentProfile.create({
      data: { userId: parentUser.id, fullName: 'Parent' },
    });
    await prisma.parentStudent.create({
      data: { parentId: parentProfile.id, studentId: s0.profile.id },
    });

    // Mock (no pass-through) — assert the producer emits; skip the async listener.
    const spy = jest
      .spyOn(app.get(EventEmitter2), 'emit')
      .mockReturnValue(true);
    await app.get(AttendanceService).mark(
      {
        sectionSubjectId: cls.sectionSubject.id,
        date: '2026-07-20',
        period: 1,
        entries: [{ studentId: s0.profile.id, status: 'ABSENT' }],
      } as any,
      {
        userId: cls.teacherUser.id,
        role: Role.TEACHER,
        schoolId: cls.school.id,
      } as any,
    );
    const ev = notifEvents(spy).find((e) => e.type === 'ATTENDANCE_MARKED');
    expect(ev).toBeDefined();
    expect(ev.userIds).toEqual(
      expect.arrayContaining([s0.user.id, parentUser.id]),
    );
    expect(ev.notifyPreferenceKey).toBe('notifyAttendance');
    spy.mockRestore();
  });

  it('notifies the student + parent when exam marks are registered', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const s0 = cls.students[0];
    const parentUser = await createTestUser({
      role: Role.PARENT,
      schoolId: cls.school.id,
    });
    const parentProfile = await prisma.parentProfile.create({
      data: { userId: parentUser.id, fullName: 'Parent' },
    });
    await prisma.parentStudent.create({
      data: { parentId: parentProfile.id, studentId: s0.profile.id },
    });
    const exam = await prisma.exam.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: cls.academicYear.id,
        sectionSubjectId: cls.sectionSubject.id,
        createdByTeacherId: cls.teacherProfile.id,
        title: 'Midterm',
        status: 'PUBLISHED',
        maxScore: 100,
      },
    });

    // Mock (no pass-through) — assert the producer emits; skip the async listener.
    const spy = jest
      .spyOn(app.get(EventEmitter2), 'emit')
      .mockReturnValue(true);
    await app.get(ExamsService).markResult(
      exam.id,
      { studentId: s0.profile.id, score: 88 } as any,
      {
        userId: cls.teacherUser.id,
        role: Role.TEACHER,
        schoolId: cls.school.id,
      } as any,
    );
    const ev = notifEvents(spy).find((e) => e.type === 'EXAM_RESULT');
    expect(ev).toBeDefined();
    expect(ev.userIds).toEqual(
      expect.arrayContaining([s0.user.id, parentUser.id]),
    );
    spy.mockRestore();
  });

  it('dismisses notifications (own rows only), removing just the row', async () => {
    const u1 = await createTestUser({ role: Role.STUDENT, schoolId });
    const u2 = await createTestUser({ role: Role.STUDENT, schoolId });
    const mk = (userId: string, t: string) =>
      prisma.notification.create({
        data: { userId, type: 'NEW_MESSAGE', title: t, body: t },
      });
    const a = await mk(u1.id, 'a');
    const b = await mk(u1.id, 'b');
    const c = await mk(u1.id, 'c');
    const theirs = await mk(u2.id, 'd');
    const token = await tokenFor(app, u1);

    const one = await request(app.getHttpServer())
      .delete(`/api/notifications/${a.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(one.status).toBe(200);
    expect(
      await prisma.notification.findUnique({ where: { id: a.id } }),
    ).toBeNull();

    // Bulk dismiss (a category "clear all") — ignores another user's id.
    const many = await request(app.getHttpServer())
      .delete('/api/notifications')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [b.id, theirs.id] });
    expect(many.status).toBe(200);
    expect(many.body.dismissed).toBe(1); // only b (owned)
    expect(
      await prisma.notification.findUnique({ where: { id: b.id } }),
    ).toBeNull();
    expect(
      await prisma.notification.findUnique({ where: { id: c.id } }),
    ).not.toBeNull();
    expect(
      await prisma.notification.findUnique({ where: { id: theirs.id } }),
    ).not.toBeNull();
  });

  it('scopes the bell to notifications since the given timestamp', async () => {
    const u = await createTestUser({ role: Role.STUDENT, schoolId });
    await prisma.notification.create({
      data: {
        userId: u.id,
        type: 'NEW_MESSAGE',
        title: 'old',
        body: 'old',
        createdAt: new Date('2020-01-01T00:00:00Z'),
      },
    });
    await prisma.notification.create({
      data: { userId: u.id, type: 'NEW_MESSAGE', title: 'new', body: 'new' },
    });
    const token = await tokenFor(app, u);
    const since = new Date('2021-01-01T00:00:00Z').toISOString();

    const list = await request(app.getHttpServer())
      .get('/api/notifications')
      .query({ since })
      .set('Authorization', `Bearer ${token}`);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].title).toBe('new');

    const count = await request(app.getHttpServer())
      .get('/api/notifications/unread-count')
      .query({ since })
      .set('Authorization', `Bearer ${token}`);
    expect(count.body.unread).toBe(1);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app.getHttpServer()).get('/api/notifications');
    expect(res.status).toBe(401);
  });
});
