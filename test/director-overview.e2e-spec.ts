import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser } from './utils/factories';
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
    await prisma.challan.create({
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
    return { school, section, student };
  }

  it('shows one scorecard row per branch and never adds currencies together', async () => {
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
    await prisma.attendance.createMany({
      data: (['PRESENT', 'ABSENT'] as const).map((status, i) => ({
        schoolId: a.school.id,
        studentId: a.student.id,
        sectionSubjectId: ss.id,
        date: new Date(today - (i + 1) * DAY),
        period: 1,
        status,
        markedByUserId: principal.id,
      })),
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
      attendance: { num: 1, den: 2, value: 0.5 },
      collectionRate: { num: 50_000, den: 100_000, value: 0.5 },
      overdue: 0,
      principal: { active: 1, daysSinceLogin: 20 },
    });
    expect(row(b.school.id).data.principal).toEqual({
      active: 0,
      daysSinceLogin: null,
    });
    expect(row(c.id)).toMatchObject({
      status: 'no_year',
      data: { enrolled: null, collectionRate: null },
    });

    expect(res.body.group).toEqual({
      enrolled: 2,
      attendance: { num: 1, den: 2, value: 0.5 },
      collectionRate: {
        PKR: { num: 50_000, den: 100_000, value: 0.5 },
        AED: { num: 20_000, den: 20_000, value: 1 },
      },
    });
    // The overview always reads the last 30 days; a range filter does not change it.
    expect(res.body.window.preset).toBe('30d');
  });
});
