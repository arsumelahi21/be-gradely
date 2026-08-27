import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

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
  });
});
