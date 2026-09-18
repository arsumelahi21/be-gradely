import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { seedExamination } from './utils/exam-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * The term is chosen explicitly at create/publish and named again before any result is
 * extracted. Nothing is inferred — not the current term, not the latest, not the only one.
 */
describe('Examination terms (e2e)', () => {
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
  const TERM_REQUIRED = 'Please select a term before publishing the exam.';
  const TERM_FILTER = 'Please select a term.';

  async function world() {
    const cls = await seedClass({ studentCount: 2 });
    const adminUser = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    return {
      cls,
      admin: await tokenFor(app, adminUser),
      teacher: await tokenFor(app, cls.teacherUser),
      adminUserId: adminUser.id,
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  const addTerm = (w: World, name: string, sortOrder = 0) =>
    prisma.academicTerm.create({
      data: {
        schoolId: w.cls.school.id,
        academicYearId: w.cls.academicYear.id,
        name,
        sortOrder,
      },
    });

  const proposal = (w: World, termId?: string | null) => ({
    title: 'Mid Term Test',
    academicYearId: w.cls.academicYear.id,
    classGradeId: w.cls.classGrade.id,
    sectionId: w.cls.section.id,
    ...(termId === undefined ? {} : { termId }),
  });

  /** A published examination whose single subject is marked, so it reaches a result card. */
  async function markedExam(w: World, termId: string | null, title: string) {
    const { examination, subjects } = await seedExamination({
      schoolId: w.cls.school.id,
      academicYearId: w.cls.academicYear.id,
      sectionId: w.cls.section.id,
      sectionSubjectIds: [w.cls.sectionSubject.id],
      termId,
      title,
      status: 'PUBLISHED',
    });
    for (const [i, s] of w.cls.students.entries()) {
      await prisma.examResult.create({
        data: {
          examId: subjects[0].id,
          studentId: s.profile.id,
          score: 70 + i,
        },
      });
    }
    return examination;
  }

  describe('choosing a term', () => {
    it('refuses a principal an examination without a term, whether or not one exists', async () => {
      const w = await world();

      // No terms configured yet: the principal is told to create one, not handed a default.
      const bare = await api()
        .post('/api/exams')
        .set(bearer(w.admin))
        .send(proposal(w))
        .expect(400);
      expect(bare.body.message).toContain('no terms yet');

      const term = await addTerm(w, 'First Term', 1);
      const missing = await api()
        .post('/api/exams')
        .set(bearer(w.admin))
        .send(proposal(w))
        .expect(400);
      expect(missing.body.message).toBe(TERM_REQUIRED);

      // Explicitly null is refused exactly like omitting it — no silent fallback.
      await api()
        .post('/api/exams')
        .set(bearer(w.admin))
        .send(proposal(w, null))
        .expect(400);

      const created = await api()
        .post('/api/exams')
        .set(bearer(w.admin))
        .send(proposal(w, term.id))
        .expect(201);
      expect(created.body.term).toMatchObject({
        id: term.id,
        name: 'First Term',
      });
    });

    it("refuses a term from another school or another school's session", async () => {
      const w = await world();
      const other = await seedClass({ studentCount: 0 });
      const foreign = await prisma.academicTerm.create({
        data: {
          schoolId: other.school.id,
          academicYearId: other.academicYear.id,
          name: 'First Term',
        },
      });

      await api()
        .post('/api/exams')
        .set(bearer(w.admin))
        .send(proposal(w, foreign.id))
        .expect(400);
      await api()
        .post('/api/exams')
        .set(bearer(w.admin))
        .send(proposal(w, randomUUID()))
        .expect(400);
      expect(await prisma.examination.count()).toBe(0);
    });

    it('still lets a teacher draft a proposal without a term', async () => {
      const w = await world();
      await addTerm(w, 'First Term', 1);

      const draft = await api()
        .post('/api/exams')
        .set(bearer(w.teacher))
        .send(proposal(w))
        .expect(201);
      expect(draft.body.term).toBeNull();
      expect(draft.body.status).toBe('DRAFT');
    });
  });

  describe('term dates', () => {
    const createTerm = (w: World, body: Record<string, unknown>) =>
      api()
        .post('/api/exam-settings/terms')
        .set(bearer(w.admin))
        .send({ academicYearId: w.cls.academicYear.id, ...body });
    const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

    it('accepts a term with no dates, either date or both, sent as null or blank', async () => {
      const w = await world();
      const cases: [string, object, string | null, string | null][] = [
        ['Omitted', {}, null, null],
        ['Null', { startDate: null, endDate: null }, null, null],
        ['Blank', { startDate: '', endDate: '' }, null, null],
        ['Start only', { startDate: '2026-08-01' }, '2026-08-01', null],
        ['End only', { endDate: '2026-12-20' }, null, '2026-12-20'],
        [
          'Both',
          { startDate: '2026-08-01', endDate: '2026-12-20' },
          '2026-08-01',
          '2026-12-20',
        ],
      ];
      for (const [name, dates, start, end] of cases) {
        const res = await createTerm(w, { name, ...dates }).expect(201);
        expect([day(res.body.startDate), day(res.body.endDate)]).toEqual([
          start,
          end,
        ]);
      }
    });

    it('refuses a start date after the end date, including against a stored date', async () => {
      const w = await world();
      const bad = await createTerm(w, {
        name: 'First Term',
        startDate: '2026-12-20',
        endDate: '2026-08-01',
      }).expect(400);
      expect(bad.body.message).toBe(
        'Term end date must be on or after its start date',
      );

      const term = await createTerm(w, {
        name: 'First Term',
        startDate: '2026-08-01',
      }).expect(201);
      await api()
        .patch(`/api/exam-settings/terms/${term.body.id}`)
        .set(bearer(w.admin))
        .send({ endDate: '2026-07-01' })
        .expect(400);
    });

    it('clears the dates of an existing term, and they stay optional afterwards', async () => {
      const w = await world();
      const term = await createTerm(w, {
        name: 'First Term',
        startDate: '2026-08-01',
        endDate: '2026-12-20',
      }).expect(201);
      const path = `/api/exam-settings/terms/${term.body.id}`;

      const oneCleared = await api()
        .patch(path)
        .set(bearer(w.admin))
        .send({ endDate: '' })
        .expect(200);
      expect([
        day(oneCleared.body.startDate),
        day(oneCleared.body.endDate),
      ]).toEqual(['2026-08-01', null]);

      await api()
        .patch(path)
        .set(bearer(w.admin))
        .send({ startDate: null, endDate: null })
        .expect(200);
      await api()
        .patch(path)
        .set(bearer(w.admin))
        .send({ name: 'Term 1' })
        .expect(200);
      expect(
        await prisma.academicTerm.findUniqueOrThrow({
          where: { id: term.body.id },
        }),
      ).toMatchObject({ name: 'Term 1', startDate: null, endDate: null });
    });
  });

  describe('publishing', () => {
    it('publishes with a term that has no dates and a subject with no paper', async () => {
      const w = await world();
      const term = await addTerm(w, 'First Term', 1);
      const { examination } = await seedExamination({
        schoolId: w.cls.school.id,
        academicYearId: w.cls.academicYear.id,
        sectionId: w.cls.section.id,
        sectionSubjectIds: [w.cls.sectionSubject.id],
        status: 'DRAFT',
        termId: term.id,
        invigilatorTeacherId: w.cls.teacherProfile.id,
      });

      await api()
        .post(`/api/exams/${examination.id}/publish`)
        .set(bearer(w.admin))
        .expect(201);
      expect(await current(examination.id)).toBe('PUBLISHED');
      expect(
        await prisma.examPaper.count({
          where: { exam: { examinationId: examination.id } },
        }),
      ).toBe(0);
    });

    it('refuses to publish without a term, and publishes once one is chosen', async () => {
      const w = await world();
      const term = await addTerm(w, 'First Term', 1);
      const { examination, subjects } = await seedExamination({
        schoolId: w.cls.school.id,
        academicYearId: w.cls.academicYear.id,
        sectionId: w.cls.section.id,
        sectionSubjectIds: [w.cls.sectionSubject.id],
        status: 'DRAFT',
        termId: null,
        invigilatorTeacherId: w.cls.teacherProfile.id,
      });
      // A paper is present so this also covers publishing with one.
      await prisma.examPaper.create({
        data: {
          examId: subjects[0].id,
          schoolId: w.cls.school.id,
          data: Buffer.from('%PDF-1.4\n%%EOF\n'),
          fileName: 'paper.pdf',
          sizeBytes: 16,
          sha256: 'x'.repeat(64),
        },
      });

      const refused = await api()
        .post(`/api/exams/${examination.id}/publish`)
        .set(bearer(w.admin))
        .expect(400);
      expect(refused.body.message).toBe(TERM_REQUIRED);
      expect(await current(examination.id)).toBe('DRAFT');

      await api()
        .patch(`/api/exams/${examination.id}`)
        .set(bearer(w.admin))
        .send({ termId: term.id })
        .expect(200);
      await api()
        .post(`/api/exams/${examination.id}/publish`)
        .set(bearer(w.admin))
        .expect(201);
      expect(await current(examination.id)).toBe('PUBLISHED');
    });

    const current = async (id: string) =>
      (
        await prisma.examination.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        })
      ).status;
  });

  describe('extracting results', () => {
    it('will not extract a class sheet or a card without a term, and never mixes two', async () => {
      const w = await world();
      const first = await addTerm(w, 'First Term', 1);
      const second = await addTerm(w, 'Second Term', 2);
      await markedExam(w, first.id, 'First Term Test');
      await markedExam(w, second.id, 'Second Term Test');
      const student = w.cls.students[0].profile.id;
      const year = w.cls.academicYear.id;
      const cards = `/api/exams/sections/${w.cls.section.id}/result-cards`;
      const card = `/api/exams/students/${student}/result-card`;

      // No term at all: nothing is extracted, and the message says exactly what is missing.
      const noTerm = await api()
        .get(`${cards}?academicYearId=${year}`)
        .set(bearer(w.admin))
        .expect(400);
      expect(noTerm.body.message).toBe(TERM_FILTER);
      await api().get(cards).set(bearer(w.admin)).expect(400);

      const cardNoTerm = await api()
        .get(`${card}?academicYearId=${year}`)
        .set(bearer(w.admin))
        .expect(400);
      expect(cardNoTerm.body.message).toBe(TERM_FILTER);
      // A card with no filters at all used to merge every session the student ever sat.
      await api().get(card).set(bearer(w.admin)).expect(400);

      const firstSheet = await api()
        .get(`${cards}?academicYearId=${year}&termId=${first.id}`)
        .set(bearer(w.admin))
        .expect(200);
      expect(titlesOf(firstSheet.body.cards)).toEqual(['First Term Test']);

      const secondSheet = await api()
        .get(`${cards}?academicYearId=${year}&termId=${second.id}`)
        .set(bearer(w.admin))
        .expect(200);
      expect(titlesOf(secondSheet.body.cards)).toEqual(['Second Term Test']);

      const firstCard = await api()
        .get(`${card}?academicYearId=${year}&termId=${first.id}`)
        .set(bearer(w.admin))
        .expect(200);
      expect(
        firstCard.body.exams.map((e: { title: string }) => e.title),
      ).toEqual(['First Term Test']);
      expect(firstCard.body.exams[0].term).toMatchObject({ id: first.id });
    });

    it('refuses a term that belongs to another session or another school', async () => {
      const w = await world();
      const term = await addTerm(w, 'First Term', 1);
      await markedExam(w, term.id, 'First Term Test');
      const otherYear = await prisma.academicYear.create({
        data: {
          schoolId: w.cls.school.id,
          name: 'Next year',
          code: `AY-${randomUUID().slice(0, 8)}`,
          startDate: new Date('2027-01-01'),
          endDate: new Date('2027-12-31'),
        },
      });
      const otherSchool = await seedClass({ studentCount: 0 });
      const foreignTerm = await prisma.academicTerm.create({
        data: {
          schoolId: otherSchool.school.id,
          academicYearId: otherSchool.academicYear.id,
          name: 'First Term',
        },
      });
      const cards = `/api/exams/sections/${w.cls.section.id}/result-cards`;

      // Right school, wrong session.
      await api()
        .get(`${cards}?academicYearId=${otherYear.id}&termId=${term.id}`)
        .set(bearer(w.admin))
        .expect(400);
      // Another school's term, and an id that is no term at all.
      await api()
        .get(
          `${cards}?academicYearId=${w.cls.academicYear.id}&termId=${foreignTerm.id}`,
        )
        .set(bearer(w.admin))
        .expect(400);
      await api()
        .get(
          `${cards}?academicYearId=${w.cls.academicYear.id}&termId=${randomUUID()}`,
        )
        .set(bearer(w.admin))
        .expect(400);
    });

    it('keeps another school out even with a valid term of their own', async () => {
      const w = await world();
      const term = await addTerm(w, 'First Term', 1);
      await markedExam(w, term.id, 'First Term Test');
      const other = await seedClass({ studentCount: 1 });
      const otherAdmin = await createTestUser({
        role: Role.SCHOOL_ADMIN,
        schoolId: other.school.id,
      });
      const token = await tokenFor(app, otherAdmin);

      await api()
        .get(
          `/api/exams/sections/${w.cls.section.id}/result-cards?academicYearId=${w.cls.academicYear.id}&termId=${term.id}`,
        )
        .set(bearer(token))
        .expect(403);
      await api()
        .get(
          `/api/exams/students/${w.cls.students[0].profile.id}/result-card?academicYearId=${w.cls.academicYear.id}&termId=${term.id}`,
        )
        .set(bearer(token))
        .expect(403);
    });

    const titlesOf = (cards: { exams: { title: string }[] }[]) => [
      ...new Set(cards.flatMap((c) => c.exams.map((e) => e.title))),
    ];
  });
});
