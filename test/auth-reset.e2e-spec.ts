import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser } from './utils/factories';
import { Role } from '../src/common/types/role.type';

describe('Password reset (e2e)', () => {
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

  /** Arrange a user with a known raw reset token (hash stored, future expiry). */
  async function userWithResetToken(overrides?: { expired?: boolean }) {
    const user = await createTestUser({
      role: Role.STUDENT,
      email: 'reset@test.local',
      password: 'OldPassword@1',
    });
    const rawToken = 'known-raw-reset-token';
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetTokenHash: await bcrypt.hash(rawToken, 10),
        resetTokenExpiresAt: new Date(
          Date.now() + (overrides?.expired ? -1000 : 60 * 60 * 1000),
        ),
      },
    });
    return { user, token: `${user.id}.${rawToken}` };
  }

  it('forgot-password returns the same response for existing and unknown emails', async () => {
    await createTestUser({ role: Role.STUDENT, email: 'exists@test.local' });

    const known = await request(app.getHttpServer())
      .post('/api/auth/forgot-password')
      .send({ email: 'exists@test.local' });
    const unknown = await request(app.getHttpServer())
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@test.local' });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);

    // But a token was only actually issued for the real account.
    const realUser = await prisma.user.findUnique({
      where: { email: 'exists@test.local' },
    });
    expect(realUser?.resetTokenHash).toBeTruthy();
  });

  it('resets the password with a valid token, then lets the user log in', async () => {
    const { token } = await userWithResetToken();

    const reset = await request(app.getHttpServer())
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'BrandNew@123' });
    expect(reset.status).toBe(201);

    // Old password no longer works; new one does.
    const oldLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'reset@test.local', password: 'OldPassword@1' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'reset@test.local', password: 'BrandNew@123' });
    expect(newLogin.status).toBe(201);
  });

  it('rejects an expired token', async () => {
    const { token } = await userWithResetToken({ expired: true });
    const res = await request(app.getHttpServer())
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'BrandNew@123' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid token', async () => {
    await userWithResetToken();
    const res = await request(app.getHttpServer())
      .post('/api/auth/reset-password')
      .send({ token: 'not-a-real.token', newPassword: 'BrandNew@123' });
    expect(res.status).toBe(400);
  });

  it('rejects a reused token (single-use)', async () => {
    const { token } = await userWithResetToken();
    const first = await request(app.getHttpServer())
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'BrandNew@123' });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'Another@123' });
    expect(second.status).toBe(400);
  });
});
