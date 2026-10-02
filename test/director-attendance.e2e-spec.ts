import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser } from './utils/factories';
import { Role } from '../src/common/types/role.type';

const DAY = 86_400_000;
let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

type Mark = 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED';

// The rate counts every mark; the "below 75%" count only canonical students with 10+ marks.
describe('Director attendance insights (e2e)', () => {
  let app: INestApplication;
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const day = (n: number) => new Date(today - n * DAY);

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

  async function section(schoolId: string, name: string, isActive = true) {
    const classGrade = await prisma.classGrade.create({
      data: { schoolId, name: `Grade ${name}` },
    });
    const s = await prisma.section.create({
      data: { schoolId, classGradeId: classGrade.id, name, isActive },
    });
    const subject = await prisma.subject.create({
      data: { schoolId, name: `Maths ${uniq()}` },
    });
    const ss = await prisma.sectionSubject.create({
      data: { sectionId: s.id, subjectId: subject.id },
    });
    return { section: s, ss };
  }

  async function student(
    schoolId: string,
    fullName: string,
    place?: { sectionId: string; academicYearId: string },
    userActive = true,
  ) {
    const user = await createTestUser({
      role: Role.STUDENT,
      schoolId,
      isActive: userActive,
    });
    const profile = await prisma.studentProfile.create({
      data: { userId: user.id, schoolId, fullName },
    });
    if (place)
      await prisma.enrollment.create({
        data: { studentId: profile.id, ...place, status: 'ACTIVE' },
      });
    return profile;
  }

  /** One mark per day, newest yesterday. */
  async function marks(
    schoolId: string,
    studentId: string,
    sectionSubjectId: string,
    statuses: Mark[],
    by: string,
  ) {
    await prisma.attendance.createMany({
      data: statuses.map((status, i) => ({
        schoolId,
        studentId,
        sectionSubjectId,
        date: day(i + 1),
        period: 1,
        status,
        markedByUserId: by,
      })),
    });
  }

  async function fixture() {
    const a = await createTestSchool({ name: 'Alpha' });
    const principal = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: a.id,
    });
    const year = await prisma.academicYear.create({
      data: {
        schoolId: a.id,
        name: 'A now',
        code: `AY${uniq()}`,
        startDate: day(150),
        endDate: day(-200),
      },
    });
    const a1 = await section(a.id, 'A-1');
    const a2 = await section(a.id, 'A-2');
    const closed = await section(a.id, 'A-3', false);
    const inA1 = { sectionId: a1.section.id, academicYearId: year.id };

    const s1 = await student(a.id, 'Areeba Ali', inA1);
    const s2 = await student(a.id, 'Bilal Raza', inA1);
    const s3 = await student(a.id, 'Danish Iqbal', inA1);
    await student(a.id, 'Fatima Noor', {
      sectionId: a2.section.id,
      academicYearId: year.id,
    });
    const gone = await student(a.id, 'Gone Student', inA1, false);
    await student(a.id, 'Closed Section', {
      sectionId: closed.section.id,
      academicYearId: year.id,
    });

    await marks(a.id, s1.id, a1.ss.id, Array(10).fill('PRESENT'), principal.id);
    await marks(
      a.id,
      s2.id,
      a1.ss.id,
      [
        'PRESENT',
        'PRESENT',
        'PRESENT',
        'PRESENT',
        'PRESENT',
        'PRESENT',
        'LATE',
        'ABSENT',
        'ABSENT',
        'ABSENT',
      ],
      principal.id,
    );
    await marks(a.id, s3.id, a1.ss.id, Array(5).fill('ABSENT'), principal.id);
    await marks(
      a.id,
      gone.id,
      a1.ss.id,
      Array(10).fill('ABSENT'),
      principal.id,
    );

    // A branch with no session still reports its marks.
    const b = await createTestSchool({ name: 'Bravo' });
    const bPrincipal = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: b.id,
    });
    const b1 = await section(b.id, 'B-1');
    const bStudent = await student(b.id, 'Bravo Kid');
    await marks(
      b.id,
      bStudent.id,
      b1.ss.id,
      ['PRESENT', 'PRESENT'],
      bPrincipal.id,
    );
    // One absence in the 30 days before the window.
    await prisma.attendance.create({
      data: {
        schoolId: b.id,
        studentId: bStudent.id,
        sectionSubjectId: b1.ss.id,
        date: day(40),
        period: 1,
        status: 'ABSENT',
        markedByUserId: bPrincipal.id,
      },
    });

    const group = await prisma.schoolGroup.create({ data: { name: 'G' } });
    await prisma.school.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { groupId: group.id },
    });
    const director = await createTestUser({
      role: Role.DIRECTOR,
      groupId: group.id,
    });
    const login = await api()
      .post('/api/auth/login')
      .send({ email: director.email, password: director.password });
    return { a, b, director, token: login.body.accessToken as string };
  }

  const get = (token: string, path: string) =>
    api()
      .get(`/api/director/insights/${path}`)
      .set({ Authorization: `Bearer ${token}` });
  const row = (body: any, id: string) =>
    body.branches.find((r: any) => r.schoolId === id);

  it('reports the rate over every mark and the at-risk count over canonical students', async () => {
    const { a, b, token } = await fixture();
    const res = await get(token, 'attendance');
    expect(res.status).toBe(200);

    const alpha = row(res.body, a.id).data;
    // 35 marks; present + late = 10 + 7. The deactivated student's marks still count here.
    expect(alpha.rate).toEqual({ num: 17, den: 35, value: 0.4857 });
    // Only Bilal: 7 of 10. Danish has too few marks; the deactivated student is not canonical.
    // Enrolled is 5: a student placed in the closed section A-3 still counts (04-STUDENTS §4).
    expect(alpha.rateBefore).toEqual({ num: 0, den: 0, value: null });
    expect(alpha.below).toEqual({
      students: 1,
      studentsBefore: 0,
      eligible: 2,
      share: { num: 1, den: 5, value: 0.2 },
    });
    // A-2 has a student but never took a register; the inactive A-3 is ignored.
    expect(alpha.notMarking).toMatchObject({ sections: 1, of: 2 });
    expect(alpha.daily.at(-1).rate).toBeNull();

    expect(row(res.body, b.id)).toMatchObject({
      status: 'no_year',
      data: {
        rate: { num: 2, den: 2, value: 1 },
        rateBefore: { num: 0, den: 1, value: 0 },
        below: null,
        notMarking: null,
      },
    });
    expect(res.body.group).toEqual({
      rate: { num: 19, den: 37, value: 0.5135 },
      rateBefore: { num: 0, den: 1, value: 0 },
      below: {
        students: 1,
        studentsBefore: 0,
        eligible: 2,
        share: { num: 1, den: 5, value: 0.2 },
      },
      notMarking: { sections: 1, of: 2 },
    });
  });

  it('names at-risk students and silent sections for one branch only, on request', async () => {
    const { a, b, director, token } = await fixture();
    const res = await get(token, `attendance/lists?branch=${a.id}`);
    expect(res.status).toBe(200);
    expect(res.body.branches[0].data).toEqual({
      students: [
        {
          fullName: 'Bilal Raza',
          className: 'Grade A-1',
          sectionName: 'A-1',
          rate: 0.7,
          absent: 3,
        },
      ],
      notMarking: [
        { className: 'Grade A-2', sectionName: 'A-2', lastMarkedOn: null },
      ],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/studentId|rollNo|email/);

    expect((await get(token, 'attendance/lists?branch=all')).status).toBe(400);
    expect(
      (await get(token, `attendance/lists?branch=${b.id}`)).body.branches[0]
        .data,
    ).toBeNull();

    let audits = 0;
    for (let i = 0; i < 20 && audits < 2; i++) {
      audits = await prisma.auditLog.count({
        where: { actorUserId: director.id, action: 'DIRECTOR_LIST_VIEW' },
      });
      if (audits < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(audits).toBe(2);
  });

  it('accepts a custom window and refuses a range over 366 days', async () => {
    const { a, token } = await fixture();
    const from = new Date(today - 3 * DAY).toISOString().slice(0, 10);
    const to = new Date(today).toISOString().slice(0, 10);
    const res = await get(
      token,
      `attendance?branch=${a.id}&preset=custom&from=${from}&to=${to}`,
    );
    // Days 1–3 back: s1 3 present, s2 3 present (newest first), s3 3 absent, gone 3 absent.
    expect(res.body.branches[0].data.rate).toEqual({
      num: 6,
      den: 12,
      value: 0.5,
    });
    expect(
      (
        await get(
          token,
          'attendance?preset=custom&from=2024-01-01&to=2026-01-02',
        )
      ).status,
    ).toBe(400);
  });
});
