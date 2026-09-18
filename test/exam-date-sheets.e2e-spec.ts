import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { addSecondSubject, seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';
import {
  NOTIFICATION_CREATE,
  NOTIFICATION_CREATE_BATCH,
} from '../src/common/events/notification.events';

/**
 * A date sheet is a principal-created Examination: its subject rows carry date, time, venue and
 * invigilator. These cover the Date Sheet workflow end to end against the real API.
 */
describe('Examination date sheets (e2e)', () => {
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
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function studentIn(
    schoolId: string,
    sectionId: string,
    yearId: string,
  ) {
    const user = await createTestUser({ role: Role.STUDENT, schoolId });
    const profile = await prisma.studentProfile.create({
      data: { userId: user.id, schoolId, fullName: 'Student' },
    });
    await prisma.enrollment.create({
      data: {
        studentId: profile.id,
        sectionId,
        academicYearId: yearId,
        status: 'ACTIVE',
      },
    });
    return { user, profile };
  }

  async function teacherIn(schoolId: string, isActive = true) {
    const user = await createTestUser({ role: Role.TEACHER, schoolId });
    const profile = await prisma.teacherProfile.create({
      data: { userId: user.id, schoolId, fullName: 'Invigilator', isActive },
    });
    return { user, profile };
  }

  async function world() {
    // Section A: English, Mathematics, Biology. Section B (same class): English, Physics.
    const cls = await seedClass({ studentCount: 2 });
    const schoolId = cls.school.id;
    const year = cls.academicYear;
    const maths = await addSecondSubject(cls.school, cls.section.id);
    const biology = await addSecondSubject(cls.school, cls.section.id);
    const sectionB = await prisma.section.create({
      data: { schoolId, classGradeId: cls.classGrade.id, name: 'B' },
    });
    const englishB = await prisma.sectionSubject.create({
      data: {
        sectionId: sectionB.id,
        subjectId: cls.subject.id,
        teacherId: cls.teacherProfile.id,
      },
    });
    const physicsB = await addSecondSubject(cls.school, sectionB.id);
    const studentB = await studentIn(schoolId, sectionB.id, year.id);

    const classC = await prisma.classGrade.create({
      data: { schoolId, name: `Grade C ${Date.now()}` },
    });
    const sectionC = await prisma.section.create({
      data: { schoolId, classGradeId: classC.id, name: 'A' },
    });
    const historyC = await addSecondSubject(cls.school, sectionC.id);
    const studentC = await studentIn(schoolId, sectionC.id, year.id);

    const other = await seedClass({ studentCount: 1 });
    const outsider = await teacherIn(schoolId); // teaches nothing anywhere
    const bystander = await teacherIn(schoolId);
    const inactive = await teacherIn(schoolId, false);

    const [term, term2] = await Promise.all(
      ['First Term', 'Second Term'].map((name, i) =>
        prisma.academicTerm.create({
          data: { schoolId, academicYearId: year.id, name, sortOrder: i },
        }),
      ),
    );
    const admin = await createTestUser({ role: Role.SCHOOL_ADMIN, schoolId });
    const otherAdmin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: other.school.id,
    });

    return {
      cls,
      year,
      term,
      term2,
      sectionB,
      classC,
      sectionC,
      other,
      subjects: {
        english: cls.sectionSubject,
        maths: maths.sectionSubject,
        biology: biology.sectionSubject,
        englishB,
        physicsB: physicsB.sectionSubject,
        historyC: historyC.sectionSubject,
      },
      names: {
        english: cls.subject.name,
        maths: maths.subject.name,
      },
      teachers: {
        english: cls.teacherProfile,
        maths: maths.otherTeacherProfile,
        outsider: outsider.profile,
        inactive: inactive.profile,
      },
      users: {
        englishTeacher: cls.teacherUser,
        mathsTeacher: maths.otherTeacherUser,
        outsider: outsider.user,
        bystander: bystander.user,
      },
      studentsA: cls.students,
      studentB,
      studentC,
      tokens: {
        admin: await tokenFor(app, admin),
        otherAdmin: await tokenFor(app, otherAdmin),
        teacher: await tokenFor(app, cls.teacherUser),
        outsider: await tokenFor(app, outsider.user),
        bystander: await tokenFor(app, bystander.user),
        studentA: await tokenFor(app, cls.students[0].user),
        studentB: await tokenFor(app, studentB.user),
        otherStudent: await tokenFor(app, other.students[0].user),
      },
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const row = (
    w: World,
    sectionSubjectId: string,
    over: Record<string, unknown> = {},
  ) => ({
    sectionSubjectId,
    heldAt: '2027-06-14',
    startMin: 540,
    endMin: 660,
    venue: 'Room 12',
    invigilatorTeacherId: w.teachers.english.id,
    ...over,
  });

  const sheet = (
    w: World,
    rows: object[],
    over: Record<string, unknown> = {},
  ) =>
    api()
      .post('/api/exams')
      .set(bearer(w.tokens.admin))
      .send({
        title: 'First Term Examination',
        academicYearId: w.year.id,
        classGradeId: w.cls.classGrade.id,
        sectionId: w.cls.section.id,
        termId: w.term.id,
        subjects: rows,
        ...over,
      });

  const publish = (id: string, token: string) =>
    api().post(`/api/exams/${id}/publish`).set(bearer(token));

  function spyNotifications() {
    const spy = jest.spyOn(app.get(EventEmitter2), 'emit');
    const of = (name: string) =>
      spy.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
    return {
      created: () => of(NOTIFICATION_CREATE),
      batches: () => of(NOTIFICATION_CREATE_BATCH),
      restore: () => spy.mockRestore(),
    };
  }

  describe('subject allocation', () => {
    it("lists exactly a section's allocated subjects and refuses any other section's", async () => {
      const w = await world();
      const subjectIdsOf = async (sectionId: string) =>
        (
          await api()
            .get(`/api/section-subjects?sectionId=${sectionId}`)
            .set(bearer(w.tokens.admin))
            .expect(200)
        ).body
          .map((ss: { id: string }) => ss.id)
          .sort();

      expect(await subjectIdsOf(w.cls.section.id)).toEqual(
        [
          w.subjects.english.id,
          w.subjects.maths.id,
          w.subjects.biology.id,
        ].sort(),
      );
      expect(await subjectIdsOf(w.sectionB.id)).toEqual(
        [w.subjects.englishB.id, w.subjects.physicsB.id].sort(),
      );

      // Physics belongs to Section B; the same subject allocated to B is still B's row.
      for (const foreign of [w.subjects.physicsB.id, w.subjects.englishB.id]) {
        const refused = await sheet(w, [row(w, foreign)]).expect(400);
        expect(refused.body.message).toBe(
          'That subject is not taught in this section',
        );
      }
      expect(await prisma.examination.count()).toBe(0);
    });
  });

  describe('drafts', () => {
    it('requires session, term, class and section', async () => {
      const w = await world();
      const refusedTerm = await sheet(w, [], { termId: undefined }).expect(400);
      expect(refusedTerm.body.message).toBe(
        'Please select a term before publishing the exam.',
      );
      for (const field of ['academicYearId', 'classGradeId', 'sectionId']) {
        await sheet(w, [], { [field]: undefined }).expect(400);
      }
      await sheet(w, [], { sectionId: w.sectionC.id }).expect(400);
    });

    it('saves and edits a draft without notifying anyone', async () => {
      const w = await world();
      const events = spyNotifications();
      const draft = await sheet(w, [
        row(w, w.subjects.english.id),
        row(w, w.subjects.maths.id, { heldAt: '2027-06-15' }),
      ]).expect(201);
      expect(draft.body.status).toBe('DRAFT');
      expect(draft.body.subjects).toHaveLength(2);

      const edited = await api()
        .put(`/api/exams/${draft.body.id}/subjects`)
        .set(bearer(w.tokens.admin))
        .send({
          subjects: [
            row(w, w.subjects.english.id, { venue: 'Main Hall' }),
            row(w, w.subjects.maths.id, {
              heldAt: '2027-06-15',
              startMin: 600,
              endMin: 720,
            }),
            row(w, w.subjects.biology.id, { heldAt: '2027-06-16' }),
          ],
        })
        .expect(200);
      expect(edited.body.subjects).toHaveLength(3);
      const byId = new Map<string, any>(
        edited.body.subjects.map((s: any) => [s.sectionSubjectId, s]),
      );
      expect(byId.get(w.subjects.english.id).venue).toBe('Main Hall');
      expect(byId.get(w.subjects.maths.id)).toMatchObject({
        startMin: 600,
        endMin: 720,
        invigilator: { id: w.teachers.english.id },
      });

      const reduced = await api()
        .put(`/api/exams/${draft.body.id}/subjects`)
        .set(bearer(w.tokens.admin))
        .send({ subjects: [row(w, w.subjects.english.id)] })
        .expect(200);
      expect(reduced.body.subjects).toHaveLength(1);

      await api()
        .post('/api/exams')
        .set(bearer(w.tokens.teacher))
        .send({
          title: 'Teacher proposal',
          academicYearId: w.year.id,
          classGradeId: w.cls.classGrade.id,
          sectionId: w.cls.section.id,
        })
        .expect(201);
      const list = await api()
        .get('/api/exams?view=datesheets&page=1')
        .set(bearer(w.tokens.admin))
        .expect(200);
      expect(list.body.items.map((e: any) => e.id)).toEqual([draft.body.id]);

      expect(events.created()).toEqual([]);
      expect(events.batches()).toEqual([]);
      events.restore();
    });

    it('refuses a duplicate subject and an end time before the start', async () => {
      const w = await world();
      const duplicate = await sheet(w, [
        row(w, w.subjects.english.id),
        row(w, w.subjects.english.id, { heldAt: '2027-06-15' }),
      ]).expect(400);
      expect(duplicate.body.message).toBe(
        'Each subject can only be added once',
      );

      const backwards = await sheet(w, [
        row(w, w.subjects.english.id, { startMin: 660, endMin: 540 }),
      ]).expect(400);
      expect(backwards.body.message).toBe('End time must be after start time');
    });
  });

  describe('publishing', () => {
    it('refuses an incomplete sheet, naming each problem against its row', async () => {
      const w = await world();
      const events = spyNotifications();
      const draft = await sheet(w, [
        row(w, w.subjects.english.id, {
          venue: null,
          invigilatorTeacherId: null,
        }),
        row(w, w.subjects.maths.id, {
          heldAt: null,
          startMin: null,
          endMin: null,
        }),
      ]).expect(201);
      const bySs = new Map<string, string>(
        draft.body.subjects.map((s: any) => [s.sectionSubjectId, s.id]),
      );
      const english = bySs.get(w.subjects.english.id);
      const maths = bySs.get(w.subjects.maths.id);

      const expected = [
        {
          subjectId: english,
          message: `${w.names.english}: venue is required`,
        },
        {
          subjectId: english,
          message: `${w.names.english}: invigilator is required`,
        },
        {
          subjectId: maths,
          message: `${w.names.maths}: exam date is required`,
        },
        {
          subjectId: maths,
          message: `${w.names.maths}: start time is required`,
        },
        { subjectId: maths, message: `${w.names.maths}: end time is required` },
      ];
      const refused = await publish(draft.body.id, w.tokens.admin).expect(400);
      expect(refused.body.issues).toEqual(expect.arrayContaining(expected));
      expect(refused.body.issues).toHaveLength(expected.length);

      const check = await api()
        .get(`/api/exams/${draft.body.id}/schedule-check`)
        .set(bearer(w.tokens.admin))
        .expect(200);
      expect(check.body.issues).toEqual(expect.arrayContaining(expected));
      expect(check.body.issues).toHaveLength(expected.length);

      expect(
        (
          await prisma.examination.findUniqueOrThrow({
            where: { id: draft.body.id },
          })
        ).status,
      ).toBe('DRAFT');
      expect(events.created()).toEqual([]);
      expect(events.batches()).toEqual([]);
      events.restore();
    });

    it('publishes once, notifying only its students and its invigilators', async () => {
      const w = await world();
      const draft = await sheet(w, [
        row(w, w.subjects.english.id),
        row(w, w.subjects.maths.id, {
          heldAt: '2027-06-15',
          venue: 'Room 13',
          invigilatorTeacherId: w.teachers.maths.id,
        }),
      ]).expect(201);

      await publish(draft.body.id, w.tokens.teacher).expect(403);
      await publish(draft.body.id, w.tokens.studentA).expect(403);
      await publish(draft.body.id, w.tokens.otherAdmin).expect(403);

      const events = spyNotifications();
      const published = await publish(draft.body.id, w.tokens.admin).expect(
        201,
      );
      expect(published.body.status).toBe('PUBLISHED');

      const [toStudents] = events
        .created()
        .filter((e) => e.type === 'EXAM_PUBLISHED');
      expect(new Set(toStudents.userIds)).toEqual(
        new Set(w.studentsA.map((s) => s.user.id)),
      );
      expect(toStudents.body).toContain('First Term');

      const [duties] = events.batches();
      expect(duties.type).toBe('EXAM_INVIGILATION');
      expect(duties.items.map((i: any) => i.userIds)).toEqual([
        [w.users.englishTeacher.id],
        [w.users.mathsTeacher.id],
      ]);
      expect(duties.items[0].body).toBe(
        `You have been assigned as an invigilator for ${w.names.english}, ${w.cls.classGrade.name} Section ${w.cls.section.name} (First Term), on 14 Jun 2027 from 09:00 to 11:00 at Room 12.`,
      );

      await publish(draft.body.id, w.tokens.admin).expect(409);
      expect(
        events.created().filter((e) => e.type === 'EXAM_PUBLISHED'),
      ).toHaveLength(1);
      expect(events.batches()).toHaveLength(1);
      events.restore();

      await api()
        .put(`/api/exams/${draft.body.id}/subjects`)
        .set(bearer(w.tokens.admin))
        .send({ subjects: [row(w, w.subjects.english.id)] })
        .expect(409);
    });

    it('blocks invigilator, venue and student clashes but allows touching slots', async () => {
      const w = await world();
      const a = await sheet(w, [row(w, w.subjects.english.id)]).expect(201);
      await publish(a.body.id, w.tokens.admin).expect(201);

      const sectionB = (rows: object[]) =>
        sheet(w, rows, {
          sectionId: w.sectionB.id,
          title: 'Section B Examination',
        });
      const b = await sectionB([
        row(w, w.subjects.physicsB.id, {
          startMin: 600,
          endMin: 720,
          venue: 'Room 30',
        }),
      ]).expect(201);
      const invigilatorClash = await publish(b.body.id, w.tokens.admin).expect(
        400,
      );
      expect(invigilatorClash.body.message).toContain(
        'Teacher is already assigned as an invigilator during this time',
      );

      const setB = (over: Record<string, unknown>) =>
        api()
          .put(`/api/exams/${b.body.id}/subjects`)
          .set(bearer(w.tokens.admin))
          .send({
            subjects: [
              row(w, w.subjects.physicsB.id, {
                startMin: 600,
                endMin: 720,
                ...over,
              }),
            ],
          })
          .expect(200);
      await setB({
        invigilatorTeacherId: w.teachers.maths.id,
        venue: 'room 12',
      });
      const venueClash = await publish(b.body.id, w.tokens.admin).expect(400);
      expect(venueClash.body.message).toContain(
        'room 12 is already occupied during this time',
      );

      // Different invigilator and venue: another section may sit at the same time.
      await setB({
        invigilatorTeacherId: w.teachers.maths.id,
        venue: 'Room 30',
      });
      await publish(b.body.id, w.tokens.admin).expect(201);

      // Section A cannot sit a second overlapping paper, whoever invigilates.
      const again = await sheet(
        w,
        [
          row(w, w.subjects.maths.id, {
            startMin: 600,
            endMin: 720,
            venue: 'Room 40',
            invigilatorTeacherId: w.teachers.outsider.id,
          }),
        ],
        { termId: w.term2.id, title: 'Monthly Test' },
      ).expect(201);
      const studentClash = await publish(again.body.id, w.tokens.admin).expect(
        400,
      );
      expect(studentClash.body.message).toContain('this section already has');

      // 11:00 starts exactly when Room 12 and its invigilator are freed.
      const c = await sheet(
        w,
        [row(w, w.subjects.historyC.id, { startMin: 660, endMin: 780 })],
        {
          classGradeId: w.classC.id,
          sectionId: w.sectionC.id,
          title: 'Grade C Examination',
        },
      ).expect(201);
      await publish(c.body.id, w.tokens.admin).expect(201);
    });

    it('lets marks entry set the totals the date sheet left out, then locks them', async () => {
      const w = await world();
      const draft = await sheet(w, [row(w, w.subjects.english.id)]).expect(201);
      await publish(draft.body.id, w.tokens.admin).expect(201);
      const subjectId: string = draft.body.subjects[0].id;
      const marks = `/api/exams/${draft.body.id}/subjects/${subjectId}/marks`;
      const studentId = w.studentsA[0].profile.id;

      const noTotal = await api()
        .put(marks)
        .set(bearer(w.tokens.teacher))
        .send({ entries: [{ studentId, score: 40 }] })
        .expect(409);
      expect(noTotal.body.message).toBe(
        'Set the total marks for this subject first',
      );

      await api()
        .put(marks)
        .set(bearer(w.tokens.teacher))
        .send({
          maxScore: 50,
          passingMarks: 20,
          entries: [{ studentId, score: 40 }],
        })
        .expect(200);
      const roster = await api()
        .get(marks)
        .set(bearer(w.tokens.teacher))
        .expect(200);
      expect(roster.body.subject).toMatchObject({
        maxScore: 50,
        passingMarks: 20,
        totalsLocked: true,
      });

      const rescale = await api()
        .put(marks)
        .set(bearer(w.tokens.teacher))
        .send({ maxScore: 60, entries: [{ studentId, score: 45 }] })
        .expect(409);
      expect(rescale.body.message).toBe(
        "Total marks can't change once marks have been entered",
      );
      await api()
        .put(marks)
        .set(bearer(w.tokens.teacher))
        .send({ maxScore: 50, entries: [{ studentId, score: 45 }] })
        .expect(200);
    });
  });

  describe('access', () => {
    it('keeps drafts and other sections private, and shows invigilators their duty', async () => {
      const w = await world();
      const draft = await sheet(w, [
        row(w, w.subjects.english.id, {
          invigilatorTeacherId: w.teachers.outsider.id,
        }),
      ]).expect(201);
      const get = (token: string) =>
        api().get(`/api/exams/${draft.body.id}`).set(bearer(token));

      await get(w.tokens.studentA).expect(403);
      await get(w.tokens.outsider).expect(403);
      await publish(draft.body.id, w.tokens.admin).expect(201);

      await get(w.tokens.studentA).expect(200);
      const duty = await get(w.tokens.outsider).expect(200);
      expect(duty.body.subjects[0].invigilator).toMatchObject({
        id: w.teachers.outsider.id,
      });
      expect(duty.body.permissions).toMatchObject({
        canEdit: false,
        canPublish: false,
        canViewPaper: false,
        canEnterMarks: false,
      });

      await get(w.tokens.studentB).expect(403);
      await get(w.tokens.bystander).expect(403);
      await get(w.tokens.otherStudent).expect(403);
      await get(w.tokens.otherAdmin).expect(403);
      const otherList = await api()
        .get('/api/exams?view=datesheets&page=1')
        .set(bearer(w.tokens.otherAdmin))
        .expect(200);
      expect(otherList.body.items).toEqual([]);
    });

    it('lets only the principal assign invigilators, and only active teachers of the school', async () => {
      const w = await world();
      const proposal = await api()
        .post('/api/exams')
        .set(bearer(w.tokens.teacher))
        .send({
          title: 'Teacher proposal',
          academicYearId: w.year.id,
          classGradeId: w.cls.classGrade.id,
          sectionId: w.cls.section.id,
          subjects: [
            { sectionSubjectId: w.subjects.english.id, heldAt: '2027-06-14' },
          ],
        })
        .expect(201);
      const forbidden = await api()
        .patch(
          `/api/exams/${proposal.body.id}/subjects/${proposal.body.subjects[0].id}`,
        )
        .set(bearer(w.tokens.teacher))
        .send({ invigilatorTeacherId: w.teachers.english.id })
        .expect(403);
      expect(forbidden.body.message).toBe(
        'Only the principal assigns invigilators',
      );
      await api()
        .put(`/api/exams/${proposal.body.id}/subjects`)
        .set(bearer(w.tokens.teacher))
        .send({ subjects: [] })
        .expect(403);

      for (const invigilatorTeacherId of [
        w.other.teacherProfile.id,
        w.teachers.inactive.id,
      ]) {
        const refused = await sheet(w, [
          row(w, w.subjects.english.id, { invigilatorTeacherId }),
        ]).expect(400);
        expect(refused.body.message).toBe(
          'Choose an active teacher from your school as the invigilator',
        );
      }

      await sheet(w, [], {
        classGradeId: w.other.classGrade.id,
        sectionId: w.other.section.id,
      }).expect(400);
      await sheet(w, [row(w, w.other.sectionSubject.id)]).expect(400);
      expect(
        await prisma.examination.count({
          where: { title: 'First Term Examination' },
        }),
      ).toBe(0);
    });
  });

  describe('session and term isolation', () => {
    it('never mixes sessions or terms, for the principal or the student', async () => {
      const w = await world();
      const first = await sheet(w, [row(w, w.subjects.english.id)]).expect(201);
      await publish(first.body.id, w.tokens.admin).expect(201);
      const second = await sheet(
        w,
        [row(w, w.subjects.english.id, { heldAt: '2027-11-10' })],
        {
          termId: w.term2.id,
          title: 'Second Term Examination',
        },
      ).expect(201);
      await publish(second.body.id, w.tokens.admin).expect(201);

      const nextYear = await prisma.academicYear.create({
        data: {
          schoolId: w.cls.school.id,
          name: '2028-2029',
          code: `NEXT${Date.now()}`,
          startDate: new Date('2028-04-01'),
          endDate: new Date('2029-03-31'),
        },
      });
      const nextTerm = await prisma.academicTerm.create({
        data: {
          schoolId: w.cls.school.id,
          academicYearId: nextYear.id,
          name: 'First Term',
        },
      });
      const next = await sheet(
        w,
        [row(w, w.subjects.english.id, { heldAt: '2028-06-14' })],
        {
          academicYearId: nextYear.id,
          termId: nextTerm.id,
          title: 'Next Session Examination',
        },
      ).expect(201);
      await publish(next.body.id, w.tokens.admin).expect(201);

      const idsFor = async (query: string, token = w.tokens.admin) =>
        (
          await api()
            .get(`/api/exams?view=datesheets&page=1&${query}`)
            .set(bearer(token))
            .expect(200)
        ).body.items.map((e: any) => e.id);

      expect(
        await idsFor(`academicYearId=${w.year.id}&termId=${w.term.id}`),
      ).toEqual([first.body.id]);
      expect(
        await idsFor(`academicYearId=${w.year.id}&termId=${w.term2.id}`),
      ).toEqual([second.body.id]);
      expect(await idsFor(`academicYearId=${nextYear.id}`)).toEqual([
        next.body.id,
      ]);

      // The student sat this section in the first session only.
      const studentView = await api()
        .get('/api/exams?page=1')
        .set(bearer(w.tokens.studentA))
        .expect(200);
      expect(studentView.body.items.map((e: any) => e.id).sort()).toEqual(
        [first.body.id, second.body.id].sort(),
      );
      await api()
        .get(`/api/exams/${next.body.id}`)
        .set(bearer(w.tokens.studentA))
        .expect(403);
    });
  });
});
