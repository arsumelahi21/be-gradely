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

// Scores are mark-weighted over finalized results only; a reopened result row (finalizedAt
// nulled) must not count.
describe('Director academics insights (e2e)', () => {
  let app: INestApplication;
  const now = Date.now();
  const daysAgo = (n: number) => new Date(now - n * DAY);

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

  async function classSection(
    schoolId: string,
    className: string,
    level: number,
  ) {
    const classGrade = await prisma.classGrade.create({
      data: { schoolId, name: className, level },
    });
    const section = await prisma.section.create({
      data: { schoolId, classGradeId: classGrade.id, name: 'A' },
    });
    const subject = await prisma.subject.create({
      data: { schoolId, name: `Maths ${uniq()}` },
    });
    const ss = await prisma.sectionSubject.create({
      data: { sectionId: section.id, subjectId: subject.id },
    });
    return { section, ss };
  }

  async function fixture() {
    const a = await createTestSchool({ name: 'Alpha' });
    const year = await prisma.academicYear.create({
      data: {
        schoolId: a.id,
        name: 'A now',
        code: `AY${uniq()}`,
        startDate: daysAgo(150),
        endDate: daysAgo(-200),
      },
    });
    const g5 = await classSection(a.id, 'Grade 5', 5);
    const g6 = await classSection(a.id, 'Grade 6', 6);
    const student = (fullName: string) =>
      prisma.studentProfile.create({ data: { schoolId: a.id, fullName } });
    const [s1, s2, s3, s4] = await Promise.all(
      ['S1', 'S2', 'S3', 'S4'].map(student),
    );
    const exam = (
      sectionId: string,
      ssId: string,
      extra: Parameters<typeof seedExamination>[0] extends infer O
        ? Partial<O>
        : never,
    ) =>
      seedExamination({
        schoolId: a.id,
        academicYearId: year.id,
        sectionId,
        sectionSubjectIds: [ssId],
        ...extra,
      });

    const e1 = await exam(g5.section.id, g5.ss.id, {
      resultStatus: 'FINALIZED',
      heldAt: daysAgo(30),
    });
    const e2 = await exam(g6.section.id, g6.ss.id, {
      resultStatus: 'FINALIZED',
      heldAt: daysAgo(30),
    });
    const result = (
      examinationId: string,
      studentId: string,
      obtained: number,
      passed: boolean,
      finalized = true,
    ) =>
      prisma.examinationResult.create({
        data: {
          examinationId,
          studentId,
          totalObtained: obtained,
          totalMax: 100,
          passed,
          finalizedAt: finalized ? new Date() : null,
        },
      });
    await result(e1.examination.id, s1.id, 80, true);
    await result(e1.examination.id, s2.id, 30, false);
    await result(e1.examination.id, s3.id, 100, true, false);
    await result(e2.examination.id, s4.id, 90, true);

    // Last paper three weeks ago and still not finalized: overdue. Three days ago: not yet.
    await exam(g5.section.id, g5.ss.id, {
      resultStatus: 'IN_PROGRESS',
      heldAt: daysAgo(21),
      title: 'Overdue',
    });
    await exam(g6.section.id, g6.ss.id, {
      resultStatus: 'NOT_STARTED',
      heldAt: daysAgo(3),
      title: 'Recent',
    });
    const pending = await exam(g5.section.id, g5.ss.id, {
      status: 'PENDING_REVIEW',
      title: 'Waiting',
    });
    await prisma.examination.update({
      where: { id: pending.examination.id },
      data: { submittedAt: daysAgo(5) },
    });

    const b = await createTestSchool({ name: 'Bravo' });
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
    return { a, b, token: login.body.accessToken as string };
  }

  const academics = (token: string, q = '') =>
    api()
      .get(`/api/director/insights/academics${q}`)
      .set({ Authorization: `Bearer ${token}` });

  it('weights scores by marks over finalized results and counts what is holding exams up', async () => {
    const { a, b, token } = await fixture();
    const res = await academics(token);
    expect(res.status).toBe(200);
    const alpha = res.body.branches.find((r: any) => r.schoolId === a.id).data;
    expect(alpha.results).toEqual({
      obtained: 200,
      max: 300,
      avgScorePercent: 66.67,
      pass: { num: 2, den: 3, value: 0.6667 },
    });
    expect(
      alpha.byLevel.map((l: any) => [l.label, l.avgScorePercent, l.pass.value]),
    ).toEqual([
      ['Class 5', 55, 0.5],
      ['Class 6', 90, 1],
    ]);
    expect(alpha.resultsOverdue).toBe(1);
    expect(alpha.reviews).toEqual({ pending: 1, oldestAgeDays: 5 });
    expect(alpha.weakest).toBeUndefined();

    expect(
      res.body.branches.find((r: any) => r.schoolId === b.id),
    ).toMatchObject({
      status: 'no_year',
      data: {
        results: null,
        resultsOverdue: null,
        reviews: { pending: 0, oldestAgeDays: null },
      },
    });
    expect(res.body.group).toMatchObject({
      results: { avgScorePercent: 66.67 },
      resultsOverdue: 1,
      reviews: { pending: 1, oldestAgeDays: 5 },
    });
  });

  it('lists the weakest classes, never students, for one branch', async () => {
    const { a, token } = await fixture();
    const res = await academics(token, `?branch=${a.id}`);
    expect(res.body.branches[0].data.weakest).toEqual([
      {
        className: 'Grade 5',
        sectionName: 'A',
        avgScorePercent: 55,
        pass: { num: 1, den: 2, value: 0.5 },
      },
      {
        className: 'Grade 6',
        sectionName: 'A',
        avgScorePercent: 90,
        pass: { num: 1, den: 1, value: 1 },
      },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/"S[1-4]"|studentId/);
  });
});
