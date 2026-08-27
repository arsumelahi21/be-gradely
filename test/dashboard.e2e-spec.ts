import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * School-admin dashboard metrics (GET /api/dashboard/school-stats); risks are
 * incorrect per-student aggregation and cross-school data leakage.
 */
describe('Dashboard school stats (e2e)', () => {
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

  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`);

  it('aggregates gender, high/low performers, at-risk, admissions and class size', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const [a, b] = cls.students;

    // Demographics + a new admission this calendar year.
    await prisma.studentProfile.update({
      where: { id: a.profile.id },
      data: { gender: 'MALE', dateOfJoining: new Date() },
    });
    await prisma.studentProfile.update({
      where: { id: b.profile.id },
      data: { gender: 'FEMALE' },
    });

    // Exam out of 100: A averages 95 (high achiever), B averages 30 (< pass).
    const exam = await prisma.exam.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: cls.academicYear.id,
        sectionSubjectId: cls.sectionSubject.id,
        createdByTeacherId: cls.teacherProfile.id,
        title: 'Exam',
        status: 'PUBLISHED',
        maxScore: 100,
      },
    });
    await prisma.examResult.createMany({
      data: [
        { examId: exam.id, studentId: a.profile.id, score: 95 },
        { examId: exam.id, studentId: b.profile.id, score: 30 },
      ],
    });

    // A: one ABSENT → 0% attended → at risk. B: one PRESENT → not at risk.
    await prisma.attendance.createMany({
      data: [
        {
          schoolId: cls.school.id,
          studentId: a.profile.id,
          sectionSubjectId: cls.sectionSubject.id,
          date: new Date('2026-07-20'),
          period: 1,
          status: 'ABSENT',
          markedByUserId: cls.teacherUser.id,
        },
        {
          schoolId: cls.school.id,
          studentId: b.profile.id,
          sectionSubjectId: cls.sectionSubject.id,
          date: new Date('2026-07-20'),
          period: 1,
          status: 'PRESENT',
          markedByUserId: cls.teacherUser.id,
        },
      ],
    });

    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);

    const res = await get('/api/dashboard/school-stats', token);
    expect(res.status).toBe(200);
    expect(res.body.schoolId).toBe(cls.school.id);
    expect(res.body.totalStudents).toBe(2);
    expect(res.body.gender).toEqual({
      male: 1,
      female: 1,
      other: 0,
      unspecified: 0,
    });
    expect(res.body.highAchievers).toBe(1);
    expect(res.body.lowPerformers).toBe(1);
    expect(res.body.gradedStudents).toBe(2);
    expect(res.body.passPercent).toBe(40);
    expect(res.body.atRiskAttendance).toBe(1);
    expect(res.body.newAdmissions).toBe(1);
    expect(res.body.avgClassSize).toBe(2); // 2 enrolled / 1 section
  });

  it("a school admin's stats never include another school's data", async () => {
    const cls = await seedClass({ studentCount: 2 });
    await prisma.studentProfile.update({
      where: { id: cls.students[0].profile.id },
      data: { gender: 'MALE' },
    });

    const otherSchool = await createTestSchool();
    const otherAdmin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: otherSchool.id,
    });
    const token = await tokenFor(app, otherAdmin);

    const res = await get('/api/dashboard/school-stats', token);
    expect(res.status).toBe(200);
    expect(res.body.schoolId).toBe(otherSchool.id);
    expect(res.body.totalStudents).toBe(0);
    expect(res.body.gender).toEqual({
      male: 0,
      female: 0,
      other: 0,
      unspecified: 0,
    });
    expect(res.body.highAchievers).toBe(0);
    expect(res.body.avgClassSize).toBe(0);
  });

  it('rejects a teacher (admins only)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);
    const res = await get('/api/dashboard/school-stats', token);
    expect(res.status).toBe(403);
  });
});
