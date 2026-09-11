import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

/**
 * What a promoted student SEES.
 *
 * The sibling `promotions` spec proves the data is written correctly; this one
 * proves the consequence the school actually cares about — the moment a student
 * moves up, last year's assignments, quizzes, subjects, teachers and timetable
 * stop appearing for them, and the new class's own content appears instead.
 *
 * Nothing is deleted to achieve that: every consumer read scopes to an ACTIVE
 * enrollment, and promotion marks the old one COMPLETED. These tests pin that
 * behaviour so a future query that forgets the status filter is caught here.
 */
describe('What a promoted student sees (e2e)', () => {
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

  /** One class + section, fully stocked: subject, teacher, assignment, quiz, timetable. */
  async function stockClass(
    schoolId: string,
    yearId: string,
    className: string,
    level: number,
    label: string,
  ) {
    const grade = await prisma.classGrade.create({
      data: { schoolId, name: className, level },
    });
    const section = await prisma.section.create({
      data: { schoolId, classGradeId: grade.id, name: 'A' },
    });
    const subject = await prisma.subject.create({
      data: { schoolId, name: `${label}-Subject` },
    });
    const teacherUser = await createTestUser({ role: Role.TEACHER, schoolId });
    const teacher = await prisma.teacherProfile.create({
      data: {
        userId: teacherUser.id,
        schoolId,
        fullName: `${label}-Teacher`,
      },
    });
    const sectionSubject = await prisma.sectionSubject.create({
      data: {
        sectionId: section.id,
        subjectId: subject.id,
        teacherId: teacher.id,
      },
    });
    const assignment = await prisma.assignment.create({
      data: {
        schoolId,
        academicYearId: yearId,
        sectionSubjectId: sectionSubject.id,
        createdByTeacherId: teacher.id,
        title: `${label}-Assignment`,
        status: 'PUBLISHED',
        maxScore: 10,
      },
    });
    const quiz = await prisma.quiz.create({
      data: {
        schoolId,
        sectionId: section.id,
        subjectId: subject.id,
        title: `${label}-Quiz`,
        createdByUserId: teacherUser.id,
        isPublished: true,
      },
    });
    await prisma.question.create({
      data: {
        quizId: quiz.id,
        type: 'TRUE_FALSE',
        text: 'True?',
        correctAnswer: true,
        points: 1,
        order: 1,
      },
    });
    const timetable = await prisma.timetable.create({
      data: {
        schoolId,
        academicYearId: yearId,
        sectionId: section.id,
        status: 'PUBLISHED',
        workingDays: ['MONDAY'],
      },
    });
    const period = await prisma.timetablePeriod.create({
      data: {
        timetableId: timetable.id,
        schoolId,
        index: 1,
        startMin: 480,
        endMin: 525,
        kind: 'CLASS',
      },
    });
    await prisma.timetableEntry.create({
      data: {
        timetableId: timetable.id,
        schoolId,
        sectionId: section.id,
        academicYearId: yearId,
        dayOfWeek: 'MONDAY',
        periodId: period.id,
        startMin: 480,
        endMin: 525,
        sectionSubjectId: sectionSubject.id,
        teacherId: teacher.id,
      },
    });
    return {
      grade,
      section,
      subject,
      teacher,
      sectionSubject,
      assignment,
      quiz,
    };
  }

  async function seed() {
    const school = await createTestSchool();
    const [thisYear, nextYear] = await Promise.all([
      prisma.academicYear.create({
        data: {
          schoolId: school.id,
          name: `Cur-${uniq()}`,
          code: `C${uniq()}`,
          startDate: new Date('2026-01-01'),
          endDate: new Date('2026-12-31'),
          isActive: true,
        },
      }),
      prisma.academicYear.create({
        data: {
          schoolId: school.id,
          name: `Nxt-${uniq()}`,
          code: `N${uniq()}`,
          startDate: new Date('2027-01-01'),
          endDate: new Date('2027-12-31'),
          isActive: false,
        },
      }),
    ]);

    const from = await stockClass(school.id, thisYear.id, 'Grade 5', 5, 'OLD');
    const to = await stockClass(school.id, nextYear.id, 'Grade 6', 6, 'NEW');

    const studentUser = await createTestUser({
      role: Role.STUDENT,
      schoolId: school.id,
    });
    const student = await prisma.studentProfile.create({
      data: {
        userId: studentUser.id,
        schoolId: school.id,
        fullName: 'Mover',
        monthlyFeeAmount: 0,
      },
    });
    await prisma.enrollment.create({
      data: {
        studentId: student.id,
        sectionId: from.section.id,
        academicYearId: thisYear.id,
        status: 'ACTIVE',
      },
    });

    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: school.id,
    });

    return {
      school,
      thisYear,
      nextYear,
      from,
      to,
      student,
      studentToken: await tokenFor(app, studentUser),
      adminToken: await tokenFor(app, admin),
    };
  }

  const asStudent = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`);

  async function promote(f: Awaited<ReturnType<typeof seed>>) {
    await request(app.getHttpServer())
      .post('/api/promotions/execute')
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({
        sourceAcademicYearId: f.thisYear.id,
        targetAcademicYearId: f.nextYear.id,
        students: [
          {
            studentId: f.student.id,
            destinationClassGradeId: f.to.grade.id,
            destinationSectionId: f.to.section.id,
          },
        ],
      })
      .expect(201);
  }

  it('is moved into the next class, with exactly one active placement', async () => {
    const f = await seed();
    await promote(f);

    const rows = await prisma.enrollment.findMany({
      where: { studentId: f.student.id },
    });
    const active = rows.filter((r) => r.status === 'ACTIVE');
    expect(active).toHaveLength(1);
    expect(active[0].sectionId).toBe(f.to.section.id);
    expect(active[0].academicYearId).toBe(f.nextYear.id);
    // The old placement is kept as history, not deleted.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.sectionId === f.from.section.id)?.status).toBe(
      'COMPLETED',
    );
  });

  it('sees the old class before promotion and the new one after', async () => {
    const f = await seed();

    const before = await asStudent('/api/assignments', f.studentToken).expect(
      200,
    );
    const beforeTitles = (
      Array.isArray(before.body) ? before.body : before.body.items
    ).map((a: { title: string }) => a.title);
    expect(beforeTitles).toContain('OLD-Assignment');
    expect(beforeTitles).not.toContain('NEW-Assignment');

    await promote(f);

    const after = await asStudent('/api/assignments', f.studentToken).expect(
      200,
    );
    const afterTitles = (
      Array.isArray(after.body) ? after.body : after.body.items
    ).map((a: { title: string }) => a.title);
    // The whole point: last year's work is gone from their view.
    expect(afterTitles).not.toContain('OLD-Assignment');
    expect(afterTitles).toContain('NEW-Assignment');
  });

  it('no longer sees the old class quizzes', async () => {
    const f = await seed();

    const before = await asStudent(
      '/api/quizzes/available',
      f.studentToken,
    ).expect(200);
    const beforeTitles = (
      Array.isArray(before.body) ? before.body : before.body.items
    ).map((q: { title: string }) => q.title);
    expect(beforeTitles).toContain('OLD-Quiz');

    await promote(f);

    const after = await asStudent(
      '/api/quizzes/available',
      f.studentToken,
    ).expect(200);
    const afterTitles = (
      Array.isArray(after.body) ? after.body : after.body.items
    ).map((q: { title: string }) => q.title);
    expect(afterTitles).not.toContain('OLD-Quiz');
    expect(afterTitles).toContain('NEW-Quiz');
  });

  it('no longer sees the old subjects or their teachers', async () => {
    const f = await seed();
    await promote(f);

    const res = await asStudent('/api/section-subjects', f.studentToken).expect(
      200,
    );
    const rows = Array.isArray(res.body) ? res.body : res.body.items;

    const sectionIds = rows.map((r: { sectionId: string }) => r.sectionId);
    expect(sectionIds).not.toContain(f.from.section.id);
    expect(sectionIds).toContain(f.to.section.id);

    const subjectNames = rows.map(
      (r: { subject?: { name: string } }) => r.subject?.name,
    );
    expect(subjectNames).not.toContain('OLD-Subject');
    expect(subjectNames).toContain('NEW-Subject');

    const teacherNames = rows.map(
      (r: { teacher?: { fullName: string } | null }) => r.teacher?.fullName,
    );
    expect(teacherNames).not.toContain('OLD-Teacher');
    expect(teacherNames).toContain('NEW-Teacher');
  });

  it('gets the new class timetable, not the old one', async () => {
    const f = await seed();
    await promote(f);

    const res = await asStudent(
      `/api/timetable/me?academicYearId=${f.nextYear.id}`,
      f.studentToken,
    ).expect(200);

    expect(res.body.section?.id ?? res.body.sectionId).toBe(f.to.section.id);
    expect(res.body.entries).toHaveLength(1);

    // The finished session's grid is no longer served to them either.
    const old = await asStudent(
      `/api/timetable/me?academicYearId=${f.thisYear.id}`,
      f.studentToken,
    );
    expect(old.body?.entries ?? []).toHaveLength(0);
  });

  it('keeps the old records in the database — this is a view change, not a purge', async () => {
    const f = await seed();
    await promote(f);

    // Everything the student stopped seeing still exists for the school.
    expect(
      await prisma.assignment.count({ where: { id: f.from.assignment.id } }),
    ).toBe(1);
    expect(await prisma.quiz.count({ where: { id: f.from.quiz.id } })).toBe(1);
    expect(
      await prisma.sectionSubject.count({
        where: { id: f.from.sectionSubject.id },
      }),
    ).toBe(1);
    expect(
      await prisma.timetable.count({ where: { sectionId: f.from.section.id } }),
    ).toBe(1);
  });
  /**
   * What a student sees in the class they were promoted INTO.
   *
   * Nothing is deleted to make this work — an Assignment hangs off
   * SectionSubject and a Quiz off Section, and neither carries a student FK, so
   * they are the CLASS's record. The join date on the new enrollment is what
   * decides whether a given piece of work was ever theirs to do.
   */
  describe('work already finished before the student arrived', () => {
    it('hides assignments whose deadline passed before they joined', async () => {
      const f = await seed();

      // Two assignments in the destination class: one already overdue when the
      // student lands, one still ahead of them.
      const past = await prisma.assignment.create({
        data: {
          schoolId: f.school.id,
          academicYearId: f.nextYear.id,
          sectionSubjectId: f.to.sectionSubject.id,
          createdByTeacherId: f.to.teacher.id,
          title: 'NEW-Assignment-Past',
          status: 'PUBLISHED',
          maxScore: 10,
          dueAt: new Date('2027-01-10'),
        },
      });
      const future = await prisma.assignment.create({
        data: {
          schoolId: f.school.id,
          academicYearId: f.nextYear.id,
          sectionSubjectId: f.to.sectionSubject.id,
          createdByTeacherId: f.to.teacher.id,
          title: 'NEW-Assignment-Future',
          status: 'PUBLISHED',
          maxScore: 10,
          dueAt: new Date('2027-12-01'),
        },
      });

      await promote(f);
      // Promotion stamps startDate = now; pin it between the two deadlines.
      await prisma.enrollment.updateMany({
        where: {
          studentId: f.student.id,
          sectionId: f.to.section.id,
          academicYearId: f.nextYear.id,
        },
        data: { startDate: new Date('2027-06-01') },
      });

      const res = await asStudent('/api/assignments', f.studentToken).expect(
        200,
      );
      const titles = (Array.isArray(res.body) ? res.body : res.body.items).map(
        (a: { title: string }) => a.title,
      );

      expect(titles).not.toContain('NEW-Assignment-Past');
      expect(titles).toContain('NEW-Assignment-Future');
      // Undated work has no deadline to have missed, so it stays visible.
      expect(titles).toContain('NEW-Assignment');

      // Neither row was deleted — this is a visibility rule, not a purge.
      expect(await prisma.assignment.count({ where: { id: past.id } })).toBe(1);
      expect(await prisma.assignment.count({ where: { id: future.id } })).toBe(
        1,
      );
    });

    it('still shows a destination quiz written before they arrived', async () => {
      // Deliberate asymmetry with assignments. The rule is about DEADLINES, and
      // Quiz has no deadline column — filtering on createdAt would hide a quiz
      // that is still open just because it predates the student's arrival.
      const f = await seed();
      await promote(f);

      await prisma.enrollment.updateMany({
        where: {
          studentId: f.student.id,
          sectionId: f.to.section.id,
          academicYearId: f.nextYear.id,
        },
        data: { startDate: new Date('2027-06-01') },
      });
      await prisma.quiz.update({
        where: { id: f.to.quiz.id },
        data: { createdAt: new Date('2027-01-05') },
      });

      const res = await asStudent(
        '/api/quizzes/available',
        f.studentToken,
      ).expect(200);
      const titles = (Array.isArray(res.body) ? res.body : res.body.items).map(
        (q: { title: string }) => q.title,
      );

      expect(titles).toContain('NEW-Quiz');
      // The OLD class's quiz is gone regardless — that is the placement
      // closing, not a date filter.
      expect(titles).not.toContain('OLD-Quiz');
    });
  });
});
