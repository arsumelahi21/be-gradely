import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser } from './utils/factories';
import { Role } from '../src/common/types/role.type';

const DAY = 86_400_000;
let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

// 04-STUDENTS §10, with dates relative to today: the canonical "enrolled" student is active in
// both flags and placed this session; admissions count anyone who joined, active or not.
describe('Director students insights (e2e)', () => {
  let app: INestApplication;
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

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

  const api = () => request(app.getHttpServer());

  async function year(
    schoolId: string,
    name: string,
    startAgo: number,
    endAgo: number,
  ) {
    return prisma.academicYear.create({
      data: {
        schoolId,
        name,
        code: `AY${uniq()}`,
        startDate: daysAgo(startAgo),
        endDate: daysAgo(endAgo),
      },
    });
  }

  async function section(
    schoolId: string,
    className: string,
    level: number | null,
    name: string,
  ) {
    const classGrade = await prisma.classGrade.create({
      data: { schoolId, name: className, level },
    });
    return prisma.section.create({
      data: { schoolId, classGradeId: classGrade.id, name },
    });
  }

  async function student(
    schoolId: string,
    s: {
      name: string;
      gender: 'MALE' | 'FEMALE';
      joined: Date | null;
      createdAt?: Date;
      profileActive?: boolean;
      userActive?: boolean;
      placed?: {
        sectionId: string;
        academicYearId: string;
        status?: 'ACTIVE' | 'COMPLETED';
      }[];
    },
  ) {
    const user = await createTestUser({
      role: Role.STUDENT,
      schoolId,
      isActive: s.userActive ?? true,
    });
    const profile = await prisma.studentProfile.create({
      data: {
        userId: user.id,
        schoolId,
        fullName: s.name,
        gender: s.gender,
        dateOfJoining: s.joined,
        isActive: s.profileActive ?? true,
        rollNo: `R${uniq()}`,
        ...(s.createdAt && { createdAt: s.createdAt }),
      },
    });
    for (const p of s.placed ?? [])
      await prisma.enrollment.create({
        data: {
          studentId: profile.id,
          sectionId: p.sectionId,
          academicYearId: p.academicYearId,
          status: p.status ?? 'ACTIVE',
        },
      });
    return profile;
  }

  async function fixture() {
    const a = await createTestSchool({ name: 'Alpha' });
    const aNow = await year(a.id, 'A now', 150, -200);
    const aBefore = await year(a.id, 'A before', 550, 160);
    const a1 = await section(a.id, 'Grade 5', 5, 'A-1');
    const a2 = await section(a.id, 'Grade 6', 6, 'A-2');
    const inA1 = [{ sectionId: a1.id, academicYearId: aNow.id }];
    await student(a.id, {
      name: 'Areeba Ali',
      gender: 'FEMALE',
      joined: daysAgo(45),
      placed: inA1,
    });
    await student(a.id, {
      name: 'Bilal Raza',
      gender: 'MALE',
      joined: daysAgo(500),
      placed: [
        ...inA1,
        { sectionId: a1.id, academicYearId: aBefore.id, status: 'COMPLETED' },
      ],
    });
    await student(a.id, {
      name: 'Danish Iqbal',
      gender: 'MALE',
      joined: daysAgo(500),
      placed: inA1,
    });
    await student(a.id, {
      name: 'Fatima Noor',
      gender: 'FEMALE',
      joined: daysAgo(260),
      userActive: false,
      placed: [{ sectionId: a2.id, academicYearId: aNow.id }],
    });
    await student(a.id, {
      name: 'Hamza Tariq',
      gender: 'MALE',
      joined: daysAgo(6),
    });
    await student(a.id, {
      name: 'Sana Javed',
      gender: 'FEMALE',
      joined: daysAgo(900),
      profileActive: false,
      placed: inA1,
    });

    const b = await createTestSchool({ name: 'Bravo' });
    const bNow = await year(b.id, 'B now', 40, -250);
    const b1 = await section(b.id, 'Year 1', null, 'B-1');
    const inB1 = [{ sectionId: b1.id, academicYearId: bNow.id }];
    await student(b.id, {
      name: 'Layla',
      gender: 'FEMALE',
      joined: daysAgo(40),
      placed: inB1,
    });
    await student(b.id, {
      name: 'Omar',
      gender: 'MALE',
      joined: daysAgo(40),
      placed: inB1,
    });
    await student(b.id, {
      name: 'Mariam',
      gender: 'FEMALE',
      joined: daysAgo(10),
      placed: inB1,
    });

    const c = await createTestSchool({ name: 'Charlie' });
    await student(c.id, {
      name: 'Chris',
      gender: 'MALE',
      joined: null,
      createdAt: daysAgo(8),
    });
    await student(c.id, {
      name: 'Chloe',
      gender: 'FEMALE',
      joined: daysAgo(150),
    });

    const foreign = await createTestSchool({ name: 'Delta' });
    const director = await createTestUser({ role: Role.DIRECTOR });
    const group = await prisma.schoolGroup.create({
      data: { name: 'G', directorId: director.id },
    });
    await prisma.school.updateMany({
      where: { id: { in: [a.id, b.id, c.id] } },
      data: { groupId: group.id },
    });
    const login = await api()
      .post('/api/auth/login')
      .send({ email: director.email, password: director.password });
    return { a, b, c, foreign, token: login.body.accessToken as string };
  }

  const students = (token: string, q = '') =>
    api()
      .get(`/api/director/insights/students${q}`)
      .set({ Authorization: `Bearer ${token}` });
  const row = (body: any, id: string) =>
    body.branches.find((r: any) => r.schoolId === id);

  it('counts only active, placed students as enrolled', async () => {
    const { a, b, c, token } = await fixture();
    const res = await students(token);
    expect(res.status).toBe(200);

    expect(row(res.body, a.id).data).toMatchObject({
      enrolled: 3,
      unplaced: 1,
      inactive: 2,
      gender: { male: 2, female: 1, other: 0, unspecified: 0 },
      sections: {
        active: 2,
        withStudents: 1,
        empty: 1,
        avgSize: { num: 3, den: 1, value: 3 },
      },
      byLevel: [
        { key: '5', level: 5, label: 'Class 5', enrolled: 3, sections: 1 },
        { key: '6', level: 6, label: 'Class 6', enrolled: 0, sections: 1 },
      ],
      admissions: { count: 1 },
    });
    expect(row(res.body, a.id).data.admissions.monthly).toHaveLength(12);
    expect(row(res.body, b.id).data.byLevel).toEqual([
      {
        key: 'name:year 1',
        level: null,
        label: 'Year 1',
        enrolled: 3,
        sections: 1,
      },
    ]);
    expect(row(res.body, c.id)).toMatchObject({
      status: 'no_year',
      data: {
        enrolled: null,
        unplaced: null,
        gender: null,
        byLevel: null,
        sections: null,
        inactive: 0,
        admissions: { count: 1 },
      },
    });
  });

  it('rolls up session figures from branches with a session, admissions from every branch', async () => {
    const { token } = await fixture();
    const { body } = await students(token);
    expect(body.group).toMatchObject({
      enrolled: 6,
      unplaced: 1,
      inactive: 2,
      gender: { male: 3, female: 3, other: 0, unspecified: 0 },
      sections: {
        active: 3,
        withStudents: 2,
        empty: 1,
        avgSize: { num: 6, den: 2, value: 3 },
      },
      admissions: { count: 3 },
    });
    expect(body.group.byLevel.map((l: any) => l.key)).toEqual([
      '5',
      '6',
      'name:year 1',
    ]);
    expect(body.coverage).toEqual({ ok: 2, total: 3 });
  });

  it('counts students who left in the window, from the audit log', async () => {
    const { a, token } = await fixture();
    const audit = (role: string, daysAgo: number, id: string) => ({
      actorUserId: 'principal',
      schoolId: a.id,
      action: 'USER_DEACTIVATE',
      entityType: 'User',
      entityId: id,
      metadata: { role },
      createdAt: new Date(Date.now() - daysAgo * DAY),
    });
    await prisma.auditLog.createMany({
      data: [
        audit('STUDENT', 5, 's1'),
        audit('STUDENT', 40, 's2'),
        audit('TEACHER', 5, 't1'),
      ],
    });
    const { body } = await students(token);
    expect(row(body, a.id).data.leavers).toBe(1);
    expect(body.group.leavers).toBe(1);
    expect(
      row((await students(token, '?preset=90d')).body, a.id).data.leavers,
    ).toBe(2);
  });

  it('reads the previous session by relative position', async () => {
    const { a, b, token } = await fixture();
    const { body } = await students(token, '?ay=previous');
    expect(row(body, a.id).data).toMatchObject({
      enrolled: 0,
      unplaced: 4,
      sections: { empty: 2, avgSize: { value: null } },
    });
    expect(row(body, b.id).status).toBe('no_year');
  });

  it('returns no names and has no lists route', async () => {
    const { a, foreign, token } = await fixture();
    const res = await students(token, `?branch=${a.id}`);
    expect(res.body.branches).toHaveLength(1);
    expect(res.body.coverage).toEqual({ ok: 1, total: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(
      /Areeba|Hamza|Sana|rollNo|R\d{5}/,
    );
    expect((await students(token, `?branch=${foreign.id}`)).status).toBe(404);
    expect(
      (
        await api()
          .get(`/api/director/insights/students/lists?branch=${a.id}`)
          .set({ Authorization: `Bearer ${token}` })
      ).status,
    ).toBe(404);
  });
});
