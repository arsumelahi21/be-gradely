import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';

/**
 * Regression guard: a teacher must be able to grade a SUBMITTED submission AND
 * re-grade an already-MARKED one (old backend blocked the latter, breaking "Update marks").
 */
describe('Assignments / re-grading (e2e)', () => {
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

  async function seedSubmittedAssignment() {
    const cls = await seedClass({ studentCount: 1 });
    const student = cls.students[0];

    const assignment = await prisma.assignment.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: cls.academicYear.id,
        sectionSubjectId: cls.sectionSubject.id,
        createdByTeacherId: cls.teacherProfile.id,
        title: 'Worksheet 1',
        maxScore: 100,
        status: 'PUBLISHED',
      },
    });

    const submission = await prisma.assignmentSubmission.create({
      data: {
        assignmentId: assignment.id,
        studentId: student.profile.id,
        status: 'SUBMITTED',
        s3Key: `assignments/${assignment.id}/${student.profile.id}.pdf`,
        submittedAt: new Date(),
      },
    });

    const token = await tokenFor(app, cls.teacherUser);
    return { token, submission };
  }

  function mark(token: string, submissionId: string, body: object) {
    return request(app.getHttpServer())
      .patch(`/api/assignments/submissions/${submissionId}/mark`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('grades a SUBMITTED submission then updates the grade on the MARKED one', async () => {
    const { token, submission } = await seedSubmittedAssignment();

    const first = await mark(token, submission.id, {
      score: 70,
      remarks: 'Good',
    });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('MARKED');
    expect(first.body.score).toBe(70);

    // Re-grade the already-MARKED submission — previously rejected.
    const second = await mark(token, submission.id, {
      score: 85,
      remarks: 'Revised after review',
    });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('MARKED');
    expect(second.body.score).toBe(85);
    expect(second.body.remarks).toBe('Revised after review');
  });

  it('still refuses to mark an UPLOADING submission', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const student = cls.students[0];
    const assignment = await prisma.assignment.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: cls.academicYear.id,
        sectionSubjectId: cls.sectionSubject.id,
        createdByTeacherId: cls.teacherProfile.id,
        title: 'Worksheet 2',
        maxScore: 50,
        status: 'PUBLISHED',
      },
    });
    const submission = await prisma.assignmentSubmission.create({
      data: {
        assignmentId: assignment.id,
        studentId: student.profile.id,
        status: 'UPLOADING',
        s3Key: `assignments/${assignment.id}/${student.profile.id}.pdf`,
      },
    });
    const token = await tokenFor(app, cls.teacherUser);

    const res = await mark(token, submission.id, { score: 10 });
    expect(res.status).toBe(400);
  });
});
