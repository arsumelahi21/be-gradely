import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser } from './utils/factories';
import { Role } from '../src/common/types/role.type';

const DAY = 86_400_000;

describe('Director network map (e2e)', () => {
  let app: INestApplication;
  const api = () => request(app.getHttpServer());

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

  async function fixture() {
    const a = await createTestSchool({ name: 'Alpha' });
    const foreign = await createTestSchool({ name: 'Elsewhere' });
    const year = await prisma.academicYear.create({
      data: {
        schoolId: a.id,
        name: 'Now',
        code: 'NOW',
        startDate: new Date(Date.now() - 100 * DAY),
        endDate: new Date(Date.now() + 200 * DAY),
      },
    });
    const classGrade = await prisma.classGrade.create({
      data: { schoolId: a.id, name: 'Grade 5', level: 5 },
    });
    const section = await prisma.section.create({
      data: { schoolId: a.id, classGradeId: classGrade.id, name: 'A' },
    });
    const student = await prisma.studentProfile.create({
      data: { schoolId: a.id, fullName: 'Zainab Secret-Name' },
    });
    await prisma.enrollment.create({
      data: {
        studentId: student.id,
        sectionId: section.id,
        academicYearId: year.id,
        status: 'ACTIVE',
      },
    });
    await prisma.examination.createMany({
      data: (['DRAFT', 'PENDING_REVIEW', 'REJECTED'] as const).map(
        (status, i) => ({
          schoolId: a.id,
          academicYearId: year.id,
          classGradeId: classGrade.id,
          sectionId: section.id,
          title: `Exam ${i}`,
          status,
          className: 'Grade 5',
          sectionName: 'A',
        }),
      ),
    });
    await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: a.id,
      fullName: 'Pat Principal',
    });

    const director = await createTestUser({ role: Role.DIRECTOR });
    const group = await prisma.schoolGroup.create({
      data: { name: 'G', directorId: director.id },
    });
    await prisma.school.update({
      where: { id: a.id },
      data: { groupId: group.id },
    });
    const login = await api()
      .post('/api/auth/login')
      .send({ email: director.email, password: director.password });
    return { a, foreign, token: login.body.accessToken as string };
  }

  const map = (token: string, id: string) =>
    api()
      .get(`/api/director/map/${id}`)
      .set({ Authorization: `Bearer ${token}` });

  it('returns every area of one branch, with section-level detail and no student names', async () => {
    const { a, token } = await fixture();
    const res = await map(token, a.id);
    expect(res.status).toBe(200);
    expect(res.body.branches).toHaveLength(1);
    const data = res.body.branches[0].data;
    expect(Object.keys(data).sort()).toEqual(
      [
        'academics',
        'attendance',
        'exams',
        'fees',
        'principals',
        'staffing',
        'students',
      ].sort(),
    );
    expect(data.students.enrolled).toBe(1);
    expect(data.students.byLevel).toMatchObject([
      { label: 'Class 5', enrolled: 1 },
    ]);
    // Rejected date sheets are left out of the pipeline.
    expect(data.exams).toEqual({ draft: 1, review: 1, marking: 0, final: 0 });
    expect(data.principals.map((p: any) => p.fullName)).toEqual([
      'Pat Principal',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('Secret-Name');
  });

  it('answers a branch outside the director’s groups with 404, and a malformed id with 400', async () => {
    const { foreign, token } = await fixture();
    expect((await map(token, foreign.id)).status).toBe(404);
    expect(
      (await map(token, '00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
    expect((await map(token, 'nope')).status).toBe(400);
  });
});
