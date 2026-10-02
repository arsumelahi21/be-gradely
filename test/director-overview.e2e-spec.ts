import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser } from './utils/factories';
import { seedExamination } from './utils/exam-fixture';
import { Role } from '../src/common/types/role.type';

const DAY = 86_400_000;
let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

describe('Director overview (e2e)', () => {
  let app: INestApplication;
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  beforeEach(async () => {
    await resetDb();
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A branch with one enrolled student, one challan and (optionally) two attendance marks. */
  async function branch(
    name: string,
    currency: string,
    billed: number,
    paid: number,
  ) {
    const school = await createTestSchool({ name });
    await prisma.school.update({
      where: { id: school.id },
      data: { currency },
    });
    const year = await prisma.academicYear.create({
      data: {
        schoolId: school.id,
        name: `${name} now`,
        code: `AY${uniq()}`,
        startDate: new Date(today - 100 * DAY),
        endDate: new Date(today + 200 * DAY),
      },
    });
    const classGrade = await prisma.classGrade.create({
      data: { schoolId: school.id, name: 'Grade 1' },
    });
    const section = await prisma.section.create({
      data: { schoolId: school.id, classGradeId: classGrade.id, name: 'A' },
    });
    const student = await prisma.studentProfile.create({
      data: { schoolId: school.id, fullName: 'Kid' },
    });
    await prisma.enrollment.create({
      data: {
        studentId: student.id,
        sectionId: section.id,
        academicYearId: year.id,
        status: 'ACTIVE',
      },
    });
    const challan = await prisma.challan.create({
      data: {
        schoolId: school.id,
        challanNo: `C-${uniq()}`,
        studentId: student.id,
        academicYearId: year.id,
        periodYear: now.getUTCFullYear(),
        periodMonth: now.getUTCMonth() + 1,
        issueDate: new Date(today - 5 * DAY),
        dueDate: new Date(today + 5 * DAY),
        grossAmount: billed,
        netAmount: billed,
        paidAmount: paid,
        status: paid >= billed ? 'PAID' : 'PARTIALLY_PAID',
      },
    });
    await prisma.payment.create({
      data: {
        schoolId: school.id,
        challanId: challan.id,
        amount: paid,
        method: 'CASH',
        paidAt: new Date(Date.now() - 60_000),
      },
    });
    return { school, section, student, year };
  }

  it('gives each branch its figures with the period before, and never adds currencies together', async () => {
    const a = await branch('Alpha', 'PKR', 100_000, 50_000);
    const principal = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: a.school.id,
    });
    await prisma.auditLog.create({
      data: {
        actorUserId: principal.id,
        schoolId: a.school.id,
        action: 'LOGIN',
        createdAt: new Date(Date.now() - 20 * DAY),
      },
    });
    const subject = await prisma.subject.create({
      data: { schoolId: a.school.id, name: 'Maths' },
    });
    const ss = await prisma.sectionSubject.create({
      data: { sectionId: a.section.id, subjectId: subject.id },
    });
    // Pass rate: last session 1 of 1 passed, this one 0 of 1; a paper held 10 days ago is
    // 7+ days overdue but not yet 14.
    const lastYear = await prisma.academicYear.create({
      data: {
        schoolId: a.school.id,
        name: 'Alpha before',
        code: `AY${uniq()}`,
        startDate: new Date(today - 465 * DAY),
        endDate: new Date(today - 101 * DAY),
      },
    });
    const exam = (academicYearId: string, extra: object) =>
      seedExamination({
        schoolId: a.school.id,
        academicYearId,
        sectionId: a.section.id,
        sectionSubjectIds: [ss.id],
        ...extra,
      });
    for (const [ayId, passed] of [
      [lastYear.id, true],
      [a.year.id, false],
    ] as const) {
      const { examination } = await exam(ayId, { resultStatus: 'FINALIZED' });
      await prisma.examinationResult.create({
        data: {
          examinationId: examination.id,
          studentId: a.student.id,
          totalObtained: passed ? 80 : 20,
          totalMax: 100,
          passed,
          finalizedAt: new Date(),
        },
      });
    }
    await exam(a.year.id, {
      resultStatus: 'IN_PROGRESS',
      heldAt: new Date(today - 10 * DAY),
      title: 'Late',
    });

    // Two marks in the last 30 days, one in the 30 before.
    await prisma.attendance.createMany({
      data: (
        [
          ['PRESENT', 1],
          ['ABSENT', 2],
          ['PRESENT', 40],
        ] as const
      ).map(([status, daysAgo]) => ({
        schoolId: a.school.id,
        studentId: a.student.id,
        sectionSubjectId: ss.id,
        date: new Date(today - daysAgo * DAY),
        period: 1,
        status,
        markedByUserId: principal.id,
      })),
    });
    const parent = await createTestUser({
      role: Role.PARENT,
      schoolId: a.school.id,
    });
    await prisma.auditLog.createMany({
      data: [
        {
          actorUserId: parent.id,
          schoolId: a.school.id,
          action: 'LOGIN',
          createdAt: new Date(Date.now() - 3 * DAY),
        },
        {
          actorUserId: principal.id,
          schoolId: a.school.id,
          action: 'USER_DEACTIVATE',
          entityType: 'User',
          entityId: 'teacher-1',
          metadata: { role: Role.TEACHER },
          createdAt: new Date(Date.now() - 2 * DAY),
        },
      ],
    });

    const b = await branch('Bravo', 'AED', 20_000, 20_000);
    const c = await createTestSchool({ name: 'Charlie' });

    const group = await prisma.schoolGroup.create({ data: { name: 'G' } });
    await prisma.school.updateMany({
      where: { id: { in: [a.school.id, b.school.id, c.id] } },
      data: { groupId: group.id },
    });
    const director = await createTestUser({
      role: Role.DIRECTOR,
      groupId: group.id,
    });
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: director.email, password: director.password });
    const res = await request(app.getHttpServer())
      .get('/api/director/insights/overview?preset=7d')
      .set({ Authorization: `Bearer ${login.body.accessToken}` });
    expect(res.status).toBe(200);

    const row = (id: string) =>
      res.body.branches.find((r: any) => r.schoolId === id);
    expect(row(a.school.id).data).toMatchObject({
      currency: 'PKR',
      enrolled: 1,
      attendance: {
        now: { num: 1, den: 2, value: 0.5 },
        prev: { num: 1, den: 1, value: 1 },
      },
      pass: {
        now: { num: 0, den: 1, value: 0 },
        prev: { num: 1, den: 1, value: 1 },
      },
      collectionRate: { num: 50_000, den: 100_000, value: 0.5 },
      pace: { now: { value: 0.5 }, prev: { den: 0, value: null } },
      overdue: 0,
      registers: { silent3: 0, silent5: 0, of: 1 },
      exams: { reviewWaitingDays: null, overdue7: 1, overdue14: 0 },
      parents: { now: { num: 1, den: 1 }, prev: { num: 0, den: 1 } },
      teacherLeavers: 1,
      principal: { active: 1, daysSinceLogin: 20 },
    });
    expect(row(a.school.id).data.timetable).toMatchObject({
      published: 0,
      sessionDays: 100,
    });
    expect(row(b.school.id).data).toMatchObject({
      registers: { silent3: 1, silent5: 1, of: 1 },
      teacherLeavers: 0,
      principal: { active: 0, daysSinceLogin: null },
    });
    expect(row(c.id)).toMatchObject({
      status: 'no_year',
      data: { enrolled: null, collectionRate: null, registers: null },
    });

    expect(res.body.group).toEqual({
      enrolled: 2,
      attendance: {
        now: { num: 1, den: 2, value: 0.5 },
        prev: { num: 1, den: 1, value: 1 },
      },
      pass: {
        now: { num: 0, den: 1, value: 0 },
        prev: { num: 1, den: 1, value: 1 },
      },
      // PKR 50% and AED 100%: each branch counts once, amounts are never pooled.
      collection: { average: 0.75, branches: 2, paceNow: 0.75, pacePrev: null },
    });
    // The overview always reads the last 30 days; a range filter does not change it.
    expect(res.body.window.preset).toBe('30d');
  });
});
