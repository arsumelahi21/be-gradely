import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

/**
 * Scoping guard for GET /api/search: a non-admin only sees reachable people
 * (no classmates, no non-linked students) — assertions check foreign ids are ABSENT.
 */
describe('Search scoping (e2e)', () => {
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

  const search = async (token: string, q: string) => {
    const res = await request(app.getHttpServer())
      .get('/api/search')
      .query({ q })
      .set('Authorization', `Bearer ${token}`);
    return res;
  };
  const userIds = (body: any): string[] =>
    (body.results ?? [])
      .filter((r: any) => r.kind === 'user')
      .map((r: any) => r.id);

  it('lets a teacher find their own-section students', async () => {
    const cls = await seedClass({ studentCount: 2 });
    // A student in a DIFFERENT school the teacher must never see.
    const foreign = await seedClass({ studentCount: 1 });
    const token = await tokenFor(app, cls.teacherUser);

    const res = await search(token, 'Student');
    expect(res.status).toBe(200);
    const ids = userIds(res.body);
    expect(ids).toContain(cls.students[0].user.id);
    expect(ids).toContain(cls.students[1].user.id);
    expect(ids).not.toContain(foreign.students[0].user.id);
  });

  it('shows a student their teacher but NOT their classmates', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const token = await tokenFor(app, cls.students[0].user);

    // Classmate name search returns no people (classmates are excluded).
    const peers = await search(token, 'Student');
    expect(peers.status).toBe(200);
    expect(userIds(peers.body)).not.toContain(cls.students[1].user.id);

    // But the section's teacher is reachable.
    const teachers = await search(token, 'Teacher');
    expect(userIds(teachers.body)).toContain(cls.teacherUser.id);
  });

  it('shows a parent their linked child but NOT a non-linked student', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const parentUser = await createTestUser({
      role: Role.PARENT,
      schoolId: cls.school.id,
    });
    const parent = await prisma.parentProfile.create({
      data: { userId: parentUser.id, fullName: 'Parent' },
    });
    await prisma.parentStudent.create({
      data: { parentId: parent.id, studentId: cls.students[0].profile.id },
    });
    const token = await tokenFor(app, parentUser);

    const res = await search(token, 'Student');
    const ids = userIds(res.body);
    expect(ids).toContain(cls.students[0].user.id); // their child
    expect(ids).not.toContain(cls.students[1].user.id); // someone else's child
  });
});
