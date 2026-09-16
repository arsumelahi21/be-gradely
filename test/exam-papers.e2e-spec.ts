import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { addSecondSubject, seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * Exam papers are confidential. Every check here goes straight at the API: hiding a button
 * in the UI is not a control. Students, parents, other teachers, other schools and the
 * platform admin must all be refused, and no response or notification may reveal the file.
 */
describe('Exam paper security (e2e)', () => {
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

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const api = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const PAPER_LEAKS = [
    'maths-final.pdf',
    'sha256',
    '"paper"',
    'hasPaper',
    '/paper',
    '%PDF',
  ];

  async function world() {
    const cls = await seedClass({ studentCount: 2 });
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
      data: {
        parentId: parentProfile.id,
        studentId: cls.students[0].profile.id,
      },
    });
    // Same school, same section, different subject: a teacher with no claim on this paper.
    const other = await addSecondSubject(cls.school, cls.section.id);

    // School B, a complete second tenant.
    const b = await seedClass({ studentCount: 1 });
    const bAdmin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: b.school.id,
    });

    const tokens = {
      teacher: await tokenFor(app, cls.teacherUser),
      otherTeacher: await tokenFor(app, other.otherTeacherUser),
      admin: await tokenFor(app, admin),
      superAdmin: await tokenFor(app, superAdmin),
      student: await tokenFor(app, cls.students[0].user),
      parent: await tokenFor(app, parentUser),
      bAdmin: await tokenFor(app, bAdmin),
      bTeacher: await tokenFor(app, b.teacherUser),
      bStudent: await tokenFor(app, b.students[0].user),
    };

    // The principal cannot publish a termless examination, so the session gets a term up front.
    const term = await prisma.academicTerm.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: cls.academicYear.id,
        name: 'First Term',
      },
    });

    const created = await api()
      .post('/api/exams')
      .set(bearer(tokens.teacher))
      .send({
        title: 'Mid Term Examination',
        academicYearId: cls.academicYear.id,
        classGradeId: cls.classGrade.id,
        sectionId: cls.section.id,
        termId: term.id,
        subjects: [
          {
            sectionSubjectId: cls.sectionSubject.id,
            heldAt: '2026-10-12',
            startMin: 540,
            endMin: 660,
            venue: 'Hall 1',
            maxScore: 100,
            passingMarks: 40,
          },
        ],
      })
      .expect(201);
    const examId: string = created.body.id;
    const subjectId: string = created.body.subjects[0].id;
    const paperPath = `/api/exams/${examId}/subjects/${subjectId}/paper`;
    return {
      cls,
      term,
      admin,
      parentUser,
      other,
      b,
      tokens,
      examId,
      subjectId,
      paperPath,
    };
  }

  const upload = (
    path: string,
    token: string,
    body = pdf,
    filename = 'maths-final.pdf',
    contentType = 'application/pdf',
  ) =>
    api()
      .put(path)
      .set(bearer(token))
      .attach('paper', body, { filename, contentType });

  async function submitAndPublish(w: Awaited<ReturnType<typeof world>>) {
    await api()
      .post(`/api/exams/${w.examId}/submit`)
      .set(bearer(w.tokens.teacher))
      .expect(201);
    await api()
      .post(`/api/exams/${w.examId}/publish`)
      .set(bearer(w.tokens.admin))
      .expect(201);
  }

  it('TEST 2: the author uploads a PDF privately and can read it back', async () => {
    const w = await world();
    const res = await upload(w.paperPath, w.tokens.teacher).expect(200);
    expect(res.body).toMatchObject({
      fileName: 'maths-final.pdf',
      sizeBytes: pdf.length,
      replaced: false,
    });

    const row = await prisma.examPaper.findUniqueOrThrow({
      where: { examId: w.subjectId },
    });
    expect(row.schoolId).toBe(w.cls.school.id);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);

    const read = await api()
      .get(w.paperPath)
      .set(bearer(w.tokens.teacher))
      .buffer(true)
      .expect(200);
    expect(read.headers['content-type']).toContain('application/pdf');
    expect(read.headers['cache-control']).toContain('no-store');
    expect(read.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(read.body).equals(pdf)).toBe(true);
  });

  it('rejects non-PDF content, a disguised PDF and oversize files', async () => {
    const w = await world();
    await upload(
      w.paperPath,
      w.tokens.teacher,
      Buffer.from('hello'),
      'notes.txt',
      'text/plain',
    ).expect(400);
    await upload(
      w.paperPath,
      w.tokens.teacher,
      Buffer.from('MZ\x90\x00 not a pdf'),
      'virus.pdf',
    ).expect(400);
    await upload(
      w.paperPath,
      w.tokens.teacher,
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x25),
    ).expect(413);
    expect(await prisma.examPaper.count()).toBe(0);
  });

  it('TEST 3 & 4: students and parents get 403 on the paper, before and after publication', async () => {
    const w = await world();
    await upload(w.paperPath, w.tokens.teacher).expect(200);
    const childQuery = `?studentId=${w.cls.students[0].profile.id}`;

    await api().get(w.paperPath).set(bearer(w.tokens.student)).expect(403);
    await api()
      .get(w.paperPath + childQuery)
      .set(bearer(w.tokens.parent))
      .expect(403);

    await submitAndPublish(w);
    await api().get(w.paperPath).set(bearer(w.tokens.student)).expect(403);
    await api()
      .get(w.paperPath + childQuery)
      .set(bearer(w.tokens.parent))
      .expect(403);
    // Neither can upload or delete one either.
    await upload(w.paperPath, w.tokens.student).expect(403);
    await api().delete(w.paperPath).set(bearer(w.tokens.parent)).expect(403);
  });

  it('TEST 5: another teacher of the same section is refused', async () => {
    const w = await world();
    await upload(w.paperPath, w.tokens.teacher).expect(200);
    await api().get(w.paperPath).set(bearer(w.tokens.otherTeacher)).expect(403);
    await submitAndPublish(w);
    await api().get(w.paperPath).set(bearer(w.tokens.otherTeacher)).expect(403);
    await upload(w.paperPath, w.tokens.otherTeacher).expect(403);
  });

  it('TEST 16 & 17: other schools, the platform admin and tampered ids are all refused', async () => {
    const w = await world();
    await upload(w.paperPath, w.tokens.teacher).expect(200);
    await submitAndPublish(w);

    await api().get(w.paperPath).set(bearer(w.tokens.bAdmin)).expect(403);
    await api().get(w.paperPath).set(bearer(w.tokens.bTeacher)).expect(403);
    await api().get(w.paperPath).set(bearer(w.tokens.bStudent)).expect(403);
    await api().get(w.paperPath).set(bearer(w.tokens.superAdmin)).expect(403);
    await api().get(w.paperPath).expect(401);

    // Tampered ids: a random subject, a subject of another examination, a non-uuid.
    await api()
      .get(`/api/exams/${w.examId}/subjects/${randomUUID()}/paper`)
      .set(bearer(w.tokens.admin))
      .expect(404);
    await api()
      .get(`/api/exams/${randomUUID()}/subjects/${w.subjectId}/paper`)
      .set(bearer(w.tokens.admin))
      .expect(404);
    await api()
      .get(`/api/exams/${w.examId}/subjects/not-a-uuid/paper`)
      .set(bearer(w.tokens.admin))
      .expect(400);

    // The principal of the owning school can read it, and that access is audited without file data.
    await api().get(w.paperPath).set(bearer(w.tokens.admin)).expect(200);
    // The audit write is fire-and-forget, so wait for it rather than racing it.
    let audit: { metadata: unknown } | null = null;
    for (
      const deadline = Date.now() + 3000;
      !audit && Date.now() < deadline;
    ) {
      audit = await prisma.auditLog.findFirst({
        where: { action: 'EXAM_PAPER_VIEW', actorUserId: w.admin.id },
      });
      if (!audit) await new Promise((r) => setTimeout(r, 100));
    }
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit!.metadata)).not.toContain('maths-final.pdf');
  });

  it('never exposes the paper in student/parent responses or notifications', async () => {
    const w = await world();
    await upload(w.paperPath, w.tokens.teacher).expect(200);
    await submitAndPublish(w);
    const studentId = w.cls.students[0].profile.id;

    const bodies = [
      (
        await api()
          .get(`/api/exams/${w.examId}`)
          .set(bearer(w.tokens.student))
          .expect(200)
      ).text,
      (await api().get('/api/exams').set(bearer(w.tokens.student)).expect(200))
        .text,
      (
        await api()
          .get(`/api/exams/${w.examId}?studentId=${studentId}`)
          .set(bearer(w.tokens.parent))
          .expect(200)
      ).text,
      (
        await api()
          .get(`/api/exams?studentId=${studentId}`)
          .set(bearer(w.tokens.parent))
          .expect(200)
      ).text,
    ];
    for (const body of bodies) {
      expect(body).toContain('Mid Term Examination');
      for (const leak of PAPER_LEAKS) expect(body).not.toContain(leak);
    }

    // The listener writes rows asynchronously; wait for the publish fan-out to land.
    const deadline = Date.now() + 5000;
    let rows: Array<{ title: string; body: string; link: string | null }> = [];
    while (Date.now() < deadline) {
      rows = await prisma.notification.findMany({
        where: { type: 'EXAM_PUBLISHED' },
      });
      if (rows.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(rows.length).toBe(2);
    for (const n of rows) {
      const text = `${n.title} ${n.body} ${n.link}`;
      expect(text).toContain('Hall 1');
      for (const leak of PAPER_LEAKS) expect(text).not.toContain(leak);
    }
  });

  it('lets only the author replace or remove the paper, and only before review', async () => {
    const w = await world();
    await upload(w.paperPath, w.tokens.teacher).expect(200);
    const first = await prisma.examPaper.findUniqueOrThrow({
      where: { examId: w.subjectId },
    });

    const replaced = await upload(
      w.paperPath,
      w.tokens.teacher,
      Buffer.concat([pdf, Buffer.from('% v2\n')]),
    ).expect(200);
    expect(replaced.body.replaced).toBe(true);
    const second = await prisma.examPaper.findUniqueOrThrow({
      where: { examId: w.subjectId },
    });
    expect(second.sha256).not.toBe(first.sha256);
    expect(await prisma.examPaper.count()).toBe(1); // replaced in place, no orphaned copy

    // The principal requests changes instead of swapping the teacher's file.
    await upload(w.paperPath, w.tokens.admin).expect(403);

    await api()
      .post(`/api/exams/${w.examId}/submit`)
      .set(bearer(w.tokens.teacher))
      .expect(201);
    await upload(w.paperPath, w.tokens.teacher).expect(409);
    await api().delete(w.paperPath).set(bearer(w.tokens.teacher)).expect(409);
  });

  it('the principal views each subject paper while it waits for review, and the teacher replaces one after changes', async () => {
    const w = await world();
    // A second subject on the same examination, taught by the same teacher.
    const physics = await prisma.subject.create({
      data: { schoolId: w.cls.school.id, name: 'Physics' },
    });
    const physicsSection = await prisma.sectionSubject.create({
      data: {
        sectionId: w.cls.section.id,
        subjectId: physics.id,
        teacherId: w.cls.teacherProfile.id,
      },
    });
    const added = await api()
      .post(`/api/exams/${w.examId}/subjects`)
      .set(bearer(w.tokens.teacher))
      .send({
        sectionSubjectId: physicsSection.id,
        heldAt: '2026-10-13',
        startMin: 540,
        endMin: 660,
        maxScore: 50,
        passingMarks: 20,
      })
      .expect(201);
    const second = added.body.subjects.find(
      (s: { sectionSubjectId: string }) =>
        s.sectionSubjectId === physicsSection.id,
    );
    const secondPath = `/api/exams/${w.examId}/subjects/${second.id}/paper`;

    const mathsPdf = Buffer.concat([pdf, Buffer.from('% maths\n')]);
    const physicsPdf = Buffer.concat([pdf, Buffer.from('% physics\n')]);
    await upload(w.paperPath, w.tokens.teacher, mathsPdf, 'maths.pdf').expect(
      200,
    );
    await upload(
      secondPath,
      w.tokens.teacher,
      physicsPdf,
      'physics.pdf',
    ).expect(200);
    await api()
      .post(`/api/exams/${w.examId}/submit`)
      .set(bearer(w.tokens.teacher))
      .expect(201);

    // Exam Approvals: the pending detail offers the principal a view, never a change.
    const detail = await api()
      .get(`/api/exams/${w.examId}`)
      .set(bearer(w.tokens.admin))
      .expect(200);
    expect(detail.body.status).toBe('PENDING_REVIEW');
    expect(detail.body.permissions).toMatchObject({
      canViewPaper: true,
      canManagePaper: false,
      canReview: true,
    });
    const namesBySubject = Object.fromEntries(
      detail.body.subjects.map(
        (s: { id: string; paper: { fileName: string } | null }) => [
          s.id,
          s.paper?.fileName,
        ],
      ),
    );
    expect(namesBySubject).toEqual({
      [w.subjectId]: 'maths.pdf',
      [second.id]: 'physics.pdf',
    });

    // Each subject serves its own bytes, and only through its own examination.
    const readMaths = await api()
      .get(w.paperPath)
      .set(bearer(w.tokens.admin))
      .buffer(true)
      .expect(200);
    const readPhysics = await api()
      .get(secondPath)
      .set(bearer(w.tokens.admin))
      .buffer(true)
      .expect(200);
    expect(Buffer.from(readMaths.body).equals(mathsPdf)).toBe(true);
    expect(Buffer.from(readPhysics.body).equals(physicsPdf)).toBe(true);
    await api()
      .get(`/api/exams/${randomUUID()}/subjects/${second.id}/paper`)
      .set(bearer(w.tokens.admin))
      .expect(404);

    // Students and parents stay locked out while it is under review.
    await api().get(secondPath).set(bearer(w.tokens.student)).expect(403);
    await api().get(secondPath).set(bearer(w.tokens.parent)).expect(403);

    // Changes requested hands the paper back: the teacher replaces physics only.
    await api()
      .post(`/api/exams/${w.examId}/request-changes`)
      .set(bearer(w.tokens.admin))
      .send({ reason: 'Question 4 of the physics paper is ambiguous.' })
      .expect(201);
    const physicsV2 = Buffer.concat([pdf, Buffer.from('% physics v2\n')]);
    const replaced = await upload(
      secondPath,
      w.tokens.teacher,
      physicsV2,
      'physics-v2.pdf',
    ).expect(200);
    expect(replaced.body).toMatchObject({
      fileName: 'physics-v2.pdf',
      replaced: true,
    });

    const afterMaths = await api()
      .get(w.paperPath)
      .set(bearer(w.tokens.admin))
      .buffer(true)
      .expect(200);
    const afterPhysics = await api()
      .get(secondPath)
      .set(bearer(w.tokens.admin))
      .buffer(true)
      .expect(200);
    expect(Buffer.from(afterMaths.body).equals(mathsPdf)).toBe(true);
    expect(Buffer.from(afterPhysics.body).equals(physicsV2)).toBe(true);
    expect(await prisma.examPaper.count()).toBe(2);
  });

  it('removing a paper or deleting the draft leaves no bytes behind', async () => {
    const w = await world();
    await upload(w.paperPath, w.tokens.teacher).expect(200);
    await api().delete(w.paperPath).set(bearer(w.tokens.teacher)).expect(200);
    expect(await prisma.examPaper.count()).toBe(0);

    await upload(w.paperPath, w.tokens.teacher).expect(200);
    await api()
      .delete(`/api/exams/${w.examId}`)
      .set(bearer(w.tokens.teacher))
      .expect(200);
    expect(await prisma.examPaper.count()).toBe(0);
    expect(await prisma.examination.count()).toBe(0);
  });

  // Login and refresh now refuse deactivated users and suspended schools; a paper must not stay
  // reachable on an access token issued before that.
  it('refuses the paper to a deactivated author or a suspended school, even on a valid token', async () => {
    const w = await world();
    await upload(w.paperPath, w.tokens.teacher).expect(200);

    await prisma.user.update({
      where: { id: w.cls.teacherUser.id },
      data: { isActive: false },
    });
    await api().get(w.paperPath).set(bearer(w.tokens.teacher)).expect(403);
    await upload(w.paperPath, w.tokens.teacher).expect(403);
    await prisma.user.update({
      where: { id: w.cls.teacherUser.id },
      data: { isActive: true },
    });
    await api().get(w.paperPath).set(bearer(w.tokens.teacher)).expect(200);

    await prisma.school.update({
      where: { id: w.cls.school.id },
      data: { isActive: false },
    });
    await api().get(w.paperPath).set(bearer(w.tokens.admin)).expect(403);
    await api().get(w.paperPath).set(bearer(w.tokens.teacher)).expect(403);
    await api().delete(w.paperPath).set(bearer(w.tokens.teacher)).expect(403);
    // Bytes are untouched: suspension blocks access, it does not delete anything.
    expect(await prisma.examPaper.count()).toBe(1);
  });

  it('never returns credential columns from any exam response', async () => {
    const w = await world();
    await upload(w.paperPath, w.tokens.teacher).expect(200);
    const studentId = w.cls.students[0].profile.id;
    // Result extraction is always by session AND term.
    const scope = `academicYearId=${w.cls.academicYear.id}&termId=${w.term.id}`;
    const cardsPath = `/api/exams/sections/${w.cls.section.id}/result-cards?${scope}`;
    const staff = [
      `/api/exams/${w.examId}`,
      `/api/exams/${w.examId}/history`,
      '/api/exams',
      `/api/exams/${w.examId}/results`,
      `/api/exams/${w.examId}/subjects/${w.subjectId}/result`,
      `/api/exams/students/${studentId}/result-card?${scope}`,
      cardsPath,
    ];
    for (const path of staff) {
      const res = await api().get(path).set(bearer(w.tokens.admin)).expect(200);
      expect(res.text).not.toMatch(/passwordHash|refreshTokenHash|resetToken/);
    }
  });
});
