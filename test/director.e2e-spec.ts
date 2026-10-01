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
    const g1 = await prisma.schoolGroup.create({ data: { name: 'G1' } });
    const g2 = await prisma.schoolGroup.create({ data: { name: 'G2' } });
    await prisma.school.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { groupId: g1.id },
    });
    await prisma.school.update({
      where: { id: d.id },
      data: { groupId: g2.id },
    });
    const d1 = await createTestUser({ role: Role.DIRECTOR, groupId: g1.id });
    const d2 = await createTestUser({ role: Role.DIRECTOR, groupId: g1.id });
    const principalB = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: b.id,
    });
    return { sa, saToken, a, b, d, standalone, g1, g2, d1, d2, principalB };
  }

  describe('schema', () => {
    it('installs the director CHECK constraint', async () => {
      const rows = await prisma.$queryRaw<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'User_director_group_check'`;
      expect(rows).toHaveLength(1);
    });

    it('rejects a director without a group, a director with a school and a grouped teacher', async () => {
      const school = await createTestSchool();
      const group = await prisma.schoolGroup.create({ data: { name: 'G' } });
      await expect(createTestUser({ role: Role.DIRECTOR })).rejects.toThrow();
      await expect(
        createTestUser({
          role: Role.DIRECTOR,
          groupId: group.id,
          schoolId: school.id,
        }),
      ).rejects.toThrow();
      await expect(
        createTestUser({
          role: Role.TEACHER,
          schoolId: school.id,
          groupId: group.id,
        }),
      ).rejects.toThrow();
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
      const { d1, g1 } = await fixture();
      const token = await loginToken(d1.email, d1.password);

      const me = await api().get('/api/auth/me').set(auth(token));
      expect(me.status).toBe(200);
      expect(me.body.groupId).toBe(g1.id);
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
        api().get('/api/messaging/threads'),
        api().get('/api/schools'),
        api().get('/api/groups'),
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
      expect(res.body.group).toEqual({ id: g1.id, name: 'G1' });
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

    it('gets an empty list for a group with no schools', async () => {
      const group = await prisma.schoolGroup.create({
        data: { name: 'Empty' },
      });
      const d = await createTestUser({
        role: Role.DIRECTOR,
        groupId: group.id,
      });
      const token = await loginToken(d.email, d.password);

      const res = await api().get('/api/director/branches').set(auth(token));
      expect(res.status).toBe(200);
      expect(res.body.branches).toEqual([]);
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
      const { saToken, g1 } = await fixture();
      const created = await api()
        .post('/api/groups')
        .set(auth(saToken))
        .send({ name: '  New Group  ' });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe('New Group');

      const all = await api().get('/api/groups').set(auth(saToken));
      expect(all.body.map((g: any) => g.name)).toEqual([
        'G1',
        'G2',
        'New Group',
      ]);
      expect(all.body[0]).toMatchObject({ schoolCount: 2, directorCount: 2 });

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
      expect(
        (await api().post('/api/groups').set(auth(saToken)).send({ name: ' ' }))
          .status,
      ).toBe(400);
    });

    it('returns a group with explicit school and director fields only', async () => {
      const { saToken, g1 } = await fixture();
      const res = await api().get(`/api/groups/${g1.id}`).set(auth(saToken));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.directors[0]).sort()).toEqual(
        ['email', 'fullName', 'id', 'isActive', 'mustChangePassword'].sort(),
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

    it('creates a director who signs in with the password the super admin chose', async () => {
      const { saToken, g1 } = await fixture();
      const body = {
        email: 'director@test.local',
        password: 'Chosen@123',
        fullName: 'Dana Director',
      };
      const res = await api()
        .post(`/api/groups/${g1.id}/directors`)
        .set(auth(saToken))
        .send(body);
      expect(res.status).toBe(201);
      expect(res.body.director).toMatchObject({
        email: body.email,
        fullName: body.fullName,
        isActive: true,
        mustChangePassword: false,
      });
      expect(JSON.stringify(res.body)).not.toContain(body.password);

      const token = await loginToken(body.email, body.password);
      expect(
        (await api().get('/api/director/branches').set(auth(token))).status,
      ).toBe(200);

      const row = await prisma.user.findUniqueOrThrow({
        where: { email: body.email },
      });
      expect(row).toMatchObject({
        role: Role.DIRECTOR,
        groupId: g1.id,
        schoolId: null,
      });
    });

    it('validates the director body', async () => {
      const { saToken, g1, d1, a } = await fixture();
      const post = (body: object) =>
        api()
          .post(`/api/groups/${g1.id}/directors`)
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
      expect(
        (
          await api()
            .post('/api/groups/00000000-0000-4000-8000-000000000000/directors')
            .set(auth(saToken))
            .send({
              email: 'n@test.local',
              password: 'Chosen@123',
              fullName: 'N',
            })
        ).status,
      ).toBe(404);
    });

    it('audits group changes, with the branch on attach and detach', async () => {
      const { saToken, sa, g1, standalone } = await fixture();
      const created = await api()
        .post('/api/groups')
        .set(auth(saToken))
        .send({ name: 'Audited' });
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
        .post(`/api/groups/${g1.id}/directors`)
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
      const { g1, principalB, a } = await fixture();
      const teacher = await createTestUser({
        role: Role.TEACHER,
        schoolId: a.id,
      });
      for (const user of [principalB, teacher]) {
        const token = await tokenFor(app, user);
        const calls = [
          api().get('/api/groups'),
          api().get(`/api/groups/${g1.id}`),
          api().post('/api/groups').send({ name: 'X' }),
          api().patch(`/api/groups/${g1.id}`).send({ name: 'X' }),
          api().post(`/api/groups/${g1.id}/schools`).send({ schoolId: a.id }),
          api().delete(`/api/groups/${g1.id}/schools/${a.id}`),
          api().post(`/api/groups/${g1.id}/directors`).send({
            email: 'z@test.local',
            password: 'Chosen@123',
            fullName: 'Z',
          }),
        ];
        for (const call of calls) {
          expect((await call.set(auth(token))).status).toBe(403);
        }
      }
    });
  });
});
