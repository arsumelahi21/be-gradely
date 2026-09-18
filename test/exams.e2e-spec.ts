import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { addSecondSubject, seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';
import { NOTIFICATION_CREATE } from '../src/common/events/notification.events';

/**
 * Examination lifecycle against the real API and database: proposal, review cycles,
 * publication targeting, marks, calculation, finalization and report cards.
 */
describe('Examinations (e2e)', () => {
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

  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
  const api = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function world() {
    const cls = await seedClass({ studentCount: 2 });
    const [s0, s1] = cls.students;
    const other = await addSecondSubject(cls.school, cls.section.id);
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const superAdmin = await createTestUser({ role: Role.SUPER_ADMIN });

    const parentUser = await createTestUser({
      role: Role.PARENT,
      schoolId: cls.school.id,
    });
    const parentProfile = await prisma.parentProfile.create({
      data: { userId: parentUser.id, fullName: 'Parent' },
    });
    await prisma.parentStudent.create({
      data: { parentId: parentProfile.id, studentId: s0.profile.id },
    });

    // Student X: same class, different section. Student Y: same section, different session.
    const sectionB = await prisma.section.create({
      data: {
        schoolId: cls.school.id,
        classGradeId: cls.classGrade.id,
        name: 'B',
      },
    });
    const pastYear = await prisma.academicYear.create({
      data: {
        schoolId: cls.school.id,
        name: 'Past Session',
        code: `PAST${Date.now()}`,
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-12-31'),
      },
    });
    const makeStudent = async (
      name: string,
      sectionId: string,
      academicYearId: string,
    ) => {
      const user = await createTestUser({
        role: Role.STUDENT,
        schoolId: cls.school.id,
      });
      const profile = await prisma.studentProfile.create({
        data: { userId: user.id, schoolId: cls.school.id, fullName: name },
      });
      await prisma.enrollment.create({
        data: {
          studentId: profile.id,
          sectionId,
          academicYearId,
          status: 'ACTIVE',
        },
      });
      return { user, profile };
    };
    const studentX = await makeStudent(
      'Other Section',
      sectionB.id,
      cls.academicYear.id,
    );
    const studentY = await makeStudent(
      'Other Session',
      cls.section.id,
      pastYear.id,
    );

    // Publishing demands a term, so the session carries one throughout these flows.
    const term = await prisma.academicTerm.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: cls.academicYear.id,
        name: 'First Term',
      },
    });

    const tokens = {
      teacher: await tokenFor(app, cls.teacherUser),
      otherTeacher: await tokenFor(app, other.otherTeacherUser),
      admin: await tokenFor(app, admin),
      superAdmin: await tokenFor(app, superAdmin),
      s0: await tokenFor(app, s0.user),
      s1: await tokenFor(app, s1.user),
      parent: await tokenFor(app, parentUser),
      studentX: await tokenFor(app, studentX.user),
      studentY: await tokenFor(app, studentY.user),
    };
    return {
      cls,
      term,
      s0,
      s1,
      other,
      admin,
      parentUser,
      sectionB,
      studentX,
      studentY,
      tokens,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const subjectInput = (
    sectionSubjectId: string,
    over: Record<string, unknown> = {},
  ) => ({
    sectionSubjectId,
    heldAt: '2026-10-12',
    startMin: 540,
    endMin: 660,
    venue: 'Hall 1',
    maxScore: 100,
    passingMarks: 40,
    ...over,
  });

  async function teacherDraft(w: World, title = 'Mid Term Examination') {
    const res = await api()
      .post('/api/exams')
      .set(bearer(w.tokens.teacher))
      .send({
        title,
        academicYearId: w.cls.academicYear.id,
        classGradeId: w.cls.classGrade.id,
        sectionId: w.cls.section.id,
        termId: w.term.id,
        subjects: [subjectInput(w.cls.sectionSubject.id)],
      })
      .expect(201);
    return {
      id: res.body.id as string,
      subjectId: res.body.subjects[0].id as string,
      body: res.body,
    };
  }

  const uploadPaper = (examId: string, subjectId: string, token: string) =>
    api()
      .put(`/api/exams/${examId}/subjects/${subjectId}/paper`)
      .set(bearer(token))
      .attach('paper', pdf, {
        filename: 'paper.pdf',
        contentType: 'application/pdf',
      });

  /** An admin-authored, published two-subject examination (A taught by teacher, B by otherTeacher). */
  async function publishedTwoSubjectExam(w: World) {
    const created = await api()
      .post('/api/exams')
      .set(bearer(w.tokens.admin))
      .send({
        title: 'Final Term Examination',
        academicYearId: w.cls.academicYear.id,
        classGradeId: w.cls.classGrade.id,
        sectionId: w.cls.section.id,
        termId: w.term.id,
        subjects: [
          subjectInput(w.cls.sectionSubject.id),
          subjectInput(w.other.sectionSubject.id, { heldAt: '2026-10-13' }),
        ],
      })
      .expect(201);
    const id: string = created.body.id;
    const bySs = new Map<string, string>(
      created.body.subjects.map((s: any) => [s.sectionSubjectId, s.id]),
    );
    const subjectA = bySs.get(w.cls.sectionSubject.id)!;
    const subjectB = bySs.get(w.other.sectionSubject.id)!;
    await uploadPaper(id, subjectA, w.tokens.admin).expect(200);
    await uploadPaper(id, subjectB, w.tokens.admin).expect(200);
    await api()
      .post(`/api/exams/${id}/publish`)
      .set(bearer(w.tokens.admin))
      .expect(201);
    return { id, subjectA, subjectB };
  }

  function notificationSpy() {
    const spy = jest.spyOn(app.get(EventEmitter2), 'emit');
    return {
      events: (type: string) =>
        spy.mock.calls
          .filter((c) => c[0] === NOTIFICATION_CREATE && c[1].type === type)
          .map((c) => c[1]),
      restore: () => spy.mockRestore(),
    };
  }

  it('TEST 1: a teacher creates and edits a draft but can never publish it', async () => {
    const w = await world();
    const draft = await teacherDraft(w);
    expect(draft.body).toMatchObject({
      status: 'DRAFT',
      resultStatus: 'NOT_STARTED',
    });
    expect(draft.body.permissions).toMatchObject({
      canEdit: true,
      canSubmit: true,
      canPublish: false,
    });

    const patched = await api()
      .patch(`/api/exams/${draft.id}`)
      .set(bearer(w.tokens.teacher))
      .send({
        title: 'Mid Term Examination 2026',
        instructions: 'Bring a pencil',
      })
      .expect(200);
    expect(patched.body.title).toBe('Mid Term Examination 2026');

    await api()
      .post(`/api/exams/${draft.id}/publish`)
      .set(bearer(w.tokens.teacher))
      .expect(403);
    expect(
      (await prisma.examination.findUniqueOrThrow({ where: { id: draft.id } }))
        .status,
    ).toBe('DRAFT');

    // Scope: a subject they don't teach, a section they're not in, missing mandatory fields.
    await api()
      .post(`/api/exams/${draft.id}/subjects`)
      .set(bearer(w.tokens.teacher))
      .send(subjectInput(w.other.sectionSubject.id))
      .expect(403);
    await api()
      .post('/api/exams')
      .set(bearer(w.tokens.teacher))
      .send({
        title: 'X',
        academicYearId: w.cls.academicYear.id,
        classGradeId: w.cls.classGrade.id,
        sectionId: w.sectionB.id,
      })
      .expect(403);
    await api()
      .post('/api/exams')
      .set(bearer(w.tokens.teacher))
      .send({
        academicYearId: w.cls.academicYear.id,
        classGradeId: w.cls.classGrade.id,
        sectionId: w.cls.section.id,
      })
      .expect(400);

    const history = await api()
      .get(`/api/exams/${draft.id}/history`)
      .set(bearer(w.tokens.teacher))
      .expect(200);
    expect(history.body.map((e: any) => e.type)).toEqual([
      'CREATED',
      'UPDATED',
    ]);
  });

  it('accepts exam dates in past and future years, on create and on edit', async () => {
    const w = await world();
    // The date picker once stopped at the current calendar year; the API must not.
    const nextSession = await prisma.academicYear.create({
      data: {
        schoolId: w.cls.school.id,
        name: '2027-2028',
        code: `AY-2027-${Date.now()}`,
        startDate: new Date('2027-04-01'),
        endDate: new Date('2028-03-31'),
      },
    });
    const created = await api()
      .post('/api/exams')
      .set(bearer(w.tokens.teacher))
      .send({
        title: 'Spring Test',
        academicYearId: nextSession.id,
        classGradeId: w.cls.classGrade.id,
        sectionId: w.cls.section.id,
        subjects: [
          subjectInput(w.cls.sectionSubject.id, { heldAt: '2027-04-15' }),
        ],
      })
      .expect(201);
    const id: string = created.body.id;
    const subjectId: string = created.body.subjects[0].id;
    expect(created.body.subjects[0].heldAt).toMatch(/^2027-04-15/);

    for (const heldAt of [
      '2024-05-06',
      '2025-05-06',
      '2026-05-06',
      '2027-05-06',
      '2028-05-06',
    ]) {
      await api()
        .patch(`/api/exams/${id}/subjects/${subjectId}`)
        .set(bearer(w.tokens.teacher))
        .send({ heldAt })
        .expect(200);
      const reloaded = await api()
        .get(`/api/exams/${id}`)
        .set(bearer(w.tokens.teacher))
        .expect(200);
      expect(reloaded.body.subjects[0].heldAt).toMatch(
        new RegExp(`^${heldAt}`),
      );
    }
  });

  it('a proposal without an exam paper can be reviewed, rejected and published', async () => {
    const w = await world();
    const draft = await teacherDraft(w);
    expect(draft.body.subjects[0].hasPaper).toBe(false);

    const submitted = await api()
      .post(`/api/exams/${draft.id}/submit`)
      .set(bearer(w.tokens.teacher))
      .expect(201);
    expect(submitted.body.status).toBe('PENDING_REVIEW');
    await api()
      .post(`/api/exams/${draft.id}/request-changes`)
      .set(bearer(w.tokens.admin))
      .send({ reason: 'Please confirm the venue.' })
      .expect(201);
    await api()
      .post(`/api/exams/${draft.id}/submit`)
      .set(bearer(w.tokens.teacher))
      .expect(201);

    // No paper means nothing to open — never a placeholder document.
    const review = await api()
      .get(`/api/exams/${draft.id}`)
      .set(bearer(w.tokens.admin))
      .expect(200);
    expect(review.body.subjects[0].hasPaper).toBe(false);
    await api()
      .get(`/api/exams/${draft.id}/subjects/${draft.subjectId}/paper`)
      .set(bearer(w.tokens.admin))
      .expect(404);

    const published = await api()
      .post(`/api/exams/${draft.id}/publish`)
      .set(bearer(w.tokens.admin))
      .expect(201);
    expect(published.body.status).toBe('PUBLISHED');
    expect(
      await prisma.examPaper.count({ where: { examId: draft.subjectId } }),
    ).toBe(0);

    const second = await teacherDraft(w, 'Unit Test');
    await api()
      .post(`/api/exams/${second.id}/submit`)
      .set(bearer(w.tokens.teacher))
      .expect(201);
    await api()
      .post(`/api/exams/${second.id}/reject`)
      .set(bearer(w.tokens.admin))
      .send({ reason: 'This duplicates the mid term.' })
      .expect(201);
  });

  it('TEST 6-8: review cycles with reasons, principal edits and resubmission', async () => {
    const w = await world();
    const draft = await teacherDraft(w);
    const events = notificationSpy();

    await api()
      .patch(`/api/exams/${draft.id}/subjects/${draft.subjectId}`)
      .set(bearer(w.tokens.teacher))
      .send({ heldAt: null })
      .expect(200);
    const incomplete = await api()
      .post(`/api/exams/${draft.id}/submit`)
      .set(bearer(w.tokens.teacher))
      .expect(400);
    expect(incomplete.body.problems.join(' ')).toContain(
      'exam date is required',
    );
    expect(incomplete.body.problems.join(' ')).not.toContain('paper');
    await api()
      .patch(`/api/exams/${draft.id}/subjects/${draft.subjectId}`)
      .set(bearer(w.tokens.teacher))
      .send({ heldAt: '2026-10-12' })
      .expect(200);

    await uploadPaper(draft.id, draft.subjectId, w.tokens.teacher).expect(200);
    const submitted = await api()
      .post(`/api/exams/${draft.id}/submit`)
      .set(bearer(w.tokens.teacher))
      .expect(201);
    expect(submitted.body.status).toBe('PENDING_REVIEW');
    expect(submitted.body.permissions.canPublish).toBe(false);
    expect(events.events('EXAM_SUBMITTED')[0].userIds).toContain(w.admin.id);

    // Locked for the teacher while under review.
    await api()
      .patch(`/api/exams/${draft.id}`)
      .set(bearer(w.tokens.teacher))
      .send({ title: 'Nope' })
      .expect(409);

    // The principal sees it in approvals; another teacher does not see someone else's proposal.
    const approvals = await api()
      .get(`/api/exams?view=approvals&status=PENDING_REVIEW&page=1`)
      .set(bearer(w.tokens.admin))
      .expect(200);
    expect(approvals.body.items.map((e: any) => e.id)).toContain(draft.id);
    const otherList = await api()
      .get('/api/exams?page=1')
      .set(bearer(w.tokens.otherTeacher))
      .expect(200);
    expect(otherList.body.items.map((e: any) => e.id)).not.toContain(draft.id);
    await api()
      .get(`/api/exams/${draft.id}`)
      .set(bearer(w.tokens.otherTeacher))
      .expect(403);

    // TEST 7: full review screen, secure paper, and an edit during review.
    const review = await api()
      .get(`/api/exams/${draft.id}`)
      .set(bearer(w.tokens.admin))
      .expect(200);
    expect(review.body.permissions).toMatchObject({
      canReview: true,
      canViewPaper: true,
      canPublish: true,
    });
    await api()
      .get(`/api/exams/${draft.id}/subjects/${draft.subjectId}/paper`)
      .set(bearer(w.tokens.admin))
      .expect(200);
    await api()
      .patch(`/api/exams/${draft.id}/subjects/${draft.subjectId}`)
      .set(bearer(w.tokens.admin))
      .send({ venue: 'Main Hall' })
      .expect(200);

    // TEST 8: request changes needs a reason; the teacher gets it and resubmits.
    await api()
      .post(`/api/exams/${draft.id}/request-changes`)
      .set(bearer(w.tokens.admin))
      .send({})
      .expect(400);
    await api()
      .post(`/api/exams/${draft.id}/request-changes`)
      .set(bearer(w.tokens.admin))
      .send({ reason: '   ' })
      .expect(400);
    const reason = 'Please correct the exam date and upload the revised paper.';
    const changes = await api()
      .post(`/api/exams/${draft.id}/request-changes`)
      .set(bearer(w.tokens.admin))
      .send({ reason })
      .expect(201);
    expect(changes.body).toMatchObject({
      status: 'CHANGES_REQUESTED',
      reviewNote: reason,
    });
    const changeEvent = events.events('EXAM_CHANGES_REQUESTED')[0];
    expect(changeEvent.userIds).toEqual([w.cls.teacherUser.id]);
    expect(changeEvent.body).toContain(reason);

    await api()
      .patch(`/api/exams/${draft.id}/subjects/${draft.subjectId}`)
      .set(bearer(w.tokens.teacher))
      .send({ heldAt: '2026-10-19' })
      .expect(200);
    const replaced = await uploadPaper(
      draft.id,
      draft.subjectId,
      w.tokens.teacher,
    ).expect(200);
    expect(replaced.body.replaced).toBe(true);
    await api()
      .post(`/api/exams/${draft.id}/submit`)
      .set(bearer(w.tokens.teacher))
      .expect(201);

    const history = await api()
      .get(`/api/exams/${draft.id}/history`)
      .set(bearer(w.tokens.admin))
      .expect(200);
    const types = history.body.map((e: any) => e.type);
    expect(types.filter((t: string) => t === 'SUBMITTED')).toHaveLength(2);
    expect(types).toContain('CHANGES_REQUESTED');
    expect(
      history.body.find((e: any) => e.type === 'CHANGES_REQUESTED').reason,
    ).toBe(reason);
    events.restore();
  });

  it('TEST 9-10: publishing notifies the teacher and only that section and session', async () => {
    const w = await world();
    const draft = await teacherDraft(w);
    await uploadPaper(draft.id, draft.subjectId, w.tokens.teacher).expect(200);
    await api()
      .post(`/api/exams/${draft.id}/submit`)
      .set(bearer(w.tokens.teacher))
      .expect(201);

    const events = notificationSpy();
    const published = await api()
      .post(`/api/exams/${draft.id}/publish`)
      .set(bearer(w.tokens.admin))
      .expect(201);
    expect(published.body.status).toBe('PUBLISHED');

    const approved = events.events('EXAM_APPROVED')[0];
    expect(approved.userIds).toEqual([w.cls.teacherUser.id]);
    expect(approved.body).toContain('has been approved and published');

    const toStudents = events.events('EXAM_PUBLISHED')[0];
    expect(new Set(toStudents.userIds)).toEqual(
      new Set([w.s0.user.id, w.s1.user.id]),
    );
    expect(toStudents.userIds).not.toContain(w.studentX.user.id);
    expect(toStudents.userIds).not.toContain(w.studentY.user.id);
    expect(toStudents.body).toContain('Hall 1');
    expect(toStudents.body).toContain('09:00');
    expect(JSON.stringify(toStudents)).not.toMatch(/paper|\.pdf|sha256/i);
    events.restore();

    await api()
      .get(`/api/exams/${draft.id}`)
      .set(bearer(w.tokens.s0))
      .expect(200);
    await api()
      .get(`/api/exams/${draft.id}`)
      .set(bearer(w.tokens.studentX))
      .expect(403);
    await api()
      .get(`/api/exams/${draft.id}`)
      .set(bearer(w.tokens.studentY))
      .expect(403);
    const xList = await api()
      .get('/api/exams')
      .set(bearer(w.tokens.studentX))
      .expect(200);
    expect(xList.body.items).toHaveLength(0);

    await api()
      .post(`/api/exams/${draft.id}/publish`)
      .set(bearer(w.tokens.admin))
      .expect(409);
  });

  it('rejects with a reason, and a rejected proposal can never be published or marked', async () => {
    const w = await world();
    const draft = await teacherDraft(w);
    await uploadPaper(draft.id, draft.subjectId, w.tokens.teacher).expect(200);
    await api()
      .post(`/api/exams/${draft.id}/submit`)
      .set(bearer(w.tokens.teacher))
      .expect(201);

    await api()
      .post(`/api/exams/${draft.id}/reject`)
      .set(bearer(w.tokens.teacher))
      .send({ reason: 'x' })
      .expect(403);
    await api()
      .post(`/api/exams/${draft.id}/reject`)
      .set(bearer(w.tokens.admin))
      .send({})
      .expect(400);
    const rejected = await api()
      .post(`/api/exams/${draft.id}/reject`)
      .set(bearer(w.tokens.admin))
      .send({ reason: 'Duplicate of the mid term paper' })
      .expect(201);
    expect(rejected.body.status).toBe('REJECTED');

    await api()
      .post(`/api/exams/${draft.id}/publish`)
      .set(bearer(w.tokens.admin))
      .expect(409);
    await api()
      .patch(`/api/exams/${draft.id}`)
      .set(bearer(w.tokens.teacher))
      .send({ title: 'Again' })
      .expect(409);
    await api()
      .put(`/api/exams/${draft.id}/subjects/${draft.subjectId}/marks`)
      .set(bearer(w.tokens.admin))
      .send({ entries: [{ studentId: w.s0.profile.id, score: 50 }] })
      .expect(409);
  });

  it('TEST 11-13: marks entry, automatic results, remarks, finalize and reopen', async () => {
    const w = await world();
    const exam = await publishedTwoSubjectExam(w);
    const marksA = `/api/exams/${exam.id}/subjects/${exam.subjectA}/marks`;
    const marksB = `/api/exams/${exam.id}/subjects/${exam.subjectB}/marks`;

    // TEST 11: only authorized subjects, valid marks, draft saving.
    const roster = await api()
      .get(marksA)
      .set(bearer(w.tokens.teacher))
      .expect(200);
    expect(roster.body.editable).toBe(true);
    expect(roster.body.rows.map((r: any) => r.student.id).sort()).toEqual(
      [w.s0.profile.id, w.s1.profile.id].sort(),
    );
    await api().get(marksB).set(bearer(w.tokens.teacher)).expect(403);
    await api()
      .put(marksA)
      .set(bearer(w.tokens.otherTeacher))
      .send({ entries: [{ studentId: w.s0.profile.id, score: 10 }] })
      .expect(403);
    await api().get(marksA).set(bearer(w.tokens.s0)).expect(403);

    await api()
      .put(marksA)
      .set(bearer(w.tokens.teacher))
      .send({ entries: [{ studentId: w.s0.profile.id, score: 105 }] })
      .expect(400);
    await api()
      .put(marksA)
      .set(bearer(w.tokens.teacher))
      .send({ entries: [{ studentId: w.s0.profile.id, score: -1 }] })
      .expect(400);
    await api()
      .put(marksA)
      .set(bearer(w.tokens.teacher))
      .send({ entries: [{ studentId: w.studentX.profile.id, score: 50 }] })
      .expect(400);

    await api()
      .put(marksA)
      .set(bearer(w.tokens.teacher))
      .send({ entries: [{ studentId: w.s0.profile.id, score: 85 }] })
      .expect(200);
    expect(
      (await prisma.examination.findUniqueOrThrow({ where: { id: exam.id } }))
        .resultStatus,
    ).toBe('IN_PROGRESS');
    const resaved = await api()
      .put(marksA)
      .set(bearer(w.tokens.teacher))
      .send({
        entries: [
          { studentId: w.s0.profile.id, score: 86, remarks: 'Strong work' },
          { studentId: w.s1.profile.id, score: 30 },
        ],
      })
      .expect(200);
    expect(
      resaved.body.rows.find((r: any) => r.student.id === w.s0.profile.id),
    ).toMatchObject({ score: 86, remarks: 'Strong work' });

    // Finalizing with subject B still empty is refused and names the gap.
    const early = await api()
      .post(`/api/exams/${exam.id}/results/finalize`)
      .set(bearer(w.tokens.admin))
      .expect(409);
    expect(early.body.incompleteStudents).toHaveLength(2);

    await api()
      .put(marksB)
      .set(bearer(w.tokens.otherTeacher))
      .send({
        entries: [
          { studentId: w.s0.profile.id, score: 90 },
          { studentId: w.s1.profile.id, score: 90 },
        ],
      })
      .expect(200);

    // TEST 12: 86+90 = 176/200 = 88% A pass; 30+90 = 120/200 = 60% C but fails subject A.
    const sheet = await api()
      .get(`/api/exams/${exam.id}/results`)
      .set(bearer(w.tokens.admin))
      .expect(200);
    const row0 = sheet.body.rows.find(
      (r: any) => r.student.id === w.s0.profile.id,
    );
    const row1 = sheet.body.rows.find(
      (r: any) => r.student.id === w.s1.profile.id,
    );
    expect(row0).toMatchObject({
      totalObtained: 176,
      totalMax: 200,
      percentage: 88,
      grade: 'A',
      passed: true,
      position: 1,
      complete: true,
    });
    expect(row1).toMatchObject({
      totalObtained: 120,
      totalMax: 200,
      percentage: 60,
      grade: 'C',
      passed: false,
      position: 2,
    });
    expect(row1.failedSubjects).toHaveLength(1);
    expect(sheet.body.issues).toMatchObject({
      missingMarks: 0,
      invalidMarks: 0,
      incompleteStudents: 0,
      failedStudents: 1,
    });
    expect(sheet.body.summary).toMatchObject({
      totalStudents: 2,
      passed: 1,
      failed: 1,
      averagePercentage: 74,
      highestPercentage: 88,
      lowestPercentage: 60,
    });

    const summary = await api()
      .get(`/api/exams/${exam.id}/summary`)
      .set(bearer(w.tokens.admin))
      .expect(200);
    expect(summary.body.gradeDistribution.filter((g: any) => g.count)).toEqual([
      expect.objectContaining({ label: 'A', count: 1 }),
      expect.objectContaining({ label: 'C', count: 1 }),
    ]);

    // Remarks: class teacher only for class remarks, principal for principal remarks.
    const remarks = `/api/exams/${exam.id}/results/remarks`;
    await api()
      .put(remarks)
      .set(bearer(w.tokens.teacher))
      .send({
        entries: [
          { studentId: w.s0.profile.id, classTeacherRemarks: 'Great term' },
        ],
      })
      .expect(403);
    await prisma.sectionTeacher.create({
      data: {
        sectionId: w.cls.section.id,
        teacherId: w.cls.teacherProfile.id,
        isPrimary: true,
      },
    });
    await api()
      .put(remarks)
      .set(bearer(w.tokens.teacher))
      .send({
        entries: [
          { studentId: w.s0.profile.id, classTeacherRemarks: 'Great term' },
        ],
      })
      .expect(200);
    await api()
      .put(remarks)
      .set(bearer(w.tokens.teacher))
      .send({
        entries: [{ studentId: w.s0.profile.id, principalRemarks: 'Nope' }],
      })
      .expect(403);
    await api()
      .put(remarks)
      .set(bearer(w.tokens.admin))
      .send({
        entries: [
          { studentId: w.s0.profile.id, principalRemarks: 'Well done' },
        ],
      })
      .expect(200);

    // TEST 13: finalize (principal only), then everything locks.
    await api()
      .post(`/api/exams/${exam.id}/results/finalize`)
      .set(bearer(w.tokens.teacher))
      .expect(403);
    const events = notificationSpy();
    const finalized = await api()
      .post(`/api/exams/${exam.id}/results/finalize`)
      .set(bearer(w.tokens.admin))
      .expect(201);
    expect(finalized.body.examination.resultStatus).toBe('FINALIZED');
    expect(new Set(events.events('EXAM_RESULT')[0].userIds)).toEqual(
      new Set([w.s0.user.id, w.s1.user.id, w.parentUser.id]),
    );
    events.restore();

    const snapshots = await prisma.examinationResult.findMany({
      where: { examinationId: exam.id },
      orderBy: { position: 'asc' },
    });
    expect(
      snapshots.map((s) => [
        s.studentId,
        s.position,
        s.percentage,
        s.grade,
        s.passed,
      ]),
    ).toEqual([
      [w.s0.profile.id, 1, 88, 'A', true],
      [w.s1.profile.id, 2, 60, 'C', false],
    ]);
    const gradeA = await prisma.examResult.findUniqueOrThrow({
      where: {
        examId_studentId: { examId: exam.subjectA, studentId: w.s1.profile.id },
      },
    });
    expect(gradeA.grade).toBe('F');

    await api()
      .put(marksA)
      .set(bearer(w.tokens.teacher))
      .send({ entries: [{ studentId: w.s0.profile.id, score: 100 }] })
      .expect(409);
    await api()
      .put(marksA)
      .set(bearer(w.tokens.admin))
      .send({ entries: [{ studentId: w.s0.profile.id, score: 100 }] })
      .expect(409);
    await api()
      .put(remarks)
      .set(bearer(w.tokens.admin))
      .send({
        entries: [{ studentId: w.s0.profile.id, principalRemarks: 'Changed' }],
      })
      .expect(409);
    await api()
      .post(`/api/exams/${exam.id}/results/finalize`)
      .set(bearer(w.tokens.admin))
      .expect(409);

    // Reopen needs the principal and a reason; marks become editable again.
    await api()
      .post(`/api/exams/${exam.id}/results/reopen`)
      .set(bearer(w.tokens.teacher))
      .send({ reason: 'x' })
      .expect(403);
    await api()
      .post(`/api/exams/${exam.id}/results/reopen`)
      .set(bearer(w.tokens.admin))
      .send({})
      .expect(400);
    const reopened = await api()
      .post(`/api/exams/${exam.id}/results/reopen`)
      .set(bearer(w.tokens.admin))
      .send({ reason: 'Re-marking subject A' })
      .expect(201);
    expect(reopened.body.examination.resultStatus).toBe('IN_PROGRESS');
    await api()
      .put(marksA)
      .set(bearer(w.tokens.teacher))
      .send({ entries: [{ studentId: w.s1.profile.id, score: 41 }] })
      .expect(200);
    await api()
      .post(`/api/exams/${exam.id}/results/finalize`)
      .set(bearer(w.tokens.admin))
      .expect(201);
    const s1Final = await prisma.examinationResult.findUniqueOrThrow({
      where: {
        examinationId_studentId: {
          examinationId: exam.id,
          studentId: w.s1.profile.id,
        },
      },
    });
    expect(s1Final).toMatchObject({ totalObtained: 131, passed: true });
  });

  it('TEST 14: report cards show only finalized, own results with the right values', async () => {
    const w = await world();
    const exam = await publishedTwoSubjectExam(w);
    await api()
      .put(`/api/exams/${exam.id}/subjects/${exam.subjectA}/marks`)
      .set(bearer(w.tokens.teacher))
      .send({
        entries: [
          { studentId: w.s0.profile.id, score: 86 },
          { studentId: w.s1.profile.id, isAbsent: true },
        ],
      })
      .expect(200);
    await api()
      .put(`/api/exams/${exam.id}/subjects/${exam.subjectB}/marks`)
      .set(bearer(w.tokens.otherTeacher))
      .send({
        entries: [
          { studentId: w.s0.profile.id, score: 90 },
          { studentId: w.s1.profile.id, score: 70 },
        ],
      })
      .expect(200);

    const cardPath = `/api/exams/${exam.id}/report-cards`;
    await api().get(cardPath).set(bearer(w.tokens.s0)).expect(403); // not finalized yet
    const provisional = await api()
      .get(cardPath)
      .set(bearer(w.tokens.admin))
      .expect(200);
    expect(provisional.body.examination.provisional).toBe(true);

    await api()
      .post(`/api/exams/${exam.id}/results/finalize`)
      .set(bearer(w.tokens.admin))
      .expect(201);

    const own = await api().get(cardPath).set(bearer(w.tokens.s0)).expect(200);
    expect(own.body.cards).toHaveLength(1);
    const card = own.body.cards[0];
    expect(own.body.school.name).toBe(w.cls.school.name);
    expect(own.body.examination).toMatchObject({
      title: 'Final Term Examination',
      className: w.cls.classGrade.name,
      sectionName: w.cls.section.name,
      academicYear: { name: w.cls.academicYear.name },
      provisional: false,
    });
    expect(card).toMatchObject({
      student: { id: w.s0.profile.id },
      totalObtained: 176,
      totalMax: 200,
      percentage: 88,
      grade: 'A',
      passed: true,
      position: 1,
      classSize: 2,
    });
    expect(card.subjects.map((s: any) => [s.obtained, s.maxScore])).toEqual([
      [86, 100],
      [90, 100],
    ]);

    await api()
      .get(`${cardPath}?studentId=${w.s1.profile.id}`)
      .set(bearer(w.tokens.s0))
      .expect(403);
    await api()
      .get(`${cardPath}?studentId=${w.s0.profile.id}`)
      .set(bearer(w.tokens.parent))
      .expect(200);
    await api()
      .get(`${cardPath}?studentId=${w.s1.profile.id}`)
      .set(bearer(w.tokens.parent))
      .expect(403);

    const absentee = await api()
      .get(`${cardPath}?studentId=${w.s1.profile.id}`)
      .set(bearer(w.tokens.admin))
      .expect(200);
    // Absent in A counts 0/100: 70/200 = 35%, an F, and a failed subject.
    expect(absentee.body.cards[0]).toMatchObject({
      totalObtained: 70,
      percentage: 35,
      passed: false,
      grade: 'F',
    });
    expect(absentee.body.cards[0].subjects[0]).toMatchObject({
      isAbsent: true,
      obtained: 0,
    });

    const all = await api()
      .get(cardPath)
      .set(bearer(w.tokens.admin))
      .expect(200);
    expect(all.body.cards).toHaveLength(2);

    const mine = await api()
      .get('/api/exams/results/me')
      .set(bearer(w.tokens.s0))
      .expect(200);
    expect(mine.body).toEqual([
      expect.objectContaining({ percentage: 88, grade: 'A', position: 1 }),
    ]);
  });

  it('keeps the platform admin to read-only metadata', async () => {
    const w = await world();
    await api().get('/api/exams').set(bearer(w.tokens.superAdmin)).expect(400);
    await api()
      .get(`/api/exams?schoolId=${w.cls.school.id}&page=1`)
      .set(bearer(w.tokens.superAdmin))
      .expect(200);
    const draft = await teacherDraft(w);
    await api()
      .post(`/api/exams/${draft.id}/publish`)
      .set(bearer(w.tokens.superAdmin))
      .expect(403);
    await api()
      .patch(`/api/exams/${draft.id}`)
      .set(bearer(w.tokens.superAdmin))
      .send({ title: 'x' })
      .expect(403);
  });
});
