import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser } from './utils/factories';
import { Role } from '../src/common/types/role.type';

const DAY = 86_400_000;

// Adoption: of each role's active accounts, how many signed in during the window.
describe('Director activity insights (e2e)', () => {
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

  it('counts sign-ins in the window over active accounts, per role', async () => {
    const a = await createTestSchool({ name: 'Alpha' });
    const user = (role: Role, isActive = true) =>
      createTestUser({ role, schoolId: a.id, isActive });
    const [t1, , p1, gone] = await Promise.all([
      user(Role.TEACHER),
      user(Role.TEACHER),
      user(Role.PARENT),
      user(Role.STUDENT, false),
    ]);
    await prisma.auditLog.createMany({
      data: [
        { actor: t1.id, days: 3 },
        { actor: p1.id, days: 40 },
        { actor: gone.id, days: 2 },
      ].map(({ actor, days }) => ({
        actorUserId: actor,
        schoolId: a.id,
        action: 'LOGIN',
        createdAt: new Date(Date.now() - days * DAY),
      })),
    });
    const group = await prisma.schoolGroup.create({ data: { name: 'G' } });
    await prisma.school.update({
      where: { id: a.id },
      data: { groupId: group.id },
    });
    const director = await createTestUser({
      role: Role.DIRECTOR,
      groupId: group.id,
    });
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: director.email, password: director.password });

    const res = await request(app.getHttpServer())
      .get('/api/director/insights/activity')
      .set({ Authorization: `Bearer ${login.body.accessToken}` });
    expect(res.status).toBe(200);
    expect(res.body.branches[0].data).toEqual({
      teachers: { num: 1, den: 2, value: 0.5 },
      // The parent last signed in 40 days ago, outside the default 30 days.
      parents: { num: 0, den: 1, value: 0 },
      // A deactivated student is not an active account.
      students: { num: 0, den: 0, value: null },
    });
    expect(res.body.group.teachers.value).toBe(0.5);
  });
});
