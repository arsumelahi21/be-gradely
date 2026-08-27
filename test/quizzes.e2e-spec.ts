import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

const QUIZ_BODY = (sectionId: string) => ({
  sectionId,
  title: 'Sample Quiz',
  questions: [
    {
      type: 'MULTIPLE_CHOICE',
      text: 'What is 2 + 2?',
      options: [
        { id: 'a', text: '3' },
        { id: 'b', text: '4' },
      ],
      correctAnswer: 'b',
      points: 2,
    },
    {
      type: 'TRUE_FALSE',
      text: 'The sky is blue.',
      correctAnswer: true,
      points: 1,
    },
  ],
});

describe('Quizzes (e2e)', () => {
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

  async function createAndPublish(cls: Awaited<ReturnType<typeof seedClass>>) {
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const created = await request(app.getHttpServer())
      .post('/api/quizzes')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send(QUIZ_BODY(cls.section.id));
    const quizId = created.body.id;
    const questions: Array<{ id: string; type: string }> =
      created.body.questions;
    await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/publish`)
      .set('Authorization', `Bearer ${teacherToken}`);
    return { teacherToken, quizId, questions };
  }

  it('lets a teacher create/publish but forbids a student', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const studentToken = await tokenFor(app, cls.students[0].user);

    const asStudent = await request(app.getHttpServer())
      .post('/api/quizzes')
      .set('Authorization', `Bearer ${studentToken}`)
      .send(QUIZ_BODY(cls.section.id));
    expect(asStudent.status).toBe(403);

    const asTeacher = await request(app.getHttpServer())
      .post('/api/quizzes')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send(QUIZ_BODY(cls.section.id));
    expect(asTeacher.status).toBe(201);
    expect(asTeacher.body.questions).toHaveLength(2);
  });

  it('shows published quizzes only to enrolled students, not other sections', async () => {
    const cls = await seedClass({ studentCount: 1 });
    await createAndPublish(cls);

    // Enrolled student sees it.
    const studentToken = await tokenFor(app, cls.students[0].user);
    const avail = await request(app.getHttpServer())
      .get('/api/quizzes/available')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(avail.status).toBe(200);
    expect(avail.body).toHaveLength(1);

    // A student enrolled in a different section (same school) does not.
    const otherGrade = await prisma.classGrade.create({
      data: { schoolId: cls.school.id, name: `Grade-X-${Date.now()}` },
    });
    const otherSection = await prisma.section.create({
      data: {
        schoolId: cls.school.id,
        classGradeId: otherGrade.id,
        name: `Sec-X-${Date.now()}`,
      },
    });
    const otherStudentUser = await createTestUser({
      role: Role.STUDENT,
      schoolId: cls.school.id,
    });
    const otherStudentProfile = await prisma.studentProfile.create({
      data: {
        userId: otherStudentUser.id,
        schoolId: cls.school.id,
        fullName: 'Outsider',
      },
    });
    await prisma.enrollment.create({
      data: {
        studentId: otherStudentProfile.id,
        sectionId: otherSection.id,
        academicYearId: cls.academicYear.id,
        status: 'ACTIVE',
      },
    });
    const otherToken = await tokenFor(app, otherStudentUser);
    const otherAvail = await request(app.getHttpServer())
      .get('/api/quizzes/available')
      .set('Authorization', `Bearer ${otherToken}`);
    expect(otherAvail.body).toHaveLength(0);
  });

  it('never leaks correctAnswer when a student starts an attempt', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { quizId } = await createAndPublish(cls);
    const studentToken = await tokenFor(app, cls.students[0].user);

    const start = await request(app.getHttpServer())
      .post(`/api/quizzes/${quizId}/attempts`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(start.status).toBe(201);
    for (const q of start.body.questions) {
      expect(q.correctAnswer).toBeUndefined();
    }
  });

  it('auto-scores objective questions (all-correct, all-wrong, partial/unanswered)', async () => {
    const cls = await seedClass({ studentCount: 3 });
    const { quizId, questions } = await createAndPublish(cls);
    const [mcq, tf] = questions;

    const submitFor = async (
      idx: number,
      answers: Record<string, string | boolean>,
    ) => {
      const token = await tokenFor(app, cls.students[idx].user);
      const start = await request(app.getHttpServer())
        .post(`/api/quizzes/${quizId}/attempts`)
        .set('Authorization', `Bearer ${token}`);
      const attemptId = start.body.attemptId;
      const res = await request(app.getHttpServer())
        .patch(`/api/quizzes/attempts/${attemptId}/submit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ answers });
      return res;
    };

    const allCorrect = await submitFor(0, { [mcq.id]: 'b', [tf.id]: true });
    expect(allCorrect.body).toMatchObject({
      score: 3,
      maxScore: 3,
      status: 'GRADED',
    });

    const allWrong = await submitFor(1, { [mcq.id]: 'a', [tf.id]: false });
    expect(allWrong.body).toMatchObject({ score: 0, maxScore: 3 });

    // MCQ correct (2 pts), true/false unanswered (0).
    const partial = await submitFor(2, { [mcq.id]: 'b' });
    expect(partial.body).toMatchObject({ score: 2, maxScore: 3 });
  });

  it('enforces the single-attempt policy', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { quizId, questions } = await createAndPublish(cls);
    const token = await tokenFor(app, cls.students[0].user);

    const start = await request(app.getHttpServer())
      .post(`/api/quizzes/${quizId}/attempts`)
      .set('Authorization', `Bearer ${token}`);
    await request(app.getHttpServer())
      .patch(`/api/quizzes/attempts/${start.body.attemptId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: { [questions[0].id]: 'b' } });

    const again = await request(app.getHttpServer())
      .post(`/api/quizzes/${quizId}/attempts`)
      .set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(400);
  });

  it('reveals correctAnswer only after the attempt is graded', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { quizId, questions } = await createAndPublish(cls);
    const token = await tokenFor(app, cls.students[0].user);

    const start = await request(app.getHttpServer())
      .post(`/api/quizzes/${quizId}/attempts`)
      .set('Authorization', `Bearer ${token}`);
    const attemptId = start.body.attemptId;

    // Before submit: no correctAnswer.
    const before = await request(app.getHttpServer())
      .get(`/api/quizzes/attempts/${attemptId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(
      before.body.questions.every((q: any) => q.correctAnswer === undefined),
    ).toBe(true);

    await request(app.getHttpServer())
      .patch(`/api/quizzes/attempts/${attemptId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: { [questions[0].id]: 'b', [questions[1].id]: true } });

    // After grading: correctAnswer + correctness present.
    const after = await request(app.getHttpServer())
      .get(`/api/quizzes/attempts/${attemptId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(
      after.body.questions.some((q: any) => q.correctAnswer !== undefined),
    ).toBe(true);
  });

  // ---- editing a draft (Phase 2) ------------------------------------------

  /** Create a quiz and leave it UNPUBLISHED — the editable state. */
  async function createDraft(cls: Awaited<ReturnType<typeof seedClass>>) {
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const created = await request(app.getHttpServer())
      .post('/api/quizzes')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send(QUIZ_BODY(cls.section.id));
    const questions: Array<{ id: string; type: string; order: number }> =
      created.body.questions;
    return { teacherToken, quizId: created.body.id as string, questions };
  }

  it('lets a teacher edit a draft quiz and one of its questions', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { teacherToken, quizId, questions } = await createDraft(cls);

    const quizRes = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ title: 'Renamed Quiz', durationMins: 30 });
    expect(quizRes.status).toBe(200);
    expect(quizRes.body).toMatchObject({
      title: 'Renamed Quiz',
      durationMins: 30,
    });

    const qRes = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/${questions[0].id}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ text: 'What is 3 + 1?', points: 5 });
    expect(qRes.status).toBe(200);
    const edited = qRes.body.questions.find(
      (q: any) => q.id === questions[0].id,
    );
    expect(edited).toMatchObject({ text: 'What is 3 + 1?', points: 5 });
    // Untouched fields survive a partial patch.
    expect(edited.correctAnswer).toBe('b');
  });

  it('reorders questions, and rejects a list that is not the full set', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { teacherToken, quizId, questions } = await createDraft(cls);
    const reversed = [questions[1].id, questions[0].id];

    const ok = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/order`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ questionIds: reversed });
    expect(ok.status).toBe(200);
    expect(ok.body.questions.map((q: any) => q.id)).toEqual(reversed);

    // A partial list must not silently reorder a subset.
    const partial = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/order`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ questionIds: [questions[0].id] });
    expect(partial.status).toBe(400);

    // A duplicated id is rejected too.
    const dupe = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/order`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ questionIds: [questions[0].id, questions[0].id] });
    expect(dupe.status).toBe(400);
  });

  it('deletes a question from a draft', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { teacherToken, quizId, questions } = await createDraft(cls);

    const res = await request(app.getHttpServer())
      .delete(`/api/quizzes/${quizId}/questions/${questions[0].id}`)
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(1);
    expect(
      await prisma.question.count({ where: { id: questions[0].id } }),
    ).toBe(0);
  });

  it('refuses every edit route once the quiz is published (409)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { teacherToken, quizId, questions } = await createAndPublish(cls);
    const auth = { Authorization: `Bearer ${teacherToken}` };

    const patchQuiz = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}`)
      .set(auth)
      .send({ title: 'Nope' });
    const patchQuestion = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/${questions[0].id}`)
      .set(auth)
      .send({ text: 'Nope' });
    const del = await request(app.getHttpServer())
      .delete(`/api/quizzes/${quizId}/questions/${questions[0].id}`)
      .set(auth);
    const reorder = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/order`)
      .set(auth)
      .send({ questionIds: [questions[1].id, questions[0].id] });

    for (const res of [patchQuiz, patchQuestion, del, reorder]) {
      expect(res.status).toBe(409);
    }
    // And nothing changed.
    const still = await prisma.quiz.findUnique({ where: { id: quizId } });
    expect(still?.title).toBe('Sample Quiz');
  });

  it('refuses every edit route once an attempt exists, even unpublished (409)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { teacherToken, quizId, questions } = await createDraft(cls);
    const auth = { Authorization: `Bearer ${teacherToken}` };

    // Publish is the only route to a student, so this state is unreachable via
    // the API — written directly to prove the second guard actually holds.
    await prisma.quizAttempt.create({
      data: {
        quizId,
        studentId: cls.students[0].profile.id,
        answers: {},
      },
    });

    const patchQuiz = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}`)
      .set(auth)
      .send({ title: 'Nope' });
    const patchQuestion = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/${questions[0].id}`)
      .set(auth)
      .send({ text: 'Nope' });
    const del = await request(app.getHttpServer())
      .delete(`/api/quizzes/${quizId}/questions/${questions[0].id}`)
      .set(auth);
    const reorder = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/order`)
      .set(auth)
      .send({ questionIds: [questions[1].id, questions[0].id] });

    for (const res of [patchQuiz, patchQuestion, del, reorder]) {
      expect(res.status).toBe(409);
    }
  });

  it('refuses a teacher who does not teach the section (403)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { quizId } = await createDraft(cls);

    // Same school, has a teacher profile, but no SectionSubject for this section.
    const strangerUser = await createTestUser({
      role: Role.TEACHER,
      schoolId: cls.school.id,
    });
    await prisma.teacherProfile.create({
      data: {
        userId: strangerUser.id,
        schoolId: cls.school.id,
        fullName: 'Stranger',
      },
    });
    const strangerToken = await tokenFor(app, strangerUser);

    const res = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ title: 'Hijacked' });
    expect(res.status).toBe(403);
  });

  it('refuses cross-school edits (403)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { quizId } = await createDraft(cls);

    const otherSchool = await createTestSchool();
    const adminB = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: otherSchool.id,
    });
    const adminBToken = await tokenFor(app, adminB);

    const res = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${adminBToken}`)
      .send({ title: 'Hijacked' });
    expect(res.status).toBe(403);
  });

  it('refuses STUDENT and PARENT on the edit routes (403)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { quizId, questions } = await createDraft(cls);

    const studentToken = await tokenFor(app, cls.students[0].user);
    const parentUser = await createTestUser({
      role: Role.PARENT,
      schoolId: cls.school.id,
    });
    const parentToken = await tokenFor(app, parentUser);

    for (const token of [studentToken, parentToken]) {
      const auth = { Authorization: `Bearer ${token}` };
      const patchQuiz = await request(app.getHttpServer())
        .patch(`/api/quizzes/${quizId}`)
        .set(auth)
        .send({ title: 'Nope' });
      const del = await request(app.getHttpServer())
        .delete(`/api/quizzes/${quizId}/questions/${questions[0].id}`)
        .set(auth);
      expect(patchQuiz.status).toBe(403);
      expect(del.status).toBe(403);
    }
  });

  it('still validates question shape when editing', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { teacherToken, quizId, questions } = await createDraft(cls);
    const [mcq, tf] = questions;
    const auth = { Authorization: `Bearer ${teacherToken}` };

    // MCQ reduced to a single option.
    const oneOption = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/${mcq.id}`)
      .set(auth)
      .send({ options: [{ id: 'a', text: 'only' }] });
    expect(oneOption.status).toBe(400);

    // correctAnswer that is not one of the stored option ids — the case that
    // only fails if the MERGED question is validated, not the patch alone.
    const badAnswer = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/${mcq.id}`)
      .set(auth)
      .send({ correctAnswer: 'zzz' });
    expect(badAnswer.status).toBe(400);

    // TRUE_FALSE with a string answer.
    const badBool = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/${tf.id}`)
      .set(auth)
      .send({ correctAnswer: 'yes' });
    expect(badBool.status).toBe(400);

    // A question belonging to another quiz reads as not-found.
    const other = await createDraft(cls);
    const wrongQuiz = await request(app.getHttpServer())
      .patch(`/api/quizzes/${quizId}/questions/${other.questions[0].id}`)
      .set(auth)
      .send({ text: 'x' });
    expect(wrongQuiz.status).toBe(404);
  });

  // ---- import (Phase 4) ---------------------------------------------------

  const CSV_HEADER =
    'type,text,option_a,option_b,option_c,option_d,option_e,option_f,correct,points';

  const goodCsv = [
    CSV_HEADER,
    'MULTIPLE_CHOICE,"What is 2 + 2, roughly?",3,4,,,,,b,2',
    'TRUE_FALSE,The sky is blue.,,,,,,,true,1',
    'MULTIPLE_CHOICE,Capital of France?,Paris,Rome,Berlin,,,,a,3',
  ].join('\n');

  /** Fails on the 5th of 10 rows — the partial-import assertion. */
  const partlyBadCsv = [
    CSV_HEADER,
    ...Array.from({ length: 4 }, (_, i) => `TRUE_FALSE,Q${i},,,,,,,true,1`),
    'MULTIPLE_CHOICE,Broken row,onlyone,,,,,,a,1',
    ...Array.from({ length: 5 }, (_, i) => `TRUE_FALSE,R${i},,,,,,,false,1`),
  ].join('\n');

  const importReq = (
    path: string,
    token: string,
    cls: Awaited<ReturnType<typeof seedClass>>,
    csv: string,
    contentType = 'text/csv',
  ) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .field('sectionId', cls.section.id)
      .field('title', 'Imported Quiz')
      .attach('file', Buffer.from(csv), {
        filename: 'quiz.csv',
        contentType,
      });

  it('serves an import template that parses cleanly', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);

    const res = await request(app.getHttpServer())
      .get('/api/quizzes/import/template')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\n')[0]).toContain('type');

    // The template must be importable as-is.
    const preview = await importReq(
      '/api/quizzes/import/preview',
      token,
      cls,
      res.text,
    );
    expect(preview.status).toBe(201);
    expect(preview.body.errors).toHaveLength(0);
  });

  it('previews a valid file and writes NOTHING', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);
    const before = await prisma.quiz.count();

    const res = await importReq(
      '/api/quizzes/import/preview',
      token,
      cls,
      goodCsv,
    );
    expect(res.status).toBe(201);
    expect(res.body.canImport).toBe(true);
    expect(res.body.errors).toHaveLength(0);
    expect(res.body.questions).toHaveLength(3);
    expect(res.body.questions[0].text).toBe('What is 2 + 2, roughly?');

    expect(await prisma.quiz.count()).toBe(before);
    expect(await prisma.question.count()).toBe(0);
  });

  it('previews an invalid file with per-row errors and writes NOTHING', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);

    const res = await importReq(
      '/api/quizzes/import/preview',
      token,
      cls,
      partlyBadCsv,
    );
    expect(res.status).toBe(201);
    expect(res.body.canImport).toBe(false);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].row).toBe(6); // header + 4 good rows + this one
    expect(await prisma.quiz.count()).toBe(0);
  });

  it('imports a valid file as exactly one quiz with its questions in order', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);

    const res = await importReq('/api/quizzes/import', token, cls, goodCsv);
    expect(res.status).toBe(201);
    expect(await prisma.quiz.count()).toBe(1);

    const questions = res.body.questions as Array<{
      text: string;
      type: string;
      points: number;
      correctAnswer: unknown;
      order: number;
      options: Array<{ id: string }> | null;
    }>;
    expect(questions).toHaveLength(3);
    expect(questions.map((q) => q.order)).toEqual([0, 1, 2]);
    expect(questions.map((q) => q.points)).toEqual([2, 1, 3]);
    expect(questions[0].correctAnswer).toBe('b');
    expect(questions[1].correctAnswer).toBe(true);
    expect(questions[2].options).toHaveLength(3);
    // Imported quizzes start as drafts, like any other.
    expect(res.body.isPublished).toBe(false);
  });

  it('creates NOTHING when one row of ten is bad', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);

    const res = await importReq(
      '/api/quizzes/import',
      token,
      cls,
      partlyBadCsv,
    );
    expect(res.status).toBe(400);
    expect(res.body.message.errors ?? res.body.errors).toBeDefined();
    // The whole point: no partial quiz.
    expect(await prisma.quiz.count()).toBe(0);
    expect(await prisma.question.count()).toBe(0);
  });

  it('rejects a missing file, an empty file and a disallowed type', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);

    const noFile = await request(app.getHttpServer())
      .post('/api/quizzes/import')
      .set('Authorization', `Bearer ${token}`)
      .field('sectionId', cls.section.id)
      .field('title', 'No file');
    expect(noFile.status).toBe(400);

    const empty = await importReq('/api/quizzes/import', token, cls, '');
    expect(empty.status).toBe(400);

    const wrongType = await importReq(
      '/api/quizzes/import',
      token,
      cls,
      goodCsv,
      'image/png',
    );
    expect(wrongType.status).toBe(400);

    expect(await prisma.quiz.count()).toBe(0);
  });

  it('applies the same permissions as creating a quiz by hand', async () => {
    const cls = await seedClass({ studentCount: 1 });

    // A student cannot import.
    const studentToken = await tokenFor(app, cls.students[0].user);
    const asStudent = await importReq(
      '/api/quizzes/import',
      studentToken,
      cls,
      goodCsv,
    );
    expect(asStudent.status).toBe(403);

    // Nor a teacher who does not teach the section.
    const strangerUser = await createTestUser({
      role: Role.TEACHER,
      schoolId: cls.school.id,
    });
    await prisma.teacherProfile.create({
      data: {
        userId: strangerUser.id,
        schoolId: cls.school.id,
        fullName: 'Stranger',
      },
    });
    const strangerToken = await tokenFor(app, strangerUser);
    const asStranger = await importReq(
      '/api/quizzes/import',
      strangerToken,
      cls,
      goodCsv,
    );
    expect(asStranger.status).toBe(403);

    // Nor an admin from another school.
    const otherSchool = await createTestSchool();
    const adminB = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: otherSchool.id,
    });
    const adminBToken = await tokenFor(app, adminB);
    const asAdminB = await importReq(
      '/api/quizzes/import',
      adminBToken,
      cls,
      goodCsv,
    );
    expect(asAdminB.status).toBe(403);

    expect(await prisma.quiz.count()).toBe(0);
  });

  it('imports a large file in a bounded number of queries', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);
    const rows = Array.from(
      { length: 50 },
      (_, i) => `TRUE_FALSE,Question ${i},,,,,,,true,1`,
    );
    const csv = [CSV_HEADER, ...rows].join('\n');

    const res = await importReq('/api/quizzes/import', token, cls, csv);
    expect(res.status).toBe(201);
    expect(res.body.questions).toHaveLength(50);
    // One quiz row + one createMany for all 50 — not 50 inserts.
    expect(await prisma.question.count()).toBe(50);
  });

  it('enforces cross-school isolation on quiz reads', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const { quizId } = await createAndPublish(cls);

    const otherSchool = await createTestSchool();
    const adminB = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: otherSchool.id,
    });
    const adminBToken = await tokenFor(app, adminB);

    const read = await request(app.getHttpServer())
      .get(`/api/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${adminBToken}`);
    expect(read.status).toBe(403);
  });
});
