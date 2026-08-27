import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';
import * as bcrypt from 'bcrypt';

/**
 * PATCH /users/me — self-edit; immutable identifiers (rollNo, admissionNo,
 * dateOfJoining, userCode) are rejected here, unlike admin PATCH /users/:id.
 */
describe('Self profile update (e2e)', () => {
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

  const patchMe = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('lets a teacher edit their own editable fields', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);

    const res = await patchMe(token, {
      fullName: 'Ms. Updated',
      city: 'Lisbon',
    });
    expect(res.status).toBe(200);

    const profile = await prisma.teacherProfile.findFirst({
      where: { userId: cls.teacherUser.id },
    });
    expect(profile?.fullName).toBe('Ms. Updated');
    expect(profile?.city).toBe('Lisbon');
  });

  it('lets a student edit their own editable fields', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.students[0].user);

    const res = await patchMe(token, { bloodGroup: 'O+', gender: 'MALE' });
    expect(res.status).toBe(200);

    const p = await prisma.studentProfile.findUnique({
      where: { id: cls.students[0].profile.id },
    });
    expect(p?.bloodGroup).toBe('O+');
    expect(p?.gender).toBe('MALE');
  });

  it('rejects immutable identifiers on self-update (DTO whitelist)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.students[0].user);

    expect((await patchMe(token, { rollNo: 'HACK-1' })).status).toBe(400);
    expect((await patchMe(token, { admissionNo: 'HACK-2' })).status).toBe(400);
    expect((await patchMe(token, { dateOfJoining: '2020-01-01' })).status).toBe(
      400,
    );
    expect((await patchMe(token, { userCode: 'HACK-3' })).status).toBe(400);

    const p = await prisma.studentProfile.findUnique({
      where: { id: cls.students[0].profile.id },
    });
    expect(p?.rollNo).not.toBe('HACK-1');
  });

  it('lets a school-admin edit their OWN profile (self is allowed)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);

    const res = await patchMe(token, { fullName: 'Principal X', phone: '999' });
    expect(res.status).toBe(200);

    const u = await prisma.user.findUnique({ where: { id: admin.id } });
    expect(u?.fullName).toBe('Principal X');
    expect(u?.phone).toBe('999');
  });

  it('rejects an unauthenticated self-update', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/users/me')
      .send({ fullName: 'X' });
    expect(res.status).toBe(401);
  });

  // PATCH /users/me/password — self-service change; verifies the current password.
  const changePw = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch('/api/users/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('changes the password when the current one is correct (and nulls refresh)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    await prisma.user.update({
      where: { id: admin.id },
      data: { refreshTokenHash: 'stale' },
    });
    const token = await tokenFor(app, admin);

    const res = await changePw(token, {
      currentPassword: admin.password,
      newPassword: 'NewPass@456',
    });
    expect(res.status).toBe(200);

    const u = await prisma.user.findUnique({ where: { id: admin.id } });
    expect(await bcrypt.compare('NewPass@456', u!.passwordHash)).toBe(true);
    expect(u?.refreshTokenHash).toBeNull();
  });

  it('rejects a wrong current password and leaves it unchanged', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);

    const res = await changePw(token, {
      currentPassword: 'WrongPass@000',
      newPassword: 'NewPass@456',
    });
    expect(res.status).toBe(400);

    const u = await prisma.user.findUnique({ where: { id: admin.id } });
    expect(await bcrypt.compare(admin.password, u!.passwordHash)).toBe(true);
  });

  it('rejects a too-short new password (min 8)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);

    const res = await changePw(token, {
      currentPassword: admin.password,
      newPassword: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unauthenticated password change', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/users/me/password')
      .send({ currentPassword: 'x', newPassword: 'NewPass@456' });
    expect(res.status).toBe(401);
  });
});
