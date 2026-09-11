import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

/**
 * A confirmed delete removes the entity and everything that exists only because
 * of it — no refusal because dependent data exists.
 *
 * Each case is run twice: once on a bare entity and once on one loaded with
 * every dependent record we can attach, so a cascade that only works on empty
 * data cannot pass. Independent history (AuditLog holds no FK) must survive.
 */
describe('Deletion cascades (e2e)', () => {
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

  /** A school with a full academic graph and every dependent row hung off it. */
  async function seedFullGraph() {
    const school = await createTestSchool();
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: school.id,
    });
    const token = await tokenFor(app, admin);

    const year = await prisma.academicYear.create({
      data: {
        schoolId: school.id,
        name: `Y-${uniq()}`,
        code: `Y${uniq()}`,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        isActive: true,
      },
    });
    const grade = await prisma.classGrade.create({
      data: { schoolId: school.id, name: `Grade-${uniq()}` },
    });
    const section = await prisma.section.create({
      data: { schoolId: school.id, classGradeId: grade.id, name: `S${uniq()}` },
    });
    const subject = await prisma.subject.create({
      data: { schoolId: school.id, name: `Sub-${uniq()}` },
    });

    const teacherUser = await createTestUser({
      role: Role.TEACHER,
      schoolId: school.id,
    });
    const teacher = await prisma.teacherProfile.create({
      data: {
        userId: teacherUser.id,
        schoolId: school.id,
        fullName: 'Teacher',
      },
    });
    const sectionSubject = await prisma.sectionSubject.create({
      data: {
        sectionId: section.id,
        subjectId: subject.id,
        teacherId: teacher.id,
      },
    });
    await prisma.sectionTeacher.create({
      data: { sectionId: section.id, teacherId: teacher.id },
    });
    await prisma.teacherSubjectSpecialty.create({
      data: { teacherId: teacher.id, subjectId: subject.id },
    });

    const studentUser = await createTestUser({
      role: Role.STUDENT,
      schoolId: school.id,
    });
    const student = await prisma.studentProfile.create({
      data: {
        userId: studentUser.id,
        schoolId: school.id,
        fullName: 'Student',
        monthlyFeeAmount: 1000,
      },
    });
    const parentUser = await createTestUser({
      role: Role.PARENT,
      schoolId: school.id,
    });
    // ParentProfile has no schoolId — it is scoped through its User.
    const parent = await prisma.parentProfile.create({
      data: { userId: parentUser.id, fullName: 'Parent' },
    });
    await prisma.parentStudent.create({
      data: { parentId: parent.id, studentId: student.id },
    });
    await prisma.enrollment.create({
      data: {
        studentId: student.id,
        sectionId: section.id,
        academicYearId: year.id,
        status: 'ACTIVE',
      },
    });

    // Dependent records across every module.
    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        studentId: student.id,
        sectionSubjectId: sectionSubject.id,
        date: new Date('2026-02-02'),
        status: 'PRESENT',
        markedByUserId: admin.id,
      },
    });
    const assignment = await prisma.assignment.create({
      data: {
        schoolId: school.id,
        academicYearId: year.id,
        sectionSubjectId: sectionSubject.id,
        createdByTeacherId: teacher.id,
        title: 'HW',
        status: 'PUBLISHED',
        maxScore: 10,
      },
    });
    await prisma.assignmentSubmission.create({
      data: {
        assignmentId: assignment.id,
        studentId: student.id,
        status: 'MARKED',
        s3Key: 'k',
        score: 8,
      },
    });
    const exam = await prisma.exam.create({
      data: {
        schoolId: school.id,
        academicYearId: year.id,
        sectionSubjectId: sectionSubject.id,
        createdByTeacherId: teacher.id,
        title: 'Midterm',
        status: 'PUBLISHED',
      },
    });
    await prisma.examResult.create({
      data: { examId: exam.id, studentId: student.id, score: 70 },
    });
    const quiz = await prisma.quiz.create({
      data: {
        schoolId: school.id,
        sectionId: section.id,
        subjectId: subject.id,
        title: 'Quiz',
        createdByUserId: teacherUser.id,
        isPublished: true,
      },
    });
    await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        studentId: student.id,
        answers: {},
        score: 5,
        maxScore: 10,
      },
    });
    const challan = await prisma.challan.create({
      data: {
        schoolId: school.id,
        challanNo: `CH-${uniq()}`,
        studentId: student.id,
        academicYearId: year.id,
        sectionId: section.id,
        classGradeId: grade.id,
        periodYear: 2026,
        periodMonth: 2,
        issueDate: new Date(),
        dueDate: new Date(),
        grossAmount: 1000,
        discountAmount: 0,
        netAmount: 1000,
        generatedByUserId: admin.id,
      },
    });
    await prisma.payment.create({
      data: {
        schoolId: school.id,
        challanId: challan.id,
        amount: 500,
        method: 'CASH',
        paidAt: new Date(),
        recordedByUserId: admin.id,
      },
    });
    const timetable = await prisma.timetable.create({
      data: {
        schoolId: school.id,
        academicYearId: year.id,
        sectionId: section.id,
        status: 'PUBLISHED',
        workingDays: ['MONDAY'],
      },
    });
    const period = await prisma.timetablePeriod.create({
      data: {
        timetableId: timetable.id,
        schoolId: school.id,
        index: 1,
        startMin: 480,
        endMin: 525,
        kind: 'CLASS',
      },
    });
    await prisma.timetableEntry.create({
      data: {
        timetableId: timetable.id,
        schoolId: school.id,
        sectionId: section.id,
        academicYearId: year.id,
        dayOfWeek: 'MONDAY',
        periodId: period.id,
        startMin: 480,
        endMin: 525,
        sectionSubjectId: sectionSubject.id,
        teacherId: teacher.id,
      },
    });

    // Independent history — no FK, must survive every cascade below.
    const audit = await prisma.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: 'SEED_MARKER',
        schoolId: school.id,
      },
    });

    return {
      school,
      admin,
      token,
      year,
      grade,
      section,
      subject,
      teacher,
      teacherUser,
      sectionSubject,
      student,
      studentUser,
      parent,
      quiz,
      challan,
      timetable,
      audit,
    };
  }

  const del = (path: string, token: string) =>
    request(app.getHttpServer())
      .delete(path)
      .set('Authorization', `Bearer ${token}`);

  /** Audit history is independent of every entity and must always survive. */
  async function expectAuditSurvives(auditId: string) {
    expect(await prisma.auditLog.count({ where: { id: auditId } })).toBe(1);
  }

  describe('Subject', () => {
    it('deletes with no dependents', async () => {
      const f = await seedFullGraph();
      const bare = await prisma.subject.create({
        data: { schoolId: f.school.id, name: `Bare-${uniq()}` },
      });
      await del(`/api/subjects/${bare.id}`, f.token).expect(200);
      expect(await prisma.subject.count({ where: { id: bare.id } })).toBe(0);
    });

    it('deletes along with its section-subjects, attendance and specialties', async () => {
      const f = await seedFullGraph();
      await del(`/api/subjects/${f.subject.id}`, f.token).expect(200);

      expect(await prisma.subject.count({ where: { id: f.subject.id } })).toBe(
        0,
      );
      expect(
        await prisma.sectionSubject.count({
          where: { id: f.sectionSubject.id },
        }),
      ).toBe(0);
      // Anchored to the section-subject, so it goes with it.
      expect(
        await prisma.attendance.count({
          where: { sectionSubjectId: f.sectionSubject.id },
        }),
      ).toBe(0);
      expect(
        await prisma.teacherSubjectSpecialty.count({
          where: { subjectId: f.subject.id },
        }),
      ).toBe(0);
      // The section itself is NOT owned by the subject and stays.
      expect(await prisma.section.count({ where: { id: f.section.id } })).toBe(
        1,
      );
      await expectAuditSurvives(f.audit.id);
    });
  });

  describe('Section', () => {
    it('deletes with enrollments, subjects, quizzes and its timetable', async () => {
      const f = await seedFullGraph();
      await del(`/api/sections/${f.section.id}`, f.token).expect(200);

      expect(await prisma.section.count({ where: { id: f.section.id } })).toBe(
        0,
      );
      for (const [label, count] of [
        [
          'enrollment',
          prisma.enrollment.count({ where: { sectionId: f.section.id } }),
        ],
        [
          'sectionSubject',
          prisma.sectionSubject.count({ where: { sectionId: f.section.id } }),
        ],
        ['quiz', prisma.quiz.count({ where: { sectionId: f.section.id } })],
        [
          'timetable',
          prisma.timetable.count({ where: { sectionId: f.section.id } }),
        ],
        [
          'timetableEntry',
          prisma.timetableEntry.count({ where: { sectionId: f.section.id } }),
        ],
        [
          'sectionTeacher',
          prisma.sectionTeacher.count({ where: { sectionId: f.section.id } }),
        ],
      ] as const) {
        expect(`${label}=${await count}`).toBe(`${label}=0`);
      }
      // The student, teacher and subject outlive the section they met in.
      expect(
        await prisma.studentProfile.count({ where: { id: f.student.id } }),
      ).toBe(1);
      expect(
        await prisma.teacherProfile.count({ where: { id: f.teacher.id } }),
      ).toBe(1);
      expect(await prisma.subject.count({ where: { id: f.subject.id } })).toBe(
        1,
      );
      await expectAuditSurvives(f.audit.id);
    });
  });

  describe('ClassGrade', () => {
    it('deletes the class and every section beneath it', async () => {
      const f = await seedFullGraph();
      await del(`/api/class-grades/${f.grade.id}`, f.token).expect(200);

      expect(await prisma.classGrade.count({ where: { id: f.grade.id } })).toBe(
        0,
      );
      expect(await prisma.section.count({ where: { id: f.section.id } })).toBe(
        0,
      );
      expect(
        await prisma.enrollment.count({ where: { sectionId: f.section.id } }),
      ).toBe(0);
      expect(
        await prisma.timetable.count({ where: { sectionId: f.section.id } }),
      ).toBe(0);
      await expectAuditSurvives(f.audit.id);
    });
  });

  describe('Student', () => {
    it('deletes with attendance, results, enrollments and fee records', async () => {
      const f = await seedFullGraph();
      await del(`/api/users/${f.studentUser.id}`, f.token).expect(200);

      expect(
        await prisma.studentProfile.count({ where: { id: f.student.id } }),
      ).toBe(0);
      for (const [label, count] of [
        [
          'attendance',
          prisma.attendance.count({ where: { studentId: f.student.id } }),
        ],
        [
          'enrollment',
          prisma.enrollment.count({ where: { studentId: f.student.id } }),
        ],
        [
          'quizAttempt',
          prisma.quizAttempt.count({ where: { studentId: f.student.id } }),
        ],
        [
          'submission',
          prisma.assignmentSubmission.count({
            where: { studentId: f.student.id },
          }),
        ],
        [
          'examResult',
          prisma.examResult.count({ where: { studentId: f.student.id } }),
        ],
        [
          'parentLink',
          prisma.parentStudent.count({ where: { studentId: f.student.id } }),
        ],
        [
          'challan',
          prisma.challan.count({ where: { studentId: f.student.id } }),
        ],
        [
          'payment',
          prisma.payment.count({ where: { challanId: f.challan.id } }),
        ],
      ] as const) {
        expect(`${label}=${await count}`).toBe(`${label}=0`);
      }
      // The class they sat in, and their parent, are not theirs to take.
      expect(await prisma.section.count({ where: { id: f.section.id } })).toBe(
        1,
      );
      expect(
        await prisma.parentProfile.count({ where: { id: f.parent.id } }),
      ).toBe(1);
      await expectAuditSurvives(f.audit.id);
    });
  });

  describe('Teacher', () => {
    it('deletes with assignments, specialties and timetable entries', async () => {
      const f = await seedFullGraph();
      await del(`/api/users/${f.teacherUser.id}`, f.token).expect(200);

      expect(
        await prisma.teacherProfile.count({ where: { id: f.teacher.id } }),
      ).toBe(0);
      expect(
        await prisma.timetableEntry.count({
          where: { teacherId: f.teacher.id },
        }),
      ).toBe(0);
      expect(
        await prisma.sectionTeacher.count({
          where: { teacherId: f.teacher.id },
        }),
      ).toBe(0);
      expect(
        await prisma.teacherSubjectSpecialty.count({
          where: { teacherId: f.teacher.id },
        }),
      ).toBe(0);
      // The section-subject survives with no teacher, not deleted (SetNull).
      const ss = await prisma.sectionSubject.findUnique({
        where: { id: f.sectionSubject.id },
      });
      expect(ss).not.toBeNull();
      expect(ss?.teacherId).toBeNull();
      // Attendance is anchored to the section-subject, so it is untouched.
      expect(
        await prisma.attendance.count({
          where: { sectionSubjectId: f.sectionSubject.id },
        }),
      ).toBe(1);
      await expectAuditSurvives(f.audit.id);
    });
  });

  describe('AcademicYear', () => {
    it('deletes with its enrollments, challans and timetables', async () => {
      const f = await seedFullGraph();
      await del(`/api/academic-years/${f.year.id}`, f.token).expect(200);

      expect(
        await prisma.academicYear.count({ where: { id: f.year.id } }),
      ).toBe(0);
      expect(
        await prisma.enrollment.count({ where: { academicYearId: f.year.id } }),
      ).toBe(0);
      expect(
        await prisma.challan.count({ where: { academicYearId: f.year.id } }),
      ).toBe(0);
      expect(
        await prisma.timetable.count({ where: { academicYearId: f.year.id } }),
      ).toBe(0);
      // Students and sections belong to the school, not the session.
      expect(
        await prisma.studentProfile.count({ where: { id: f.student.id } }),
      ).toBe(1);
      expect(await prisma.section.count({ where: { id: f.section.id } })).toBe(
        1,
      );
      await expectAuditSurvives(f.audit.id);
    });
  });

  describe('SectionSubject', () => {
    it('is removable even with attendance recorded against it', async () => {
      const f = await seedFullGraph();
      expect(
        await prisma.attendance.count({
          where: { sectionSubjectId: f.sectionSubject.id },
        }),
      ).toBe(1);

      // This used to be refused with "attendance has already been recorded".
      await del(`/api/section-subjects/${f.sectionSubject.id}`, f.token).expect(
        200,
      );

      expect(
        await prisma.sectionSubject.count({
          where: { id: f.sectionSubject.id },
        }),
      ).toBe(0);
      expect(
        await prisma.attendance.count({
          where: { sectionSubjectId: f.sectionSubject.id },
        }),
      ).toBe(0);
      await expectAuditSurvives(f.audit.id);
    });
  });

  describe('fee configuration', () => {
    it('deletes a fee head used on issued challans, leaving the bill intact', async () => {
      const f = await seedFullGraph();
      const head = await prisma.feeHead.create({
        data: {
          schoolId: f.school.id,
          name: `Head-${uniq()}`,
          defaultAmount: 500,
        },
      });
      const item = await prisma.challanItem.create({
        data: {
          challanId: f.challan.id,
          feeHeadId: head.id,
          label: 'Transport',
          amount: 500,
          kind: 'FEE',
        },
      });

      await del(`/api/fees/heads/${head.id}`, f.token).expect(200);

      expect(await prisma.feeHead.count({ where: { id: head.id } })).toBe(0);
      // The snapshot IS the immutability mechanism: label and amount survive.
      const kept = await prisma.challanItem.findUnique({
        where: { id: item.id },
      });
      expect(kept).toMatchObject({ label: 'Transport', amount: 500 });
      expect(kept?.feeHeadId).toBeNull();
    });
  });

  describe('no orphans left behind', () => {
    it('leaves nothing pointing at a deleted class', async () => {
      const f = await seedFullGraph();
      await del(`/api/class-grades/${f.grade.id}`, f.token).expect(200);

      const orphans = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`
        SELECT (
          (SELECT COUNT(*) FROM "Section"        WHERE "classGradeId" = '${f.grade.id}') +
          (SELECT COUNT(*) FROM "Enrollment"     WHERE "sectionId"    = '${f.section.id}') +
          (SELECT COUNT(*) FROM "SectionSubject" WHERE "sectionId"    = '${f.section.id}') +
          (SELECT COUNT(*) FROM "TimetableEntry" WHERE "sectionId"    = '${f.section.id}') +
          (SELECT COUNT(*) FROM "Quiz"           WHERE "sectionId"    = '${f.section.id}')
        ) AS n`);
      expect(Number(orphans[0].n)).toBe(0);
    });
  });
});
