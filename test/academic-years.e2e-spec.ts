import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

describe('Academic years (e2e)', () => {
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

  const createYear = (token: string, code: string) =>
    request(app.getHttpServer())
      .post('/api/academic-years')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: code,
        code,
        startDate: '2027-04-01',
        endDate: '2028-03-31',
      });

  const adminTokenFor = async (schoolId: string) =>
    tokenFor(app, await createTestUser({ role: Role.SCHOOL_ADMIN, schoolId }));

  it('scopes the year code to one school (same code elsewhere is fine, a repeat is not)', async () => {
    const schoolA = await createTestSchool();
    const schoolB = await createTestSchool();
    const tokenA = await adminTokenFor(schoolA.id);
    const tokenB = await adminTokenFor(schoolB.id);

    expect((await createYear(tokenA, '2027-2028')).status).toBe(201);
    expect((await createYear(tokenB, '2027-2028')).status).toBe(201);
    expect((await createYear(tokenA, '2027-2028')).status).toBe(409);
  });
});
