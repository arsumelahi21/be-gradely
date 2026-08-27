import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * Audit logging (Phase 4.2): actions produce AuditLog rows with the right
 * actor/entity; viewer is admin-only and tenant-scoped.
 */
describe('Audit log (e2e)', () => {
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

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('records LOGIN and lets an admin see it (tenant-scoped)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });

    // A real login through the API produces a LOGIN audit row.
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: cls.teacherUser.email, password: 'Password@123' })
      .expect((r) => {
        if (![200, 201].includes(r.status)) {
          throw new Error(`login status ${r.status}`);
        }
      });

    const adminToken = await tokenFor(app, admin);
    const res = await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const login = res.body.items.find((i: any) => i.action === 'LOGIN');
    expect(login).toBeTruthy();
    expect(login.entityId).toBe(cls.teacherUser.id);
    expect(login.actor?.email).toBe(cls.teacherUser.email);
  });

  it('records USER_CREATE when an admin creates a user', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);

    await request(app.getHttpServer())
      .post('/api/users')
      .set(auth(adminToken))
      .send({
        email: `new-teacher-${Date.now()}@test.local`,
        password: 'Password@123',
        role: 'TEACHER',
        fullName: 'New Teacher',
        phone: '555-1',
      })
      .expect((r) => {
        if (![200, 201].includes(r.status)) {
          throw new Error(
            `create status ${r.status}: ${JSON.stringify(r.body)}`,
          );
        }
      });

    const res = await request(app.getHttpServer())
      .get('/api/audit-logs?action=USER_CREATE')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0].action).toBe('USER_CREATE');
  });

  it("does not leak another school's audit entries", async () => {
    const cls = await seedClass({ studentCount: 1 });
    // Generate an event in school A (a login).
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: cls.teacherUser.email, password: 'Password@123' });

    const otherSchool = await createTestSchool();
    const otherAdmin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: otherSchool.id,
    });
    const token = await tokenFor(app, otherAdmin);

    const res = await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set(auth(token));
    expect(res.status).toBe(200);
    // School B's admin sees none of school A's rows.
    expect(
      res.body.items.some((i: any) => i.actorUserId === cls.teacherUser.id),
    ).toBe(false);
  });

  it('is admin-only', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);
    const res = await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set(auth(token));
    expect(res.status).toBe(403);
  });
});
