import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * Duplicate names in the class module must come back as a 409 the form can
 * show, not a 500.
 *
 * Every case here used to reach Nest's default handler as a raw P2002, so the
 * admin saw "Internal server error" while creating a section whose only problem
 * was a name already in use. These tests pin both halves: the status, and a
 * message that names the thing that clashed.
 */
describe('Class module duplicate names (e2e)', () => {
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

  const server = () => request(app.getHttpServer());

  const adminFor = async (schoolId: string) =>
    tokenFor(app, await createTestUser({ role: Role.SCHOOL_ADMIN, schoolId }));

  describe('sections — @@unique([classGradeId, name])', () => {
    it('rejects a second section with the same name in one class', async () => {
      const cls = await seedClass({ studentCount: 0 });
      const token = await adminFor(cls.school.id);

      const res = await server()
        .post('/api/sections')
        .set('Authorization', `Bearer ${token}`)
        .send({ classGradeId: cls.classGrade.id, name: cls.section.name });

      expect(res.status).toBe(409);
      // Must name BOTH, or the admin can't tell what to change.
      expect(res.body.message).toContain(cls.classGrade.name);
      expect(res.body.message).toContain(cls.section.name);

      const rows = await prisma.section.findMany({
        where: { classGradeId: cls.classGrade.id },
      });
      expect(rows).toHaveLength(1);
    });

    it('allows the same section name under a DIFFERENT class', async () => {
      const cls = await seedClass({ studentCount: 0 });
      const token = await adminFor(cls.school.id);
      const otherGrade = await prisma.classGrade.create({
        data: { schoolId: cls.school.id, name: `Grade-other-${Date.now()}` },
      });

      const res = await server()
        .post('/api/sections')
        .set('Authorization', `Bearer ${token}`)
        .send({ classGradeId: otherGrade.id, name: cls.section.name });

      // "A" in Grade 6 and "A" in Grade 7 are different rooms of children.
      expect(res.status).toBe(201);
    });

    it('rejects RENAMING a section onto a name already used in its class', async () => {
      const cls = await seedClass({ studentCount: 0 });
      const token = await adminFor(cls.school.id);
      const second = await prisma.section.create({
        data: {
          schoolId: cls.school.id,
          classGradeId: cls.classGrade.id,
          name: `Sec-second-${Date.now()}`,
        },
      });

      const res = await server()
        .patch(`/api/sections/${second.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: cls.section.name });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain(cls.section.name);

      const unchanged = await prisma.section.findUniqueOrThrow({
        where: { id: second.id },
      });
      expect(unchanged.name).toBe(second.name);
    });
  });

  describe('classes — @@unique([schoolId, name])', () => {
    it('rejects a second class with the same name in one school', async () => {
      const cls = await seedClass({ studentCount: 0 });
      const token = await adminFor(cls.school.id);

      const res = await server()
        .post('/api/class-grades')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: cls.classGrade.name });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain(cls.classGrade.name);
    });

    it('allows the same class name in ANOTHER school', async () => {
      const cls = await seedClass({ studentCount: 0 });
      const otherSchool = await createTestSchool();
      const token = await adminFor(otherSchool.id);

      const res = await server()
        .post('/api/class-grades')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: cls.classGrade.name });

      // The constraint is per school; every school has a "Grade 1".
      expect(res.status).toBe(201);
    });
  });

  describe('section subjects — @@unique([sectionId, subjectId])', () => {
    it('rejects allocating the same subject to a section twice', async () => {
      const cls = await seedClass({ studentCount: 0 });
      const token = await adminFor(cls.school.id);

      const res = await server()
        .post('/api/section-subjects')
        .set('Authorization', `Bearer ${token}`)
        .send({ sectionId: cls.section.id, subjectId: cls.subject.id });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain(cls.subject.name);

      const rows = await prisma.sectionSubject.findMany({
        where: { sectionId: cls.section.id },
      });
      expect(rows).toHaveLength(1);
    });

    it('leaves the teacher roster untouched when the allocation is refused', async () => {
      const cls = await seedClass({ studentCount: 0 });
      const token = await adminFor(cls.school.id);
      const otherUser = await createTestUser({
        role: Role.TEACHER,
        schoolId: cls.school.id,
      });
      const other = await prisma.teacherProfile.create({
        data: {
          userId: otherUser.id,
          schoolId: cls.school.id,
          fullName: 'Would-be',
        },
      });

      const res = await server()
        .post('/api/section-subjects')
        .set('Authorization', `Bearer ${token}`)
        .send({
          sectionId: cls.section.id,
          subjectId: cls.subject.id,
          teacherId: other.id,
        });

      expect(res.status).toBe(409);
      // The roster write shares the create's transaction, so a refused
      // allocation must not leave its teacher on the section.
      const roster = await prisma.sectionTeacher.findMany({
        where: { sectionId: cls.section.id, teacherId: other.id },
      });
      expect(roster).toHaveLength(0);
    });
  });

  /**
   * Section, ClassGrade and Subject are all referenced WITHOUT a cascade, so
   * Prisma's default Restrict refuses the delete. Untranslated that is another
   * 500 — and a worse one, because the admin is told nothing about the roster
   * still sitting in the section.
   */
  describe('deletes blocked by rows that do not cascade', () => {
    it('refuses to delete a section in use and names what is holding it', async () => {
      const cls = await seedClass({ studentCount: 3 });
      const token = await adminFor(cls.school.id);

      const res = await server()
        .delete(`/api/sections/${cls.section.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('3 enrolled students');
      expect(res.body.message).toContain('1 subject');

      // Nothing may be half-deleted.
      await expect(
        prisma.section.findUniqueOrThrow({ where: { id: cls.section.id } }),
      ).resolves.toBeDefined();
    });

    it('deletes an empty section normally', async () => {
      const cls = await seedClass({ studentCount: 0 });
      const token = await adminFor(cls.school.id);
      const empty = await prisma.section.create({
        data: {
          schoolId: cls.school.id,
          classGradeId: cls.classGrade.id,
          name: `Empty-${Date.now()}`,
        },
      });

      const res = await server()
        .delete(`/api/sections/${empty.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(
        await prisma.section.findUnique({ where: { id: empty.id } }),
      ).toBeNull();
    });

    it('refuses to delete a class that still has sections', async () => {
      const cls = await seedClass({ studentCount: 0 });
      const token = await adminFor(cls.school.id);

      const res = await server()
        .delete(`/api/class-grades/${cls.classGrade.id}`)
        .set('Authorization', `Bearer ${token}`);

      // The old comment here claimed sections cascade. They do not.
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('1 section');
    });

    it('refuses to delete a subject still allocated to a class', async () => {
      const cls = await seedClass({ studentCount: 0 });
      const token = await adminFor(cls.school.id);

      const res = await server()
        .delete(`/api/subjects/${cls.subject.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('1 class allocation');
    });
  });
});
