import { INestApplication, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { RolesGuard } from '../src/auth/guards/roles.guard';

// A fresh app per test because /auth/login is throttled per account and network.
describe('Directors and school groups (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    await resetDb();
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  // A director's scope requires a live refresh hash, so sign in for real.
  async function loginToken(email: string, password: string) {
    const res = await api().post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(201);
    return res.body.accessToken as string;
  }

  // AuditLogService.record is fire-and-forget, so the row can land just after the response.
  async function auditRows(where: object, expected: number) {
    for (let i = 0; ; i++) {
      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'asc' },
      });
      if (rows.length >= expected || i === 20) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function fixture() {
    const sa = await createTestUser({ role: Role.SUPER_ADMIN });
    const saToken = await tokenFor(app, sa);
    const [a, b, d, standalone] = await Promise.all(
      ['Alpha', 'Bravo', 'Delta', 'Solo'].map((name) =>
        createTestSchool({ name }),
      ),
    );
    const d1 = await createTestUser({ role: Role.DIRECTOR });
    const d2 = await createTestUser({ role: Role.DIRECTOR });
    const g1 = await prisma.schoolGroup.create({
      data: { name: 'G1', directorId: d1.id },
    });
    const g2 = await prisma.schoolGroup.create({
      data: { name: 'G2', directorId: d2.id },
    });
    await prisma.school.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { groupId: g1.id },
    });
    await prisma.school.update({
      where: { id: d.id },
      data: { groupId: g2.id },
    });
    const principalB = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: b.id,
    });
    return { sa, saToken, a, b, d, standalone, g1, g2, d1, d2, principalB };
  }

  describe('schema', () => {
    // Raw SQL, invisible to migrate diff: checked here instead.
    it('installs the director CHECK and the one-active-principal index', async () => {
      const checks = await prisma.$queryRaw<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'User_director_school_check'`;
      expect(checks).toHaveLength(1);
      const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
         WHERE indexname = 'User_one_active_principal_per_school'`;
      expect(indexes[0].indexdef).toMatch(/UNIQUE.*WHERE/);
    });

    it('rejects a director with a school and a second active principal, at the database', async () => {
      const school = await createTestSchool();
      await expect(
        createTestUser({ role: Role.DIRECTOR, schoolId: school.id }),
      ).rejects.toThrow();
      await createTestUser({ role: Role.SCHOOL_ADMIN, schoolId: school.id });
      await expect(
        createTestUser({ role: Role.SCHOOL_ADMIN, schoolId: school.id }),
      ).rejects.toThrow();
      // History is fine: deactivated principals don't count.
      await createTestUser({
        role: Role.SCHOOL_ADMIN,
        schoolId: school.id,
        isActive: false,
      });
    });
  });

  describe('role allowlist', () => {
    // Reads every handler's @Roles, so a DIRECTOR added to the wrong list fails here.
    function routesAdmitting(role: Role): string[] {
      const out: string[] = [];
      for (const mod of app.get(ModulesContainer).values()) {
        for (const wrapper of mod.controllers.values()) {
          const ctrl = wrapper.metatype as any;
          if (!ctrl?.prototype) continue;
          const base: string = Reflect.getMetadata(PATH_METADATA, ctrl) ?? '';
          const classRoles = Reflect.getMetadata(ROLES_KEY, ctrl);
          for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
            const fn = ctrl.prototype[name];
            if (name === 'constructor' || typeof fn !== 'function') continue;
            const path = Reflect.getMetadata(PATH_METADATA, fn);
            if (path === undefined) continue;
            const roles: Role[] | undefined =
              Reflect.getMetadata(ROLES_KEY, fn) ?? classRoles;
            if (!roles?.includes(role)) continue;
            const method =
              RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn)];
            out.push(
              `${method} /${base}/${path}`
                .replace(/\/+/g, '/')
                .replace(/\/$/, ''),
            );
          }
        }
      }
      return out.sort();
    }

    // A controller without RolesGuard admits every role, and the allowlist below cannot see it.
    it('puts RolesGuard on every controller except health and auth', () => {
      const unguarded: string[] = [];
      for (const mod of app.get(ModulesContainer).values()) {
        for (const wrapper of mod.controllers.values()) {
          const ctrl = wrapper.metatype as any;
          if (!ctrl || ['AppController', 'AuthController'].includes(ctrl.name))
            continue;
          const guards: unknown[] =
            Reflect.getMetadata(GUARDS_METADATA, ctrl) ?? [];
          if (!guards.includes(RolesGuard)) unguarded.push(ctrl.name);
        }
      }
      expect(unguarded).toEqual([]);
    });

    it('admits DIRECTOR to exactly its own routes and the self-service ones', () => {
      expect(routesAdmitting(Role.DIRECTOR)).toEqual(
        [
          'GET /director/branches',
          'GET /director/insights/fees',
          'GET /director/insights/fees/lists',
          'GET /director/insights/students',
          'GET /director/insights/attendance',
          'GET /director/insights/attendance/lists',
          'GET /director/insights/academics',
          'GET /director/insights/staffing',
          'GET /director/principals',
          'GET /director/insights/activity',
          'GET /director/insights/overview',
          'GET /director/map/:branchId',
          // The one director write: its own group's targets row.
          'GET /director/targets',
          'PATCH /director/targets',
          // Messaging: the service limits a director to 1:1 threads in their branches.
          'GET /messaging/threads',
          'POST /messaging/threads',
          'GET /messaging/unread-count',
          'GET /messaging/recipients',
          'POST /messaging/broadcast',
          'GET /messaging/threads/:id',
          'DELETE /messaging/threads/:id',
          'GET /messaging/threads/:id/messages',
          'POST /messaging/threads/:id/messages',
          'PATCH /messaging/threads/:id/messages/:messageId',
          'DELETE /messaging/threads/:id/messages/:messageId',
          'PUT /messaging/threads/:id/messages/:messageId/reaction',
          'DELETE /messaging/threads/:id/messages/:messageId/reaction',
          'POST /messaging/threads/:id/attachments',
          'PATCH /messaging/threads/:id/read',
          'POST /messaging/report',
          'GET /notifications',
          'GET /notifications/unread-count',
          'DELETE /notifications',
          'DELETE /notifications/:id',
          'PATCH /notifications/read-all',
          'PATCH /notifications/read',
          'PATCH /notifications/:id/read',
          'GET /settings/me',
          'PATCH /settings/me',
          'GET /schools/me/logo',
          'PATCH /users/me/password',
          'POST /users/me/photo',
          'DELETE /users/me/photo',
          'GET /users/me/photo',
          'GET /users/:id/photo',
        ].sort(),
      );
    });
  });

  describe('a signed-in director', () => {
    it('signs in, reads its profile and its own self-service routes', async () => {
      const { d1 } = await fixture();
      const token = await loginToken(d1.email, d1.password);

      const me = await api().get('/api/auth/me').set(auth(token));
      expect(me.status).toBe(200);
      expect(me.body.school).toBeNull();

      expect(
        (await api().get('/api/settings/me').set(auth(token))).status,
      ).toBe(200);
      expect(
        (await api().get('/api/notifications').set(auth(token))).status,
      ).toBe(200);
      expect(
        (await api().get('/api/schools/me/logo').set(auth(token))).status,
      ).toBe(404);
    });

    it('is refused everywhere a school role works', async () => {
      const { d1, principalB } = await fixture();
      const token = await loginToken(d1.email, d1.password);
      const refused = [
        api().get(`/api/users/${principalB.id}`),
        api().get('/api/users/me'),
        api().patch('/api/users/me').send({ fullName: 'X' }),
        api().get('/api/users'),
        api().get('/api/search?q=a'),
        api().get('/api/chatbot/chats'),
        api().get('/api/dashboard/school-overview'),
        api().get('/api/schools'),
        api().get('/api/groups'),
        api().get('/api/directors'),
        api().post('/api/users').send({}),
        api()
          .patch(`/api/users/${principalB.id}/active`)
          .send({ isActive: false }),
        api().post(`/api/users/${principalB.id}/password-reset`),
      ];
      for (const req of refused) {
        expect((await req.set(auth(token))).status).toBe(403);
      }
    });

    it('lists only its own group’s branches, each with its current session', async () => {
      const { d1, a, g1 } = await fixture();
      await prisma.academicYear.createMany({
        data: [
          {
            schoolId: a.id,
            name: 'Old',
            code: 'OLD',
            startDate: new Date('2000-01-01'),
            endDate: new Date('2000-12-31'),
          },
          {
            schoolId: a.id,
            name: 'Now',
            code: 'NOW',
            startDate: new Date('2001-01-01'),
            endDate: new Date('2999-12-31'),
          },
        ],
      });
      const token = await loginToken(d1.email, d1.password);

      const res = await api().get('/api/director/branches').set(auth(token));
      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([{ id: g1.id, name: 'G1' }]);
      expect(res.body.branches.map((x: any) => x.name)).toEqual([
        'Alpha',
        'Bravo',
      ]);
      expect(Object.keys(res.body.branches[0]).sort()).toEqual(
        [
          'academicYear',
          'city',
          'code',
          'currency',
          'groupId',
          'isActive',
          'name',
          'schoolId',
        ].sort(),
      );
      expect(res.body.branches[0].academicYear).toMatchObject({
        name: 'Now',
        startDate: '2001-01-01',
        endDate: '2999-12-31',
      });
      expect(res.body.branches[1].academicYear).toBeNull();
    });

    it('gets an empty list for a group with no schools, or with no group at all', async () => {
      const d = await createTestUser({ role: Role.DIRECTOR });
      const token = await loginToken(d.email, d.password);
      const none = await api().get('/api/director/branches').set(auth(token));
      expect(none.status).toBe(200);
      expect(none.body).toEqual({ groups: [], branches: [] });

      await prisma.schoolGroup.create({
        data: { name: 'Empty', directorId: d.id },
      });
      const res = await api().get('/api/director/branches').set(auth(token));
      expect(res.body.groups.map((g: any) => g.name)).toEqual(['Empty']);
      expect(res.body.branches).toEqual([]);
    });

    it('sees every group it directs, and can narrow to one', async () => {
      const { d1, g1, standalone } = await fixture();
      const g3 = await prisma.schoolGroup.create({
        data: { name: 'G3', directorId: d1.id },
      });
      await prisma.school.update({
        where: { id: standalone.id },
        data: { groupId: g3.id },
      });
      const token = await loginToken(d1.email, d1.password);

      const res = await api().get('/api/director/branches').set(auth(token));
      expect(res.body.groups.map((g: any) => g.name)).toEqual(['G1', 'G3']);
      expect(res.body.branches.map((b: any) => [b.name, b.groupId])).toEqual([
        ['Alpha', g1.id],
        ['Bravo', g1.id],
        ['Solo', g3.id],
      ]);

      const insights = (q: string) =>
        api().get(`/api/director/insights/students${q}`).set(auth(token));
      const only = await insights(`?group=${g3.id}`);
      expect(only.body.branches.map((b: any) => b.name)).toEqual(['Solo']);
      // Another director's group, or a branch outside the chosen group: the same 404.
      const { g2 } = await fixture();
      expect((await insights(`?group=${g2.id}`)).status).toBe(404);
      expect(
        (await insights(`?group=${g3.id}&branch=${standalone.id}`)).status,
      ).toBe(200);
      const alpha = res.body.branches[0].schoolId;
      expect((await insights(`?group=${g3.id}&branch=${alpha}`)).status).toBe(
        404,
      );
    });
  });

  describe('scope is re-derived on every request', () => {
    it('drops a detached branch on the very next request', async () => {
      const { d1, saToken, g1, b } = await fixture();
      const token = await loginToken(d1.email, d1.password);

      await api()
        .delete(`/api/groups/${g1.id}/schools/${b.id}`)
        .set(auth(saToken))
        .expect(200);

      const res = await api().get('/api/director/branches').set(auth(token));
      expect(res.body.branches.map((x: any) => x.name)).toEqual(['Alpha']);
    });

    it('locks out a deactivated director on the same token, but not the other director', async () => {
      const { d1, d2, saToken } = await fixture();
      const t1 = await loginToken(d1.email, d1.password);
      const t2 = await loginToken(d2.email, d2.password);

      await api()
        .patch(`/api/users/${d1.id}/active`)
        .set(auth(saToken))
        .send({ isActive: false })
        .expect(200);

      expect(
        (await api().get('/api/director/branches').set(auth(t1))).status,
      ).toBe(401);
      expect(
        (await api().get('/api/director/branches').set(auth(t2))).status,
      ).toBe(200);
    });

    it('locks out after an API logout and after a super admin reset', async () => {
      const { d1, d2, saToken } = await fixture();
      const t1 = await loginToken(d1.email, d1.password);
      const t2 = await loginToken(d2.email, d2.password);

      await api().post('/api/auth/logout').set(auth(t1)).expect(201);
      await api()
        .post(`/api/users/${d2.id}/password-reset`)
        .set(auth(saToken))
        .expect(201);

      for (const t of [t1, t2]) {
        expect(
          (await api().get('/api/director/branches').set(auth(t))).status,
        ).toBe(401);
      }
    });

    it('rejects a director token that never signed in', async () => {
      const { d1 } = await fixture();
      const forged = await tokenFor(app, d1);
      expect(
        (await api().get('/api/director/branches').set(auth(forged))).status,
      ).toBe(401);
    });
  });

  describe('users service guards', () => {
    it('refuses to create a director through POST /users', async () => {
      const { saToken, a } = await fixture();
      const res = await api().post('/api/users').set(auth(saToken)).send({
        email: 'x@test.local',
        password: 'Password@123',
        role: Role.DIRECTOR,
        fullName: 'X',
        schoolId: a.id,
      });
      expect(res.status).toBe(400);
    });

    it('never gives a director a school, but lets a super admin rename one', async () => {
      const { saToken, d1, a } = await fixture();
      expect(
        (
          await api()
            .patch(`/api/users/${d1.id}`)
            .set(auth(saToken))
            .send({ schoolId: a.id })
        ).status,
      ).toBe(400);
      const ok = await api()
        .patch(`/api/users/${d1.id}`)
        .set(auth(saToken))
        .send({ fullName: 'Renamed', schoolId: null });
      expect(ok.status).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: d1.id } });
      expect(row.fullName).toBe('Renamed');
      expect(row.schoolId).toBeNull();
    });

    it('keeps principals away from directors', async () => {
      const { d1, principalB } = await fixture();
      const token = await tokenFor(app, principalB);
      expect(
        (
          await api()
            .patch(`/api/users/${d1.id}/active`)
            .set(auth(token))
            .send({ isActive: false })
        ).status,
      ).toBe(403);
      expect(
        (
          await api()
            .post(`/api/users/${d1.id}/password-reset`)
            .set(auth(token))
        ).status,
      ).toBe(404);
    });

    it('audits activation and deactivation for every role', async () => {
      const { saToken, d1, principalB } = await fixture();
      await api()
        .patch(`/api/users/${d1.id}/active`)
        .set(auth(saToken))
        .send({ isActive: false })
        .expect(200);
      await api()
        .patch(`/api/users/${principalB.id}/active`)
        .set(auth(saToken))
        .send({ isActive: true })
        .expect(200);

      const rows = await auditRows(
        { action: { in: ['USER_ACTIVATE', 'USER_DEACTIVATE'] } },
        2,
      );
      expect(rows.map((r) => [r.action, r.entityId, r.schoolId])).toEqual([
        ['USER_DEACTIVATE', d1.id, null],
        ['USER_ACTIVATE', principalB.id, principalB.schoolId],
      ]);
    });
  });

  describe('super admin /groups', () => {
    it('creates, lists, paginates and renames groups', async () => {
      const { saToken, g1, d1, principalB } = await fixture();
      const created = await api()
        .post('/api/groups')
        .set(auth(saToken))
        .send({ name: '  New Group  ', directorId: d1.id });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: 'New Group',
        directorId: d1.id,
      });

      const all = await api().get('/api/groups').set(auth(saToken));
      expect(all.body.map((g: any) => g.name)).toEqual([
        'G1',
        'G2',
        'New Group',
      ]);
      expect(all.body[0]).toMatchObject({
        schoolCount: 2,
        director: { id: d1.id },
      });

      const page = await api()
        .get('/api/groups?page=2&pageSize=2')
        .set(auth(saToken));
      expect(page.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(page.body.items.map((g: any) => g.name)).toEqual(['New Group']);

      await api()
        .patch(`/api/groups/${g1.id}`)
        .set(auth(saToken))
        .send({ name: 'Renamed' })
        .expect(200);
      expect(
        (await api().get(`/api/groups/${g1.id}`).set(auth(saToken))).body.name,
      ).toBe('Renamed');
      const post = (body: object) =>
        api().post('/api/groups').set(auth(saToken)).send(body);
      expect((await post({ name: ' ', directorId: d1.id })).status).toBe(400);
      expect((await post({ name: 'No director' })).status).toBe(400);
      // A principal is not a director.
      expect(
        (await post({ name: 'X', directorId: principalB.id })).status,
      ).toBe(404);
    });

    it('returns a group with explicit school and director fields only', async () => {
      const { saToken, g1 } = await fixture();
      const res = await api().get(`/api/groups/${g1.id}`).set(auth(saToken));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.director).sort()).toEqual(
        ['email', 'fullName', 'id', 'isActive'].sort(),
      );
      expect(JSON.stringify(res.body)).not.toMatch(
        /passwordHash|refreshTokenHash/,
      );
    });

    it('attaches atomically and refuses a school in another group', async () => {
      const { saToken, g1, d, standalone } = await fixture();
      const attach = (schoolId: string) =>
        api()
          .post(`/api/groups/${g1.id}/schools`)
          .set(auth(saToken))
          .send({ schoolId });

      expect((await attach(standalone.id)).status).toBe(201);
      expect((await attach(standalone.id)).status).toBe(201);
      expect((await attach(d.id)).status).toBe(409);
      expect(
        (await attach('00000000-0000-4000-8000-000000000000')).status,
      ).toBe(404);
      expect(
        (
          await api()
            .post('/api/groups/00000000-0000-4000-8000-000000000000/schools')
            .set(auth(saToken))
            .send({ schoolId: standalone.id })
        ).status,
      ).toBe(404);
    });

    it('detaches only from its own group and removes only the directors’ thread rows', async () => {
      const { saToken, g1, g2, b, d1, principalB } = await fixture();
      const thread = await prisma.messageThread.create({
        data: {
          schoolId: b.id,
          type: 'DIRECT',
          participants: {
            create: [{ userId: d1.id }, { userId: principalB.id }],
          },
        },
      });

      expect(
        (
          await api()
            .delete(`/api/groups/${g2.id}/schools/${b.id}`)
            .set(auth(saToken))
        ).status,
      ).toBe(404);

      const res = await api()
        .delete(`/api/groups/${g1.id}/schools/${b.id}`)
        .set(auth(saToken));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        detached: true,
        threadParticipantsRemoved: 1,
      });

      const left = await prisma.threadParticipant.findMany({
        where: { threadId: thread.id },
      });
      expect(left.map((p) => p.userId)).toEqual([principalB.id]);
      expect(
        (await prisma.school.findUniqueOrThrow({ where: { id: b.id } }))
          .groupId,
      ).toBeNull();
    });

    it('gives a group another director, who takes over its branches and conversations', async () => {
      const { saToken, g1, b, d1, d2, principalB } = await fixture();
      const thread = await prisma.messageThread.create({
        data: {
          schoolId: b.id,
          type: 'DIRECT',
          participants: {
            create: [{ userId: d1.id }, { userId: principalB.id }],
          },
        },
      });
      const t1 = await loginToken(d1.email, d1.password);
      const t2 = await loginToken(d2.email, d2.password);

      await api()
        .patch(`/api/groups/${g1.id}`)
        .set(auth(saToken))
        .send({ directorId: d2.id })
        .expect(200);

      const branches = async (t: string) =>
        (await api().get('/api/director/branches').set(auth(t))).body.branches
          .map((x: any) => x.name)
          .sort();
      expect(await branches(t1)).toEqual([]);
      expect(await branches(t2)).toEqual(['Alpha', 'Bravo', 'Delta']);
      const left = await prisma.threadParticipant.findMany({
        where: { threadId: thread.id },
      });
      expect(left.map((x) => x.userId)).toEqual([principalB.id]);
      expect(
        (await api().patch(`/api/groups/${g1.id}`).set(auth(saToken)).send({}))
          .status,
      ).toBe(400);
    });

    it('deletes a group only once it has no branches', async () => {
      const { saToken, g1, a, b } = await fixture();
      const del = () => api().delete(`/api/groups/${g1.id}`).set(auth(saToken));
      expect((await del()).status).toBe(409);
      for (const id of [a.id, b.id])
        await api()
          .delete(`/api/groups/${g1.id}/schools/${id}`)
          .set(auth(saToken))
          .expect(200);
      expect((await del()).status).toBe(200);
      expect(await prisma.schoolGroup.count({ where: { id: g1.id } })).toBe(0);
      expect((await del()).status).toBe(404);
    });

    it('audits group changes, with the branch on attach and detach', async () => {
      const { saToken, sa, g1, d1, standalone } = await fixture();
      const created = await api()
        .post('/api/groups')
        .set(auth(saToken))
        .send({ name: 'Audited', directorId: d1.id });
      await api()
        .patch(`/api/groups/${created.body.id}`)
        .set(auth(saToken))
        .send({ name: 'Audited 2' });
      await api()
        .post(`/api/groups/${g1.id}/schools`)
        .set(auth(saToken))
        .send({ schoolId: standalone.id });
      await api()
        .delete(`/api/groups/${g1.id}/schools/${standalone.id}`)
        .set(auth(saToken));
      await api()
        .post('/api/directors')
        .set(auth(saToken))
        .send({ email: 'a@test.local', password: 'Chosen@123', fullName: 'A' });

      const rows = await auditRows({ actorUserId: sa.id }, 5);
      expect(rows.map((r) => [r.action, r.schoolId])).toEqual([
        ['GROUP_CREATE', null],
        ['GROUP_UPDATE', null],
        ['GROUP_SCHOOL_ATTACH', standalone.id],
        ['GROUP_SCHOOL_DETACH', standalone.id],
        ['USER_CREATE', null],
      ]);
    });

    it('is super admin only', async () => {
      const { g1, d1, principalB, a } = await fixture();
      const teacher = await createTestUser({
        role: Role.TEACHER,
        schoolId: a.id,
      });
      for (const user of [principalB, teacher]) {
        const token = await tokenFor(app, user);
        const calls = [
          api().get('/api/groups'),
          api().get(`/api/groups/${g1.id}`),
          api().post('/api/groups').send({ name: 'X', directorId: d1.id }),
          api().patch(`/api/groups/${g1.id}`).send({ name: 'X' }),
          api().delete(`/api/groups/${g1.id}`),
          api().post(`/api/groups/${g1.id}/schools`).send({ schoolId: a.id }),
          api().delete(`/api/groups/${g1.id}/schools/${a.id}`),
          api().get('/api/directors'),
          api().get(`/api/directors/${d1.id}`),
          api().post('/api/directors').send({
            email: 'z@test.local',
            password: 'Chosen@123',
            fullName: 'Z',
          }),
          api().patch(`/api/directors/${d1.id}`).send({ fullName: 'Z' }),
          api().delete(`/api/directors/${d1.id}`),
        ];
        for (const call of calls) {
          expect((await call.set(auth(token))).status).toBe(403);
        }
      }
    });
  });

  describe('super admin /directors', () => {
    it('creates a director who signs in with the password the super admin chose', async () => {
      const { saToken } = await fixture();
      const body = {
        email: 'director@test.local',
        password: 'Chosen@123',
        fullName: 'Dana Director',
      };
      const res = await api()
        .post('/api/directors')
        .set(auth(saToken))
        .send(body);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        email: body.email,
        fullName: body.fullName,
        isActive: true,
        mustChangePassword: false,
        directedGroups: [],
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /Chosen@123|passwordHash|refreshTokenHash/,
      );

      const token = await loginToken(body.email, body.password);
      expect(
        (await api().get('/api/director/branches').set(auth(token))).status,
      ).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({
        where: { email: body.email },
      });
      expect(row).toMatchObject({ role: Role.DIRECTOR, schoolId: null });
    });

    it('validates the director body', async () => {
      const { saToken, d1, a } = await fixture();
      const post = (body: object) =>
        api()
          .post('/api/directors')
          .set(auth(saToken))
          .send({
            email: 'n@test.local',
            password: 'Chosen@123',
            fullName: 'N',
            ...body,
          });
      expect((await post({ password: 'short12' })).status).toBe(400);
      expect((await post({ schoolId: a.id })).status).toBe(400);
      expect((await post({ role: Role.SCHOOL_ADMIN })).status).toBe(400);
      expect((await post({ email: d1.email })).status).toBe(409);
    });

    it('lists, edits and shows the groups each director oversees', async () => {
      const { saToken, d1, g1, principalB } = await fixture();
      const list = await api()
        .get('/api/directors?page=1&pageSize=10&search=')
        .set(auth(saToken));
      expect(list.body.total).toBe(2);
      const mine = list.body.items.find((d: any) => d.id === d1.id);
      expect(mine.directedGroups).toEqual([
        { id: g1.id, name: 'G1', _count: { schools: 2 } },
      ]);

      const edited = await api()
        .patch(`/api/directors/${d1.id}`)
        .set(auth(saToken))
        .send({ fullName: 'Renamed Director' });
      expect(edited.body.fullName).toBe('Renamed Director');
      // Only directors live here.
      expect(
        (await api().get(`/api/directors/${principalB.id}`).set(auth(saToken)))
          .status,
      ).toBe(404);
    });

    it('deletes a director only once they oversee no group', async () => {
      const { saToken, d1, d2, g1 } = await fixture();
      const del = () =>
        api().delete(`/api/directors/${d1.id}`).set(auth(saToken));
      const refused = await del();
      expect(refused.status).toBe(409);
      expect(refused.body.message).toContain('G1');

      await api()
        .patch(`/api/groups/${g1.id}`)
        .set(auth(saToken))
        .send({ directorId: d2.id })
        .expect(200);
      expect((await del()).status).toBe(200);
      expect(await prisma.user.count({ where: { id: d1.id } })).toBe(0);
    });

    it('refuses to delete a director whose messages principals still have', async () => {
      const { saToken, b, principalB } = await fixture();
      const d = await createTestUser({ role: Role.DIRECTOR });
      const thread = await prisma.messageThread.create({
        data: {
          schoolId: b.id,
          type: 'DIRECT',
          participants: {
            create: [{ userId: d.id }, { userId: principalB.id }],
          },
        },
      });
      await prisma.message.create({
        data: {
          threadId: thread.id,
          senderId: d.id,
          body: 'Please send the report',
        },
      });
      const res = await api()
        .delete(`/api/directors/${d.id}`)
        .set(auth(saToken));
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/Deactivate them instead/);
      expect(await prisma.message.count({ where: { senderId: d.id } })).toBe(1);
    });
  });

  describe('one active principal per branch', () => {
    const principalBody = (schoolId: string, email: string) => ({
      email,
      password: 'Password@123',
      role: Role.SCHOOL_ADMIN,
      fullName: 'Second Principal',
      phone: '03001234567',
      schoolId,
    });

    it('refuses a second active principal on create, naming the current one', async () => {
      const { saToken, b, a } = await fixture();
      const res = await api()
        .post('/api/users')
        .set(auth(saToken))
        .send(principalBody(b.id, 'second@test.local'));
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already has an active principal/);
      // Alpha has none yet, so it can have one.
      expect(
        (
          await api()
            .post('/api/users')
            .set(auth(saToken))
            .send(principalBody(a.id, 'alpha@test.local'))
        ).status,
      ).toBe(201);
    });

    it('refuses to reactivate or move a principal into a school that has one', async () => {
      const { saToken, a, b } = await fixture();
      const old = await createTestUser({
        role: Role.SCHOOL_ADMIN,
        schoolId: b.id,
        isActive: false,
      });
      expect(
        (
          await api()
            .patch(`/api/users/${old.id}/active`)
            .set(auth(saToken))
            .send({ isActive: true })
        ).status,
      ).toBe(409);

      const alphaPrincipal = await createTestUser({
        role: Role.SCHOOL_ADMIN,
        schoolId: a.id,
      });
      expect(
        (
          await api()
            .patch(`/api/users/${alphaPrincipal.id}`)
            .set(auth(saToken))
            .send({ schoolId: b.id })
        ).status,
      ).toBe(409);
    });
  });
});
