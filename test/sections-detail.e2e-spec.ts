import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

// GET /api/sections/:id/detail collapses 3 per-section calls (subjects+teachers+enrollments) into one.
// These tests guard it returns the same data as the individual endpoints and stays tenant/role gated.
describe('Section detail (e2e)', () => {
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

  const ids = (arr: Array<{ id: string }>) => arr.map((x) => x.id).sort();

  it('returns the same subjects/teachers/enrollments as the 3 individual endpoints', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);
    const auth = { Authorization: `Bearer ${token}` };

    // Give the section a roster teacher so `teachers` is non-empty.
    await request(app.getHttpServer())
      .post(`/api/sections/${cls.section.id}/teachers`)
      .set(auth)
      .send({ teacherId: cls.teacherProfile.id, isPrimary: true });

    const server = request(app.getHttpServer());
    const [subjects, teachers, enrollments, detail] = await Promise.all([
      server.get(`/api/section-subjects?sectionId=${cls.section.id}`).set(auth),
      server.get(`/api/sections/${cls.section.id}/teachers`).set(auth),
      server.get(`/api/enrollments?sectionId=${cls.section.id}`).set(auth),
      server.get(`/api/sections/${cls.section.id}/detail`).set(auth),
    ]);

    expect(detail.status).toBe(200);
    expect(ids(detail.body.subjects)).toEqual(ids(subjects.body));
    expect(ids(detail.body.teachers)).toEqual(ids(teachers.body));
    expect(ids(detail.body.enrollments)).toEqual(ids(enrollments.body));
    expect(detail.body.enrollments).toHaveLength(2);
    expect(detail.body.teachers).toHaveLength(1);
  });

  it('rejects cross-school access (tenant scope)', async () => {
    const cls = await seedClass({ studentCount: 0 });
    const otherSchool = await createTestSchool();
    const otherSchoolAdmin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: otherSchool.id,
    });
    const token = await tokenFor(app, otherSchoolAdmin);

    const res = await request(app.getHttpServer())
      .get(`/api/sections/${cls.section.id}/detail`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('rejects non-admin roles', async () => {
    const cls = await seedClass({ studentCount: 0 });
    const token = await tokenFor(app, cls.teacherUser);

    const res = await request(app.getHttpServer())
      .get(`/api/sections/${cls.section.id}/detail`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
