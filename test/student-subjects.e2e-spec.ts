import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { seedExamination } from './utils/exam-fixture';
import { Role } from '../src/common/types/role.type';

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

/**
 * Student subject selection — students in one section can take different subjects,
 * whatever the class is called.
 *
 * The load-bearing assertion is "regular classes are unchanged": a compulsory
 * SectionSubject must resolve to the whole section roster, exactly as it did
 * before StudentSubject existed. Everything else is the new behaviour.
 */
describe('Student subject enrollment (e2e)', () => {
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

  /** One section: Maths compulsory, Physics/Economics/Biology elective, 3 students. */
  async function seedSelectionSection() {
    const cls = await seedClass({ studentCount: 3 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });

    const electives: Record<string, string> = {};
    for (const name of ['Physics', 'Economics', 'Biology']) {
      const subject = await prisma.subject.create({
        data: { schoolId: cls.school.id, name: `${name}-${uniq()}` },
      });
      const ss = await prisma.sectionSubject.create({
        data: {
          sectionId: cls.section.id,
          subjectId: subject.id,
          isElective: true,
        },
      });
      electives[name] = ss.id;
    }

    return {
      ...cls,
      admin,
      adminToken: await tokenFor(app, admin),
      // cls.sectionSubject is the fixture's default — left compulsory on purpose.
      maths: cls.sectionSubject.id,
      electives,
      studentIds: cls.students.map((s) => s.profile.id),
    };
  }

  const patch = (token: string, body: object) =>
    request(app.getHttpServer())
      .patch('/api/student-subjects')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const matrix = (token: string, sectionId: string, academicYearId: string) =>
    request(app.getHttpServer())
      .get('/api/student-subjects')
      .query({ sectionId, academicYearId })
      .set('Authorization', `Bearer ${token}`);

  describe('the section matrix', () => {
    it('lists every offering and flags which are elective', async () => {
      const f = await seedSelectionSection();
      const res = await matrix(f.adminToken, f.section.id, f.academicYear.id);

      expect(res.status).toBe(200);
      expect(res.body.offerings).toHaveLength(4);
      expect(res.body.offerings.filter((o: any) => o.isElective)).toHaveLength(
        3,
      );
      expect(res.body.rosterTotal).toBe(3);
    });

    it('gives each student only their own selections', async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[1]],
        add: [f.electives.Economics],
      });

      const res = await matrix(f.adminToken, f.section.id, f.academicYear.id);
      const byStudent = new Map<string, string[]>(
        res.body.items.map((i: any) => [i.student.id, i.selected]),
      );
      expect(byStudent.get(f.studentIds[0])).toEqual([f.electives.Physics]);
      expect(byStudent.get(f.studentIds[1])).toEqual([f.electives.Economics]);
      expect(byStudent.get(f.studentIds[2])).toEqual([]);
    });
  });

  describe('assigning subjects', () => {
    it('assigns different combinations to different students', async () => {
      const f = await seedSelectionSection();
      const res = await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics, f.electives.Biology],
      });
      expect(res.status).toBe(200);
      expect(res.body.added).toBe(2);
      expect(res.body.studentsUpdated).toBe(1);
      expect(res.body.skipped).toEqual([]);
    });

    it('applies one subject to several students in a single request', async () => {
      const f = await seedSelectionSection();
      const res = await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: f.studentIds,
        add: [f.electives.Physics],
      });
      expect(res.body.added).toBe(3);
      expect(res.body.studentsUpdated).toBe(3);
    });

    it('treats re-sending an existing choice as a no-op, not an error', async () => {
      const f = await seedSelectionSection();
      const body = {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      };
      await patch(f.adminToken, body);
      const again = await patch(f.adminToken, body);

      expect(again.status).toBe(200);
      expect(again.body.added).toBe(0);
    });

    it('notifies the student and guardians once per save, and not for a no-op', async () => {
      const f = await seedSelectionSection();
      const parentUser = await createTestUser({
        role: Role.PARENT,
        schoolId: f.school.id,
      });
      const parent = await prisma.parentProfile.create({
        data: { userId: parentUser.id, fullName: 'Parent' },
      });
      await prisma.parentStudent.create({
        data: { parentId: parent.id, studentId: f.studentIds[0] },
      });
      const body = {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics, f.electives.Biology],
      };
      const notesOf = (userId: string) =>
        prisma.notification.findMany({
          where: { userId, type: 'SUBJECTS_UPDATED' },
          orderBy: { createdAt: 'asc' },
        });
      // The listener writes asynchronously.
      const waitFor = async (userId: string, count: number) => {
        const deadline = Date.now() + 5000;
        while (
          (await notesOf(userId)).length < count &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 100));
        }
        return notesOf(userId);
      };

      await patch(f.adminToken, body);
      const [own] = await waitFor(f.students[0].user.id, 1);
      expect(own.body).toMatch(/Added: Physics-\d+, Biology-\d+\./);
      expect(own.link).toBe('/subjects');
      const [guardian] = await waitFor(parentUser.id, 1);
      expect(guardian.title).toBe(
        `${f.students[0].profile.fullName}'s subjects were updated`,
      );
      expect(guardian.link).toBe(`/subjects?studentId=${f.studentIds[0]}`);

      // The no-op, then a real change as a fence: once the fence lands, a
      // notification from the no-op would already be there too.
      await patch(f.adminToken, body);
      await patch(f.adminToken, { ...body, add: [f.electives.Economics] });
      const after = await waitFor(f.students[0].user.id, 2);
      expect(after).toHaveLength(2);
      expect(after[1].body).toMatch(/Added: Economics-\d+\./);
    });

    it('removes a choice that has no marks or attendance behind it', async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });
      const res = await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        remove: [f.electives.Physics],
      });
      expect(res.body.removed).toBe(1);
    });

    it('refuses to assign a compulsory subject per student', async () => {
      const f = await seedSelectionSection();
      const res = await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.maths],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/whole class/i);
    });

    it('refuses to add and remove the same subject at once', async () => {
      const f = await seedSelectionSection();
      const res = await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
        remove: [f.electives.Physics],
      });
      expect(res.status).toBe(400);
    });

    it('skips a student who is not enrolled in the section, and commits the rest', async () => {
      const f = await seedSelectionSection();
      const outsider = await prisma.studentProfile.create({
        data: {
          schoolId: f.school.id,
          fullName: `Outsider ${uniq()}`,
        },
      });

      const res = await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [...f.studentIds, outsider.id],
        add: [f.electives.Physics],
      });
      expect(res.status).toBe(200);
      expect(res.body.added).toBe(3);
      expect(res.body.studentsUpdated).toBe(3);
      expect(res.body.skipped).toHaveLength(1);
      expect(res.body.skipped[0].studentId).toBe(outsider.id);
      expect(res.body.skipped[0].reason).toMatch(/not currently enrolled/i);
    });

    it('skips a student with attendance in a subject being removed, and commits the rest', async () => {
      const f = await seedSelectionSection();
      const pair = [f.studentIds[0], f.studentIds[1]];
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: pair,
        add: [f.electives.Physics],
      });
      await prisma.attendance.create({
        data: {
          schoolId: f.school.id,
          studentId: f.studentIds[0],
          sectionSubjectId: f.electives.Physics,
          date: new Date('2026-06-01'),
          status: 'PRESENT',
          markedByUserId: f.admin.id,
        },
      });

      const res = await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: pair,
        remove: [f.electives.Physics],
      });
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(1);
      expect(res.body.studentsUpdated).toBe(1);
      expect(res.body.skipped).toHaveLength(1);
      expect(res.body.skipped[0].studentId).toBe(f.studentIds[0]);
      expect(res.body.skipped[0].reason).toMatch(
        /already recorded for Student 0 in Physics-\d+/,
      );
      const left = await prisma.studentSubject.findMany({
        where: { sectionSubjectId: f.electives.Physics },
        select: { studentId: true },
      });
      expect(left).toEqual([{ studentId: f.studentIds[0] }]);
    });

    it('skips a student with marks this session in a subject being removed', async () => {
      const f = await seedSelectionSection();
      const pair = [f.studentIds[0], f.studentIds[1]];
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: pair,
        add: [f.electives.Physics],
      });
      const { subjects } = await seedExamination({
        schoolId: f.school.id,
        academicYearId: f.academicYear.id,
        sectionId: f.section.id,
        sectionSubjectIds: [f.electives.Physics],
        heldAt: new Date('2026-06-15'),
      });
      await prisma.examResult.create({
        data: { examId: subjects[0].id, studentId: f.studentIds[0], score: 70 },
      });

      const res = await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: pair,
        remove: [f.electives.Physics],
      });
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(1);
      expect(res.body.skipped.map((s: any) => s.studentId)).toEqual([
        f.studentIds[0],
      ]);
    });

    it("counts attendance on the session's first and last day, not the day before", async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: f.studentIds,
        add: [f.electives.Physics],
      });
      // The fixture session runs 2026-01-01 to 2026-12-31.
      const days = ['2026-01-01', '2026-12-31', '2025-12-31'];
      await prisma.attendance.createMany({
        data: days.map((day, i) => ({
          schoolId: f.school.id,
          studentId: f.studentIds[i],
          sectionSubjectId: f.electives.Physics,
          date: new Date(day),
          status: 'PRESENT' as const,
          markedByUserId: f.admin.id,
        })),
      });

      const res = await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: f.studentIds,
        remove: [f.electives.Physics],
      });
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(1);
      expect(res.body.skipped.map((s: any) => s.studentId).sort()).toEqual(
        [f.studentIds[0], f.studentIds[1]].sort(),
      );
    });
  });

  describe('integrity', () => {
    it('404s a subject from another section', async () => {
      const f = await seedSelectionSection();
      const otherSection = await prisma.section.create({
        data: {
          schoolId: f.school.id,
          classGradeId: f.classGrade.id,
          name: `Other-${uniq()}`,
        },
      });
      const otherSubject = await prisma.subject.create({
        data: { schoolId: f.school.id, name: `Other-${uniq()}` },
      });
      const foreign = await prisma.sectionSubject.create({
        data: {
          sectionId: otherSection.id,
          subjectId: otherSubject.id,
          isElective: true,
        },
      });

      const res = await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics, foreign.id],
      });
      // Both exist in this school, but they do not share a section.
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/same section/i);
    });

    it('404s an academic session from another school', async () => {
      const f = await seedSelectionSection();
      const otherSchool = await createTestSchool();
      const otherYear = await prisma.academicYear.create({
        data: {
          schoolId: otherSchool.id,
          name: `AY-${uniq()}`,
          code: `AY${uniq()}`,
          startDate: new Date('2026-01-01'),
          endDate: new Date('2026-12-31'),
        },
      });

      const res = await patch(f.adminToken, {
        academicYearId: otherYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });
      expect(res.status).toBe(404);
    });

    it("404s another school's subject rather than confirming it exists", async () => {
      const f = await seedSelectionSection();
      const other = await seedSelectionSection();

      const res = await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [other.electives.Physics],
      });
      expect(res.status).toBe(404);
    });

    it('refuses a teacher reading or editing selections', async () => {
      const f = await seedSelectionSection();
      const token = await tokenFor(app, f.teacherUser);

      expect(
        (await matrix(token, f.section.id, f.academicYear.id)).status,
      ).toBe(403);
      const res = await patch(token, {
        academicYearId: f.academicYear.id,
        studentIds: f.studentIds,
        add: [f.electives.Physics],
      });
      expect(res.status).toBe(403);
      expect(await prisma.studentSubject.count()).toBe(0);
    });

    it("404s another school's section on the matrix", async () => {
      const f = await seedSelectionSection();
      const other = await seedSelectionSection();

      const res = await matrix(
        f.adminToken,
        other.section.id,
        other.academicYear.id,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('history', () => {
    it('leaves a finished session untouched when the next one is edited', async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });

      // Next session, same section, a different combination.
      const nextYear = await prisma.academicYear.create({
        data: {
          schoolId: f.school.id,
          name: `AY-${uniq()}`,
          code: `AY${uniq()}`,
          startDate: new Date('2027-01-01'),
          endDate: new Date('2027-12-31'),
        },
      });
      await prisma.enrollment.updateMany({
        where: {
          studentId: f.studentIds[0],
          academicYearId: f.academicYear.id,
        },
        data: { status: 'COMPLETED' },
      });
      await prisma.enrollment.create({
        data: {
          studentId: f.studentIds[0],
          sectionId: f.section.id,
          academicYearId: nextYear.id,
          status: 'ACTIVE',
        },
      });
      await patch(f.adminToken, {
        academicYearId: nextYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Economics],
      });

      const rows = await prisma.studentSubject.findMany({
        where: { studentId: f.studentIds[0] },
        select: { academicYearId: true, sectionSubjectId: true },
      });
      expect(rows).toHaveLength(2);
      expect(
        rows.find((r) => r.academicYearId === f.academicYear.id)
          ?.sectionSubjectId,
      ).toBe(f.electives.Physics);
    });

    it("does not let last session's marks or attendance block a removal this session", async () => {
      const f = await seedSelectionSection();
      const [studentId] = f.studentIds;
      await prisma.attendance.create({
        data: {
          schoolId: f.school.id,
          studentId,
          sectionSubjectId: f.electives.Physics,
          date: new Date('2026-06-01'),
          status: 'PRESENT',
          markedByUserId: f.admin.id,
        },
      });
      const { subjects } = await seedExamination({
        schoolId: f.school.id,
        academicYearId: f.academicYear.id,
        sectionId: f.section.id,
        sectionSubjectIds: [f.electives.Physics],
        heldAt: new Date('2026-06-15'),
      });
      await prisma.examResult.create({
        data: { examId: subjects[0].id, studentId, score: 70 },
      });

      // Same section, next session — the shape where history used to leak in.
      const nextYear = await prisma.academicYear.create({
        data: {
          schoolId: f.school.id,
          name: `AY-${uniq()}`,
          code: `AY${uniq()}`,
          startDate: new Date('2027-01-01'),
          endDate: new Date('2027-12-31'),
        },
      });
      await prisma.enrollment.updateMany({
        where: { studentId, academicYearId: f.academicYear.id },
        data: { status: 'COMPLETED' },
      });
      await prisma.enrollment.create({
        data: {
          studentId,
          sectionId: f.section.id,
          academicYearId: nextYear.id,
          status: 'ACTIVE',
        },
      });
      const body = { academicYearId: nextYear.id, studentIds: [studentId] };
      await patch(f.adminToken, { ...body, add: [f.electives.Physics] });

      const res = await patch(f.adminToken, {
        ...body,
        remove: [f.electives.Physics],
      });
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(1);
      expect(res.body.skipped).toEqual([]);
    });

    it('lets a compulsory subject with last session’s attendance be narrowed after switching to student selection', async () => {
      const f = await seedSelectionSection();
      const [studentId] = f.studentIds;
      await prisma.attendance.create({
        data: {
          schoolId: f.school.id,
          studentId,
          sectionSubjectId: f.maths,
          date: new Date('2026-06-01'),
          status: 'PRESENT',
          markedByUserId: f.admin.id,
        },
      });
      const nextYear = await prisma.academicYear.create({
        data: {
          schoolId: f.school.id,
          name: `AY-${uniq()}`,
          code: `AY${uniq()}`,
          startDate: new Date('2027-01-01'),
          endDate: new Date('2027-12-31'),
        },
      });
      await prisma.enrollment.updateMany({
        where: { studentId, academicYearId: f.academicYear.id },
        data: { status: 'COMPLETED' },
      });
      await prisma.enrollment.create({
        data: {
          studentId,
          sectionId: f.section.id,
          academicYearId: nextYear.id,
          status: 'ACTIVE',
        },
      });

      await request(app.getHttpServer())
        .patch(`/api/section-subjects/${f.maths}`)
        .set('Authorization', `Bearer ${f.adminToken}`)
        .send({ isElective: true })
        .expect(200);
      const res = await patch(f.adminToken, {
        academicYearId: nextYear.id,
        studentIds: [studentId],
        remove: [f.maths],
      });
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(1);
      expect(res.body.skipped).toEqual([]);
      // Last session's attendance is history, never touched by the change.
      expect(
        await prisma.attendance.count({
          where: { studentId, sectionSubjectId: f.maths },
        }),
      ).toBe(1);
    });
  });

  describe('reading one student', () => {
    const combination = (token: string, studentId: string) =>
      request(app.getHttpServer())
        .get(`/api/student-subjects/student/${studentId}`)
        .set('Authorization', `Bearer ${token}`);

    it('returns compulsory subjects plus the student own choices', async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });

      const res = await combination(f.adminToken, f.studentIds[0]);
      expect(res.status).toBe(200);
      const ids = res.body.subjects.map((s: any) => s.sectionSubjectId).sort();
      expect(ids).toEqual([f.maths, f.electives.Physics].sort());
    });

    it('lets a student read their own combination', async () => {
      const f = await seedSelectionSection();
      const token = await tokenFor(app, f.students[0].user);
      const res = await combination(token, f.studentIds[0]);
      expect(res.status).toBe(200);
    });

    it("refuses a student reading a classmate's combination", async () => {
      const f = await seedSelectionSection();
      const token = await tokenFor(app, f.students[0].user);
      const res = await combination(token, f.studentIds[1]);
      expect(res.status).toBe(403);
    });

    it('404s a student from another school rather than 403ing', async () => {
      const f = await seedSelectionSection();
      const other = await seedSelectionSection();
      const res = await combination(f.adminToken, other.studentIds[0]);
      expect(res.status).toBe(404);
    });
  });

  describe('default selection', () => {
    const chosen = (studentId: string) =>
      prisma.studentSubject
        .findMany({ where: { studentId }, select: { sectionSubjectId: true } })
        .then((rows) => rows.map((r) => r.sectionSubjectId).sort());

    it('clears choices on unenrol and ticks every elective on re-enrol', async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });
      const enrollment = await prisma.enrollment.findFirstOrThrow({
        where: { studentId: f.studentIds[0], sectionId: f.section.id },
      });

      const removed = await request(app.getHttpServer())
        .delete(`/api/enrollments/${enrollment.id}`)
        .set('Authorization', `Bearer ${f.adminToken}`);
      expect(removed.status).toBe(200);
      expect(await chosen(f.studentIds[0])).toEqual([]);

      const enrolled = await request(app.getHttpServer())
        .post('/api/enrollments')
        .set('Authorization', `Bearer ${f.adminToken}`)
        .send({
          studentId: f.studentIds[0],
          sectionId: f.section.id,
          academicYearId: f.academicYear.id,
        });
      expect(enrolled.status).toBe(201);
      expect(await chosen(f.studentIds[0])).toEqual(
        Object.values(f.electives).sort(),
      );
    });

    it('does not re-tick an unticked subject when the placement is re-saved', async () => {
      const f = await seedSelectionSection();
      const enrollment = await prisma.enrollment.findFirstOrThrow({
        where: { studentId: f.studentIds[0], sectionId: f.section.id },
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/enrollments/${enrollment.id}`)
        .set('Authorization', `Bearer ${f.adminToken}`)
        .send({ startDate: '2026-02-01' });
      expect(res.status).toBe(200);
      expect(await chosen(f.studentIds[0])).toEqual([]);
    });

    it('keeps a reactivated student’s choices instead of ticking everything again', async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });
      const enrollment = await prisma.enrollment.findFirstOrThrow({
        where: { studentId: f.studentIds[0], sectionId: f.section.id },
      });
      const setStatus = (status: string) =>
        request(app.getHttpServer())
          .patch(`/api/enrollments/${enrollment.id}`)
          .set('Authorization', `Bearer ${f.adminToken}`)
          .send({ status })
          .expect(200);

      await setStatus('INACTIVE');
      await setStatus('ACTIVE');
      expect(await chosen(f.studentIds[0])).toEqual([f.electives.Physics]);
    });

    it('clears a subject’s choices when it is made compulsory again', async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/section-subjects/${f.electives.Physics}`)
        .set('Authorization', `Bearer ${f.adminToken}`)
        .send({ isElective: false });
      expect(res.status).toBe(200);
      expect(
        await prisma.studentSubject.count({
          where: { sectionSubjectId: f.electives.Physics },
        }),
      ).toBe(0);
    });

    it('ticks a subject for the whole roster when it is switched to student selection', async () => {
      const f = await seedSelectionSection();
      const res = await request(app.getHttpServer())
        .patch(`/api/section-subjects/${f.maths}`)
        .set('Authorization', `Bearer ${f.adminToken}`)
        .send({ isElective: true });
      expect(res.status).toBe(200);

      const takers = await prisma.studentSubject.findMany({
        where: { sectionSubjectId: f.maths },
        select: { studentId: true },
      });
      expect(takers.map((t) => t.studentId).sort()).toEqual(
        [...f.studentIds].sort(),
      );
    });
  });

  describe('examinations', () => {
    it('finalizes an examination whose only paper some students do not take', async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });
      const { examination, subjects } = await seedExamination({
        schoolId: f.school.id,
        academicYearId: f.academicYear.id,
        sectionId: f.section.id,
        sectionSubjectIds: [f.electives.Physics],
        heldAt: new Date('2026-01-15'),
      });
      await request(app.getHttpServer())
        .put(`/api/exams/${examination.id}/subjects/${subjects[0].id}/marks`)
        .set('Authorization', `Bearer ${f.adminToken}`)
        .send({ entries: [{ studentId: f.studentIds[0], score: 70 }] })
        .expect(200);

      // The two students without Physics sit nothing here; they used to read
      // as "missing marks" and block finalize forever.
      await request(app.getHttpServer())
        .post(`/api/exams/${examination.id}/results/finalize`)
        .set('Authorization', `Bearer ${f.adminToken}`)
        .expect(201);
      const results = await prisma.examinationResult.findMany({
        where: { examinationId: examination.id },
        select: { studentId: true },
      });
      expect(results).toEqual([{ studentId: f.studentIds[0] }]);
    });
  });

  describe('assignments', () => {
    it('expects work only from takers still sitting in the section', async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0], f.studentIds[1]],
        add: [f.electives.Physics],
      });
      // Deactivating keeps the choices, so they must not count as expected work.
      await prisma.enrollment.updateMany({
        where: { studentId: f.studentIds[1], sectionId: f.section.id },
        data: { status: 'INACTIVE' },
      });
      await prisma.assignment.create({
        data: {
          schoolId: f.school.id,
          academicYearId: f.academicYear.id,
          sectionSubjectId: f.electives.Physics,
          createdByTeacherId: f.teacherProfile.id,
          title: 'Lab report',
          maxScore: 100,
          status: 'PUBLISHED',
        },
      });

      const res = await request(app.getHttpServer())
        .get('/api/assignments/school/stats')
        .set('Authorization', `Bearer ${f.adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.expected).toBe(1);
    });
  });

  describe('regular classes are unchanged', () => {
    it('keeps the whole section on a compulsory subject attendance roster', async () => {
      const f = await seedSelectionSection();
      // Only one student chose Physics; Maths is compulsory and must ignore that.
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });

      const res = await request(app.getHttpServer())
        .get(`/api/attendance/section-subject/${f.maths}`)
        .query({ date: '2026-06-01' })
        .set('Authorization', `Bearer ${f.adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.roster).toHaveLength(3);
    });

    it('narrows the roster of an elective to the students who chose it', async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });

      const res = await request(app.getHttpServer())
        .get(`/api/attendance/section-subject/${f.electives.Physics}`)
        .query({ date: '2026-06-01' })
        .set('Authorization', `Bearer ${f.adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.roster).toHaveLength(1);
      expect(res.body.roster[0].student.id).toBe(f.studentIds[0]);
    });

    it('refuses to mark a student for an elective they did not choose', async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });

      const res = await request(app.getHttpServer())
        .post('/api/attendance/mark')
        .set('Authorization', `Bearer ${f.adminToken}`)
        .send({
          sectionSubjectId: f.electives.Physics,
          date: '2026-06-01',
          entries: [{ studentId: f.studentIds[1], status: 'PRESENT' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not one of the chosen subjects/i);
    });
  });
});
