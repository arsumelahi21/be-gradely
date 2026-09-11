import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { CacheService } from '../src/common/services/cache.service';
import { Role } from '../src/common/types/role.type';

/**
 * The invariant: SectionTeacher (what the Teachers panel lists and what the class
 * card's `_count.teachers` counts) must mirror SectionSubject.teacherId (who
 * actually teaches a subject in that section).
 */
describe('Section roster mirrors subject teachers (e2e)', () => {
  let app: INestApplication;
  let cache: {
    redis: { disconnect(): void } | null;
    mem: Map<string, unknown>;
  };

  beforeAll(async () => {
    app = await createTestApp();
    // `.env` points REDIS_URL at a Redis that is not running under e2e and
    // CacheService fails open, so nothing would be cached at all — pin the
    // in-memory backend so the invalidation test means the same thing on every
    // machine, Redis running or not.
    cache = app.get(CacheService);
    cache.redis?.disconnect();
    cache.redis = null;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb();
    cache.mem.clear();
  });

  const server = () => request(app.getHttpServer());

  /** A school + section + an admin token for it. NOTE: seedClass writes its own
   *  sectionSubject straight through Prisma, so the section starts with an EMPTY
   *  roster — the legacy state this fix exists for. */
  const setup = async () => {
    const cls = await seedClass({ studentCount: 0 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);
    return { cls, auth: { Authorization: `Bearer ${token}` } };
  };

  const makeTeacher = async (schoolId: string, fullName: string) => {
    const user = await createTestUser({ role: Role.TEACHER, schoolId });
    return prisma.teacherProfile.create({
      data: { userId: user.id, schoolId, fullName },
    });
  };

  const makeSubject = (schoolId: string, name: string) =>
    prisma.subject.create({ data: { schoolId, name } });

  const allocate = (
    auth: Record<string, string>,
    body: Record<string, unknown>,
  ) => server().post('/api/section-subjects').set(auth).send(body);

  const roster = (sectionId: string) =>
    prisma.sectionTeacher.findMany({ where: { sectionId } });

  const rosterIds = async (sectionId: string) =>
    (await roster(sectionId)).map((r) => r.teacherId).sort();

  /** The Teachers panel. */
  const panelIds = async (auth: Record<string, string>, sectionId: string) => {
    const res = await server()
      .get(`/api/sections/${sectionId}/teachers`)
      .set(auth);
    expect(res.status).toBe(200);
    return (res.body as any[]).map((r) => r.teacherId).sort();
  };

  /** The class-detail card — a different, uncached read of the same roster. */
  const detailTeacherIds = async (
    auth: Record<string, string>,
    sectionId: string,
  ) => {
    const res = await server()
      .get(`/api/sections/${sectionId}/detail`)
      .set(auth);
    expect(res.status).toBe(200);
    return (res.body.teachers as any[]).map((r) => r.teacherId).sort();
  };

  /** The class card's cached counts. */
  const counts = async (auth: Record<string, string>, sectionId: string) => {
    const res = await server().get('/api/sections').set(auth);
    expect(res.status).toBe(200);
    const row = (res.body as any[]).find((s) => s.id === sectionId);
    expect(row).toBeDefined();
    return row._count as {
      subjects: number;
      teachers: number;
      enrollments: number;
    };
  };

  describe('ensureOnRoster — allocating a subject rosters its teacher', () => {
    it('POST /api/section-subjects rosters the teacher, on the panel, the detail card and the count', async () => {
      const { cls, auth } = await setup();
      const teacher = await makeTeacher(cls.school.id, 'Physics Teacher');
      const subject = await makeSubject(cls.school.id, 'Physics');

      const created = await allocate(auth, {
        sectionId: cls.section.id,
        subjectId: subject.id,
        teacherId: teacher.id,
      });
      expect(created.status).toBe(201);

      const rows = await roster(cls.section.id);
      expect(rows.map((r) => r.teacherId)).toEqual([teacher.id]);
      expect(rows[0]).toMatchObject({
        assignmentRole: 'Subject Teacher',
        isPrimary: false,
      });
      // Nothing backfills allocations written before the fix (seedClass's own),
      // so the fixture's teacher is deliberately still absent.
      expect(rows.map((r) => r.teacherId)).not.toContain(cls.teacherProfile.id);

      expect(await panelIds(auth, cls.section.id)).toEqual([teacher.id]);
      expect(await detailTeacherIds(auth, cls.section.id)).toEqual([
        teacher.id,
      ]);
      expect((await counts(auth, cls.section.id)).teachers).toBe(1);
    });

    it('PATCHing a teacher onto an unstaffed subject adds the roster row', async () => {
      const { cls, auth } = await setup();
      const teacher = await makeTeacher(cls.school.id, 'Late Hire');
      const subject = await makeSubject(cls.school.id, 'Chemistry');

      const created = await allocate(auth, {
        sectionId: cls.section.id,
        subjectId: subject.id,
      });
      expect(created.status).toBe(201);
      expect(created.body.teacherId).toBeNull();
      // An unstaffed subject must not roster a phantom.
      expect(await roster(cls.section.id)).toHaveLength(0);

      const patched = await server()
        .patch(`/api/section-subjects/${created.body.id}`)
        .set(auth)
        .send({ teacherId: teacher.id });
      expect(patched.status).toBe(200);
      expect(patched.body.teacherId).toBe(teacher.id);

      const rows = await roster(cls.section.id);
      expect(rows.map((r) => r.teacherId)).toEqual([teacher.id]);
      expect(rows[0]).toMatchObject({
        assignmentRole: 'Subject Teacher',
        isPrimary: false,
      });
      expect(await panelIds(auth, cls.section.id)).toEqual([teacher.id]);
    });

    it('one PATCH swaps the roster over: B is added, A (teaching nothing else) is dropped', async () => {
      const { cls, auth } = await setup();
      const teacherA = await makeTeacher(cls.school.id, 'A');
      const teacherB = await makeTeacher(cls.school.id, 'B');
      const subject = await makeSubject(cls.school.id, 'History');

      const created = await allocate(auth, {
        sectionId: cls.section.id,
        subjectId: subject.id,
        teacherId: teacherA.id,
      });
      expect(created.status).toBe(201);
      expect(await rosterIds(cls.section.id)).toEqual([teacherA.id]);

      const patched = await server()
        .patch(`/api/section-subjects/${created.body.id}`)
        .set(auth)
        .send({ teacherId: teacherB.id });
      expect(patched.status).toBe(200);

      // Exactly [B] also pins the ordering: the SectionSubject write must land
      // before the prune counts, or A still looks like they teach this subject.
      const rows = await roster(cls.section.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        teacherId: teacherB.id,
        assignmentRole: 'Subject Teacher',
        isPrimary: false,
      });
      expect(await panelIds(auth, cls.section.id)).toEqual([teacherB.id]);
      expect((await counts(auth, cls.section.id)).teachers).toBe(1);
    });

    it('reports every one of four subjects taught by four different teachers', async () => {
      const { cls, auth } = await setup();
      const teachers = [
        await makeTeacher(cls.school.id, 'T1'),
        await makeTeacher(cls.school.id, 'T2'),
        await makeTeacher(cls.school.id, 'T3'),
        await makeTeacher(cls.school.id, 'T4'),
      ];

      for (const [i, teacher] of teachers.entries()) {
        const subject = await makeSubject(cls.school.id, `Subject ${i}`);
        const res = await allocate(auth, {
          sectionId: cls.section.id,
          subjectId: subject.id,
          teacherId: teacher.id,
        });
        expect(res.status).toBe(201);
      }

      const expected = teachers.map((t) => t.id).sort();
      const rows = await roster(cls.section.id);
      expect(rows.map((r) => r.teacherId).sort()).toEqual(expected);
      expect(
        rows.every(
          (r) => r.assignmentRole === 'Subject Teacher' && !r.isPrimary,
        ),
      ).toBe(true);
      expect(await panelIds(auth, cls.section.id)).toEqual(expected);
      expect((await counts(auth, cls.section.id)).teachers).toBe(4);
    });
  });

  describe('ensureOnRoster never rewrites a row a human set', () => {
    it('giving the class teacher a subject preserves isPrimary, the role and the dates', async () => {
      const { cls, auth } = await setup();
      const homeroom = await makeTeacher(cls.school.id, 'Homeroom');
      const control = await makeTeacher(cls.school.id, 'Control');

      const assigned = await server()
        .post(`/api/sections/${cls.section.id}/teachers`)
        .set(auth)
        .send({
          teacherId: homeroom.id,
          assignmentRole: 'Class Teacher',
          isPrimary: true,
          startDate: '2026-01-06T00:00:00.000Z',
          endDate: '2026-12-18T00:00:00.000Z',
        });
      expect(assigned.status).toBe(201);

      for (const [teacher, name] of [
        [homeroom, 'History'],
        [control, 'Art'],
      ] as const) {
        const subject = await makeSubject(cls.school.id, name);
        const res = await allocate(auth, {
          sectionId: cls.section.id,
          subjectId: subject.id,
          teacherId: teacher.id,
        });
        expect(res.status).toBe(201);
      }

      const rows = await prisma.sectionTeacher.findMany({
        where: { sectionId: cls.section.id, teacherId: homeroom.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(assigned.body.id);
      expect(rows[0]).toMatchObject({
        isPrimary: true,
        assignmentRole: 'Class Teacher',
      });
      // `update: {}` preserves the WHOLE row, not only the two fields the prune reads.
      expect(rows[0].startDate?.toISOString()).toBe('2026-01-06T00:00:00.000Z');
      expect(rows[0].endDate?.toISOString()).toBe('2026-12-18T00:00:00.000Z');

      // The colleague with no prior row still gets the auto-created one, so a
      // full revert fails here rather than passing vacuously.
      const controlRow = await prisma.sectionTeacher.findFirstOrThrow({
        where: { sectionId: cls.section.id, teacherId: control.id },
      });
      expect(controlRow).toMatchObject({
        assignmentRole: 'Subject Teacher',
        isPrimary: false,
      });

      const panel = await server()
        .get(`/api/sections/${cls.section.id}/teachers`)
        .set(auth);
      expect(panel.status).toBe(200);
      expect(
        (panel.body as any[])
          .filter((r) => r.isPrimary)
          .map((r) => r.teacherId),
      ).toEqual([homeroom.id]);
    });

    it('a PATCH that only edits the schedule leaves the class teacher row untouched', async () => {
      const { cls, auth } = await setup();
      const homeroom = await makeTeacher(cls.school.id, 'Homeroom');
      const subject = await makeSubject(cls.school.id, 'Geography');

      const assigned = await server()
        .post(`/api/sections/${cls.section.id}/teachers`)
        .set(auth)
        .send({
          teacherId: homeroom.id,
          assignmentRole: 'Class Teacher',
          isPrimary: true,
        });
      expect(assigned.status).toBe(201);

      const created = await allocate(auth, {
        sectionId: cls.section.id,
        subjectId: subject.id,
        teacherId: homeroom.id,
      });
      expect(created.status).toBe(201);

      // teacherId is unchanged, so ensureOnRoster re-enters its update branch.
      const patched = await server()
        .patch(`/api/section-subjects/${created.body.id}`)
        .set(auth)
        .send({ schedule: 'Mon 09:00' });
      expect(patched.status).toBe(200);
      expect(patched.body.schedule).toBe('Mon 09:00');

      const rows = await roster(cls.section.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(assigned.body.id);
      expect(rows[0]).toMatchObject({
        isPrimary: true,
        assignmentRole: 'Class Teacher',
      });
    });
  });

  describe('pruneRosterIfUnused — only an unused auto row is removed', () => {
    it('keeps a swapped-out teacher who still teaches another subject in the section', async () => {
      const { cls, auth } = await setup();
      // seedClass's teacher already teaches one subject (no roster row); a
      // SECOND subject through the API is what puts them on the roster.
      const second = await makeSubject(cls.school.id, 'Physics');
      const created = await allocate(auth, {
        sectionId: cls.section.id,
        subjectId: second.id,
        teacherId: cls.teacherProfile.id,
      });
      expect(created.status).toBe(201);

      const replacement = await makeTeacher(cls.school.id, 'Replacement');
      const patched = await server()
        .patch(`/api/section-subjects/${created.body.id}`)
        .set(auth)
        .send({ teacherId: replacement.id });
      expect(patched.status).toBe(200);

      expect(
        await prisma.sectionSubject.count({
          where: {
            sectionId: cls.section.id,
            teacherId: cls.teacherProfile.id,
          },
        }),
      ).toBe(1);

      const expected = [cls.teacherProfile.id, replacement.id].sort();
      expect(await rosterIds(cls.section.id)).toEqual(expected);
      expect(await panelIds(auth, cls.section.id)).toEqual(expected);
      expect((await counts(auth, cls.section.id)).teachers).toBe(2);
    });

    it('DELETE prunes the roster row only when it was their last subject there', async () => {
      const { cls, auth } = await setup();
      const teacher = await makeTeacher(cls.school.id, 'Two Subjects');

      const allocations: string[] = [];
      for (const name of ['Biology', 'Chemistry']) {
        const subject = await makeSubject(cls.school.id, name);
        const res = await allocate(auth, {
          sectionId: cls.section.id,
          subjectId: subject.id,
          teacherId: teacher.id,
        });
        expect(res.status).toBe(201);
        allocations.push(res.body.id);
      }
      // Two subjects, one roster row.
      expect(await rosterIds(cls.section.id)).toEqual([teacher.id]);

      const first = await server()
        .delete(`/api/section-subjects/${allocations[0]}`)
        .set(auth);
      expect(first.status).toBe(200);
      expect(await rosterIds(cls.section.id)).toEqual([teacher.id]);
      expect(await panelIds(auth, cls.section.id)).toEqual([teacher.id]);

      const second = await server()
        .delete(`/api/section-subjects/${allocations[1]}`)
        .set(auth);
      expect(second.status).toBe(200);
      expect(await roster(cls.section.id)).toHaveLength(0);
      expect(await panelIds(auth, cls.section.id)).toEqual([]);
      expect((await counts(auth, cls.section.id)).teachers).toBe(0);
    });

    it('keeps a class teacher whose role is still the auto marker (isPrimary guard)', async () => {
      const { cls, auth } = await setup();
      const homeroom = await makeTeacher(cls.school.id, 'Homeroom');
      const plain = await makeTeacher(cls.school.id, 'Plain');

      const allocations: string[] = [];
      for (const [teacher, name] of [
        [homeroom, 'Music'],
        [plain, 'Drama'],
      ] as const) {
        const subject = await makeSubject(cls.school.id, name);
        const res = await allocate(auth, {
          sectionId: cls.section.id,
          subjectId: subject.id,
          teacherId: teacher.id,
        });
        expect(res.status).toBe(201);
        allocations.push(res.body.id);
      }

      // Promote WITHOUT a role, so the row keeps the auto marker and only
      // isPrimary stands between it and the prune — the guard isolated here.
      const promoted = await server()
        .post(`/api/sections/${cls.section.id}/teachers`)
        .set(auth)
        .send({ teacherId: homeroom.id, isPrimary: true });
      expect(promoted.status).toBe(201);
      expect(promoted.body.assignmentRole).toBe('Subject Teacher');
      expect(promoted.body.isPrimary).toBe(true);

      for (const id of allocations) {
        const res = await server()
          .delete(`/api/section-subjects/${id}`)
          .set(auth);
        expect(res.status).toBe(200);
      }

      // The control's untouched auto row went, so the prune really did run.
      const rows = await roster(cls.section.id);
      expect(rows.map((r) => r.teacherId)).toEqual([homeroom.id]);
      expect(rows[0]).toMatchObject({
        isPrimary: true,
        assignmentRole: 'Subject Teacher',
      });
      expect(await panelIds(auth, cls.section.id)).toEqual([homeroom.id]);
    });

    it('keeps an auto row a human has since re-titled (assignmentRole guard)', async () => {
      const { cls, auth } = await setup();
      const head = await makeTeacher(cls.school.id, 'Head');
      const plain = await makeTeacher(cls.school.id, 'Plain');

      const allocations: string[] = [];
      for (const [teacher, name] of [
        [head, 'Physics'],
        [plain, 'Chemistry'],
      ] as const) {
        const subject = await makeSubject(cls.school.id, name);
        const res = await allocate(auth, {
          sectionId: cls.section.id,
          subjectId: subject.id,
          teacherId: teacher.id,
        });
        expect(res.status).toBe(201);
        allocations.push(res.body.id);
      }
      const autoRows = await roster(cls.section.id);
      expect(autoRows).toHaveLength(2);
      expect(
        autoRows.every((r) => r.assignmentRole === 'Subject Teacher'),
      ).toBe(true);

      // A human re-titles one of them; isPrimary stays false throughout, so only
      // the assignmentRole check protects it.
      const promoted = await server()
        .post(`/api/sections/${cls.section.id}/teachers`)
        .set(auth)
        .send({ teacherId: head.id, assignmentRole: 'Head of Department' });
      expect(promoted.status).toBe(201);

      for (const id of allocations) {
        const res = await server()
          .delete(`/api/section-subjects/${id}`)
          .set(auth);
        expect(res.status).toBe(200);
      }

      const rows = await roster(cls.section.id);
      expect(rows.map((r) => r.teacherId)).toEqual([head.id]);
      expect(rows[0]).toMatchObject({
        assignmentRole: 'Head of Department',
        isPrimary: false,
      });
      expect(await panelIds(auth, cls.section.id)).toEqual([head.id]);
      expect((await counts(auth, cls.section.id)).teachers).toBe(1);
    });

    it('PATCH { teacherId: null } unstaffs the subject and prunes the roster row', async () => {
      const { cls, auth } = await setup();
      const teacher = await makeTeacher(cls.school.id, 'Leaving');
      const subject = await makeSubject(cls.school.id, 'Urdu');

      const created = await allocate(auth, {
        sectionId: cls.section.id,
        subjectId: subject.id,
        teacherId: teacher.id,
      });
      expect(created.status).toBe(201);
      expect(await rosterIds(cls.section.id)).toEqual([teacher.id]);

      // Clearing the teacher skips ensureOnRoster entirely — only the prune runs.
      const patched = await server()
        .patch(`/api/section-subjects/${created.body.id}`)
        .set(auth)
        .send({ teacherId: null });
      expect(patched.status).toBe(200);
      expect(patched.body.teacherId).toBeNull();

      expect(await roster(cls.section.id)).toHaveLength(0);
      expect(await panelIds(auth, cls.section.id)).toEqual([]);
      expect((await counts(auth, cls.section.id)).teachers).toBe(0);
    });
  });

  describe('cache invalidation — the class card is never stale after a roster write', () => {
    it('create, update and remove each drop the cached section counts', async () => {
      const { cls, auth } = await setup();
      const teacherX = await makeTeacher(cls.school.id, 'X');
      const teacherY = await makeTeacher(cls.school.id, 'Y');

      expect(await counts(auth, cls.section.id)).toMatchObject({
        subjects: 1,
        teachers: 0,
      });

      // Written straight through Prisma, so nothing can invalidate: the count
      // must still read 1, which proves the entry really is cached and the
      // fresh reads below cannot pass vacuously.
      const bypassSubject = await makeSubject(cls.school.id, 'Bypass');
      const bypass = await prisma.sectionSubject.create({
        data: { sectionId: cls.section.id, subjectId: bypassSubject.id },
      });
      expect(await counts(auth, cls.section.id)).toMatchObject({
        subjects: 1,
        teachers: 0,
      });

      const physics = await makeSubject(cls.school.id, 'Physics');
      const created = await allocate(auth, {
        sectionId: cls.section.id,
        subjectId: physics.id,
        teacherId: teacherX.id,
      });
      expect(created.status).toBe(201);
      // create() invalidates: the stale entry would still say {1, 0}.
      expect(await counts(auth, cls.section.id)).toMatchObject({
        subjects: 3,
        teachers: 1,
      });
      expect(await rosterIds(cls.section.id)).toEqual([teacherX.id]);

      const patched = await server()
        .patch(`/api/section-subjects/${bypass.id}`)
        .set(auth)
        .send({ teacherId: teacherY.id });
      expect(patched.status).toBe(200);
      // update() invalidates: the entry re-cached above would still say 1 teacher.
      expect(await counts(auth, cls.section.id)).toMatchObject({
        subjects: 3,
        teachers: 2,
      });

      const removed = await server()
        .delete(`/api/section-subjects/${created.body.id}`)
        .set(auth);
      expect(removed.status).toBe(200);
      // remove() invalidates: the stale entry would still say {3, 2}.
      expect(await counts(auth, cls.section.id)).toMatchObject({
        subjects: 2,
        teachers: 1,
      });
      expect(await rosterIds(cls.section.id)).toEqual([teacherY.id]);
    });
  });

  describe('known bug', () => {
    // update() writes the row to `section.id` but calls both roster helpers with
    // `current.sectionId`, so a cross-section move breaks the mirror both ways.
    // Marked `.failing`: it goes green the moment the helpers take the new id.
    it.failing(
      'moving a subject to another section moves its roster row with it',
      async () => {
        const { cls, auth } = await setup();
        const sectionB = await prisma.section.create({
          data: {
            schoolId: cls.school.id,
            classGradeId: cls.classGrade.id,
            name: 'Section B',
          },
        });
        const teacher = await makeTeacher(cls.school.id, 'Mover');
        const subject = await makeSubject(cls.school.id, 'Moving Subject');

        const created = await allocate(auth, {
          sectionId: cls.section.id,
          subjectId: subject.id,
          teacherId: teacher.id,
        });
        expect(created.status).toBe(201);
        expect(await rosterIds(cls.section.id)).toEqual([teacher.id]);

        const patched = await server()
          .patch(`/api/section-subjects/${created.body.id}`)
          .set(auth)
          .send({ sectionId: sectionB.id });
        expect(patched.status).toBe(200);
        expect(patched.body.sectionId).toBe(sectionB.id);

        expect(await rosterIds(cls.section.id)).toEqual([]);
        expect(await rosterIds(sectionB.id)).toEqual([teacher.id]);
        expect(await panelIds(auth, cls.section.id)).toEqual([]);
        expect(await panelIds(auth, sectionB.id)).toEqual([teacher.id]);
      },
    );
  });
});
