import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

// A fresh app per test: /auth/login is capped at 5/min per IP and every request
// here comes from the same address.
describe('Admin-issued password reset (e2e)', () => {
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
  const login = (email: string, password: string) =>
    api().post('/api/auth/login').send({ email, password });

  async function school() {
    const s = await createTestSchool();
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: s.id,
    });
    const student = await createTestUser({
      role: Role.STUDENT,
      schoolId: s.id,
    });
    return { s, admin, student, adminToken: await tokenFor(app, admin) };
  }

  const reset = (userId: string, token: string) =>
    api()
      .post(`/api/users/${userId}/password-reset`)
      .set('Authorization', `Bearer ${token}`);

  it('issues a one-time password that replaces the old one', async () => {
    const { student, adminToken } = await school();

    const res = await reset(student.id, adminToken);
    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword).toMatch(
      /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/,
    );

    expect((await login(student.email, student.password)).status).toBe(401);
    expect(
      (await login(student.email, res.body.temporaryPassword)).status,
    ).toBe(201);
  });

  it('confines the temporary session to setting a new password', async () => {
    const { student, adminToken } = await school();
    const { body } = await reset(student.id, adminToken);
    const signIn = await login(student.email, body.temporaryPassword);
    const auth = `Bearer ${signIn.body.accessToken}`;

    expect(
      (await api().get('/api/users/me').set('Authorization', auth)).status,
    ).toBe(403);
    // Reachable, or the app cannot render the change-password screen.
    expect(
      (await api().get('/api/auth/me').set('Authorization', auth)).status,
    ).toBe(200);

    const changed = await api()
      .patch('/api/users/me/password')
      .set('Authorization', auth)
      .send({
        currentPassword: body.temporaryPassword,
        newPassword: 'Chosen@12345',
      });
    expect(changed.status).toBe(200);

    const after = await login(student.email, 'Chosen@12345');
    expect(
      (
        await api()
          .get('/api/users/me')
          .set('Authorization', `Bearer ${after.body.accessToken}`)
      ).status,
    ).toBe(200);
  });

  it('logs the holder out of sessions opened with the old password', async () => {
    const { student, adminToken } = await school();
    const before = await login(student.email, student.password);

    await reset(student.id, adminToken);

    const refreshed = await api()
      .post('/api/auth/refresh')
      .send({ refreshToken: before.body.refreshToken });
    expect(refreshed.status).toBe(403);
  });

  it('does not reach into another school', async () => {
    const { adminToken } = await school();
    const other = await createTestSchool();
    const outsider = await createTestUser({
      role: Role.STUDENT,
      schoolId: other.id,
    });

    // 404, not 403 — a 403 would confirm the id exists.
    expect((await reset(outsider.id, adminToken)).status).toBe(404);
  });

  it('is closed to teachers', async () => {
    const { s, student } = await school();
    const teacher = await createTestUser({
      role: Role.TEACHER,
      schoolId: s.id,
    });

    expect((await reset(student.id, await tokenFor(app, teacher))).status).toBe(
      403,
    );
  });

  it('refuses to reset the caller, who has Change password instead', async () => {
    const { admin, adminToken } = await school();

    expect((await reset(admin.id, adminToken)).status).toBe(400);
  });
});
