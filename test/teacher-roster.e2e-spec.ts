import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';

describe('Teacher roster (e2e)', () => {
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

  it('gives a teacher the roster fields but not the student’s personal data', async () => {
    const cls = await seedClass({ studentCount: 1 });
    await prisma.studentProfile.update({
      where: { id: cls.students[0].profile.id },
      data: {
        rollNo: 'R-42',
        nationalId: '35201-1234567-8',
        guardianPhone: '0300-7654321',
        whatsapp: '0300-1111111',
        city: 'Lahore',
        prevInstituteName: 'Old School',
      },
    });
    const teacherToken = await tokenFor(app, cls.teacherUser);

    const res = await request(app.getHttpServer())
      .get(`/api/teachers/${cls.teacherProfile.id}/students`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);

    const body = JSON.stringify(res.body);
    // Non-vacuous: the roster still has to carry what the teacher screen renders.
    expect(body).toContain('R-42');
    expect(body).not.toMatch(
      /35201-1234567-8|0300-7654321|0300-1111111|Lahore|Old School/,
    );
  });

  it('paginates the roster when page is supplied', async () => {
    const cls = await seedClass({ studentCount: 3 });
    const teacherToken = await tokenFor(app, cls.teacherUser);

    const res = await request(app.getHttpServer())
      .get(`/api/teachers/${cls.teacherProfile.id}/students`)
      .query({ page: 1, pageSize: 2 })
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);

    expect(res.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(res.body.items).toHaveLength(2);
  });

  it('returns a plain array when no page is supplied', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const teacherToken = await tokenFor(app, cls.teacherUser);

    const res = await request(app.getHttpServer())
      .get(`/api/teachers/${cls.teacherProfile.id}/students`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });
});
