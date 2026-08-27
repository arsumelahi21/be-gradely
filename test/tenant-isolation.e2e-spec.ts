import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * Regression guard: SCHOOL_ADMIN from School B must get 403 (not 404) reading/mutating
 * School A's resources — tenant scoping is per-query, not structural, so one missed filter leaks FERPA data.
 */
describe('Cross-tenant isolation (e2e)', () => {
  let app: INestApplication;
  let bAdminToken: string;
  let ids: Record<string, string>;
  let schoolBStudentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb();

    // School A — the victim tenant, with one resource per school-scoped module.
    const a = await seedClass({ studentCount: 1 });
    const enrollment = await prisma.enrollment.findFirstOrThrow({
      where: { studentId: a.students[0].profile.id },
    });
    const exam = await prisma.exam.create({
      data: {
        schoolId: a.school.id,
        academicYearId: a.academicYear.id,
        sectionSubjectId: a.sectionSubject.id,
        createdByTeacherId: a.teacherProfile.id,
        title: 'A-Exam',
        status: 'PUBLISHED',
        maxScore: 100,
      },
    });
    const assignment = await prisma.assignment.create({
      data: {
        schoolId: a.school.id,
        academicYearId: a.academicYear.id,
        sectionSubjectId: a.sectionSubject.id,
        createdByTeacherId: a.teacherProfile.id,
        title: 'A-Assignment',
        status: 'PUBLISHED',
      },
    });
    const quiz = await prisma.quiz.create({
      data: {
        schoolId: a.school.id,
        sectionId: a.section.id,
        subjectId: a.subject.id,
        title: 'A-Quiz',
        createdByUserId: a.teacherUser.id,
        isPublished: true,
      },
    });
    const announcement = await prisma.announcement.create({
      data: {
        schoolId: a.school.id,
        authorUserId: a.teacherUser.id,
        title: 'A-Announcement',
        body: 'hello',
        publishAt: new Date('2026-01-01'),
      },
    });
    const thread = await prisma.messageThread.create({
      data: {
        schoolId: a.school.id,
        type: 'DIRECT',
        participants: {
          create: [
            { userId: a.teacherUser.id },
            { userId: a.students[0].user.id },
          ],
        },
      },
    });

    ids = {
      student: a.students[0].profile.id,
      user: a.students[0].user.id,
      section: a.section.id,
      classGrade: a.classGrade.id,
      subject: a.subject.id,
      academicYear: a.academicYear.id,
      enrollment: enrollment.id,
      sectionSubject: a.sectionSubject.id,
      teacher: a.teacherProfile.id,
      exam: exam.id,
      assignment: assignment.id,
      quiz: quiz.id,
      announcement: announcement.id,
      thread: thread.id,
    };

    // School B — the attacker tenant. A real, valid SCHOOL_ADMIN token.
    const b = await seedClass({ studentCount: 1 });
    schoolBStudentId = b.students[0].profile.id;
    const bAdmin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: b.school.id,
    });
    bAdminToken = await tokenFor(app, bAdmin);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const auth = () => `Bearer ${bAdminToken}`;

  // GET/PATCH/DELETE of a School-A resource with School-B's token. GETs run first;
  // mutations last, so a broken DELETE can't mask an earlier GET leak.
  const cases: Array<[string, 'get' | 'patch' | 'delete', () => string]> = [
    ['GET students/:id', 'get', () => `/api/students/${ids.student}`],
    ['GET users/:id', 'get', () => `/api/users/${ids.user}`],
    ['GET sections/:id', 'get', () => `/api/sections/${ids.section}`],
    [
      'GET class-grades/:id',
      'get',
      () => `/api/class-grades/${ids.classGrade}`,
    ],
    ['GET subjects/:id', 'get', () => `/api/subjects/${ids.subject}`],
    [
      'GET academic-years/:id',
      'get',
      () => `/api/academic-years/${ids.academicYear}`,
    ],
    ['GET enrollments/:id', 'get', () => `/api/enrollments/${ids.enrollment}`],
    [
      'GET section-subjects/:id',
      'get',
      () => `/api/section-subjects/${ids.sectionSubject}`,
    ],
    ['GET teachers/:id', 'get', () => `/api/teachers/${ids.teacher}`],
    ['GET exams/:id', 'get', () => `/api/exams/${ids.exam}`],
    ['GET assignments/:id', 'get', () => `/api/assignments/${ids.assignment}`],
    ['GET quizzes/:id', 'get', () => `/api/quizzes/${ids.quiz}`],
    [
      'GET announcements/:id',
      'get',
      () => `/api/announcements/${ids.announcement}`,
    ],
    [
      'GET attendance/student/:id',
      'get',
      () => `/api/attendance/student/${ids.student}`,
    ],
    [
      // ?date is a required query param — supply it so validation passes and the
      // request actually reaches the tenant check (else it 400s before scoping).
      'GET attendance/section-subject/:id',
      'get',
      () =>
        `/api/attendance/section-subject/${ids.sectionSubject}?date=2026-07-20`,
    ],
    [
      'GET messaging/threads/:id',
      'get',
      () => `/api/messaging/threads/${ids.thread}`,
    ],
    // Mutations last.
    ['PATCH students/:id', 'patch', () => `/api/students/${ids.student}`],
    ['PATCH sections/:id', 'patch', () => `/api/sections/${ids.section}`],
    ['DELETE sections/:id', 'delete', () => `/api/sections/${ids.section}`],
    ['DELETE students/:id', 'delete', () => `/api/students/${ids.student}`],
  ];

  it.each(cases)(
    'denies School B admin: %s',
    async (_label, method, pathFn) => {
      const res = await request(app.getHttpServer())
        [method](pathFn())
        .set('Authorization', auth())
        .send({});
      expect(res.status).toBe(403);
    },
  );

  it('positive control: School B admin CAN read its OWN student (token is valid)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/students/${schoolBStudentId}`)
      .set('Authorization', auth());
    expect(res.status).toBe(200);
  });

  it("audit log is tenant-pinned: School B admin never sees School A's entries", async () => {
    const aLog = await prisma.auditLog.create({
      data: {
        actorUserId: ids.user,
        schoolId: (
          await prisma.studentProfile.findFirstOrThrow({
            where: { id: ids.student },
            select: { schoolId: true },
          })
        ).schoolId,
        action: 'USER_UPDATE',
        entityType: 'StudentProfile',
        entityId: ids.student,
      },
    });

    const res = await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set('Authorization', auth());
    expect(res.status).toBe(200);
    const rows: Array<{ id: string }> = res.body.items ?? res.body;
    expect(rows.map((r) => r.id)).not.toContain(aLog.id);
  });
});
