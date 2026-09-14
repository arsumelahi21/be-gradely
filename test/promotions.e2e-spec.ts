import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { PrismaService } from '../src/prisma/prisma.service';
import { Role } from '../src/common/types/role.type';

/** Seeded relative to today — a fixed year becomes a scheduled failure. */
function sessionDates(offsetYears: number) {
  const year = new Date().getUTCFullYear() + offsetYears;
  return {
    startDate: new Date(Date.UTC(year, 0, 1)),
    endDate: new Date(Date.UTC(year, 11, 31)),
  };
}

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

/**
 * Grade 5 (A, B) and Grade 6 (A) in one school, two sessions, students enrolled
 * in Grade 5 A. Enough to exercise every promotion path.
 */
async function seedPromotionFixture(studentCount = 2) {
  const school = await createTestSchool();

  const [currentYear, nextYear] = await Promise.all([
    prisma.academicYear.create({
      data: {
        schoolId: school.id,
        name: `Current-${uniq()}`,
        code: `CUR${uniq()}`,
        isActive: true,
        ...sessionDates(0),
      },
    }),
    prisma.academicYear.create({
      data: {
        schoolId: school.id,
        name: `Next-${uniq()}`,
        code: `NXT${uniq()}`,
        isActive: false,
        ...sessionDates(1),
      },
    }),
  ]);

  const grade5 = await prisma.classGrade.create({
    data: { schoolId: school.id, name: 'Grade 5' },
  });
  const grade6 = await prisma.classGrade.create({
    data: { schoolId: school.id, name: 'Grade 6' },
  });
  const section5a = await prisma.section.create({
    data: { schoolId: school.id, classGradeId: grade5.id, name: 'A' },
  });
  const section5b = await prisma.section.create({
    data: { schoolId: school.id, classGradeId: grade5.id, name: 'B' },
  });
  const section6a = await prisma.section.create({
    data: { schoolId: school.id, classGradeId: grade6.id, name: 'A' },
  });

  const students: Array<{ id: string; fullName: string }> = [];
  for (let i = 0; i < studentCount; i++) {
    const user = await createTestUser({
      role: Role.STUDENT,
      schoolId: school.id,
    });
    const profile = await prisma.studentProfile.create({
      data: {
        userId: user.id,
        schoolId: school.id,
        fullName: `Student ${i}`,
        monthlyFeeAmount: 0,
      },
    });
    await prisma.enrollment.create({
      data: {
        studentId: profile.id,
        sectionId: section5a.id,
        academicYearId: currentYear.id,
        status: 'ACTIVE',
      },
    });
    students.push({ id: profile.id, fullName: profile.fullName });
  }

  const admin = await createTestUser({
    role: Role.SCHOOL_ADMIN,
    schoolId: school.id,
  });

  return {
    school,
    currentYear,
    nextYear,
    grade5,
    grade6,
    section5a,
    section5b,
    section6a,
    students,
    admin,
  };
}

describe('Class promotion (e2e)', () => {
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

  const plan = (
    f: Awaited<ReturnType<typeof seedPromotionFixture>>,
    overrides: Record<string, unknown> = {},
  ) => ({
    sourceAcademicYearId: f.currentYear.id,
    targetAcademicYearId: f.nextYear.id,
    students: f.students.map((s) => ({
      studentId: s.id,
      destinationClassGradeId: f.grade6.id,
      destinationSectionId: f.section6a.id,
    })),
    ...overrides,
  });

  describe('authorization', () => {
    it('rejects unauthenticated requests on every route', async () => {
      const server = app.getHttpServer();
      await request(server).get('/api/promotions/students').expect(401);
      await request(server)
        .post('/api/promotions/preview')
        .send({})
        .expect(401);
      await request(server)
        .post('/api/promotions/execute')
        .send({})
        .expect(401);
    });

    it.each([Role.TEACHER, Role.STUDENT, Role.PARENT])(
      'rejects %s',
      async (role) => {
        const f = await seedPromotionFixture(1);
        const user = await createTestUser({ role, schoolId: f.school.id });
        const token = await tokenFor(app, user);

        await request(app.getHttpServer())
          .get('/api/promotions/students')
          .query({
            academicYearId: f.currentYear.id,
            classGradeId: f.grade5.id,
          })
          .set('Authorization', `Bearer ${token}`)
          .expect(403);

        await request(app.getHttpServer())
          .post('/api/promotions/execute')
          .set('Authorization', `Bearer ${token}`)
          .send(plan(f))
          .expect(403);
      },
    );

    it("refuses another school's class and promotes nobody", async () => {
      const f = await seedPromotionFixture(1);
      const other = await createTestSchool();
      const intruder = await createTestUser({
        role: Role.SCHOOL_ADMIN,
        schoolId: other.id,
      });
      const token = await tokenFor(app, intruder);

      await request(app.getHttpServer())
        .get('/api/promotions/students')
        .query({ academicYearId: f.currentYear.id, classGradeId: f.grade5.id })
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(403);

      expect(
        await prisma.enrollment.count({
          where: { academicYearId: f.nextYear.id },
        }),
      ).toBe(0);
    });
  });

  describe('source roster', () => {
    it('lists the class and suggests the next class and matching section', async () => {
      const f = await seedPromotionFixture(2);
      const token = await tokenFor(app, f.admin);

      const res = await request(app.getHttpServer())
        .get('/api/promotions/students')
        .query({
          academicYearId: f.currentYear.id,
          classGradeId: f.grade5.id,
          targetAcademicYearId: f.nextYear.id,
        })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.total).toBe(2);
      expect(res.body.suggestion.classGrade).toMatchObject({
        id: f.grade6.id,
        name: 'Grade 6',
      });
      // 5-A → 6-A, and 6-A already exists so it is reused.
      expect(res.body.suggestion.sections).toEqual([
        {
          sourceSectionId: f.section5a.id,
          sourceSectionName: 'A',
          destinationSectionId: f.section6a.id,
          destinationSectionName: 'A',
          exists: true,
        },
      ]);
      expect(res.body.students[0].alreadyPlaced).toBeNull();
    });

    it('flags a student who already holds a place in the destination session', async () => {
      const f = await seedPromotionFixture(1);
      const token = await tokenFor(app, f.admin);
      await prisma.enrollment.create({
        data: {
          studentId: f.students[0].id,
          sectionId: f.section6a.id,
          academicYearId: f.nextYear.id,
          status: 'ACTIVE',
        },
      });

      const res = await request(app.getHttpServer())
        .get('/api/promotions/students')
        .query({
          academicYearId: f.currentYear.id,
          classGradeId: f.grade5.id,
          targetAcademicYearId: f.nextYear.id,
        })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.students[0].alreadyPlaced).toMatchObject({
        sectionId: f.section6a.id,
        label: 'Grade 6 A',
      });
    });
  });

  describe('preview', () => {
    it('summarises without writing anything', async () => {
      const f = await seedPromotionFixture(2);
      const token = await tokenFor(app, f.admin);
      const before = await prisma.enrollment.count();

      const res = await request(app.getHttpServer())
        .post('/api/promotions/preview')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      expect(res.body.counts.PROMOTE).toBe(2);
      expect(res.body.canExecute).toBe(true);
      expect(await prisma.enrollment.count()).toBe(before);
      expect(await prisma.section.count()).toBe(3);
    });
  });

  describe('execute', () => {
    it('promotes into the next session and preserves the old placement as history', async () => {
      const f = await seedPromotionFixture(2);
      const token = await tokenFor(app, f.admin);

      const res = await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      expect(res.body).toMatchObject({
        promoted: 2,
        reactivated: 0,
        sectionsCreated: 0,
      });

      const rows = await prisma.enrollment.findMany({
        where: { studentId: f.students[0].id },
        orderBy: { academicYearId: 'asc' },
      });
      expect(rows).toHaveLength(2);

      // The previous year's row still exists, still points at Grade 5 A, and is
      // only marked finished — nothing was overwritten.
      const past = rows.find((r) => r.academicYearId === f.currentYear.id)!;
      expect(past.sectionId).toBe(f.section5a.id);
      expect(past.status).toBe('COMPLETED');
      expect(past.endDate).not.toBeNull();

      const current = rows.find((r) => r.academicYearId === f.nextYear.id)!;
      expect(current.sectionId).toBe(f.section6a.id);
      expect(current.status).toBe('ACTIVE');
    });

    it('leaves unselected students in their current class', async () => {
      const f = await seedPromotionFixture(3);
      const token = await tokenFor(app, f.admin);

      await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(
          plan(f, {
            students: [
              {
                studentId: f.students[0].id,
                destinationClassGradeId: f.grade6.id,
                destinationSectionId: f.section6a.id,
              },
            ],
          }),
        )
        .expect(201);

      const untouched = await prisma.enrollment.findMany({
        where: { studentId: f.students[1].id },
      });
      expect(untouched).toHaveLength(1);
      expect(untouched[0]).toMatchObject({
        sectionId: f.section5a.id,
        academicYearId: f.currentYear.id,
        status: 'ACTIVE',
      });
    });

    it('keeps attendance and fee history attached to the old class', async () => {
      const f = await seedPromotionFixture(1);
      const token = await tokenFor(app, f.admin);

      const subject = await prisma.subject.create({
        data: { schoolId: f.school.id, name: `Maths-${uniq()}` },
      });
      const sectionSubject = await prisma.sectionSubject.create({
        data: { sectionId: f.section5a.id, subjectId: subject.id },
      });
      const attendance = await prisma.attendance.create({
        data: {
          schoolId: f.school.id,
          studentId: f.students[0].id,
          sectionSubjectId: sectionSubject.id,
          date: new Date(Date.UTC(2026, 0, 15)),
          status: 'PRESENT',
          markedByUserId: f.admin.id,
        },
      });
      const challan = await prisma.challan.create({
        data: {
          schoolId: f.school.id,
          challanNo: `CH-${uniq()}`,
          studentId: f.students[0].id,
          academicYearId: f.currentYear.id,
          sectionId: f.section5a.id,
          classGradeId: f.grade5.id,
          periodYear: 2026,
          periodMonth: 1,
          issueDate: new Date(),
          dueDate: new Date(),
          grossAmount: 1000,
          discountAmount: 0,
          netAmount: 1000,
          generatedByUserId: f.admin.id,
        },
      });

      await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      // Neither record references an enrollment, so promotion cannot disturb
      // them — this asserts that stays true.
      const keptAttendance = await prisma.attendance.findUnique({
        where: { id: attendance.id },
      });
      expect(keptAttendance).toMatchObject({
        sectionSubjectId: sectionSubject.id,
        status: 'PRESENT',
      });
      const keptChallan = await prisma.challan.findUnique({
        where: { id: challan.id },
      });
      expect(keptChallan).toMatchObject({
        sectionId: f.section5a.id,
        academicYearId: f.currentYear.id,
        netAmount: 1000,
      });
    });

    it('detects an existing enrollment and refuses to promote twice', async () => {
      const f = await seedPromotionFixture(2);
      const token = await tokenFor(app, f.admin);

      await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      const afterFirst = await prisma.enrollment.count();

      const second = await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      // The source rows are COMPLETED now, so the students read as no longer in
      // the source class; either way nothing is written a second time.
      expect(second.body.promoted).toBe(0);
      expect(await prisma.enrollment.count()).toBe(afterFirst);
    });

    it('skips a student already promoted by someone else and still promotes the rest', async () => {
      const f = await seedPromotionFixture(2);
      const token = await tokenFor(app, f.admin);
      await prisma.enrollment.create({
        data: {
          studentId: f.students[0].id,
          sectionId: f.section6a.id,
          academicYearId: f.nextYear.id,
          status: 'ACTIVE',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      expect(res.body.promoted).toBe(1);
      expect(res.body.counts.ALREADY_PROMOTED).toBe(1);
      expect(
        await prisma.enrollment.count({
          where: {
            studentId: f.students[0].id,
            academicYearId: f.nextYear.id,
          },
        }),
      ).toBe(1);
    });

    it('reuses an existing destination section instead of creating a duplicate', async () => {
      const f = await seedPromotionFixture(1);
      const token = await tokenFor(app, f.admin);

      await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(
          plan(f, {
            createMissingSections: true,
            students: [
              {
                studentId: f.students[0].id,
                destinationClassGradeId: f.grade6.id,
                destinationSectionName: 'A',
              },
            ],
          }),
        )
        .expect(201);

      const sixthSections = await prisma.section.findMany({
        where: { classGradeId: f.grade6.id },
      });
      expect(sixthSections).toHaveLength(1);
      expect(sixthSections[0].id).toBe(f.section6a.id);
    });

    it('creates a missing section only when asked, and writes nothing when refused', async () => {
      const f = await seedPromotionFixture(1);
      const token = await tokenFor(app, f.admin);
      const body = plan(f, {
        students: [
          {
            studentId: f.students[0].id,
            destinationClassGradeId: f.grade6.id,
            destinationSectionName: 'C',
          },
        ],
      });

      const blocked = await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);
      expect(blocked.body.message).toContain('no destination section');
      expect(
        await prisma.section.count({ where: { classGradeId: f.grade6.id } }),
      ).toBe(1);
      expect(
        await prisma.enrollment.count({
          where: { academicYearId: f.nextYear.id },
        }),
      ).toBe(0);

      const allowed = await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...body, createMissingSections: true })
        .expect(201);
      expect(allowed.body).toMatchObject({ promoted: 1, sectionsCreated: 1 });

      const created = await prisma.section.findFirst({
        where: { classGradeId: f.grade6.id, name: 'C' },
      });
      expect(created).not.toBeNull();
    });

    it('sends selected students to different destination sections in one run', async () => {
      const f = await seedPromotionFixture(2);
      const token = await tokenFor(app, f.admin);

      await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(
          plan(f, {
            createMissingSections: true,
            students: [
              {
                studentId: f.students[0].id,
                destinationClassGradeId: f.grade6.id,
                destinationSectionId: f.section6a.id,
              },
              {
                studentId: f.students[1].id,
                destinationClassGradeId: f.grade6.id,
                destinationSectionName: 'B',
              },
            ],
          }),
        )
        .expect(201);

      const placed = await prisma.enrollment.findMany({
        where: { academicYearId: f.nextYear.id },
        include: { section: true },
      });
      expect(placed).toHaveLength(2);
      expect(new Set(placed.map((p) => p.section.name))).toEqual(
        new Set(['A', 'B']),
      );
    });

    it('moves a student within the same session without tripping the one-class rule', async () => {
      const f = await seedPromotionFixture(1);
      const token = await tokenFor(app, f.admin);

      const res = await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send({
          sourceAcademicYearId: f.currentYear.id,
          targetAcademicYearId: f.currentYear.id,
          students: [
            {
              studentId: f.students[0].id,
              destinationClassGradeId: f.grade5.id,
              destinationSectionId: f.section5b.id,
            },
          ],
        })
        .expect(201);

      expect(res.body.promoted).toBe(1);
      const rows = await prisma.enrollment.findMany({
        where: { studentId: f.students[0].id },
      });
      // Exactly one ACTIVE placement, and the old one kept as history.
      expect(rows.filter((r) => r.status === 'ACTIVE')).toHaveLength(1);
      expect(rows.filter((r) => r.status === 'ACTIVE')[0].sectionId).toBe(
        f.section5b.id,
      );
      expect(rows).toHaveLength(2);
    });

    it('rejects a student from another school without promoting anyone', async () => {
      const f = await seedPromotionFixture(1);
      const token = await tokenFor(app, f.admin);
      const other = await createTestSchool();
      const otherUser = await createTestUser({
        role: Role.STUDENT,
        schoolId: other.id,
      });
      const outsider = await prisma.studentProfile.create({
        data: {
          userId: otherUser.id,
          schoolId: other.id,
          fullName: 'Outsider',
        },
      });

      await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(
          plan(f, {
            students: [
              {
                studentId: f.students[0].id,
                destinationClassGradeId: f.grade6.id,
                destinationSectionId: f.section6a.id,
              },
              {
                studentId: outsider.id,
                destinationClassGradeId: f.grade6.id,
                destinationSectionId: f.section6a.id,
              },
            ],
          }),
        )
        .expect(400);

      expect(
        await prisma.enrollment.count({
          where: { academicYearId: f.nextYear.id },
        }),
      ).toBe(0);
    });

    it('returns the same session envelope as preview, so the caller can name both sessions', async () => {
      const f = await seedPromotionFixture(1);
      const token = await tokenFor(app, f.admin);

      const previewed = await request(app.getHttpServer())
        .post('/api/promotions/preview')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      const executed = await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      for (const body of [previewed.body, executed.body]) {
        expect(body.sourceAcademicYear).toMatchObject({
          id: f.currentYear.id,
          name: f.currentYear.name,
        });
        expect(body.targetAcademicYear).toMatchObject({
          id: f.nextYear.id,
          name: f.nextYear.name,
        });
      }
    });

    it('carries the session envelope even when the run is a no-op', async () => {
      const f = await seedPromotionFixture(1);
      const token = await tokenFor(app, f.admin);
      // Already placed in the destination session, so nothing is actionable.
      await prisma.enrollment.create({
        data: {
          studentId: f.students[0].id,
          sectionId: f.section6a.id,
          academicYearId: f.nextYear.id,
          status: 'ACTIVE',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      expect(res.body.promoted).toBe(0);
      expect(res.body.targetAcademicYear).toMatchObject({
        id: f.nextYear.id,
        name: f.nextYear.name,
      });
    });

    describe('resetting a section the run empties', () => {
      /** Gives a section a subject with a teacher, a homeroom link and a timetable. */
      async function attachTeaching(
        f: Awaited<ReturnType<typeof seedPromotionFixture>>,
        sectionId: string,
      ) {
        const teacherUser = await createTestUser({
          role: Role.TEACHER,
          schoolId: f.school.id,
        });
        const teacher = await prisma.teacherProfile.create({
          data: {
            userId: teacherUser.id,
            schoolId: f.school.id,
            fullName: 'Teacher',
          },
        });
        const subject = await prisma.subject.create({
          data: { schoolId: f.school.id, name: `Subject-${uniq()}` },
        });
        const sectionSubject = await prisma.sectionSubject.create({
          data: { sectionId, subjectId: subject.id, teacherId: teacher.id },
        });
        await prisma.sectionTeacher.create({
          data: { sectionId, teacherId: teacher.id },
        });
        const timetable = await prisma.timetable.create({
          data: {
            schoolId: f.school.id,
            academicYearId: f.currentYear.id,
            sectionId,
            status: 'PUBLISHED',
            workingDays: ['MONDAY', 'TUESDAY'],
          },
        });
        return { teacher, subject, sectionSubject, timetable };
      }

      it('leaves a section that still holds students untouched', async () => {
        // Two students, only one promoted — the room is still in use, so half
        // a promotion must never strip teachers from whoever is still sitting
        // in it. This is why "emptied" is judged AFTER the placements move.
        const f = await seedPromotionFixture(2);
        const token = await tokenFor(app, f.admin);
        const setup = await attachTeaching(f, f.section5a.id);

        const res = await request(app.getHttpServer())
          .post('/api/promotions/execute')
          .set('Authorization', `Bearer ${token}`)
          .send({
            sourceAcademicYearId: f.currentYear.id,
            targetAcademicYearId: f.nextYear.id,
            students: [
              {
                studentId: f.students[0].id,
                destinationClassGradeId: f.grade6.id,
                destinationSectionId: f.section6a.id,
              },
            ],
          })
          .expect(201);

        expect(res.body.sectionsReset).toBe(0);
        const ss = await prisma.sectionSubject.findUnique({
          where: { id: setup.sectionSubject.id },
        });
        expect(ss?.teacherId).toBe(setup.teacher.id);
        const tt = await prisma.timetable.findUnique({
          where: { id: setup.timetable.id },
        });
        expect(tt?.status).toBe('PUBLISHED');
      });

      it('rejects the retired resetEmptiedSections flag', async () => {
        // The reset is automatic now; the flag is gone from the DTO, and
        // forbidNonWhitelisted turns a stale client into a 400 rather than a
        // silently ignored option.
        const f = await seedPromotionFixture(1);
        const token = await tokenFor(app, f.admin);

        await request(app.getHttpServer())
          .post('/api/promotions/execute')
          .set('Authorization', `Bearer ${token}`)
          .send(plan(f, { resetEmptiedSections: true }))
          .expect(400);
      });

      it('unassigns teachers and archives the timetable once the section is empty', async () => {
        const f = await seedPromotionFixture(2);
        const token = await tokenFor(app, f.admin);
        const setup = await attachTeaching(f, f.section5a.id);

        const res = await request(app.getHttpServer())
          .post('/api/promotions/execute')
          .set('Authorization', `Bearer ${token}`)
          .send(plan(f))
          .expect(201);

        expect(res.body.sectionsReset).toBe(1);

        const ss = await prisma.sectionSubject.findUnique({
          where: { id: setup.sectionSubject.id },
        });
        expect(ss).not.toBeNull();
        expect(ss?.teacherId).toBeNull();

        expect(
          await prisma.sectionTeacher.count({
            where: { sectionId: f.section5a.id },
          }),
        ).toBe(0);

        const tt = await prisma.timetable.findUnique({
          where: { id: setup.timetable.id },
        });
        expect(tt?.status).toBe('ARCHIVED');
      });

      it('does NOT reset a section that still holds students', async () => {
        const f = await seedPromotionFixture(3);
        const token = await tokenFor(app, f.admin);
        const setup = await attachTeaching(f, f.section5a.id);

        // Promote one of three — the other two stay put.
        const res = await request(app.getHttpServer())
          .post('/api/promotions/execute')
          .set('Authorization', `Bearer ${token}`)
          .send(
            plan(f, {
              students: [
                {
                  studentId: f.students[0].id,
                  destinationClassGradeId: f.grade6.id,
                  destinationSectionId: f.section6a.id,
                },
              ],
            }),
          )
          .expect(201);

        expect(res.body.promoted).toBe(1);
        expect(res.body.sectionsReset).toBe(0);

        const ss = await prisma.sectionSubject.findUnique({
          where: { id: setup.sectionSubject.id },
        });
        expect(ss?.teacherId).toBe(setup.teacher.id);
        const tt = await prisma.timetable.findUnique({
          where: { id: setup.timetable.id },
        });
        expect(tt?.status).toBe('PUBLISHED');
      });

      it('never deletes subjects, assignments, attendance or results', async () => {
        const f = await seedPromotionFixture(1);
        const token = await tokenFor(app, f.admin);
        const setup = await attachTeaching(f, f.section5a.id);

        const assignment = await prisma.assignment.create({
          data: {
            schoolId: f.school.id,
            academicYearId: f.currentYear.id,
            sectionSubjectId: setup.sectionSubject.id,
            createdByTeacherId: setup.teacher.id,
            title: 'Term paper',
            status: 'PUBLISHED',
            maxScore: 10,
          },
        });
        const submission = await prisma.assignmentSubmission.create({
          data: {
            assignmentId: assignment.id,
            studentId: f.students[0].id,
            status: 'MARKED',
            s3Key: 'k',
            score: 9,
          },
        });
        const attendance = await prisma.attendance.create({
          data: {
            schoolId: f.school.id,
            studentId: f.students[0].id,
            sectionSubjectId: setup.sectionSubject.id,
            date: new Date(Date.UTC(2026, 1, 3)),
            status: 'PRESENT',
            markedByUserId: f.admin.id,
          },
        });

        await request(app.getHttpServer())
          .post('/api/promotions/execute')
          .set('Authorization', `Bearer ${token}`)
          .send(plan(f))
          .expect(201);

        // The subject row survives — it is the anchor everything above hangs on.
        expect(
          await prisma.sectionSubject.count({
            where: { id: setup.sectionSubject.id },
          }),
        ).toBe(1);
        expect(
          await prisma.assignment.count({ where: { id: assignment.id } }),
        ).toBe(1);
        const keptSubmission = await prisma.assignmentSubmission.findUnique({
          where: { id: submission.id },
        });
        expect(keptSubmission?.score).toBe(9);
        expect(
          await prisma.attendance.count({ where: { id: attendance.id } }),
        ).toBe(1);
      });
    });

    it('records one audit entry per run', async () => {
      const f = await seedPromotionFixture(1);
      const token = await tokenFor(app, f.admin);

      await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      const logs = await prisma.auditLog.findMany({
        where: { action: 'ENROLLMENT_PROMOTE', schoolId: f.school.id },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].actorUserId).toBe(f.admin.id);
    });

    it('issues the same number of queries for 2 students as for 12', async () => {
      // Every model call promotion makes; a per-student loop would show up here.
      const CALLS = [
        'academicYear.findMany',
        'studentProfile.findMany',
        'classGrade.findMany',
        'enrollment.findMany',
        'section.findMany',
        'section.create',
        'enrollment.updateMany',
        'enrollment.createMany',
      ] as const;

      async function countFor(studentCount: number) {
        const f = await seedPromotionFixture(studentCount);
        const token = await tokenFor(app, f.admin);
        const svc = app.get(PrismaService);

        const counts: Record<string, number> = {};
        const restores: Array<() => void> = [];
        for (const path of CALLS) {
          const [model, method] = path.split('.');
          const original = svc[model][method].bind(svc[model]);
          counts[path] = 0;
          svc[model][method] = (...args: unknown[]) => {
            counts[path] += 1;
            return original(...args);
          };
          restores.push(() => {
            svc[model][method] = original;
          });
        }

        try {
          await request(app.getHttpServer())
            .post('/api/promotions/execute')
            .set('Authorization', `Bearer ${token}`)
            .send(plan(f))
            .expect(201);
        } finally {
          restores.forEach((r) => r());
        }

        const promoted = await prisma.enrollment.count({
          where: { academicYearId: f.nextYear.id, status: 'ACTIVE' },
        });
        return { counts, promoted };
      }

      const small = await countFor(2);
      await resetDb();
      const large = await countFor(12);

      expect(small.promoted).toBe(2);
      expect(large.promoted).toBe(12);
      // 6x the students, identical query counts.
      expect(large.counts).toEqual(small.counts);
    });
  });
  /**
   * Session separation — the rule that replaced the "old student" flag.
   *
   * A destination class holds a DIFFERENT roster each session. Promotion adds
   * to the target session's roster; it never reads from it, never replaces it,
   * and never offers its students up as candidates for the same run.
   */
  describe('sessions keep the two rosters apart', () => {
    /** Someone already sitting in 6-A for the NEXT session. */
    async function seatInDestination(
      f: Awaited<ReturnType<typeof seedPromotionFixture>>,
      name: string,
    ) {
      const user = await createTestUser({
        role: Role.STUDENT,
        schoolId: f.school.id,
      });
      const profile = await prisma.studentProfile.create({
        data: {
          userId: user.id,
          schoolId: f.school.id,
          fullName: name,
          monthlyFeeAmount: 0,
        },
      });
      await prisma.enrollment.create({
        data: {
          studentId: profile.id,
          sectionId: f.section6a.id,
          academicYearId: f.nextYear.id,
          status: 'ACTIVE',
        },
      });
      return profile;
    }

    it('never offers destination-session students as promotion candidates', async () => {
      const f = await seedPromotionFixture(2);
      const token = await tokenFor(app, f.admin);
      const seated = await seatInDestination(f, 'Already In Six');

      // Ask for Grade 6 in the SOURCE session: the seated student belongs to
      // the next session, so they must not appear.
      const res = await request(app.getHttpServer())
        .get('/api/promotions/students')
        .query({
          academicYearId: f.currentYear.id,
          classGradeId: f.grade6.id,
          targetAcademicYearId: f.nextYear.id,
        })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const ids = res.body.students.map(
        (s: { studentId: string }) => s.studentId,
      );
      expect(ids).not.toContain(seated.id);
      expect(res.body.total).toBe(0);
    });

    it('leaves existing destination students in place and adds to them', async () => {
      const f = await seedPromotionFixture(2);
      const token = await tokenFor(app, f.admin);
      const x = await seatInDestination(f, 'Student X');
      const y = await seatInDestination(f, 'Student Y');

      await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      const roster = await prisma.enrollment.findMany({
        where: {
          sectionId: f.section6a.id,
          academicYearId: f.nextYear.id,
          status: 'ACTIVE',
        },
        select: { studentId: true },
      });
      const ids = roster.map((r) => r.studentId);

      // 2 who were already there + 2 promoted in, and nobody removed.
      expect(ids).toHaveLength(4);
      expect(ids).toEqual(expect.arrayContaining([x.id, y.id]));
      for (const s of f.students) expect(ids).toContain(s.id);
    });

    it('reports destination occupancy for the target session only', async () => {
      const f = await seedPromotionFixture(1);
      const token = await tokenFor(app, f.admin);
      await seatInDestination(f, 'Student X');
      await seatInDestination(f, 'Student Y');

      const next = await request(app.getHttpServer())
        .get('/api/promotions/destination')
        .query({ academicYearId: f.nextYear.id, classGradeId: f.grade6.id })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(next.body.existingStudents).toBe(2);
      expect(next.body.sections).toEqual([
        { id: f.section6a.id, name: 'A', existingStudents: 2 },
      ]);

      // The same room in the CURRENT session is empty — occupancy is per
      // (section, session), which is the whole point.
      const current = await request(app.getHttpServer())
        .get('/api/promotions/destination')
        .query({ academicYearId: f.currentYear.id, classGradeId: f.grade6.id })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(current.body.existingStudents).toBe(0);
    });

    it('promoting again is idempotent - no duplicate enrollment rows', async () => {
      const f = await seedPromotionFixture(2);
      const token = await tokenFor(app, f.admin);

      await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      const second = await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      expect(second.body.promoted).toBe(0);
      expect(
        await prisma.enrollment.count({
          where: { sectionId: f.section6a.id, academicYearId: f.nextYear.id },
        }),
      ).toBe(2);
    });

    it("refuses another school's destination class", async () => {
      const f = await seedPromotionFixture(1);
      const other = await createTestSchool();
      const intruder = await createTestUser({
        role: Role.SCHOOL_ADMIN,
        schoolId: other.id,
      });
      const token = await tokenFor(app, intruder);

      await request(app.getHttpServer())
        .get('/api/promotions/destination')
        .query({ academicYearId: f.nextYear.id, classGradeId: f.grade6.id })
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });
  /**
   * TEST 7 — a failure PART WAY THROUGH the write, not a rejected request.
   *
   * The interesting case is a fault after sections have been created and the
   * source placements already closed. Nothing may survive that: no half-moved
   * student, no orphan section, no section left reset.
   */
  describe('rollback on a mid-transaction failure', () => {
    it('leaves absolutely nothing behind when a write fails', async () => {
      const f = await seedPromotionFixture(2);
      const token = await tokenFor(app, f.admin);
      const prismaSvc = app.get(PrismaService);

      // Fail on the LAST write of the run — by then the section has been
      // created and the source rows closed, so a leak would be visible.
      const spy = jest
        .spyOn(prismaSvc, '$transaction')
        .mockImplementationOnce((fn: any) =>
          (prismaSvc as any).$transaction((tx: any) =>
            fn(
              new Proxy(tx, {
                get(target, prop) {
                  if (prop !== 'enrollment') return target[prop];
                  return new Proxy(target.enrollment, {
                    get(inner, key) {
                      if (key === 'createMany') {
                        return () => {
                          throw new Error('forced mid-transaction failure');
                        };
                      }
                      return inner[key];
                    },
                  });
                },
              }),
            ),
          ),
        );

      try {
        await request(app.getHttpServer())
          .post('/api/promotions/execute')
          .set('Authorization', `Bearer ${token}`)
          .send(
            plan(f, {
              createMissingSections: true,
              students: f.students.map((s) => ({
                studentId: s.id,
                destinationClassGradeId: f.grade6.id,
                destinationSectionName: 'BrandNew',
              })),
            }),
          )
          .expect(500);
      } finally {
        spy.mockRestore();
      }

      // No student moved.
      expect(
        await prisma.enrollment.count({
          where: { academicYearId: f.nextYear.id },
        }),
      ).toBe(0);

      // No source placement was closed — all still ACTIVE where they started.
      const source = await prisma.enrollment.findMany({
        where: { academicYearId: f.currentYear.id },
        select: { status: true, sectionId: true },
      });
      expect(source).toHaveLength(2);
      for (const row of source) {
        expect(row.status).toBe('ACTIVE');
        expect(row.sectionId).toBe(f.section5a.id);
      }

      // The section the run would have created does not exist.
      expect(
        await prisma.section.count({
          where: { classGradeId: f.grade6.id, name: 'BrandNew' },
        }),
      ).toBe(0);
    });

    it('still promotes normally once the fault is gone', async () => {
      // Proves the spy above was scoped to one call and the route is healthy.
      const f = await seedPromotionFixture(2);
      const token = await tokenFor(app, f.admin);

      const res = await request(app.getHttpServer())
        .post('/api/promotions/execute')
        .set('Authorization', `Bearer ${token}`)
        .send(plan(f))
        .expect(201);

      expect(res.body.promoted).toBe(2);
    });
  });
});
