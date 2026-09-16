import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { addSecondSubject, seedClass } from './utils/class-fixture';
import { seedExamination } from './utils/exam-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * One result, one answer. The same student's marks must come back as the same totals,
 * percentage, grade and verdict from every surface that shows them — and those numbers must be
 * the worked arithmetic: marks summed against each paper's own total, never averaged percentages.
 */
describe('Result mathematics across every surface (e2e)', () => {
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

  const api = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function world() {
    const cls = await seedClass({ studentCount: 2 });
    const islamiyat = await addSecondSubject(cls.school, cls.section.id);
    const biology = await addSecondSubject(cls.school, cls.section.id);
    const [s0, s1] = cls.students;
    await prisma.studentProfile.update({
      where: { id: s0.profile.id },
      data: { rollNo: '0001' },
    });
    await prisma.studentProfile.update({
      where: { id: s1.profile.id },
      data: { rollNo: '0002' },
    });
    const adminUser = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const term = await prisma.academicTerm.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: cls.academicYear.id,
        name: 'First Term',
      },
    });
    return {
      cls,
      term,
      s0,
      s1,
      ss: {
        maths: cls.sectionSubject.id,
        islamiyat: islamiyat.sectionSubject.id,
        biology: biology.sectionSubject.id,
      },
      admin: await tokenFor(app, adminUser),
      mathsTeacher: await tokenFor(app, cls.teacherUser),
      student: await tokenFor(app, s0.user),
      scope: `academicYearId=${cls.academicYear.id}&termId=${term.id}`,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** A published examination whose papers carry their own totals and no passing marks. */
  async function publishedExam(
    w: World,
    title: string,
    papers: { ss: string; max: number }[],
  ) {
    const { examination, subjects } = await seedExamination({
      schoolId: w.cls.school.id,
      academicYearId: w.cls.academicYear.id,
      sectionId: w.cls.section.id,
      sectionSubjectIds: papers.map((p) => p.ss),
      termId: w.term.id,
      title,
      status: 'PUBLISHED',
      passingMarks: null,
    });
    for (const [i, p] of papers.entries()) {
      await prisma.exam.update({
        where: { id: subjects[i].id },
        data: { maxScore: p.max },
      });
    }
    return { id: examination.id, subjectIds: subjects.map((s) => s.id) };
  }

  const enter = (
    w: World,
    examId: string,
    subjectId: string,
    entries: object[],
  ) =>
    api()
      .put(`/api/exams/${examId}/subjects/${subjectId}/marks`)
      .set(bearer(w.admin))
      .send({ entries });

  const finalize = (w: World, examId: string) =>
    api()
      .post(`/api/exams/${examId}/results/finalize`)
      .set(bearer(w.admin))
      .expect(201);

  /** Mid Term: Mathematics /50, Islamiyat /100, Biology /100 — the worked example, finalized. */
  async function midTerm(w: World) {
    const exam = await publishedExam(w, 'Mid Term Test', [
      { ss: w.ss.maths, max: 50 },
      { ss: w.ss.islamiyat, max: 100 },
      { ss: w.ss.biology, max: 100 },
    ]);
    const [maths, islamiyat, biology] = exam.subjectIds;
    await enter(w, exam.id, maths, [
      { studentId: w.s0.profile.id, score: 46 },
      { studentId: w.s1.profile.id, score: 40 },
    ]).expect(200);
    await enter(w, exam.id, islamiyat, [
      { studentId: w.s0.profile.id, score: 80 },
      { studentId: w.s1.profile.id, score: 70 },
    ]).expect(200);
    await enter(w, exam.id, biology, [
      { studentId: w.s0.profile.id, score: 34 },
      { studentId: w.s1.profile.id, score: 60 },
    ]).expect(200);
    await finalize(w, exam.id);
    return { ...exam, maths, islamiyat, biology };
  }

  const pick = (r: any) => ({
    totalObtained: r.totalObtained,
    totalMax: r.totalMax,
    percentage: r.percentage,
    grade: r.grade,
    passed: r.passed,
  });
  // 46 + 80 + 34 = 160 of 50 + 100 + 100 = 250 → 64%, grade C; Biology's 34% is an F, so it fails.
  const WORKED = {
    totalObtained: 160,
    totalMax: 250,
    percentage: 64,
    grade: 'C',
    passed: false,
  };

  it('TEST 4 / 21 / 48: every surface reports 160/250 = 64%, C, Fail for the same student', async () => {
    const w = await world();
    const exam = await midTerm(w);
    const s0 = w.s0.profile.id;

    const sheet = await api()
      .get(`/api/exams/${exam.id}/results`)
      .set(bearer(w.admin))
      .expect(200);
    const sheetRow = sheet.body.rows.find((r: any) => r.student.id === s0);
    expect(pick(sheetRow)).toEqual(WORKED);
    expect(
      sheetRow.subjects.map((s: any) => [
        s.obtained,
        s.maxScore,
        s.percentage,
        s.grade,
      ]),
    ).toEqual([
      [46, 50, 92, 'A+'],
      [80, 100, 80, 'A'],
      [34, 100, 34, 'F'],
    ]);

    const principalCards = await api()
      .get(`/api/exams/${exam.id}/report-cards?studentId=${s0}`)
      .set(bearer(w.admin))
      .expect(200);
    expect(pick(principalCards.body.cards[0])).toEqual(WORKED);

    const studentCards = await api()
      .get(`/api/exams/${exam.id}/report-cards`)
      .set(bearer(w.student))
      .expect(200);
    expect(pick(studentCards.body.cards[0])).toEqual(WORKED);

    const card = await api()
      .get(`/api/exams/students/${s0}/result-card?${w.scope}`)
      .set(bearer(w.admin))
      .expect(200);
    expect(pick(card.body.overall)).toEqual(WORKED);
    expect(card.body.overall).toMatchObject({
      complete: true,
      failedSubjects: [expect.any(String)],
    });
    expect(
      card.body.overall.subjects.map((s: any) => [s.obtained, s.maxScore]),
    ).toEqual([
      [46, 50],
      [80, 100],
      [34, 100],
    ]);

    const sheetOfClass = await api()
      .get(`/api/exams/sections/${w.cls.section.id}/result-cards?${w.scope}`)
      .set(bearer(w.admin))
      .expect(200);
    expect(sheetOfClass.body.subjects.map((c: any) => c.maxScore)).toEqual([
      50, 100, 100,
    ]);
    const fromClass = sheetOfClass.body.cards.find(
      (c: any) => c.student.id === s0,
    );
    expect(fromClass.overall).toEqual(card.body.overall);

    const mine = await api()
      .get('/api/exams/results/me')
      .set(bearer(w.student))
      .expect(200);
    expect(pick(mine.body[0])).toEqual(WORKED);
    const summary = await api()
      .get('/api/exams/results/me/summary')
      .set(bearer(w.student))
      .expect(200);
    expect(summary.body.sessions).toEqual([
      {
        academicYear: {
          id: w.cls.academicYear.id,
          name: w.cls.academicYear.name,
        },
        examCount: 1,
        totalObtained: 160,
        totalMax: 250,
        percentage: 64,
      },
    ]);
    const principalSummary = await api()
      .get(`/api/exams/results/student/${s0}/summary`)
      .set(bearer(w.admin))
      .expect(200);
    expect(principalSummary.body).toEqual(summary.body);
  });

  it('TEST 22: the teacher and the principal read an identical subject register', async () => {
    const w = await world();
    const exam = await midTerm(w);
    const path = `/api/exams/${exam.id}/subjects/${exam.maths}/result`;
    const [teacher, principal] = await Promise.all([
      api().get(path).set(bearer(w.mathsTeacher)).expect(200),
      api().get(path).set(bearer(w.admin)).expect(200),
    ]);
    const strip = (b: any) => ({ ...b, generatedAt: undefined });
    expect(strip(teacher.body)).toEqual(strip(principal.body));
    expect(
      teacher.body.rows.map((r: any) => [r.obtained, r.percentage, r.grade]),
    ).toEqual([
      [46, 92, 'A+'],
      [40, 80, 'A'],
    ]);
  });

  it('adds a second examination to the term by marks, and never counts a missing mark as zero', async () => {
    const w = await world();
    await midTerm(w);
    const unit = await publishedExam(w, 'Unit Test', [
      { ss: w.ss.maths, max: 100 },
      { ss: w.ss.islamiyat, max: 100 },
    ]);
    const [maths, islamiyat] = unit.subjectIds;
    await enter(w, unit.id, maths, [
      { studentId: w.s0.profile.id, score: 70 },
      { studentId: w.s1.profile.id, score: 50 },
    ]).expect(200);
    // The second student's Islamiyat paper is left unmarked.
    await enter(w, unit.id, islamiyat, [
      { studentId: w.s0.profile.id, score: 80 },
    ]).expect(200);

    const sheet = await api()
      .get(`/api/exams/sections/${w.cls.section.id}/result-cards?${w.scope}`)
      .set(bearer(w.admin))
      .expect(200);
    const byStudent = (id: string) =>
      sheet.body.cards.find((c: any) => c.student.id === id);

    // 160/250 + 150/200 = 310/450 = 68.89%. Mathematics is one column: 46/50 + 70/100 = 116/150.
    expect(byStudent(w.s0.profile.id).overall).toMatchObject({
      examCount: 2,
      complete: true,
      totalObtained: 310,
      totalMax: 450,
      percentage: 68.89,
      grade: 'C',
      passed: false,
    });
    expect(byStudent(w.s0.profile.id).overall.subjects[0]).toMatchObject({
      papers: 2,
      obtained: 116,
      maxScore: 150,
    });
    expect(sheet.body.subjects[0]).toMatchObject({ papers: 2, maxScore: 150 });

    // Incomplete: no percentage, grade or verdict — not (170 + 50) / 450 as if Islamiyat were 0.
    expect(byStudent(w.s1.profile.id).overall).toMatchObject({
      complete: false,
      totalObtained: 220,
      totalMax: 450,
      percentage: null,
      grade: null,
      passed: null,
    });
    expect(byStudent(w.s1.profile.id).overall.subjects[1]).toMatchObject({
      missing: true,
    });

    for (const c of sheet.body.cards) {
      const single = await api()
        .get(`/api/exams/students/${c.student.id}/result-card?${w.scope}`)
        .set(bearer(w.admin))
        .expect(200);
      expect(single.body.overall).toEqual(c.overall);
    }
  });

  it('TEST 12–13: refuses marks above the paper total or below zero', async () => {
    const w = await world();
    const exam = await publishedExam(w, 'Quiz', [{ ss: w.ss.maths, max: 50 }]);
    const [maths] = exam.subjectIds;
    await enter(w, exam.id, maths, [
      { studentId: w.s0.profile.id, score: 51 },
    ]).expect(400);
    await enter(w, exam.id, maths, [
      { studentId: w.s0.profile.id, score: -5 },
    ]).expect(400);
    await enter(w, exam.id, maths, [
      { studentId: w.s0.profile.id, score: 50 },
    ]).expect(200);
    expect(
      await prisma.examResult.findMany({ select: { score: true } }),
    ).toEqual([{ score: 50 }]);
  });

  it('adds marks for the school average and counts an absence as zero', async () => {
    const w = await world();
    await midTerm(w);
    const retest = await publishedExam(w, 'Retest', [
      { ss: w.ss.biology, max: 100 },
    ]);
    await enter(w, retest.id, retest.subjectIds[0], [
      { studentId: w.s0.profile.id, isAbsent: true },
      { studentId: w.s1.profile.id, score: 90 },
    ]).expect(200);
    await finalize(w, retest.id);

    // (160 + 170 + 0 + 90) / (250 + 250 + 100 + 100) = 420 / 700 = 60%.
    const stats = await api()
      .get('/api/exams/school/stats')
      .set(bearer(w.admin))
      .expect(200);
    expect(stats.body.averageScorePercent).toBe(60);
  });

  it('refuses a grading scheme that cannot fail anyone or ranks a fail above a pass', async () => {
    const w = await world();
    const allPass = await api()
      .post('/api/exam-settings/grading-schemes')
      .set(bearer(w.admin))
      .send({
        name: 'Nobody fails',
        bands: [
          { label: 'A', minPercent: 50, isPassing: true },
          { label: 'F', minPercent: 0, isPassing: true },
        ],
      })
      .expect(400);
    expect(allPass.body.message).toBe(
      'At least one band must be failing, otherwise no score could ever fail',
    );

    const inverted = await api()
      .post('/api/exam-settings/grading-schemes')
      .set(bearer(w.admin))
      .send({
        name: 'Upside down',
        bands: [
          { label: 'A', minPercent: 80, isPassing: false },
          { label: 'B', minPercent: 50, isPassing: true },
          { label: 'F', minPercent: 0, isPassing: false },
        ],
      })
      .expect(400);
    expect(inverted.body.message).toBe(
      'A failing band cannot sit above a passing one: passing grades must be the top grades',
    );
  });

  it('keeps an unfinished exam on the term of a student left out of mark entry, as incomplete', async () => {
    const w = await world();
    await midTerm(w);
    const quiz = await publishedExam(w, 'Quiz', [{ ss: w.ss.maths, max: 20 }]);
    await enter(w, quiz.id, quiz.subjectIds[0], [
      { studentId: w.s0.profile.id, score: 18 },
    ]).expect(200);

    const sheet = await api()
      .get(`/api/exams/sections/${w.cls.section.id}/result-cards?${w.scope}`)
      .set(bearer(w.admin))
      .expect(200);
    const skipped = sheet.body.cards.find(
      (c: any) => c.student.id === w.s1.profile.id,
    );
    expect(skipped.exams.map((e: any) => e.title)).toEqual([
      'Mid Term Test',
      'Quiz',
    ]);
    // 170/250 from the mid term plus an unmarked 20-mark quiz: incomplete, not 170/270 graded.
    expect(skipped.overall).toMatchObject({
      complete: false,
      totalObtained: 170,
      totalMax: 270,
      percentage: null,
      grade: null,
      passed: null,
    });
    const single = await api()
      .get(`/api/exams/students/${w.s1.profile.id}/result-card?${w.scope}`)
      .set(bearer(w.admin))
      .expect(200);
    expect(single.body.overall).toEqual(skipped.overall);
  });

  it('fails an overall F even when every subject clears its own passing marks', async () => {
    const w = await world();
    const exam = await publishedExam(w, 'Low pass lines', [
      { ss: w.ss.maths, max: 100 },
      { ss: w.ss.biology, max: 100 },
    ]);
    await prisma.exam.updateMany({
      where: { examinationId: exam.id },
      data: { passingMarks: 10 },
    });
    const [maths, biology] = exam.subjectIds;
    await enter(w, exam.id, maths, [
      { studentId: w.s0.profile.id, score: 15 },
      { studentId: w.s1.profile.id, score: 90 },
    ]).expect(200);
    await enter(w, exam.id, biology, [
      { studentId: w.s0.profile.id, score: 20 },
      { studentId: w.s1.profile.id, score: 90 },
    ]).expect(200);
    await finalize(w, exam.id);

    const sheet = await api()
      .get(`/api/exams/${exam.id}/results`)
      .set(bearer(w.admin))
      .expect(200);
    const row = sheet.body.rows.find(
      (r: any) => r.student.id === w.s0.profile.id,
    );
    // 35/200 = 17.5%: an F, so the result fails although no subject failed.
    expect(row).toMatchObject({
      percentage: 17.5,
      grade: 'F',
      passed: false,
      failedSubjects: [],
      belowPassMark: true,
    });
    const card = await api()
      .get(`/api/exams/students/${w.s0.profile.id}/result-card?${w.scope}`)
      .set(bearer(w.admin))
      .expect(200);
    expect(card.body.overall).toMatchObject({
      grade: 'F',
      passed: false,
      belowPassMark: true,
    });
  });

  it("locks a scheme's grades once it has graded a finalized result, but still allows a rename", async () => {
    const w = await world();
    const bands = (pass: number) => [
      { label: 'P', minPercent: pass, isPassing: true },
      { label: 'F', minPercent: 0, isPassing: false },
    ];
    const scheme = await api()
      .post('/api/exam-settings/grading-schemes')
      .set(bearer(w.admin))
      .send({ name: 'Pass/Fail', bands: bands(50) })
      .expect(201);
    const path = `/api/exam-settings/grading-schemes/${scheme.body.id}`;
    // Unused: grades can still change.
    await api()
      .patch(path)
      .set(bearer(w.admin))
      .send({ bands: bands(45) })
      .expect(200);

    const exam = await publishedExam(w, 'Graded by Pass/Fail', [
      { ss: w.ss.maths, max: 100 },
    ]);
    await prisma.examination.update({
      where: { id: exam.id },
      data: { gradingSchemeId: scheme.body.id },
    });
    await enter(w, exam.id, exam.subjectIds[0], [
      { studentId: w.s0.profile.id, score: 60 },
      { studentId: w.s1.profile.id, score: 30 },
    ]).expect(200);
    await finalize(w, exam.id);

    const refused = await api()
      .patch(path)
      .set(bearer(w.admin))
      .send({ bands: bands(40) })
      .expect(409);
    expect(refused.body.message).toContain('graded 1 finalized examination');
    // Re-saving the same grades and renaming are harmless.
    await api()
      .patch(path)
      .set(bearer(w.admin))
      .send({ bands: bands(45), name: 'Pass or fail' })
      .expect(200);

    const list = await api()
      .get('/api/exam-settings/grading-schemes')
      .set(bearer(w.admin))
      .expect(200);
    expect(list.body.find((s: any) => s.id === scheme.body.id)).toMatchObject({
      name: 'Pass or fail',
      finalizedResults: 1,
      problems: [],
    });
  });
});
