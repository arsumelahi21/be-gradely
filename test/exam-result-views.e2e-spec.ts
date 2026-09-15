import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { addSecondSubject, seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * The three result views: a subject register, the class matrix and a student's result card.
 * Access is re-checked on every call — a teacher reaches their own published subject and
 * nothing else, and no school ever sees another's results.
 */
describe('Result views (e2e)', () => {
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
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  type Subject = { id: string; sectionSubjectId: string };

  async function world() {
    const cls = await seedClass({ studentCount: 4 });
    const second = await addSecondSubject(cls.school, cls.section.id);
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
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
    const b = await seedClass({ studentCount: 1 });
    const bAdmin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: b.school.id,
    });

    // Roll numbers deliberately out of creation order: the register must sort by roll.
    const rolls = ['0003', '0001', '0002', '0004'];
    for (const [i, s] of cls.students.entries()) {
      await prisma.studentProfile.update({
        where: { id: s.profile.id },
        data: { rollNo: rolls[i], fullName: `Student ${rolls[i]}` },
      });
    }
    const byRoll = (roll: string) => cls.students[rolls.indexOf(roll)].profile;

    const tokens = {
      teacher: await tokenFor(app, cls.teacherUser),
      science: await tokenFor(app, second.otherTeacherUser),
      stranger: await tokenFor(app, strangerUser),
      admin: await tokenFor(app, admin),
      bAdmin: await tokenFor(app, bAdmin),
      bTeacher: await tokenFor(app, b.teacherUser),
      student: await tokenFor(app, cls.students[0].user),
    };

    // The principal owns an examination spanning both teachers subjects.
    const created = await api()
      .post('/api/exams')
      .set(bearer(tokens.admin))
      .send({
        title: 'Mid Term',
        academicYearId: cls.academicYear.id,
        classGradeId: cls.classGrade.id,
        sectionId: cls.section.id,
        subjects: [
          {
            sectionSubjectId: cls.sectionSubject.id,
            heldAt: '2026-10-12',
            maxScore: 100,
            passingMarks: 40,
          },
          {
            sectionSubjectId: second.sectionSubject.id,
            heldAt: '2026-10-13',
            maxScore: 50,
            passingMarks: 25,
          },
        ],
      })
      .expect(201);
    const examId: string = created.body.id;
    const subjects: Subject[] = created.body.subjects;
    const maths = subjects.find(
      (s) => s.sectionSubjectId === cls.sectionSubject.id,
    )!;
    const science = subjects.find(
      (s) => s.sectionSubjectId === second.sectionSubject.id,
    )!;

    for (const s of [maths, science]) {
      await api()
        .put(`/api/exams/${examId}/subjects/${s.id}/paper`)
        .set(bearer(tokens.admin))
        .attach('paper', pdf, {
          filename: 'paper.pdf',
          contentType: 'application/pdf',
        })
        .expect(200);
    }
    await api()
      .post(`/api/exams/${examId}/publish`)
      .set(bearer(tokens.admin))
      .expect(201);

    await api()
      .put(`/api/exams/${examId}/subjects/${maths.id}/marks`)
      .set(bearer(tokens.teacher))
      .send({
        entries: [
          { studentId: byRoll('0001').id, score: 87 },
          { studentId: byRoll('0002').id, score: 76 },
          { studentId: byRoll('0003').id, isAbsent: true },
        ],
      })
      .expect(200);
    await api()
      .put(`/api/exams/${examId}/subjects/${science.id}/marks`)
      .set(bearer(tokens.science))
      .send({
        entries: [
          { studentId: byRoll('0001').id, score: 45 },
          { studentId: byRoll('0002').id, score: 20 },
        ],
      })
      .expect(200);

    return { cls, second, b, tokens, examId, maths, science, byRoll };
  }

  const register = (examId: string, subjectId: string) =>
    `/api/exams/${examId}/subjects/${subjectId}/result`;

  describe('subject result register', () => {
    it('gives the subject teacher their register: roll order, totals, obtained marks and grades', async () => {
      const w = await world();
      const res = await api()
        .get(register(w.examId, w.maths.id))
        .set(bearer(w.tokens.teacher))
        .expect(200);

      expect(res.body.subject).toMatchObject({
        label: w.cls.subject.name,
        maxScore: 100,
        passingMarks: 40,
      });
      expect(res.body.rows.map((r: any) => r.student.rollNo)).toEqual([
        '0001',
        '0002',
        '0003',
        '0004',
      ]);

      const [first, second, absent, missing] = res.body.rows;
      expect(first).toMatchObject({
        obtained: 87,
        grade: 'A',
        passed: true,
        isAbsent: false,
      });
      expect(second).toMatchObject({ obtained: 76, grade: 'B', passed: true });
      expect(absent).toMatchObject({
        isAbsent: true,
        passed: false,
        state: 'ABSENT',
      });
      expect(missing).toMatchObject({
        obtained: null,
        grade: null,
        state: 'MISSING',
      });
      expect(res.body.summary).toMatchObject({
        students: 4,
        entered: 3,
        absent: 1,
        missing: 1,
        passed: 2,
        highest: 87,
        lowest: 76,
      });
      // The printed sheet needs the school's own name, never a hardcoded one.
      expect(res.body.school.name).toBe(w.cls.school.name);
    });

    it('refuses a teacher who does not teach that subject, in either direction', async () => {
      const w = await world();
      // The science teacher may read science, never maths.
      await api()
        .get(register(w.examId, w.science.id))
        .set(bearer(w.tokens.science))
        .expect(200);
      await api()
        .get(register(w.examId, w.maths.id))
        .set(bearer(w.tokens.science))
        .expect(403);
      // A colleague with no subject in this examination is refused both.
      await api()
        .get(register(w.examId, w.maths.id))
        .set(bearer(w.tokens.stranger))
        .expect(403);
      await api()
        .get(register(w.examId, w.science.id))
        .set(bearer(w.tokens.stranger))
        .expect(403);
    });

    it('refuses a teacher before the examination is published, but not the principal', async () => {
      const w = await world();
      const draft = await api()
        .post('/api/exams')
        .set(bearer(w.tokens.teacher))
        .send({
          title: 'Unit Test (draft)',
          academicYearId: w.cls.academicYear.id,
          classGradeId: w.cls.classGrade.id,
          sectionId: w.cls.section.id,
          subjects: [
            {
              sectionSubjectId: w.cls.sectionSubject.id,
              heldAt: '2026-11-02',
              maxScore: 20,
            },
          ],
        })
        .expect(201);

      const path = register(draft.body.id, draft.body.subjects[0].id);
      await api().get(path).set(bearer(w.tokens.teacher)).expect(403);
      await api().get(path).set(bearer(w.tokens.admin)).expect(200);
    });

    it('serves the principal any subject, and no other school or role at all', async () => {
      const w = await world();
      for (const subject of [w.maths, w.science]) {
        await api()
          .get(register(w.examId, subject.id))
          .set(bearer(w.tokens.admin))
          .expect(200);
      }
      await api()
        .get(register(w.examId, w.maths.id))
        .set(bearer(w.tokens.bAdmin))
        .expect(403);
      await api()
        .get(register(w.examId, w.maths.id))
        .set(bearer(w.tokens.bTeacher))
        .expect(403);
      await api()
        .get(register(w.examId, w.maths.id))
        .set(bearer(w.tokens.student))
        .expect(403);
      await api().get(register(w.examId, w.maths.id)).expect(401);
      await api()
        .get(register(w.examId, randomUUID()))
        .set(bearer(w.tokens.admin))
        .expect(404);
    });
  });

  describe('class result matrix', () => {
    it('returns students as rows and subjects as columns, each column carrying its own total', async () => {
      const w = await world();
      const res = await api()
        .get(`/api/exams/${w.examId}/results`)
        .set(bearer(w.tokens.admin))
        .expect(200);

      expect(res.body.school.name).toBe(w.cls.school.name);
      expect(res.body.subjects.map((s: any) => s.maxScore)).toEqual([100, 50]);
      expect(res.body.rows.map((r: any) => r.student.rollNo)).toEqual([
        '0001',
        '0002',
        '0003',
        '0004',
      ]);

      const top = res.body.rows[0];
      expect(top.subjects.map((c: any) => c.obtained)).toEqual([87, 45]);
      expect(top).toMatchObject({
        totalObtained: 132,
        totalMax: 150,
        percentage: 88,
        grade: 'A',
        passed: true,
      });
      // 20/50 is below the 25 pass mark, so the whole result fails.
      expect(res.body.rows[1]).toMatchObject({
        totalObtained: 96,
        passed: false,
      });
    });

    it('is refused across schools', async () => {
      const w = await world();
      await api()
        .get(`/api/exams/${w.examId}/results`)
        .set(bearer(w.tokens.bAdmin))
        .expect(403);
    });
  });

  describe('student result card', () => {
    const card = (studentId: string, query = '') =>
      `/api/exams/students/${studentId}/result-card${query}`;

    it('covers every examination the student sat, with subject rows and an overall total', async () => {
      const w = await world();
      const student = w.byRoll('0001');
      const res = await api()
        .get(card(student.id, `?academicYearId=${w.cls.academicYear.id}`))
        .set(bearer(w.tokens.admin))
        .expect(200);

      expect(res.body.student).toMatchObject({
        id: student.id,
        rollNo: '0001',
      });
      expect(res.body.placement).toMatchObject({
        className: w.cls.classGrade.name,
        sectionName: w.cls.section.name,
      });
      expect(res.body.exams).toHaveLength(1);
      const exam = res.body.exams[0];
      expect(exam.title).toBe('Mid Term');
      expect(
        exam.subjects.map((s: any) => [s.maxScore, s.obtained, s.grade]),
      ).toEqual([
        [100, 87, 'A'],
        [50, 45, 'A+'],
      ]);
      expect(exam.totals).toMatchObject({
        totalObtained: 132,
        totalMax: 150,
        grade: 'A',
        passed: true,
      });
      expect(res.body.overall).toMatchObject({
        examCount: 1,
        totalObtained: 132,
        totalMax: 150,
        percentage: 88,
        grade: 'A',
        passed: true,
      });
      // Nobody else rides along: only this student, and only their own marks.
      const other = w.byRoll('0002');
      expect(JSON.stringify(res.body)).not.toContain(other.id);
      expect(JSON.stringify(res.body)).not.toContain(other.fullName);
      expect(exam.subjects.map((s: any) => s.obtained)).toEqual([87, 45]);
    });

    it('invents nothing for a student with no marks, and keeps sessions apart', async () => {
      const w = await world();
      const untested = await api()
        .get(
          card(w.byRoll('0004').id, `?academicYearId=${w.cls.academicYear.id}`),
        )
        .set(bearer(w.tokens.admin))
        .expect(200);
      expect(untested.body.exams).toEqual([]);
      expect(untested.body.overall).toBeNull();

      // A session the student was never enrolled in returns nothing of theirs.
      const otherYear = await prisma.academicYear.create({
        data: {
          schoolId: w.cls.school.id,
          name: 'AY-other',
          code: `AYO${Date.now()}`,
          startDate: new Date('2027-01-01'),
          endDate: new Date('2027-12-31'),
        },
      });
      const elsewhere = await api()
        .get(card(w.byRoll('0001').id, `?academicYearId=${otherYear.id}`))
        .set(bearer(w.tokens.admin))
        .expect(200);
      expect(elsewhere.body.exams).toEqual([]);
    });

    it('is principal-only and tenant-scoped', async () => {
      const w = await world();
      const student = w.byRoll('0001');
      await api()
        .get(card(student.id))
        .set(bearer(w.tokens.bAdmin))
        .expect(403);
      await api()
        .get(card(w.b.students[0].profile.id))
        .set(bearer(w.tokens.admin))
        .expect(403);
      await api()
        .get(card(student.id))
        .set(bearer(w.tokens.teacher))
        .expect(403);
      await api()
        .get(card(student.id))
        .set(bearer(w.tokens.student))
        .expect(403);
      await api()
        .get(card(randomUUID()))
        .set(bearer(w.tokens.admin))
        .expect(404);
      await api().get(card(student.id)).expect(401);
    });
  });

  describe('section result cards (print all)', () => {
    const all = (sectionId: string, query: string) =>
      `/api/exams/sections/${sectionId}/result-cards${query}`;

    it('returns one card per student in the section, in roll order, each with only their own marks', async () => {
      const w = await world();
      const res = await api()
        .get(all(w.cls.section.id, `?academicYearId=${w.cls.academicYear.id}`))
        .set(bearer(w.tokens.admin))
        .expect(200);

      expect(res.body.school.name).toBe(w.cls.school.name);
      expect(res.body.placement).toMatchObject({
        className: w.cls.classGrade.name,
        sectionName: w.cls.section.name,
      });
      expect(res.body.cards.map((c: any) => c.student.rollNo)).toEqual([
        '0001',
        '0002',
        '0003',
        '0004',
      ]);

      const [first, second, absentee, untested] = res.body.cards;
      expect(first.exams[0].subjects.map((s: any) => s.obtained)).toEqual([
        87, 45,
      ]);
      expect(first.overall).toMatchObject({
        totalObtained: 132,
        grade: 'A',
        passed: true,
      });
      expect(second.exams[0].subjects.map((s: any) => s.obtained)).toEqual([
        76, 20,
      ]);
      expect(second.overall.passed).toBe(false);
      // Absent in maths is still an exam they sat; no marks at all means no exam on the card.
      expect(absentee.exams).toHaveLength(1);
      expect(untested.exams).toEqual([]);
      expect(untested.overall).toBeNull();
    });

    it('matches the single-student card exactly', async () => {
      const w = await world();
      const query = `?academicYearId=${w.cls.academicYear.id}`;
      const [bulk, single] = await Promise.all([
        api().get(all(w.cls.section.id, query)).set(bearer(w.tokens.admin)),
        api()
          .get(`/api/exams/students/${w.byRoll('0002').id}/result-card${query}`)
          .set(bearer(w.tokens.admin)),
      ]);
      const fromBulk = bulk.body.cards.find(
        (c: any) => c.student.rollNo === '0002',
      );
      const strip = (card: any) => ({ ...card, generatedAt: undefined });
      expect(strip(fromBulk)).toEqual(strip(single.body));
    });

    it("needs a session, and stays inside the principal's own school", async () => {
      const w = await world();
      const query = `?academicYearId=${w.cls.academicYear.id}`;
      await api()
        .get(all(w.cls.section.id, ''))
        .set(bearer(w.tokens.admin))
        .expect(400);
      await api()
        .get(all(w.cls.section.id, query))
        .set(bearer(w.tokens.bAdmin))
        .expect(403);
      await api()
        .get(all(w.cls.section.id, query))
        .set(bearer(w.tokens.teacher))
        .expect(403);
      await api()
        .get(all(w.cls.section.id, query))
        .set(bearer(w.tokens.student))
        .expect(403);
      // Another school's session cannot be borrowed for this section.
      await api()
        .get(all(w.cls.section.id, `?academicYearId=${w.b.academicYear.id}`))
        .set(bearer(w.tokens.admin))
        .expect(404);
      await api()
        .get(all(randomUUID(), query))
        .set(bearer(w.tokens.admin))
        .expect(404);
    });
  });
});
