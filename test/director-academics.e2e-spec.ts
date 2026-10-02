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
      extra: Partial<Parameters<typeof seedExamination>[0]>,
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
    const director = await createTestUser({ role: Role.DIRECTOR });
    const group = await prisma.schoolGroup.create({
      data: { name: 'G', directorId: director.id },
    });
    await prisma.school.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { groupId: group.id },
    });
    const login = await api()
      .post('/api/auth/login')
      .send({ email: director.email, password: director.password });
    return {
      a,
      b,
      year,
      e1,
      e2,
      token: login.body.accessToken as string,
    };
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

  it('compares with the last session, lines terms up, and finds the weakest subjects', async () => {
    const { a, year, e1, e2, token } = await fixture();
    // Last session: one result, passed.
    const before = await prisma.academicYear.create({
      data: {
        schoolId: a.id,
        name: 'A before',
        code: `AY${uniq()}`,
        startDate: daysAgo(500),
        endDate: daysAgo(151),
      },
    });
    const old = await classSection(a.id, 'Grade 4', 4);
    const oldExam = await seedExamination({
      schoolId: a.id,
      academicYearId: before.id,
      sectionId: old.section.id,
      sectionSubjectIds: [old.ss.id],
      resultStatus: 'FINALIZED',
    });
    const kid = await prisma.studentProfile.create({
      data: { schoolId: a.id, fullName: 'Old Kid' },
    });
    await prisma.examinationResult.create({
      data: {
        examinationId: oldExam.examination.id,
        studentId: kid.id,
        totalObtained: 50,
        totalMax: 100,
        passed: true,
        finalizedAt: new Date(),
      },
    });

    // Only Grade 5's examination belongs to a term.
    // An earlier term with no results yet keeps its place: Term 1 is the second term.
    await prisma.academicTerm.create({
      data: {
        schoolId: a.id,
        academicYearId: year.id,
        name: 'Orientation',
        sortOrder: -1,
      },
    });
    const term = await prisma.academicTerm.create({
      data: { schoolId: a.id, academicYearId: year.id, name: 'Term 1' },
    });
    await prisma.examination.update({
      where: { id: e1.examination.id },
      data: { termId: term.id },
    });

    // Subject marks: Grade 5's paper has 10 marks averaging 40%; Grade 6's only 2, too few to rank.
    const kids = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        prisma.studentProfile.create({
          data: { schoolId: a.id, fullName: `K${i}` },
        }),
      ),
    );
    await prisma.examResult.createMany({
      data: [
        ...kids.map((k) => ({
          examId: e1.subjects[0].id,
          studentId: k.id,
          score: 40,
        })),
        ...kids.slice(0, 2).map((k) => ({
          examId: e2.subjects[0].id,
          studentId: k.id,
          score: 90,
        })),
        { examId: e1.subjects[0].id, studentId: kid.id, isAbsent: true },
      ],
    });

    const res = await academics(token);
    const alpha = res.body.branches.find((r: any) => r.schoolId === a.id).data;
    expect(alpha.resultsBefore).toMatchObject({
      pass: { num: 1, den: 1, value: 1 },
    });
    expect(alpha.byTerm).toEqual([
      {
        name: 'Term 1',
        position: 2,
        obtained: 110,
        max: 200,
        avgScorePercent: 55,
        pass: { num: 1, den: 2, value: 0.5 },
      },
    ]);
    // 2 of 3 passed now against 1 of 1 last session.
    expect(res.body.group.passChange).toBe(-33);
    expect(res.body.group.byTerm).toMatchObject([
      { label: 'Term 1', pass: { value: 0.5 } },
    ]);
    expect(res.body.group.weakestSubjects).toEqual([
      {
        name: expect.stringMatching(/^Maths /),
        avgScorePercent: 40,
        branches: 1,
        marks: 10,
      },
    ]);
  });
});
