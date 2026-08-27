import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * Consolidated dashboard endpoints (school-overview / admin-overview) replacing
 * per-portal fan-out; must match individual endpoints, stay tenant-scoped and role-gated.
 */
describe('Dashboard overview endpoints (e2e)', () => {
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

  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`);

  it('school-overview equals the individual endpoints + returns counts/recent', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);

    const ov = await get('/api/dashboard/school-overview', token).expect(200);
    const [stats, exams, assign, att] = await Promise.all([
      get('/api/dashboard/school-stats', token).expect(200),
      get('/api/exams/school/stats', token).expect(200),
      get('/api/assignments/school/stats', token).expect(200),
      get('/api/attendance/school/summary', token).expect(200),
    ]);

    expect(ov.body.stats).toEqual(stats.body);
    expect(ov.body.exams).toEqual(exams.body);
    expect(ov.body.assignments).toEqual(assign.body);
    expect(ov.body.attendance).toEqual(att.body);

    expect(ov.body.counts.students).toBe(2);
    expect(ov.body.counts.teachers).toBe(1);
    expect(ov.body.recent.students).toHaveLength(2);
    expect(Array.isArray(ov.body.recent.classes)).toBe(true);
  });

  it('school-overview is tenant-scoped (never leaks another school)', async () => {
    await seedClass({ studentCount: 2 }); // school A with 2 students
    const other = await createTestSchool();
    const otherAdmin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: other.id,
    });
    const token = await tokenFor(app, otherAdmin);

    const ov = await get('/api/dashboard/school-overview', token).expect(200);
    expect(ov.body.counts.students).toBe(0);
    expect(ov.body.recent.students).toEqual([]);
  });

  it('school-overview rejects a teacher (admins only)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);
    await get('/api/dashboard/school-overview', token).expect(403);
  });

  it('admin-overview returns schools + cross-school counts, super-admin only', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const superAdmin = await createTestUser({ role: Role.SUPER_ADMIN });
    const token = await tokenFor(app, superAdmin);

    const ov = await get('/api/dashboard/admin-overview', token).expect(200);
    expect(Array.isArray(ov.body.schools)).toBe(true);
    expect(ov.body.schools.length).toBeGreaterThanOrEqual(1);
    expect(ov.body.counts.students).toBe(2); // cross-school total

    // a school admin must not reach it
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);
    await get('/api/dashboard/admin-overview', adminToken).expect(403);
  });

  it('refreshes the cached overview when a user is created (invalidation on write)', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);

    // Prime the 60s-cached overview envelope.
    const first = await get('/api/dashboard/school-overview', token).expect(
      200,
    );
    expect(first.body.counts.students).toBe(2);

    // Create a student through the live path — invalidateRoleCache must clear
    // the cached overview, or the next read would still report the stale 2.
    const rnd = Math.random().toString(36).slice(2);
    await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: `student-${rnd}@ghs.test`,
        password: 'Student@123',
        role: 'STUDENT',
        fullName: 'New Student',
        gender: 'MALE',
        dob: '2012-05-01',
        dateOfJoining: '2026-01-10',
        city: 'Springfield',
        state: 'Illinois',
        country: 'United States',
        // Mandatory at admission since the fee module landed.
        monthlyFeeAmount: 500000,
        newParent: {
          fullName: 'Guardian',
          email: `parent-${rnd}@ghs.test`,
          password: 'Parent@123',
          phone: '5550100',
          phoneDialCode: '+1',
        },
        relationship: 'GUARDIAN',
      })
      .expect(201);

    const second = await get('/api/dashboard/school-overview', token).expect(
      200,
    );
    expect(second.body.counts.students).toBe(3);
  });
});
