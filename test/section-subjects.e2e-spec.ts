import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

/**
 * Regression cover for two defects in the section management flow:
 *
 *  1. Removing a subject that had attendance failed with an unmapped Postgres
 *     23001 (RESTRICT) and surfaced as a bare 500.
 *  2. Subject and teacher writes never cleared the per-school `sections` /
 *     `classes` cache, so the section cards served a stale `_count` for the
 *     5-minute TTL even after a refetch.
 *
 * NOTE on (2): these assert the observable contract — the count is right after
 * every mutation. They cannot exercise the cache itself here, because `.env`
 * points REDIS_URL at a Redis nobody runs (CacheService fails open, caching
 * nothing) and ConfigModule.forRoot() reloads that .env during app construction,
 * so unsetting it in the spec does not stick. On an environment with a live
 * cache these are what catch a missing invalidation.
 */
describe('Section subjects & teachers (e2e)', () => {
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

  async function seedSection() {
    const school = await createTestSchool();
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: school.id,
    });
    const grade = await prisma.classGrade.create({
      data: { schoolId: school.id, name: `Grade-${uniq()}` },
    });
    const section = await prisma.section.create({
      data: { schoolId: school.id, classGradeId: grade.id, name: `A${uniq()}` },
    });
    const subject = await prisma.subject.create({
      data: { schoolId: school.id, name: `Subject-${uniq()}` },
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
    return {
      school,
      admin,
      token: await tokenFor(app, admin),
      grade,
      section,
      subject,
      teacher,
    };
  }

  /** The exact payload the section cards render from. */
  async function sectionCard(
    token: string,
    classGradeId: string,
    sectionId: string,
  ) {
    const res = await request(app.getHttpServer())
      .get('/api/sections')
      .query({ classGradeId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const list = Array.isArray(res.body) ? res.body : res.body.items;
    return list.find((s: any) => s.id === sectionId);
  }

  describe('removing a subject from a section', () => {
    it('removes it, and it stays removed', async () => {
      const f = await seedSection();
      const created = await request(app.getHttpServer())
        .post('/api/section-subjects')
        .set('Authorization', `Bearer ${f.token}`)
        .send({ sectionId: f.section.id, subjectId: f.subject.id })
        .expect(201);

      await request(app.getHttpServer())
        .delete(`/api/section-subjects/${created.body.id}`)
        .set('Authorization', `Bearer ${f.token}`)
        .expect(200);

      // Gone from the database, not just from a response.
      expect(
        await prisma.sectionSubject.count({ where: { id: created.body.id } }),
      ).toBe(0);

      // And gone from the list a reloaded page would fetch.
      const after = await request(app.getHttpServer())
        .get('/api/section-subjects')
        .query({ sectionId: f.section.id })
        .set('Authorization', `Bearer ${f.token}`)
        .expect(200);
      expect(after.body).toHaveLength(0);
    });

    it('deletes even when attendance exists, cascading the attendance with it', async () => {
      const f = await seedSection();
      const created = await request(app.getHttpServer())
        .post('/api/section-subjects')
        .set('Authorization', `Bearer ${f.token}`)
        .send({ sectionId: f.section.id, subjectId: f.subject.id })
        .expect(201);

      const studentUser = await createTestUser({
        role: Role.STUDENT,
        schoolId: f.school.id,
      });
      const student = await prisma.studentProfile.create({
        data: {
          userId: studentUser.id,
          schoolId: f.school.id,
          fullName: 'Student',
        },
      });
      await prisma.attendance.create({
        data: {
          schoolId: f.school.id,
          studentId: student.id,
          sectionSubjectId: created.body.id,
          date: new Date(Date.UTC(2026, 1, 3)),
          status: 'PRESENT',
          markedByUserId: f.admin.id,
        },
      });

      // A confirmed delete by an authorised admin succeeds regardless of what
      // hangs off the row. The old 409 guard was removed deliberately in the
      // delete redesign; `Attendance.sectionSubjectId` is onDelete: Cascade, so
      // the schema — not a service check — decides what goes with it.
      await request(app.getHttpServer())
        .delete(`/api/section-subjects/${created.body.id}`)
        .set('Authorization', `Bearer ${f.token}`)
        .expect(200);

      expect(
        await prisma.sectionSubject.count({ where: { id: created.body.id } }),
      ).toBe(0);
      // Its attendance went with it rather than being orphaned or blocking.
      expect(
        await prisma.attendance.count({
          where: { sectionSubjectId: created.body.id },
        }),
      ).toBe(0);
    });
  });

  describe('section card counts refresh immediately', () => {
    it('reflects a subject added and removed', async () => {
      const f = await seedSection();

      // Prime the cache — this read is what used to be served stale.
      const before = await sectionCard(f.token, f.grade.id, f.section.id);
      expect(before._count.subjects).toBe(0);

      const created = await request(app.getHttpServer())
        .post('/api/section-subjects')
        .set('Authorization', `Bearer ${f.token}`)
        .send({ sectionId: f.section.id, subjectId: f.subject.id })
        .expect(201);

      const afterAdd = await sectionCard(f.token, f.grade.id, f.section.id);
      expect(afterAdd._count.subjects).toBe(1);

      await request(app.getHttpServer())
        .delete(`/api/section-subjects/${created.body.id}`)
        .set('Authorization', `Bearer ${f.token}`)
        .expect(200);

      const afterRemove = await sectionCard(f.token, f.grade.id, f.section.id);
      expect(afterRemove._count.subjects).toBe(0);
    });

    it('reflects a subject-teacher assignment change', async () => {
      const f = await seedSection();
      const created = await request(app.getHttpServer())
        .post('/api/section-subjects')
        .set('Authorization', `Bearer ${f.token}`)
        .send({ sectionId: f.section.id, subjectId: f.subject.id })
        .expect(201);

      await sectionCard(f.token, f.grade.id, f.section.id); // prime

      await request(app.getHttpServer())
        .patch(`/api/section-subjects/${created.body.id}`)
        .set('Authorization', `Bearer ${f.token}`)
        .send({ teacherId: f.teacher.id })
        .expect(200);

      const detail = await request(app.getHttpServer())
        .get('/api/section-subjects')
        .query({ sectionId: f.section.id })
        .set('Authorization', `Bearer ${f.token}`)
        .expect(200);
      expect(detail.body[0].teacherId).toBe(f.teacher.id);
    });

    it('reflects a teacher assigned and removed', async () => {
      const f = await seedSection();

      const before = await sectionCard(f.token, f.grade.id, f.section.id);
      expect(before._count.teachers).toBe(0);

      const assigned = await request(app.getHttpServer())
        .post(`/api/sections/${f.section.id}/teachers`)
        .set('Authorization', `Bearer ${f.token}`)
        .send({ teacherId: f.teacher.id })
        .expect(201);

      const afterAssign = await sectionCard(f.token, f.grade.id, f.section.id);
      expect(afterAssign._count.teachers).toBe(1);

      await request(app.getHttpServer())
        .delete(`/api/sections/${f.section.id}/teachers/${assigned.body.id}`)
        .set('Authorization', `Bearer ${f.token}`)
        .expect(200);

      const afterRemove = await sectionCard(f.token, f.grade.id, f.section.id);
      expect(afterRemove._count.teachers).toBe(0);
    });
  });
  /**
   * The card's "N Teachers" figure.
   *
   * A teacher reaches a section two ways — the section-level assignment (the
   * class teacher) and teaching one of its subjects. `_count.teachers` sees
   * only the first, so a section taught by six different people advertised
   * "1 Teachers" while the setup screen listed all six. These pin the honest
   * DISTINCT union.
   */
  describe('section card teacher count', () => {
    /** A teacher in this school, assigned to one subject of the section. */
    async function teachSubject(
      f: Awaited<ReturnType<typeof seedSection>>,
      name: string,
    ) {
      const user = await createTestUser({
        role: Role.TEACHER,
        schoolId: f.school.id,
      });
      const teacher = await prisma.teacherProfile.create({
        data: { userId: user.id, schoolId: f.school.id, fullName: name },
      });
      const subject = await prisma.subject.create({
        data: { schoolId: f.school.id, name: `Subj-${uniq()}` },
      });
      await prisma.sectionSubject.create({
        data: {
          sectionId: f.section.id,
          subjectId: subject.id,
          teacherId: teacher.id,
        },
      });
      return teacher;
    }

    it('counts subject teachers, not just the class teacher', async () => {
      const f = await seedSection();
      await teachSubject(f, 'Maths Teacher');
      await teachSubject(f, 'Science Teacher');
      await teachSubject(f, 'Urdu Teacher');

      // One class teacher who teaches none of those subjects.
      await request(app.getHttpServer())
        .post(`/api/sections/${f.section.id}/teachers`)
        .set('Authorization', `Bearer ${f.token}`)
        .send({ teacherId: f.teacher.id })
        .expect(201);

      const card = await sectionCard(f.token, f.grade.id, f.section.id);
      // 3 subject teachers + 1 class teacher, all different people.
      expect(card.teacherCount).toBe(4);
      // The old figure is untouched for anything that wants homeroom only.
      expect(card._count.teachers).toBe(1);
    });

    it('counts a person once when they are both class and subject teacher', async () => {
      const f = await seedSection();
      const subject = await prisma.subject.create({
        data: { schoolId: f.school.id, name: `Subj-${uniq()}` },
      });
      await prisma.sectionSubject.create({
        data: {
          sectionId: f.section.id,
          subjectId: subject.id,
          teacherId: f.teacher.id,
        },
      });
      await request(app.getHttpServer())
        .post(`/api/sections/${f.section.id}/teachers`)
        .set('Authorization', `Bearer ${f.token}`)
        .send({ teacherId: f.teacher.id })
        .expect(201);

      const card = await sectionCard(f.token, f.grade.id, f.section.id);
      // UNION, not UNION ALL — the same person twice is still one teacher.
      expect(card.teacherCount).toBe(1);
    });

    it('is zero for a section nobody teaches', async () => {
      const f = await seedSection();
      const card = await sectionCard(f.token, f.grade.id, f.section.id);
      expect(card.teacherCount).toBe(0);
    });

    it('ignores a subject with no teacher assigned', async () => {
      const f = await seedSection();
      await prisma.sectionSubject.create({
        data: { sectionId: f.section.id, subjectId: f.subject.id },
      });
      const card = await sectionCard(f.token, f.grade.id, f.section.id);
      expect(card.teacherCount).toBe(0);
    });

    it('does not leak teachers from another section of the same class', async () => {
      const f = await seedSection();
      await teachSubject(f, 'Ours');

      const other = await prisma.section.create({
        data: {
          schoolId: f.school.id,
          classGradeId: f.grade.id,
          name: `B${uniq()}`,
        },
      });
      const strangerUser = await createTestUser({
        role: Role.TEACHER,
        schoolId: f.school.id,
      });
      const stranger = await prisma.teacherProfile.create({
        data: {
          userId: strangerUser.id,
          schoolId: f.school.id,
          fullName: 'Theirs',
        },
      });
      const otherSubject = await prisma.subject.create({
        data: { schoolId: f.school.id, name: `Subj-${uniq()}` },
      });
      await prisma.sectionSubject.create({
        data: {
          sectionId: other.id,
          subjectId: otherSubject.id,
          teacherId: stranger.id,
        },
      });

      const mine = await sectionCard(f.token, f.grade.id, f.section.id);
      const theirs = await sectionCard(f.token, f.grade.id, other.id);
      expect(mine.teacherCount).toBe(1);
      expect(theirs.teacherCount).toBe(1);
    });

    it('the detail payload carries each subject teacher and their user link', async () => {
      const f = await seedSection();
      const t = await teachSubject(f, 'Subject Only Teacher');

      const res = await request(app.getHttpServer())
        .get(`/api/sections/${f.section.id}/detail`)
        .set('Authorization', `Bearer ${f.token}`)
        .expect(200);

      // This teacher is NOT in `teachers` (no section-level assignment), which
      // is exactly why the card must read them off the subject row instead.
      expect(res.body.teachers).toHaveLength(0);
      const taught = res.body.subjects.find((ss: any) => ss.teacherId === t.id);
      expect(taught).toBeDefined();
      expect(taught.teacher.fullName).toBe('Subject Only Teacher');
      // `user.id` is what the card's profile link needs.
      expect(taught.teacher.user?.id).toBeTruthy();
    });
  });
});
