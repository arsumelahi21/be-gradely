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

    it("gives each subject its code and teacher's name, and no teacher contact details", async () => {
      const f = await seedSelectionSection();
      await patch(f.adminToken, {
        academicYearId: f.academicYear.id,
        studentIds: [f.studentIds[0]],
        add: [f.electives.Physics],
      });
      const physics = await prisma.sectionSubject.findUniqueOrThrow({
        where: { id: f.electives.Physics },
      });
      await prisma.subject.update({
        where: { id: physics.subjectId },
        data: { code: 'PHY-101' },
      });
      await prisma.teacherProfile.update({
        where: { id: f.teacherProfile.id },
        data: { phone: '0300-0000000', email: 'private@teacher.test' },
      });

      const res = await combination(
        await tokenFor(app, f.students[0].user),
        f.studentIds[0],
      );
      const byId = new Map<string, any>(
        res.body.subjects.map((s: any) => [s.sectionSubjectId, s]),
      );
      expect(byId.get(f.maths).teacher).toEqual({
        id: f.teacherProfile.id,
        fullName: f.teacherProfile.fullName,
      });
      expect(byId.get(f.electives.Physics)).toMatchObject({
        subject: { code: 'PHY-101' },
        teacher: null,
      });
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
    it('makes a newly added subject selectable, ticked for everyone already enrolled', async () => {
      const f = await seedSelectionSection();
      const subject = await prisma.subject.create({
        data: { schoolId: f.school.id, name: `History-${uniq()}` },
      });

      const res = await request(app.getHttpServer())
        .post('/api/section-subjects')
        .set('Authorization', `Bearer ${f.adminToken}`)
        .send({ sectionId: f.section.id, subjectId: subject.id });
      expect(res.status).toBe(201);
      expect(res.body.isElective).toBe(true);

      const takers = await prisma.studentSubject.findMany({
        where: { sectionSubjectId: res.body.id },
        select: { studentId: true },
      });
      expect(takers.map((t) => t.studentId).sort()).toEqual(
        [...f.studentIds].sort(),
      );
    });

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

  const newStudent = async (schoolId: string) => {
    const user = await createTestUser({ role: Role.STUDENT, schoolId });
    const profile = await prisma.studentProfile.create({
      data: { userId: user.id, schoolId, fullName: `New ${uniq()}` },
    });
    return Object.assign(profile, { token: await tokenFor(app, user) });
  };
  const enrol = (token: string, body: object) =>
    request(app.getHttpServer())
      .post('/api/enrollments')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  describe('enrolling with chosen subjects', () => {
    const written = async (studentId: string) => ({
      enrollments: await prisma.enrollment.count({ where: { studentId } }),
      subjects: await prisma.studentSubject.count({ where: { studentId } }),
    });

    it('records only the ticked subjects, alongside the enrollment', async () => {
      const f = await seedSelectionSection();
      const student = await newStudent(f.school.id);

      const res = await enrol(f.adminToken, {
        studentId: student.id,
        sectionId: f.section.id,
        academicYearId: f.academicYear.id,
        sectionSubjectIds: [f.maths, f.electives.Physics],
      });
      expect(res.status).toBe(201);
      // Maths is compulsory, so the whole class takes it without a row.
      const rows = await prisma.studentSubject.findMany({
        where: { studentId: student.id },
        select: { sectionSubjectId: true, academicYearId: true },
      });
      expect(rows).toEqual([
        {
          sectionSubjectId: f.electives.Physics,
          academicYearId: f.academicYear.id,
        },
      ]);
    });

    it('refuses a subject from another class and enrols nobody', async () => {
      const f = await seedSelectionSection();
      const student = await newStudent(f.school.id);
      const otherClass = await prisma.classGrade.create({
        data: { schoolId: f.school.id, name: `Class 9-${uniq()}` },
      });
      const otherSection = await prisma.section.create({
        data: {
          schoolId: f.school.id,
          classGradeId: otherClass.id,
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

      const res = await enrol(f.adminToken, {
        studentId: student.id,
        sectionId: f.section.id,
        academicYearId: f.academicYear.id,
        sectionSubjectIds: [f.electives.Physics, foreign.id],
      });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/not taught in this class/i);
      expect(await written(student.id)).toEqual({
        enrollments: 0,
        subjects: 0,
      });
    });

    it("refuses another school's subject and enrols nobody", async () => {
      const f = await seedSelectionSection();
      const other = await seedSelectionSection();
      const student = await newStudent(f.school.id);

      const res = await enrol(f.adminToken, {
        studentId: student.id,
        sectionId: f.section.id,
        academicYearId: f.academicYear.id,
        sectionSubjectIds: [other.electives.Physics],
      });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/not taught in this class/i);
      expect(await written(student.id)).toEqual({
        enrollments: 0,
        subjects: 0,
      });
    });

    it('refuses an empty or repeated subject list', async () => {
      const f = await seedSelectionSection();
      const student = await newStudent(f.school.id);
      const body = {
        studentId: student.id,
        sectionId: f.section.id,
        academicYearId: f.academicYear.id,
      };

      const empty = await enrol(f.adminToken, {
        ...body,
        sectionSubjectIds: [],
      });
      expect(empty.status).toBe(400);
      expect(String(empty.body.message)).toMatch(/at least one subject/i);
      const repeated = await enrol(f.adminToken, {
        ...body,
        sectionSubjectIds: [f.electives.Physics, f.electives.Physics],
      });
      expect(repeated.status).toBe(400);
      expect(String(repeated.body.message)).toMatch(/only be chosen once/i);
      expect(await written(student.id)).toEqual({
        enrollments: 0,
        subjects: 0,
      });
    });

    it('refuses subjects on an enrollment that is not active', async () => {
      const f = await seedSelectionSection();
      const student = await newStudent(f.school.id);

      const res = await enrol(f.adminToken, {
        studentId: student.id,
        sectionId: f.section.id,
        academicYearId: f.academicYear.id,
        status: 'INACTIVE',
        sectionSubjectIds: [f.electives.Physics],
      });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/active enrollment/i);
      expect(await written(student.id)).toEqual({
        enrollments: 0,
        subjects: 0,
      });
    });

    it('refuses a second enrollment and leaves the first one’s subjects alone', async () => {
      const f = await seedSelectionSection();
      const student = await newStudent(f.school.id);
      const body = {
        studentId: student.id,
        sectionId: f.section.id,
        academicYearId: f.academicYear.id,
        sectionSubjectIds: [f.electives.Physics],
      };

      expect((await enrol(f.adminToken, body)).status).toBe(201);
      const again = await enrol(f.adminToken, {
        ...body,
        sectionSubjectIds: [f.electives.Economics],
      });
      expect(again.status).toBe(409);
      expect(again.body.message).toMatch(/already enrolled/i);
      expect(await written(student.id)).toEqual({
        enrollments: 1,
        subjects: 1,
      });
    });

    it("refuses another school's admin and writes nothing", async () => {
      const f = await seedSelectionSection();
      const other = await seedSelectionSection();
      const student = await newStudent(f.school.id);

      const res = await enrol(other.adminToken, {
        studentId: student.id,
        sectionId: f.section.id,
        academicYearId: f.academicYear.id,
        sectionSubjectIds: [f.electives.Physics],
      });
      expect(res.status).toBe(403);
      expect(await written(student.id)).toEqual({
        enrollments: 0,
        subjects: 0,
      });
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

  /**
   * One placement, subjects from several sections of the same class: Ali sits in
   * section A but takes Chemistry and History from section B.
   */
  describe('subjects from sibling sections', () => {
    async function seedSiblings() {
      const f = await seedSelectionSection();
      const teacherBUser = await createTestUser({
        role: Role.TEACHER,
        schoolId: f.school.id,
      });
      const teacherB = await prisma.teacherProfile.create({
        data: {
          userId: teacherBUser.id,
          schoolId: f.school.id,
          fullName: 'Teacher B',
        },
      });
      const sectionB = await prisma.section.create({
        data: {
          schoolId: f.school.id,
          classGradeId: f.classGrade.id,
          name: `B-${uniq()}`,
        },
      });
      const offer = async (
        name: string,
        isElective: boolean,
        subjectId?: string,
      ) => {
        const subject = subjectId
          ? { id: subjectId }
          : await prisma.subject.create({
              data: { schoolId: f.school.id, name: `${name}-${uniq()}` },
            });
        const ss = await prisma.sectionSubject.create({
          data: {
            sectionId: sectionB.id,
            subjectId: subject.id,
            isElective,
            teacherId: teacherB.id,
          },
        });
        return { id: ss.id, subjectId: subject.id };
      };
      const mathsSubjectId = (
        await prisma.sectionSubject.findUniqueOrThrow({
          where: { id: f.maths },
        })
      ).subjectId;
      const chemistry = await offer('Chemistry', true);
      return {
        ...f,
        sectionB,
        teacherB,
        teacherBToken: await tokenFor(app, teacherBUser),
        chemistryB: chemistry.id,
        chemistrySubjectId: chemistry.subjectId,
        historyB: (await offer('History', false)).id,
        artB: (await offer('Art', true)).id,
        // Section A's compulsory Maths, offered again in B.
        mathsB: (await offer('Maths', true, mathsSubjectId)).id,
      };
    }
    type Siblings = Awaited<ReturnType<typeof seedSiblings>>;

    /** Placed in A; Physics from A, Chemistry and (B-compulsory) History from B. */
    async function enrolAcross(f: Siblings) {
      const student = await newStudent(f.school.id);
      const res = await enrol(f.adminToken, {
        studentId: student.id,
        sectionId: f.section.id,
        academicYearId: f.academicYear.id,
        sectionSubjectIds: [
          f.maths,
          f.electives.Physics,
          f.chemistryB,
          f.historyB,
        ],
      });
      expect(res.status).toBe(201);
      return student;
    }
    const picksOf = (studentId: string, academicYearId?: string) =>
      prisma.studentSubject
        .findMany({
          where: { studentId, ...(academicYearId && { academicYearId }) },
          select: { sectionSubjectId: true },
        })
        .then((rows) => rows.map((r) => r.sectionSubjectId).sort());
    const get = (token: string, url: string, query: object = {}) =>
      request(app.getHttpServer())
        .get(url)
        .query(query)
        .set('Authorization', `Bearer ${token}`);

    it('places the student once and records the picks from both sections', async () => {
      const f = await seedSiblings();
      const student = await enrolAcross(f);

      const placements = await prisma.enrollment.findMany({
        where: { studentId: student.id },
        select: { sectionId: true, status: true },
      });
      expect(placements).toEqual([
        { sectionId: f.section.id, status: 'ACTIVE' },
      ]);
      // A's Maths is compulsory for everyone placed in A, so it needs no row.
      expect(await picksOf(student.id)).toEqual(
        [f.electives.Physics, f.chemistryB, f.historyB].sort(),
      );
    });

    it('refuses the same subject from two sections', async () => {
      const f = await seedSiblings();
      const student = await newStudent(f.school.id);

      const res = await enrol(f.adminToken, {
        studentId: student.id,
        sectionId: f.section.id,
        academicYearId: f.academicYear.id,
        // A's compulsory Maths is already theirs, so B's Maths is a second copy.
        sectionSubjectIds: [f.mathsB],
      });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(
        /can only be taken from one section/i,
      );
      expect(
        await prisma.enrollment.count({ where: { studentId: student.id } }),
      ).toBe(0);
    });

    it('lists a sibling pick under the section it comes from', async () => {
      const f = await seedSiblings();
      const student = await enrolAcross(f);

      const res = await get(
        f.adminToken,
        `/api/student-subjects/student/${student.id}`,
      );
      expect(res.status).toBe(200);
      const sectionOf = Object.fromEntries(
        res.body.subjects.map(
          (s: { sectionSubjectId: string; section: { id: string } }) => [
            s.sectionSubjectId,
            s.section.id,
          ],
        ),
      );
      expect(sectionOf).toEqual({
        [f.maths]: f.section.id,
        [f.electives.Physics]: f.section.id,
        [f.chemistryB]: f.sectionB.id,
        [f.historyB]: f.sectionB.id,
      });
    });

    it('puts the student on the attendance of their sibling subjects only', async () => {
      const f = await seedSiblings();
      const student = await enrolAcross(f);
      const onRoster = async (sectionSubjectId: string) =>
        (
          await get(
            f.adminToken,
            `/api/attendance/section-subject/${sectionSubjectId}`,
            { date: '2026-06-01' },
          )
        ).body.roster.some(
          (r: { student: { id: string } }) => r.student.id === student.id,
        );

      expect(await onRoster(f.chemistryB)).toBe(true);
      expect(await onRoster(f.historyB)).toBe(true);
      expect(await onRoster(f.artB)).toBe(false);
      expect(await onRoster(f.electives.Economics)).toBe(false);

      const mark = (sectionSubjectId: string) =>
        request(app.getHttpServer())
          .post('/api/attendance/mark')
          .set('Authorization', `Bearer ${f.adminToken}`)
          .send({
            sectionSubjectId,
            date: '2026-06-01',
            entries: [{ studentId: student.id, status: 'PRESENT' }],
          });
      expect((await mark(f.chemistryB)).status).toBe(201);
      expect((await mark(f.artB)).status).toBe(400);
    });

    it("lets the sibling section's teacher see the student", async () => {
      const f = await seedSiblings();
      const student = await enrolAcross(f);

      const res = await get(
        f.teacherBToken,
        `/api/attendance/student/${student.id}`,
      );
      expect(res.status).toBe(200);
    });

    it("sits only the picked paper of the sibling section's examination", async () => {
      const f = await seedSiblings();
      const student = await enrolAcross(f);
      const { examination, subjects } = await seedExamination({
        schoolId: f.school.id,
        academicYearId: f.academicYear.id,
        sectionId: f.sectionB.id,
        sectionSubjectIds: [f.chemistryB, f.artB],
        heldAt: new Date('2026-01-15'),
      });
      const paper = (sectionSubjectId: string) =>
        subjects.find((s) => s.sectionSubjectId === sectionSubjectId)!;
      const putMark = (sectionSubjectId: string) =>
        request(app.getHttpServer())
          .put(
            `/api/exams/${examination.id}/subjects/${paper(sectionSubjectId).id}/marks`,
          )
          .set('Authorization', `Bearer ${f.adminToken}`)
          .send({ entries: [{ studentId: student.id, score: 70 }] });

      expect((await putMark(f.chemistryB)).status).toBe(200);
      expect((await putMark(f.artB)).status).toBe(400);

      // The student can open B's examination although they are placed in A.
      expect(
        (await get(student.token, `/api/exams/${examination.id}`)).status,
      ).toBe(200);

      await request(app.getHttpServer())
        .post(`/api/exams/${examination.id}/results/finalize`)
        .set('Authorization', `Bearer ${f.adminToken}`)
        .expect(201);
      const result = await prisma.examinationResult.findFirstOrThrow({
        where: { examinationId: examination.id, studentId: student.id },
        select: { totalMax: true, percentage: true },
      });
      // Art was never theirs: it neither counts as missing nor inflates the total.
      expect(result).toEqual({ totalMax: 100, percentage: 70 });
    });

    it("offers the sibling section's quiz for the picked subject only", async () => {
      const f = await seedSiblings();
      const student = await enrolAcross(f);
      const artSubjectId = (
        await prisma.sectionSubject.findUniqueOrThrow({ where: { id: f.artB } })
      ).subjectId;
      const quiz = (title: string, subjectId: string) =>
        prisma.quiz.create({
          data: {
            schoolId: f.school.id,
            sectionId: f.sectionB.id,
            subjectId,
            title,
            isPublished: true,
            createdByUserId: f.admin.id,
            questions: {
              create: {
                type: 'TRUE_FALSE',
                text: 'True?',
                correctAnswer: true,
                points: 1,
                order: 0,
              },
            },
          },
        });
      const chemistryQuiz = await quiz('Chemistry quiz', f.chemistrySubjectId);
      const artQuiz = await quiz('Art quiz', artSubjectId);

      const res = await get(student.token, '/api/quizzes/available');
      expect(res.status).toBe(200);
      expect(res.body.map((q: { id: string }) => q.id)).toEqual([
        chemistryQuiz.id,
      ]);

      const start = (quizId: string) =>
        request(app.getHttpServer())
          .post(`/api/quizzes/${quizId}/attempts`)
          .set('Authorization', `Bearer ${student.token}`);
      expect((await start(chemistryQuiz.id)).status).toBe(201);
      expect((await start(artQuiz.id)).status).toBe(403);
    });

    it("lists the sibling section's assignment for the picked subject", async () => {
      const f = await seedSiblings();
      const student = await enrolAcross(f);
      const assignment = await prisma.assignment.create({
        data: {
          schoolId: f.school.id,
          academicYearId: f.academicYear.id,
          sectionSubjectId: f.chemistryB,
          createdByTeacherId: f.teacherB.id,
          title: 'Titration report',
          maxScore: 100,
          status: 'PUBLISHED',
        },
      });

      const list = await get(student.token, '/api/assignments');
      expect(list.status).toBe(200);
      const items = list.body.items ?? list.body;
      expect(items.map((a: { id: string }) => a.id)).toContain(assignment.id);
      expect(
        (await get(student.token, `/api/assignments/${assignment.id}`)).status,
      ).toBe(200);
    });

    it('clears the picks from every section when the student moves class', async () => {
      const f = await seedSiblings();
      const student = await enrolAcross(f);
      const otherClass = await prisma.classGrade.create({
        data: { schoolId: f.school.id, name: `Class 9-${uniq()}` },
      });
      const otherSection = await prisma.section.create({
        data: {
          schoolId: f.school.id,
          classGradeId: otherClass.id,
          name: `A-${uniq()}`,
        },
      });
      const enrollment = await prisma.enrollment.findFirstOrThrow({
        where: { studentId: student.id },
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/enrollments/${enrollment.id}`)
        .set('Authorization', `Bearer ${f.adminToken}`)
        .send({ sectionId: otherSection.id });
      expect(res.status).toBe(200);
      expect(await picksOf(student.id)).toEqual([]);
    });

    it("keeps last session's picks when the student is enrolled for the next", async () => {
      const f = await seedSiblings();
      const student = await enrolAcross(f);
      const nextYear = await prisma.academicYear.create({
        data: {
          schoolId: f.school.id,
          name: `AY-${uniq()}`,
          code: `AY${uniq()}`,
          startDate: new Date('2027-01-01'),
          endDate: new Date('2027-12-31'),
        },
      });

      const res = await enrol(f.adminToken, {
        studentId: student.id,
        sectionId: f.section.id,
        academicYearId: nextYear.id,
        sectionSubjectIds: [f.electives.Economics, f.artB],
      });
      expect(res.status).toBe(201);
      expect(await picksOf(student.id, f.academicYear.id)).toEqual(
        [f.electives.Physics, f.chemistryB, f.historyB].sort(),
      );
      expect(await picksOf(student.id, nextYear.id)).toEqual(
        [f.electives.Economics, f.artB].sort(),
      );
    });

    describe('after the placement closes', () => {
      const withdraw = async (f: Siblings, studentId: string) => {
        const enrollment = await prisma.enrollment.findFirstOrThrow({
          where: { studentId, status: 'ACTIVE' },
        });
        await request(app.getHttpServer())
          .patch(`/api/enrollments/${enrollment.id}`)
          .set('Authorization', `Bearer ${f.adminToken}`)
          .send({ status: 'INACTIVE' })
          .expect(200);
      };
      const onRoster = async (
        f: Siblings,
        studentId: string,
        sectionSubjectId: string,
      ) =>
        (
          await get(
            f.adminToken,
            `/api/attendance/section-subject/${sectionSubjectId}`,
            { date: '2026-06-01' },
          )
        ).body.roster.some(
          (r: { student: { id: string } }) => r.student.id === studentId,
        );

      it("drops a withdrawn student's sibling picks from rosters and papers", async () => {
        const f = await seedSiblings();
        const student = await enrolAcross(f);
        const { examination } = await seedExamination({
          schoolId: f.school.id,
          academicYearId: f.academicYear.id,
          sectionId: f.sectionB.id,
          sectionSubjectIds: [f.chemistryB],
          heldAt: new Date('2026-01-15'),
        });

        await withdraw(f, student.id);

        expect(await onRoster(f, student.id, f.chemistryB)).toBe(false);
        expect(
          (await get(student.token, `/api/exams/${examination.id}`)).status,
        ).toBe(403);
      });

      it('keeps them closed when the student joins another class that session', async () => {
        const f = await seedSiblings();
        const student = await enrolAcross(f);
        await withdraw(f, student.id);
        const otherClass = await prisma.classGrade.create({
          data: { schoolId: f.school.id, name: `Class 9-${uniq()}` },
        });
        const otherSection = await prisma.section.create({
          data: {
            schoolId: f.school.id,
            classGradeId: otherClass.id,
            name: `A-${uniq()}`,
          },
        });

        const res = await enrol(f.adminToken, {
          studentId: student.id,
          sectionId: otherSection.id,
          academicYearId: f.academicYear.id,
        });
        expect(res.status).toBe(201);
        expect(await onRoster(f, student.id, f.chemistryB)).toBe(false);
      });

      it("replaces the closed placement's picks when re-enrolled in the class", async () => {
        const f = await seedSiblings();
        const student = await enrolAcross(f);
        await withdraw(f, student.id);

        const res = await enrol(f.adminToken, {
          studentId: student.id,
          sectionId: f.sectionB.id,
          academicYearId: f.academicYear.id,
          sectionSubjectIds: [f.artB],
        });
        expect(res.status).toBe(201);
        expect(await picksOf(student.id, f.academicYear.id)).toEqual([f.artB]);
      });

      it('keeps the current picks when a closed placement in the class is deleted', async () => {
        const f = await seedSiblings();
        const student = await enrolAcross(f);
        await withdraw(f, student.id);
        await enrol(f.adminToken, {
          studentId: student.id,
          sectionId: f.sectionB.id,
          academicYearId: f.academicYear.id,
          sectionSubjectIds: [f.artB],
        }).expect(201);
        const closed = await prisma.enrollment.findFirstOrThrow({
          where: { studentId: student.id, sectionId: f.section.id },
        });

        await request(app.getHttpServer())
          .delete(`/api/enrollments/${closed.id}`)
          .set('Authorization', `Bearer ${f.adminToken}`)
          .expect(200);

        expect(await picksOf(student.id, f.academicYear.id)).toEqual([f.artB]);
      });
    });

    it('notifies sibling pickers of a quiz in a section nobody is placed in', async () => {
      const f = await seedSiblings();
      const student = await enrolAcross(f);
      const quiz = await prisma.quiz.create({
        data: {
          schoolId: f.school.id,
          sectionId: f.sectionB.id,
          subjectId: f.chemistrySubjectId,
          title: 'Chemistry quiz',
          createdByUserId: f.admin.id,
          questions: {
            create: {
              type: 'TRUE_FALSE',
              text: 'True?',
              correctAnswer: true,
              points: 1,
              order: 0,
            },
          },
        },
      });

      await request(app.getHttpServer())
        .patch(`/api/quizzes/${quiz.id}/publish`)
        .set('Authorization', `Bearer ${f.adminToken}`)
        .expect(200);

      // The listener writes asynchronously.
      const notified = async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const n = await prisma.notification.count({
            where: { userId: student.userId!, type: 'QUIZ_PUBLISHED' },
          });
          if (n) return n;
          await new Promise((r) => setTimeout(r, 100));
        }
        return 0;
      };
      expect(await notified()).toBe(1);
    });

    describe('editing an enrolled student', () => {
      const edit = async (f: Siblings, studentId: string, body: object) => {
        const enrollment = await prisma.enrollment.findFirstOrThrow({
          where: { studentId },
        });
        return request(app.getHttpServer())
          .patch(`/api/enrollments/${enrollment.id}`)
          .set('Authorization', `Bearer ${f.adminToken}`)
          .send(body);
      };

      it('replaces the picks across sections', async () => {
        const f = await seedSiblings();
        const student = await enrolAcross(f);

        const res = await edit(f, student.id, {
          sectionSubjectIds: [f.maths, f.electives.Economics, f.chemistryB],
        });
        expect(res.status).toBe(200);
        expect(await picksOf(student.id)).toEqual(
          [f.electives.Economics, f.chemistryB].sort(),
        );
      });

      it('refuses to drop a subject with attendance this session, and changes nothing', async () => {
        const f = await seedSiblings();
        const student = await enrolAcross(f);
        await request(app.getHttpServer())
          .post('/api/attendance/mark')
          .set('Authorization', `Bearer ${f.adminToken}`)
          .send({
            sectionSubjectId: f.chemistryB,
            date: '2026-06-01',
            entries: [{ studentId: student.id, status: 'PRESENT' }],
          })
          .expect(201);

        const res = await edit(f, student.id, {
          sectionSubjectIds: [f.electives.Physics, f.historyB],
        });
        expect(res.status).toBe(409);
        expect(String(res.body.message)).toMatch(/already recorded/i);
        expect(await picksOf(student.id)).toEqual(
          [f.electives.Physics, f.chemistryB, f.historyB].sort(),
        );
      });

      it('moves the student and sets the new picks in one save', async () => {
        const f = await seedSiblings();
        const student = await enrolAcross(f);

        const res = await edit(f, student.id, {
          sectionId: f.sectionB.id,
          sectionSubjectIds: [f.historyB, f.chemistryB, f.electives.Physics],
        });
        expect(res.status).toBe(200);
        expect(res.body.sectionId).toBe(f.sectionB.id);
        // History is compulsory in B now that they sit there, so it needs no row.
        expect(await picksOf(student.id)).toEqual(
          [f.chemistryB, f.electives.Physics].sort(),
        );
      });

      it('refuses to drop a recorded subject on a move within the class, and changes nothing', async () => {
        const f = await seedSiblings();
        const student = await enrolAcross(f);
        await request(app.getHttpServer())
          .post('/api/attendance/mark')
          .set('Authorization', `Bearer ${f.adminToken}`)
          .send({
            sectionSubjectId: f.chemistryB,
            date: '2026-06-01',
            entries: [{ studentId: student.id, status: 'PRESENT' }],
          })
          .expect(201);

        const res = await edit(f, student.id, {
          sectionId: f.sectionB.id,
          sectionSubjectIds: [f.historyB, f.electives.Physics],
        });
        expect(res.status).toBe(409);
        expect(String(res.body.message)).toMatch(/already recorded/i);
        const placement = await prisma.enrollment.findFirstOrThrow({
          where: { studentId: student.id },
        });
        expect(placement.sectionId).toBe(f.section.id);
        expect(await picksOf(student.id)).toEqual(
          [f.electives.Physics, f.chemistryB, f.historyB].sort(),
        );
      });

      it("reads the student's subjects for one session", async () => {
        const f = await seedSiblings();
        const student = await enrolAcross(f);
        const otherYear = await prisma.academicYear.create({
          data: {
            schoolId: f.school.id,
            name: `AY-${uniq()}`,
            code: `AY${uniq()}`,
            startDate: new Date('2027-01-01'),
            endDate: new Date('2027-12-31'),
          },
        });
        const read = (academicYearId: string) =>
          get(f.adminToken, `/api/student-subjects/student/${student.id}`, {
            academicYearId,
          });

        const current = await read(f.academicYear.id);
        expect(current.body.section.id).toBe(f.section.id);
        expect(current.body.subjects).toHaveLength(4);
        const other = await read(otherYear.id);
        expect(other.body).toMatchObject({ section: null, subjects: [] });
      });
    });

    describe('the student timetable', () => {
      /** A published timetable for one section: two 40-minute periods from 08:00. */
      async function publish(
        f: Siblings,
        sectionId: string,
        cells: {
          sectionSubjectId: string;
          day: 'MONDAY' | 'TUESDAY';
          slot: 0 | 1;
          teacherId: string;
        }[],
      ) {
        const timetable = await prisma.timetable.create({
          data: {
            schoolId: f.school.id,
            academicYearId: f.academicYear.id,
            sectionId,
            status: 'PUBLISHED',
          },
        });
        const periods = await Promise.all(
          [
            [480, 520],
            [520, 560],
          ].map(([startMin, endMin], i) =>
            prisma.timetablePeriod.create({
              data: {
                timetableId: timetable.id,
                schoolId: f.school.id,
                index: i + 1,
                startMin,
                endMin,
              },
            }),
          ),
        );
        for (const c of cells) {
          const period = periods[c.slot];
          await prisma.timetableEntry.create({
            data: {
              timetableId: timetable.id,
              schoolId: f.school.id,
              sectionId,
              academicYearId: f.academicYear.id,
              dayOfWeek: c.day,
              periodId: period.id,
              startMin: period.startMin,
              endMin: period.endMin,
              sectionSubjectId: c.sectionSubjectId,
              teacherId: c.teacherId,
            },
          });
        }
      }

      /** Sections A, B and C of one class, each with a taught and an untaken subject. */
      async function seedTimetables() {
        const f = await seedSiblings();
        const sectionC = await prisma.section.create({
          data: {
            schoolId: f.school.id,
            classGradeId: f.classGrade.id,
            name: `C-${uniq()}`,
          },
        });
        const offerInC = async (name: string) => {
          const subject = await prisma.subject.create({
            data: { schoolId: f.school.id, name: `${name}-${uniq()}` },
          });
          return (
            await prisma.sectionSubject.create({
              data: {
                sectionId: sectionC.id,
                subjectId: subject.id,
                isElective: true,
                teacherId: f.teacherB.id,
              },
            })
          ).id;
        };
        const economicsC = await offerInC('Economics C');
        const biologyC = await offerInC('Biology C');
        const teacherA = f.teacherProfile.id;
        const teacherB = f.teacherB.id;
        await publish(f, f.section.id, [
          {
            sectionSubjectId: f.maths,
            day: 'MONDAY',
            slot: 0,
            teacherId: teacherA,
          },
          {
            sectionSubjectId: f.electives.Physics,
            day: 'MONDAY',
            slot: 1,
            teacherId: teacherA,
          },
        ]);
        await publish(f, f.sectionB.id, [
          // Same time as A's Maths: a clash the student must still see.
          {
            sectionSubjectId: f.chemistryB,
            day: 'MONDAY',
            slot: 0,
            teacherId: teacherB,
          },
          {
            sectionSubjectId: f.artB,
            day: 'TUESDAY',
            slot: 0,
            teacherId: teacherB,
          },
        ]);
        await publish(f, sectionC.id, [
          {
            sectionSubjectId: economicsC,
            day: 'TUESDAY',
            slot: 1,
            teacherId: teacherB,
          },
          {
            sectionSubjectId: biologyC,
            day: 'MONDAY',
            slot: 1,
            teacherId: teacherB,
          },
        ]);
        return { ...f, sectionC, economicsC };
      }
      type Timetables = Awaited<ReturnType<typeof seedTimetables>>;

      /** Placed in A; picks Chemistry from B and Economics from C. */
      async function studentAcross(f: Timetables) {
        const student = await newStudent(f.school.id);
        const res = await enrol(f.adminToken, {
          studentId: student.id,
          sectionId: f.section.id,
          academicYearId: f.academicYear.id,
          sectionSubjectIds: [f.maths, f.chemistryB, f.economicsC],
        });
        expect(res.status).toBe(201);
        return student;
      }
      type Entry = {
        sectionSubjectId: string;
        periodId: string;
        dayOfWeek: string;
        section: { id: string };
        teacher: { id: string };
      };
      const subjectsIn = (res: request.Response) =>
        (res.body.entries as Entry[]).map((e) => e.sectionSubjectId).sort();

      it('shows exactly the subjects the student takes, from every section', async () => {
        const f = await seedTimetables();
        const student = await studentAcross(f);

        const res = await get(student.token, '/api/timetable/me');
        expect(res.status).toBe(200);
        expect(subjectsIn(res)).toEqual(
          [f.maths, f.chemistryB, f.economicsC].sort(),
        );
        const entries = res.body.entries as Entry[];
        const chemistry = entries.find(
          (e) => e.sectionSubjectId === f.chemistryB,
        )!;
        expect(chemistry.section.id).toBe(f.sectionB.id);
        expect(chemistry.teacher.id).toBe(f.teacherB.id);
        expect(
          entries.find((e) => e.sectionSubjectId === f.economicsC)!.section.id,
        ).toBe(f.sectionC.id);
        // Maths and Chemistry clash on Monday morning: both stay, and each
        // sits in a period row the page can place it in.
        expect(entries.filter((e) => e.dayOfWeek === 'MONDAY')).toHaveLength(2);
        const rowIds = new Set(
          (res.body.periods as { id: string }[]).map((p) => p.id),
        );
        expect(entries.every((e) => rowIds.has(e.periodId))).toBe(true);
      });

      it("shows a classmate without picks only their section's compulsory subject", async () => {
        const f = await seedTimetables();
        await studentAcross(f);
        const classmate = f.students[0];

        const res = await get(
          await tokenFor(app, classmate.user),
          '/api/timetable/me',
        );
        expect(subjectsIn(res)).toEqual([f.maths]);
      });

      it("ignores another session's picks", async () => {
        const f = await seedTimetables();
        const student = await studentAcross(f);
        const lastYear = await prisma.academicYear.create({
          data: {
            schoolId: f.school.id,
            name: `AY-${uniq()}`,
            code: `AY${uniq()}`,
            startDate: new Date('2025-01-01'),
            endDate: new Date('2025-12-31'),
          },
        });
        await prisma.studentSubject.create({
          data: {
            schoolId: f.school.id,
            academicYearId: lastYear.id,
            studentId: student.id,
            sectionSubjectId: f.artB,
          },
        });

        const res = await get(student.token, '/api/timetable/me');
        expect(subjectsIn(res)).not.toContain(f.artB);
      });

      it("gives a parent their child's own timetable", async () => {
        const f = await seedTimetables();
        const student = await studentAcross(f);
        const parentUser = await createTestUser({
          role: Role.PARENT,
          schoolId: f.school.id,
        });
        const parent = await prisma.parentProfile.create({
          data: { userId: parentUser.id, fullName: 'Parent' },
        });
        await prisma.parentStudent.create({
          data: { parentId: parent.id, studentId: student.id },
        });

        const res = await get(
          await tokenFor(app, parentUser),
          '/api/timetable/me',
          { studentId: student.id },
        );
        expect(res.status).toBe(200);
        expect(subjectsIn(res)).toEqual(
          [f.maths, f.chemistryB, f.economicsC].sort(),
        );
      });
    });

    it('keeps a sibling pick when that subject is made compulsory', async () => {
      const f = await seedSiblings();
      const student = await enrolAcross(f);
      // A student placed in B who also chose Chemistry.
      const own = await newStudent(f.school.id);
      await prisma.enrollment.create({
        data: {
          studentId: own.id,
          sectionId: f.sectionB.id,
          academicYearId: f.academicYear.id,
          status: 'ACTIVE',
        },
      });
      await prisma.studentSubject.create({
        data: {
          schoolId: f.school.id,
          academicYearId: f.academicYear.id,
          studentId: own.id,
          sectionSubjectId: f.chemistryB,
        },
      });

      await request(app.getHttpServer())
        .patch(`/api/section-subjects/${f.chemistryB}`)
        .set('Authorization', `Bearer ${f.adminToken}`)
        .send({ isElective: false })
        .expect(200);
      const takers = await prisma.studentSubject.findMany({
        where: { sectionSubjectId: f.chemistryB },
        select: { studentId: true },
      });
      // B's own students take it as compulsory now; the pick from A must stay.
      expect(takers).toEqual([{ studentId: student.id }]);
    });
  });
});
