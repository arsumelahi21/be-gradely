import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

const DAY = 86_400_000;

describe('Director principals (e2e)', () => {
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

  async function fixture() {
    const [a, b, foreign] = await Promise.all(
      ['Alpha', 'Bravo', 'Delta'].map((name) => createTestSchool({ name })),
    );
    const principal = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: a.id,
      fullName: 'Pat Principal',
    });
    await prisma.user.update({
      where: { id: principal.id },
      data: { phone: '0300-1234567' },
    });
    await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: a.id,
      fullName: 'Old Principal',
      isActive: false,
    });
    await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: foreign.id,
      fullName: 'Not Ours',
    });
    await prisma.auditLog.createMany({
      data: [10, 3].map((days) => ({
        actorUserId: principal.id,
        schoolId: a.id,
        action: 'LOGIN',
        metadata: { note: 'secret-xyz' },
        createdAt: new Date(Date.now() - days * DAY),
      })),
    });

    const group = await prisma.schoolGroup.create({ data: { name: 'G' } });
    await prisma.school.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { groupId: group.id },
    });
    const director = await createTestUser({
      role: Role.DIRECTOR,
      groupId: group.id,
    });
    const login = await api()
      .post('/api/auth/login')
      .send({ email: director.email, password: director.password });
    return { a, b, principal, token: login.body.accessToken as string };
  }

  it('lists only the group principals, with their last sign-in and nothing more', async () => {
    const { a, b, principal, token } = await fixture();
    const res = await api()
      .get('/api/director/principals')
      .set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);

    const alpha = res.body.branches.find((r: any) => r.schoolId === a.id).data
      .principals;
    expect(alpha.map((p: any) => [p.fullName, p.isActive])).toEqual([
      ['Pat Principal', true],
      ['Old Principal', false],
    ]);
    expect(Object.keys(alpha[0]).sort()).toEqual(
      [
        'daysSinceLogin',
        'email',
        'fullName',
        'id',
        'isActive',
        'lastLoginAt',
      ].sort(),
    );
    expect(alpha[0]).toMatchObject({
      email: principal.email,
      daysSinceLogin: 3,
    });
    expect(
      res.body.branches.find((r: any) => r.schoolId === b.id).data.principals,
    ).toEqual([]);
    // Bravo has no principal; nobody active is quiet for 14+ days.
    expect(res.body.group).toEqual({
      principals: 1,
      branchesWithoutPrincipal: 1,
      quiet: 0,
    });

    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/Not Ours|0300-1234567|secret-xyz|passwordHash/);
  });

  it('is read-only and for directors only', async () => {
    const { a, principal, token } = await fixture();
    const asDirector = (method: 'post' | 'patch' | 'delete', path: string) =>
      api()
        [method](path)
        .set({ Authorization: `Bearer ${token}` })
        .send({});
    expect((await asDirector('post', '/api/director/principals')).status).toBe(
      404,
    );
    expect(
      (await asDirector('patch', `/api/users/${principal.id}/active`)).status,
    ).toBe(403);
    expect(
      (await asDirector('post', `/api/users/${principal.id}/password-reset`))
        .status,
    ).toBe(403);

    const principalToken = await tokenFor(app, principal);
    expect(
      (
        await api()
          .get(`/api/director/principals?branch=${a.id}`)
          .set({ Authorization: `Bearer ${principalToken}` })
      ).status,
    ).toBe(403);
  });
});
