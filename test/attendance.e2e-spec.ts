import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass, addSecondSubject } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

const DATE = '2026-03-02';

describe('Attendance (e2e)', () => {
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

  const markBody = (
    sectionSubjectId: string,
    entries: Array<{ studentId: string; status: string }>,
    period?: number,
  ) => ({
    sectionSubjectId,
    date: DATE,
    ...(period ? { period } : {}),
    entries,
  });

  it("lets the subject's teacher mark, and rejects a different teacher", async () => {
    const cls = await seedClass({ studentCount: 2 });
    const teacherToken = await tokenFor(app, cls.teacherUser);

    const ok = await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send(
        markBody(cls.sectionSubject.id, [
          { studentId: cls.students[0].profile.id, status: 'PRESENT' },
          { studentId: cls.students[1].profile.id, status: 'ABSENT' },
        ]),
      );
    expect(ok.status).toBe(201);
    expect(ok.body.count).toBe(2);

    // A different teacher in the same school (teaches another subject) is denied.
    const other = await addSecondSubject(cls.school, cls.section.id);
    const otherToken = await tokenFor(app, other.otherTeacherUser);
    const denied = await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${otherToken}`)
      .send(
        markBody(cls.sectionSubject.id, [
          { studentId: cls.students[0].profile.id, status: 'PRESENT' },
        ]),
      );
    expect(denied.status).toBe(403);
  });

  it('enforces cross-school isolation on read and write', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const otherSchool = await createTestSchool();
    const adminB = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: otherSchool.id,
    });
    const adminBToken = await tokenFor(app, adminB);

    const read = await request(app.getHttpServer())
      .get(
        `/api/attendance/section-subject/${cls.sectionSubject.id}?date=${DATE}`,
      )
      .set('Authorization', `Bearer ${adminBToken}`);
    expect(read.status).toBe(403);

    const write = await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${adminBToken}`)
      .send(
        markBody(cls.sectionSubject.id, [
          { studentId: cls.students[0].profile.id, status: 'PRESENT' },
        ]),
      );
    expect(write.status).toBe(403);
  });

  it('scopes student/parent reads to own/linked children', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send(
        markBody(cls.sectionSubject.id, [
          { studentId: cls.students[0].profile.id, status: 'PRESENT' },
        ]),
      );

    // student 0 can read own, not student 1's
    const s0Token = await tokenFor(app, cls.students[0].user);
    const own = await request(app.getHttpServer())
      .get(`/api/attendance/student/${cls.students[0].profile.id}`)
      .set('Authorization', `Bearer ${s0Token}`);
    expect(own.status).toBe(200);
    const otherStudent = await request(app.getHttpServer())
      .get(`/api/attendance/student/${cls.students[1].profile.id}`)
      .set('Authorization', `Bearer ${s0Token}`);
    expect(otherStudent.status).toBe(403);

    // parent linked to student 0 only
    const parentUser = await createTestUser({
      role: Role.PARENT,
      schoolId: cls.school.id,
    });
    const parentProfile = await prisma.parentProfile.create({
      data: { userId: parentUser.id, fullName: 'Parent' },
    });
    await prisma.parentStudent.create({
      data: {
        parentId: parentProfile.id,
        studentId: cls.students[0].profile.id,
      },
    });
    const parentToken = await tokenFor(app, parentUser);
    const linked = await request(app.getHttpServer())
      .get(`/api/attendance/student/${cls.students[0].profile.id}`)
      .set('Authorization', `Bearer ${parentToken}`);
    expect(linked.status).toBe(200);
    const notLinked = await request(app.getHttpServer())
      .get(`/api/attendance/student/${cls.students[1].profile.id}`)
      .set('Authorization', `Bearer ${parentToken}`);
    expect(notLinked.status).toBe(403);
  });

  it('is per-period: present in one subject, absent in another the same day; re-mark upserts; double period adds a row', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const student = cls.students[0].profile;
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const second = await addSecondSubject(cls.school, cls.section.id);
    // enrol the student into the section already done by seedClass; second
    // subject is in the same section so the same enrolment applies.
    const otherToken = await tokenFor(app, second.otherTeacherUser);

    await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send(
        markBody(cls.sectionSubject.id, [
          { studentId: student.id, status: 'PRESENT' },
        ]),
      );
    await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${otherToken}`)
      .send(
        markBody(second.sectionSubject.id, [
          { studentId: student.id, status: 'ABSENT' },
        ]),
      );

    let rows = await prisma.attendance.findMany({
      where: { studentId: student.id },
    });
    expect(rows).toHaveLength(2); // one per subject, same date

    // Re-mark the first subject with a new status -> upsert, still one row.
    await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send(
        markBody(cls.sectionSubject.id, [
          { studentId: student.id, status: 'LATE' },
        ]),
      );
    rows = await prisma.attendance.findMany({
      where: { studentId: student.id, sectionSubjectId: cls.sectionSubject.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('LATE');

    // Double period: same subject, period 2 -> a distinct row.
    await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send(
        markBody(
          cls.sectionSubject.id,
          [{ studentId: student.id, status: 'PRESENT' }],
          2,
        ),
      );
    rows = await prisma.attendance.findMany({
      where: { studentId: student.id, sectionSubjectId: cls.sectionSubject.id },
    });
    expect(rows).toHaveLength(2); // period 1 (LATE) + period 2 (PRESENT)
  });

  it('rejects a batch containing a non-enrolled student without writing anything', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const teacherToken = await tokenFor(app, cls.teacherUser);

    const res = await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send(
        markBody(cls.sectionSubject.id, [
          { studentId: cls.students[0].profile.id, status: 'PRESENT' },
          {
            studentId: '00000000-0000-0000-0000-000000000000',
            status: 'ABSENT',
          },
        ]),
      );
    expect(res.status).toBe(400);

    const rows = await prisma.attendance.findMany();
    expect(rows).toHaveLength(0); // no half-marked class
  });

  it('summarizes the roster with per-student present rate (teacher class summary)', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const [s0, s1] = cls.students;

    // Day 1: s0 PRESENT, s1 ABSENT.
    await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send(
        markBody(cls.sectionSubject.id, [
          { studentId: s0.profile.id, status: 'PRESENT' },
          { studentId: s1.profile.id, status: 'ABSENT' },
        ]),
      );
    // Day 2: s0 LATE (counts as attended), s1 PRESENT.
    await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        sectionSubjectId: cls.sectionSubject.id,
        date: '2026-03-03',
        entries: [
          { studentId: s0.profile.id, status: 'LATE' },
          { studentId: s1.profile.id, status: 'PRESENT' },
        ],
      });

    const summary = await request(app.getHttpServer())
      .get(`/api/attendance/section-subject/${cls.sectionSubject.id}/summary`)
      .set('Authorization', `Bearer ${teacherToken}`);

    expect(summary.status).toBe(200);
    expect(summary.body.students).toHaveLength(2);
    const byId = new Map(
      summary.body.students.map((r: any) => [r.student.id, r]),
    );
    // s0: PRESENT + LATE over 2 -> rate 1.0
    expect(byId.get(s0.profile.id)).toMatchObject({
      present: 1,
      late: 1,
      total: 2,
      presentRate: 1,
    });
    // s1: PRESENT + ABSENT over 2 -> rate 0.5
    expect(byId.get(s1.profile.id)).toMatchObject({
      present: 1,
      absent: 1,
      total: 2,
      presentRate: 0.5,
    });

    // A teacher who does not teach this subject-class is denied.
    const other = await addSecondSubject(cls.school, cls.section.id);
    const otherToken = await tokenFor(app, other.otherTeacherUser);
    const denied = await request(app.getHttpServer())
      .get(`/api/attendance/section-subject/${cls.sectionSubject.id}/summary`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(denied.status).toBe(403);
  });

  it('computes period-based and daily attendance stats', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const student = cls.students[0].profile;
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const second = await addSecondSubject(cls.school, cls.section.id);
    const otherToken = await tokenFor(app, second.otherTeacherUser);

    // Same day: PRESENT in subject 1, ABSENT in subject 2.
    await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send(
        markBody(cls.sectionSubject.id, [
          { studentId: student.id, status: 'PRESENT' },
        ]),
      );
    await request(app.getHttpServer())
      .post('/api/attendance/mark')
      .set('Authorization', `Bearer ${otherToken}`)
      .send(
        markBody(second.sectionSubject.id, [
          { studentId: student.id, status: 'ABSENT' },
        ]),
      );

    const adminUser = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, adminUser);
    const stats = await request(app.getHttpServer())
      .get(`/api/attendance/student/${student.id}/stats`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(stats.status).toBe(200);
    expect(stats.body.periodBased).toMatchObject({
      total: 2,
      present: 1,
      absent: 1,
    });
    expect(stats.body.periodBased.presentRate).toBeCloseTo(0.5);
    // One day, and it had an absence -> 0 present days.
    expect(stats.body.daily).toMatchObject({ totalDays: 1, presentDays: 0 });

    // Per-subject breakdown: subject 1 fully present, subject 2 fully absent.
    expect(stats.body.bySubject).toHaveLength(2);
    const totals = stats.body.bySubject.map((s: any) => s.total);
    expect(totals).toEqual([1, 1]);
    const rates = stats.body.bySubject.map((s: any) => s.presentRate).sort();
    expect(rates).toEqual([0, 1]);
    const presentSum = stats.body.bySubject.reduce(
      (acc: number, s: any) => acc + s.present,
      0,
    );
    expect(presentSum).toBe(1);
    for (const s of stats.body.bySubject) {
      expect(typeof s.subjectId).toBe('string');
      expect(typeof s.subjectName).toBe('string');
    }
  });
});
