import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('User avatar (self-service, e2e)', () => {
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

  const uploadPhoto = (token: string, buf = PNG, contentType = 'image/png') =>
    request(app.getHttpServer())
      .post('/api/users/me/photo')
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', buf, { filename: 'a.png', contentType });

  it('lets ANY role upload their own avatar and serves it back + flags /me', async () => {
    const school = await createTestSchool();
    const teacher = await createTestUser({
      role: Role.TEACHER,
      schoolId: school.id,
    });
    const token = await tokenFor(app, teacher);

    expect((await uploadPhoto(token)).status).toBe(201);

    const fetched = await request(app.getHttpServer())
      .get('/api/users/me/photo')
      .set('Authorization', `Bearer ${token}`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers['content-type']).toContain('image/png');
    expect(fetched.body.length).toBeGreaterThan(0);

    const me = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${token}`);
    expect(me.body.photoMimeType).toBe('image/png');
  });

  it('works the same for a SCHOOL_ADMIN and a PARENT', async () => {
    const school = await createTestSchool();
    for (const role of [Role.SCHOOL_ADMIN, Role.PARENT]) {
      const u = await createTestUser({ role, schoolId: school.id });
      const token = await tokenFor(app, u);
      expect((await uploadPhoto(token)).status).toBe(201);
      const got = await request(app.getHttpServer())
        .get('/api/users/me/photo')
        .set('Authorization', `Bearer ${token}`);
      expect(got.status).toBe(200);
    }
  });

  it('a same-school user can read another user’s avatar via /users/:id/photo', async () => {
    const school = await createTestSchool();
    const teacher = await createTestUser({
      role: Role.TEACHER,
      schoolId: school.id,
    });
    const student = await createTestUser({
      role: Role.STUDENT,
      schoolId: school.id,
    });
    const teacherToken = await tokenFor(app, teacher);
    const studentToken = await tokenFor(app, student);

    expect((await uploadPhoto(teacherToken)).status).toBe(201);

    const cross = await request(app.getHttpServer())
      .get(`/api/users/${teacher.id}/photo`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(cross.status).toBe(200);
    expect(cross.headers['content-type']).toContain('image/png');
  });

  it('DENIES reading a photo across schools (403), but a SUPER_ADMIN may', async () => {
    const schoolA = await createTestSchool();
    const schoolB = await createTestSchool();
    const teacherA = await createTestUser({
      role: Role.TEACHER,
      schoolId: schoolA.id,
    });
    const outsider = await createTestUser({
      role: Role.TEACHER,
      schoolId: schoolB.id,
    });
    const superAdmin = await createTestUser({ role: Role.SUPER_ADMIN });

    const aToken = await tokenFor(app, teacherA);
    expect((await uploadPhoto(aToken)).status).toBe(201);

    const denied = await request(app.getHttpServer())
      .get(`/api/users/${teacherA.id}/photo`)
      .set('Authorization', `Bearer ${await tokenFor(app, outsider)}`);
    expect(denied.status).toBe(403);

    const allowed = await request(app.getHttpServer())
      .get(`/api/users/${teacherA.id}/photo`)
      .set('Authorization', `Bearer ${await tokenFor(app, superAdmin)}`);
    expect(allowed.status).toBe(200);
  });

  it('returns 404 for a user who has no avatar', async () => {
    const school = await createTestSchool();
    const a = await createTestUser({ role: Role.TEACHER, schoolId: school.id });
    const b = await createTestUser({ role: Role.STUDENT, schoolId: school.id });
    const res = await request(app.getHttpServer())
      .get(`/api/users/${a.id}/photo`)
      .set('Authorization', `Bearer ${await tokenFor(app, b)}`);
    expect(res.status).toBe(404);
  });

  it('DELETE /me/photo removes it (200 -> then 404 + photoMimeType null)', async () => {
    const school = await createTestSchool();
    const u = await createTestUser({ role: Role.TEACHER, schoolId: school.id });
    const token = await tokenFor(app, u);

    expect((await uploadPhoto(token)).status).toBe(201);

    const del = await request(app.getHttpServer())
      .delete('/api/users/me/photo')
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);

    const gone = await request(app.getHttpServer())
      .get('/api/users/me/photo')
      .set('Authorization', `Bearer ${token}`);
    expect(gone.status).toBe(404);

    const me = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${token}`);
    expect(me.body.photoMimeType ?? null).toBeNull();
  });

  it('rejects a non-image upload (400)', async () => {
    const school = await createTestSchool();
    const u = await createTestUser({ role: Role.TEACHER, schoolId: school.id });
    const token = await tokenFor(app, u);
    const res = await uploadPhoto(
      token,
      Buffer.from('not an image'),
      'text/plain',
    );
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated access (401)', async () => {
    expect(
      (await request(app.getHttpServer()).get('/api/users/me/photo')).status,
    ).toBe(401);
    expect(
      (await request(app.getHttpServer()).post('/api/users/me/photo')).status,
    ).toBe(401);
  });
});
