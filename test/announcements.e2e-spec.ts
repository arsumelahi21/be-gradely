import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';
import { AnnouncementsService } from '../src/announcements/announcements.service';

describe('Announcements (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDb();
  });

  const listAs = (token: string) =>
    request(app.getHttpServer())
      .get('/api/announcements')
      .set('Authorization', `Bearer ${token}`);

  it('makes a SCHOOL announcement visible in-school but not to another school', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);

    const created = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Snow day',
        body: 'No classes tomorrow',
        targets: [{ kind: 'SCHOOL' }],
      });
    expect(created.status).toBe(201);

    const studentToken = await tokenFor(app, cls.students[0].user);
    const studentFeed = await listAs(studentToken);
    expect(studentFeed.body.items.map((a: any) => a.id)).toContain(
      created.body.id,
    );

    // A user from another school never sees it.
    const otherSchool = await createTestSchool();
    const foreigner = await createTestUser({
      role: Role.TEACHER,
      schoolId: otherSchool.id,
    });
    const foreignFeed = await listAs(await tokenFor(app, foreigner));
    expect(foreignFeed.body.items).toHaveLength(0);
  });

  it('scopes a SECTION announcement to that section only', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const teacherToken = await tokenFor(app, cls.teacherUser);

    const created = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        title: 'Bring textbooks',
        body: 'Chapter 4 tomorrow',
        targets: [{ kind: 'SECTION', refId: cls.section.id }],
      });
    expect(created.status).toBe(201);

    // Enrolled student sees it.
    const enrolled = await listAs(await tokenFor(app, cls.students[0].user));
    expect(enrolled.body.items.map((a: any) => a.id)).toContain(
      created.body.id,
    );

    // A student in the same school but a DIFFERENT section does not.
    const otherSection = await prisma.section.create({
      data: {
        schoolId: cls.school.id,
        classGradeId: cls.classGrade.id,
        name: `Sec-B-${Date.now()}`,
      },
    });
    const otherUser = await createTestUser({
      role: Role.STUDENT,
      schoolId: cls.school.id,
    });
    const otherProfile = await prisma.studentProfile.create({
      data: {
        userId: otherUser.id,
        schoolId: cls.school.id,
        fullName: 'Other',
      },
    });
    await prisma.enrollment.create({
      data: {
        studentId: otherProfile.id,
        sectionId: otherSection.id,
        academicYearId: cls.academicYear.id,
        status: 'ACTIVE',
      },
    });
    const outsider = await listAs(await tokenFor(app, otherUser));
    expect(outsider.body.items.map((a: any) => a.id)).not.toContain(
      created.body.id,
    );
  });

  it('rejects a teacher posting a SCHOOL-wide announcement', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const res = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${await tokenFor(app, cls.teacherUser)}`)
      .send({ title: 'x', body: 'y', targets: [{ kind: 'SCHOOL' }] });
    expect(res.status).toBe(403);
  });

  it('hides a future-publishAt announcement from the feed until it is due', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const created = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Later',
        body: 'Scheduled',
        targets: [{ kind: 'SCHOOL' }],
        publishAt: future,
      });
    expect(created.status).toBe(201);

    // Invisible to a student now.
    const studentFeed = await listAs(await tokenFor(app, cls.students[0].user));
    expect(studentFeed.body.items.map((a: any) => a.id)).not.toContain(
      created.body.id,
    );
  });

  it('lets only the author or a school admin edit/delete', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const created = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        title: 'Mine',
        body: 'b',
        targets: [{ kind: 'SECTION', refId: cls.section.id }],
      });

    // A different teacher in the same school cannot edit it.
    const stranger = await createTestUser({
      role: Role.TEACHER,
      schoolId: cls.school.id,
    });
    const strangerEdit = await request(app.getHttpServer())
      .patch(`/api/announcements/${created.body.id}`)
      .set('Authorization', `Bearer ${await tokenFor(app, stranger)}`)
      .send({ title: 'hijacked' });
    expect(strangerEdit.status).toBe(403);

    // The author can.
    const authorEdit = await request(app.getHttpServer())
      .patch(`/api/announcements/${created.body.id}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ title: 'Updated' });
    expect(authorEdit.status).toBe(200);
    expect(authorEdit.body.title).toBe('Updated');
  });

  it('does NOT push announcements to the bell (unlinked); scheduled stays unpublished', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);

    // Immediate announcement → recipients get NO bell notification; announcements have their own
    // dashboard container, deliberately unlinked from the bell (no NEW_ANNOUNCEMENT rows created).
    await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Now', body: 'immediate', targets: [{ kind: 'SCHOOL' }] });

    // Give any stray async listener a beat, then assert nothing landed.
    await new Promise((r) => setTimeout(r, 250));
    expect(
      await prisma.notification.count({ where: { type: 'NEW_ANNOUNCEMENT' } }),
    ).toBe(0);

    // Scheduled → publishedNotified stays false until the cron publishes it.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Later',
        body: 'scheduled',
        targets: [{ kind: 'SCHOOL' }],
        publishAt: future,
      });
    const row = await prisma.announcement.findUnique({
      where: { id: scheduled.body.id },
    });
    expect(row?.publishedNotified).toBe(false);
  });

  it('publishes a due scheduled announcement exactly once (idempotent)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const scheduled = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Later',
        body: 'scheduled',
        targets: [{ kind: 'SCHOOL' }],
        publishAt: future,
      });

    // Time arrives.
    await prisma.announcement.update({
      where: { id: scheduled.body.id },
      data: { publishAt: new Date(Date.now() - 1000) },
    });

    // First tick publishes it and flips the guard flag.
    const service = app.get(AnnouncementsService);
    expect(await service.publishDueScheduledAnnouncements()).toBe(1);
    const after = await prisma.announcement.findUnique({
      where: { id: scheduled.body.id },
    });
    expect(after?.publishedNotified).toBe(true);

    // A second tick claims nothing — the flag prevents a double-publish.
    expect(await service.publishDueScheduledAnnouncements()).toBe(0);
  });

  it('carries a type and per-user read state (unread → mark read)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });

    const created = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${await tokenFor(app, admin)}`)
      .send({
        title: 'Exam week',
        body: 'Full body.',
        targets: [{ kind: 'SCHOOL' }],
        type: 'IMPORTANT',
      });
    expect(created.status).toBe(201);
    expect(created.body.type).toBe('IMPORTANT');

    const studentToken = await tokenFor(app, cls.students[0].user);
    const feed1 = await listAs(studentToken);
    const item = feed1.body.items.find((a: any) => a.id === created.body.id);
    expect(item.type).toBe('IMPORTANT');
    expect(item.isRead).toBe(false);
    const unreadBefore = feed1.body.unread;
    expect(unreadBefore).toBeGreaterThanOrEqual(1);

    const read = await request(app.getHttpServer())
      .patch(`/api/announcements/${created.body.id}/read`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(read.status).toBe(200);

    const feed2 = await listAs(studentToken);
    expect(
      feed2.body.items.find((a: any) => a.id === created.body.id).isRead,
    ).toBe(true);
    expect(feed2.body.unread).toBe(unreadBefore - 1);

    const uc = await request(app.getHttpServer())
      .get('/api/announcements/unread-count')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(uc.body.unread).toBe(feed2.body.unread);
  });

  it("mark-all-read clears only the caller's unread", async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);
    for (const type of ['URGENT', 'GENERAL']) {
      await request(app.getHttpServer())
        .post('/api/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: `A ${type}`,
          body: 'b',
          targets: [{ kind: 'SCHOOL' }],
          type,
        });
    }
    const studentToken = await tokenFor(app, cls.students[0].user);

    const all = await request(app.getHttpServer())
      .patch('/api/announcements/read-all')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(all.status).toBe(200);
    expect(all.body.updated).toBeGreaterThanOrEqual(2);
    expect((await listAs(studentToken)).body.unread).toBe(0);

    // The teacher (also a recipient) is untouched.
    expect(
      (await listAs(await tokenFor(app, cls.teacherUser))).body.unread,
    ).toBeGreaterThanOrEqual(2);
  });

  it("dismiss removes an announcement from that user's feed only", async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const created = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${await tokenFor(app, admin)}`)
      .send({ title: 'Dismiss me', body: 'b', targets: [{ kind: 'SCHOOL' }] });

    const studentToken = await tokenFor(app, cls.students[0].user);
    const dis = await request(app.getHttpServer())
      .patch('/api/announcements/dismiss')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ ids: [created.body.id] });
    expect(dis.status).toBe(200);
    expect(dis.body.dismissed).toBe(1);

    expect(
      (await listAs(studentToken)).body.items.map((a: any) => a.id),
    ).not.toContain(created.body.id);
    // Teacher still sees it.
    expect(
      (await listAs(await tokenFor(app, cls.teacherUser))).body.items.map(
        (a: any) => a.id,
      ),
    ).toContain(created.body.id);
  });

  it('an ALL_TEACHERS announcement reaches teachers, not students', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const created = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${await tokenFor(app, admin)}`)
      .send({
        title: 'Staff only',
        body: 'b',
        targets: [{ kind: 'ALL_TEACHERS' }],
      });
    expect(created.status).toBe(201);
    expect(created.body.targets.map((t: any) => t.kind)).toContain(
      'ALL_TEACHERS',
    );

    expect(
      (await listAs(await tokenFor(app, cls.teacherUser))).body.items.map(
        (a: any) => a.id,
      ),
    ).toContain(created.body.id);
    expect(
      (await listAs(await tokenFor(app, cls.students[0].user))).body.items.map(
        (a: any) => a.id,
      ),
    ).not.toContain(created.body.id);
  });

  it('a CLASS announcement reaches students enrolled in that grade', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const created = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${await tokenFor(app, admin)}`)
      .send({
        title: 'Grade note',
        body: 'b',
        targets: [{ kind: 'CLASS', refId: cls.classGrade.id }],
      });
    expect(created.status).toBe(201);
    expect(
      (await listAs(await tokenFor(app, cls.students[0].user))).body.items.map(
        (a: any) => a.id,
      ),
    ).toContain(created.body.id);
  });

  it('teachers may target only their own sections', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const teacherToken = await tokenFor(app, cls.teacherUser);

    for (const targets of [
      [{ kind: 'ALL_STUDENTS' }],
      [{ kind: 'SCHOOL' }],
      [{ kind: 'CLASS', refId: cls.classGrade.id }],
    ]) {
      const res = await request(app.getHttpServer())
        .post('/api/announcements')
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ title: 'x', body: 'y', targets });
      expect(res.status).toBe(403);
    }

    const ok = await request(app.getHttpServer())
      .post('/api/announcements')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        title: 'Mine',
        body: 'b',
        targets: [{ kind: 'SECTION', refId: cls.section.id }],
      });
    expect(ok.status).toBe(201);
  });
});
