import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { seedClass, addSecondSubject } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

describe('Section teachers (e2e)', () => {
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

  const assign = (
    token: string,
    sectionId: string,
    body: Record<string, unknown>,
  ) =>
    request(app.getHttpServer())
      .post(`/api/sections/${sectionId}/teachers`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('is idempotent per (section, teacher) — a teacher of two subjects keeps one roster row', async () => {
    const cls = await seedClass({ studentCount: 0 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);
    const teacherId = cls.teacherProfile.id;

    const first = await assign(token, cls.section.id, {
      teacherId,
      assignmentRole: 'Subject Teacher',
    });
    expect([200, 201]).toContain(first.status);

    // Same teacher assigned again (e.g. they teach a second subject) — no 409.
    const second = await assign(token, cls.section.id, {
      teacherId,
      assignmentRole: 'Subject Teacher',
    });
    expect([200, 201]).toContain(second.status);

    const rows = await prisma.sectionTeacher.findMany({
      where: { sectionId: cls.section.id, teacherId },
    });
    expect(rows).toHaveLength(1);
  });

  it('enforces a single class teacher — marking a new primary unsets the previous', async () => {
    const cls = await seedClass({ studentCount: 0 });
    const second = await addSecondSubject(cls.school, cls.section.id);
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const token = await tokenFor(app, admin);

    await assign(token, cls.section.id, {
      teacherId: cls.teacherProfile.id,
      isPrimary: true,
    });
    await assign(token, cls.section.id, {
      teacherId: second.otherTeacherProfile.id,
      isPrimary: true,
    });

    const primaries = await prisma.sectionTeacher.findMany({
      where: { sectionId: cls.section.id, isPrimary: true },
    });
    expect(primaries).toHaveLength(1);
    expect(primaries[0].teacherId).toBe(second.otherTeacherProfile.id);
  });
});
