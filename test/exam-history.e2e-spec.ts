import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * TEST 15. Promotion closes a placement (COMPLETED) and opens a new one; results finalized in the
 * old session must stay under that session, keep their values, and stay visible to student and parent.
 */
describe('Examination history across promotion (e2e)', () => {
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
  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');

  /** Admin-authored exam: create, attach paper, publish, mark everyone, finalize. */
  async function finalizedExam(opts: {
    token: string;
    title: string;
    academicYearId: string;
    classGradeId: string;
    sectionId: string;
    sectionSubjectId: string;
    score: number;
    studentId: string;
    termId: string;
    heldAt: string;
    invigilatorTeacherId: string;
  }) {
    const created = await api()
      .post('/api/exams')
      .set(bearer(opts.token))
      .send({
        title: opts.title,
        academicYearId: opts.academicYearId,
        classGradeId: opts.classGradeId,
        sectionId: opts.sectionId,
        termId: opts.termId,
        subjects: [
          {
            sectionSubjectId: opts.sectionSubjectId,
            heldAt: opts.heldAt,
            startMin: 540,
            endMin: 660,
            venue: 'Hall 1',
            invigilatorTeacherId: opts.invigilatorTeacherId,
            maxScore: 100,
            passingMarks: 40,
          },
        ],
      })
      .expect(201);
    const id: string = created.body.id;
    const subjectId: string = created.body.subjects[0].id;
    await api()
      .put(`/api/exams/${id}/subjects/${subjectId}/paper`)
      .set(bearer(opts.token))
      .attach('paper', pdf, {
        filename: 'paper.pdf',
        contentType: 'application/pdf',
      })
      .expect(200);
    await api()
      .post(`/api/exams/${id}/publish`)
      .set(bearer(opts.token))
      .expect(201);
    await api()
      .put(`/api/exams/${id}/subjects/${subjectId}/marks`)
      .set(bearer(opts.token))
      .send({ entries: [{ studentId: opts.studentId, score: opts.score }] })
      .expect(200);
    await api()
      .post(`/api/exams/${id}/results/finalize`)
      .set(bearer(opts.token))
      .expect(201);
    return id;
  }

  it('keeps last session’s results intact and visible after promotion', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const student = cls.students[0];
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);
    const parentUser = await createTestUser({
      role: Role.PARENT,
      schoolId: cls.school.id,
    });
    const parent = await prisma.parentProfile.create({
      data: { userId: parentUser.id, fullName: 'Parent' },
    });
    await prisma.parentStudent.create({
      data: { parentId: parent.id, studentId: student.profile.id },
    });

    // Each session carries its own term: publishing demands one.
    const oldTerm = await prisma.academicTerm.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: cls.academicYear.id,
        name: 'First Term',
      },
    });
    const oldExamId = await finalizedExam({
      token: adminToken,
      title: 'Annual Examination',
      academicYearId: cls.academicYear.id,
      classGradeId: cls.classGrade.id,
      sectionId: cls.section.id,
      sectionSubjectId: cls.sectionSubject.id,
      score: 72,
      studentId: student.profile.id,
      termId: oldTerm.id,
      heldAt: '2026-06-01',
      invigilatorTeacherId: cls.teacherProfile.id,
    });
    const before = await prisma.examinationResult.findFirstOrThrow({
      where: { examinationId: oldExamId },
    });

    // Next session, next class — then promote through the real endpoint.
    const nextYear = await prisma.academicYear.create({
      data: {
        schoolId: cls.school.id,
        name: 'Next Session',
        code: `NEXT${Date.now()}`,
        startDate: new Date('2027-01-01'),
        endDate: new Date('2027-12-31'),
      },
    });
    const nextClass = await prisma.classGrade.create({
      data: { schoolId: cls.school.id, name: `Next-${Date.now()}` },
    });
    const nextSection = await prisma.section.create({
      data: { schoolId: cls.school.id, classGradeId: nextClass.id, name: 'A' },
    });
    await api()
      .post('/api/promotions/execute')
      .set(bearer(adminToken))
      .send({
        sourceAcademicYearId: cls.academicYear.id,
        targetAcademicYearId: nextYear.id,
        students: [
          {
            studentId: student.profile.id,
            destinationClassGradeId: nextClass.id,
            destinationSectionId: nextSection.id,
          },
        ],
      })
      .expect(201);

    const placements = await prisma.enrollment.findMany({
      where: { studentId: student.profile.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(placements.map((p) => [p.academicYearId, p.status])).toEqual([
      [cls.academicYear.id, 'COMPLETED'],
      [nextYear.id, 'ACTIVE'],
    ]);

    // A new-session exam in the new class does not touch the old one.
    const nextSubject = await prisma.subject.create({
      data: { schoolId: cls.school.id, name: `NextSub-${Date.now()}` },
    });
    const nextSectionSubject = await prisma.sectionSubject.create({
      data: {
        sectionId: nextSection.id,
        subjectId: nextSubject.id,
        teacherId: cls.teacherProfile.id,
      },
    });
    const nextTerm = await prisma.academicTerm.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: nextYear.id,
        name: 'First Term',
      },
    });
    const newExamId = await finalizedExam({
      token: adminToken,
      title: 'First Term Examination',
      academicYearId: nextYear.id,
      classGradeId: nextClass.id,
      sectionId: nextSection.id,
      sectionSubjectId: nextSectionSubject.id,
      score: 91,
      studentId: student.profile.id,
      termId: nextTerm.id,
      heldAt: '2027-06-01',
      invigilatorTeacherId: cls.teacherProfile.id,
    });

    const oldExam = await prisma.examination.findUniqueOrThrow({
      where: { id: oldExamId },
    });
    expect(oldExam).toMatchObject({
      academicYearId: cls.academicYear.id,
      sectionId: cls.section.id,
      className: cls.classGrade.name,
    });
    const after = await prisma.examinationResult.findFirstOrThrow({
      where: { examinationId: oldExamId },
    });
    expect(after).toMatchObject({
      totalObtained: before.totalObtained,
      percentage: before.percentage,
      grade: before.grade,
      position: before.position,
    });

    // The student and parent still see both, each under its own session.
    const studentToken = await tokenFor(app, student.user);
    const parentToken = await tokenFor(app, parentUser);
    for (const [token, query] of [
      [studentToken, ''],
      [parentToken, `?studentId=${student.profile.id}`],
    ] as const) {
      const mine = await api()
        .get(`/api/exams/results/me${query}`)
        .set(bearer(token))
        .expect(200);
      const byExam = new Map(mine.body.map((r: any) => [r.examination.id, r]));
      expect(byExam.get(oldExamId)).toMatchObject({
        percentage: 72,
        examination: { academicYear: { name: cls.academicYear.name } },
      });
      expect(byExam.get(newExamId)).toMatchObject({
        percentage: 91,
        examination: { academicYear: { name: 'Next Session' } },
      });

      await api()
        .get(`/api/exams/${oldExamId}${query}`)
        .set(bearer(token))
        .expect(200);
      const card = await api()
        .get(`/api/exams/${oldExamId}/report-cards${query}`)
        .set(bearer(token))
        .expect(200);
      expect(card.body.examination.academicYear.name).toBe(
        cls.academicYear.name,
      );
    }

    // And the old session can't be deleted out from under that history.
    await api()
      .delete(`/api/academic-years/${cls.academicYear.id}`)
      .set(bearer(adminToken))
      .expect(409);
  });
});
