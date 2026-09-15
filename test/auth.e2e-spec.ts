import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

const CREDENTIAL_FIELDS = /passwordHash|refreshTokenHash|resetToken/;

describe('Auth (e2e)', () => {
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

  // Bypasses the 5/min login throttle.
  async function refreshTokenFor(userId: string) {
    const token = await app
      .get(JwtService)
      .signAsync(
        { sub: userId },
        { secret: process.env.JWT_REFRESH_SECRET, expiresIn: '7d' },
      );
    await prisma.user.update({
      where: { id: userId },
      data: { refreshTokenHash: await bcrypt.hash(token, 10) },
    });
    return token;
  }

  it('valid credentials return access + refresh tokens', async () => {
    const school = await prisma.school.create({
      data: { name: 'S', code: `S${Date.now()}` },
    });
    const user = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: school.id,
      email: 'admin@login.test',
      password: 'Secret@12345',
    });

    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: user.email, password: 'Secret@12345' });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.role).toBe('SCHOOL_ADMIN');
    expect(JSON.stringify(res.body.user)).not.toMatch(CREDENTIAL_FIELDS);
  });

  it('wrong password is rejected with 401', async () => {
    await createTestUser({
      role: Role.STUDENT,
      email: 'wrongpw@login.test',
      password: 'Secret@12345',
    });

    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'wrongpw@login.test', password: 'not-the-password' });

    expect(res.status).toBe(401);
  });

  it('inactive user cannot log in', async () => {
    await createTestUser({
      role: Role.STUDENT,
      email: 'inactive@login.test',
      password: 'Secret@12345',
      isActive: false,
    });

    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'inactive@login.test', password: 'Secret@12345' });

    expect(res.status).toBe(401);
  });

  it('users of a suspended school cannot log in', async () => {
    const school = await createTestSchool({ isActive: false });
    const user = await createTestUser({
      role: Role.TEACHER,
      schoolId: school.id,
      password: 'Secret@12345',
    });

    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: user.email, password: 'Secret@12345' });

    expect(res.status).toBe(401);
  });

  it('refresh stops working once the user is deactivated, even after reactivation', async () => {
    const school = await createTestSchool();
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: school.id,
    });
    const user = await createTestUser({
      role: Role.TEACHER,
      schoolId: school.id,
    });
    const adminToken = await tokenFor(app, admin);
    const refresh = (refreshToken: string) =>
      request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken });
    const setActive = (isActive: boolean) =>
      request(app.getHttpServer())
        .patch(`/api/users/${user.id}/active`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive })
        .expect(200);

    const first = await refresh(await refreshTokenFor(user.id));
    expect(first.status).toBe(201);
    const { refreshToken } = first.body;

    await setActive(false);
    expect((await refresh(refreshToken)).status).toBe(403);

    await setActive(true);
    expect((await refresh(refreshToken)).status).toBe(403);
  });

  it("suspending a school revokes its users' refresh tokens, even after reactivation", async () => {
    const school = await createTestSchool();
    const superAdmin = await createTestUser({ role: Role.SUPER_ADMIN });
    const user = await createTestUser({
      role: Role.TEACHER,
      schoolId: school.id,
    });
    const token = await tokenFor(app, superAdmin);
    const setSchoolActive = (isActive: boolean) =>
      request(app.getHttpServer())
        .patch(`/api/schools/${school.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive })
        .expect(200);
    const refreshToken = await refreshTokenFor(user.id);

    await setSchoolActive(false);
    await setSchoolActive(true);

    const res = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken });
    expect(res.status).toBe(403);
  });

  it('a malformed refresh token is a 401, not a 500', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: 'not-a-jwt' });

    expect(res.status).toBe(401);
  });

  it('/auth/me requires a valid token', async () => {
    const noToken = await request(app.getHttpServer()).get('/api/auth/me');
    expect(noToken.status).toBe(401);

    const user = await createTestUser({
      role: Role.STUDENT,
      email: 'me@login.test',
    });
    const token = await tokenFor(app, user);

    const withToken = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(withToken.status).toBe(200);
    expect(withToken.body.email).toBe('me@login.test');
    expect(JSON.stringify(withToken.body)).not.toMatch(CREDENTIAL_FIELDS);
  });
});
