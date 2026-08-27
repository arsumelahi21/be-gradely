import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

describe('Settings (e2e)', () => {
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

  it('requires authentication', async () => {
    const res = await request(app.getHttpServer()).get('/api/settings/me');
    expect(res.status).toBe(401);
  });

  it('returns defaults on first read and persists updates', async () => {
    const user = await createTestUser({ role: Role.STUDENT });
    const token = await tokenFor(app, user);

    const first = await request(app.getHttpServer())
      .get('/api/settings/me')
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      emailNotifications: true,
      notifyGrades: true,
      language: 'en',
      theme: 'system',
    });

    const patched = await request(app.getHttpServer())
      .patch('/api/settings/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        emailNotifications: false,
        theme: 'dark',
        notifyMessages: false,
      });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      emailNotifications: false,
      theme: 'dark',
      notifyMessages: false,
      notifyGrades: true, // untouched
    });

    // Persisted for the next read.
    const reread = await request(app.getHttpServer())
      .get('/api/settings/me')
      .set('Authorization', `Bearer ${token}`);
    expect(reread.body.emailNotifications).toBe(false);
    expect(reread.body.theme).toBe('dark');
  });

  it('scopes settings to the requesting user', async () => {
    const a = await createTestUser({ role: Role.STUDENT });
    const b = await createTestUser({ role: Role.TEACHER });
    const tokenA = await tokenFor(app, a);
    const tokenB = await tokenFor(app, b);

    await request(app.getHttpServer())
      .patch('/api/settings/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ language: 'fr' });

    const bSettings = await request(app.getHttpServer())
      .get('/api/settings/me')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(bSettings.body.language).toBe('en'); // B unaffected by A's change
  });
});
