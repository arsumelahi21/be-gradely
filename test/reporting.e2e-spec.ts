import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * Reporting aggregates (Phase 4.1); main risk is cross-role/cross-school
 * leakage — teacher sees only their sections, principal only their school.
 */
describe('Reporting aggregates (e2e)', () => {
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

  /**
   * UTC midnight today. `getSchoolStats` defaults to a trailing 30-day window
   * (`today - 29 days`), so a hard-coded date silently drops out of range as
   * the clock moves on — which is exactly how this suite started failing.
   */
  function todayUtc(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }

  /** Two PRESENT attendance rows (one per student), dated inside that window. */
  async function markPresent(cls: Awaited<ReturnType<typeof seedClass>>) {
    for (const s of cls.students) {
      await prisma.attendance.create({
        data: {
          schoolId: cls.school.id,
          studentId: s.profile.id,
          sectionSubjectId: cls.sectionSubject.id,
          date: todayUtc(),
          period: 1,
          status: 'PRESENT',
          markedByUserId: cls.teacherUser.id,
        },
      });
    }
  }

  it('teacher summary reflects only their own sections', async () => {
    const cls = await seedClass({ studentCount: 2 });
    await markPresent(cls);
    const token = await tokenFor(app, cls.teacherUser);

    const res = await get('/api/attendance/teacher/summary', token);
    expect(res.status).toBe(200);
    expect(res.body.sections).toHaveLength(1);
    expect(res.body.overall.total).toBe(2);
    expect(res.body.overall.present).toBe(2);
    expect(res.body.overall.presentRate).toBe(1);
  });

  it('principal school summary reflects the whole school', async () => {
    const cls = await seedClass({ studentCount: 2 });
    await markPresent(cls);
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);

    const res = await get('/api/attendance/school/summary', token);
    expect(res.status).toBe(200);
    expect(res.body.range.total).toBe(2);
    expect(res.body.range.presentRate).toBe(1);
  });

  it("a school admin's stats never include another school's data", async () => {
    const cls = await seedClass({ studentCount: 2 });
    await markPresent(cls);

    // A different school with its own admin — must see zero rows from cls.
    const otherSchool = await createTestSchool();
    const otherAdmin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: otherSchool.id,
    });
    const token = await tokenFor(app, otherAdmin);

    const res = await get('/api/attendance/school/summary', token);
    expect(res.status).toBe(200);
    expect(res.body.schoolId).toBe(otherSchool.id);
    expect(res.body.range.total).toBe(0);
  });

  it('exam + assignment school stats aggregate the seeded data', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);

    // One published exam with a graded result (50/100).
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
    await prisma.examResult.create({
      data: {
        examId: exam.id,
        studentId: cls.students[0].profile.id,
        score: 50,
      },
    });

    const examRes = await get('/api/exams/school/stats', token);
    expect(examRes.status).toBe(200);
    expect(examRes.body.averageScorePercent).toBe(50);

    // One published assignment; 1 of 2 enrolled students submitted.
    const assignment = await prisma.assignment.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: cls.academicYear.id,
        sectionSubjectId: cls.sectionSubject.id,
        createdByTeacherId: cls.teacherProfile.id,
        title: 'HW',
        status: 'PUBLISHED',
      },
    });
    await prisma.assignmentSubmission.create({
      data: {
        assignmentId: assignment.id,
        studentId: cls.students[0].profile.id,
        status: 'SUBMITTED',
        s3Key: 'x',
        submittedAt: new Date(),
      },
    });

    const aRes = await get('/api/assignments/school/stats', token);
    expect(aRes.status).toBe(200);
    expect(aRes.body.expected).toBe(2);
    expect(aRes.body.submitted).toBe(1);
    expect(aRes.body.completionRate).toBe(0.5);
  });

  it('rejects a student hitting the school summary', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.students[0].user);
    const res = await get('/api/attendance/school/summary', token);
    expect(res.status).toBe(403);
  });
});
