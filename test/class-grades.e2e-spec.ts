import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

/**
 * Covers the class-level default fee: a form default for admissions, applying
 * to every section of the class. It never bills anything on its own — the
 * student's own `monthlyFeeAmount` stays the figure challans are built from.
 */
describe('Class grade default monthly fee (e2e)', () => {
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

  async function seedAdmin() {
    const school = await createTestSchool();
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: school.id,
    });
    return { school, admin, token: await tokenFor(app, admin) };
  }

  const createBody = (overrides: Record<string, unknown> = {}) => ({
    name: `Grade-${uniq()}`,
    code: `G${uniq()}`.slice(0, 12),
    ...overrides,
  });

  it('stores the default fee on create and returns it', async () => {
    const { token } = await seedAdmin();

    const res = await request(app.getHttpServer())
      .post('/api/class-grades')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody({ defaultMonthlyFee: 500000 }))
      .expect(201);

    expect(res.body.defaultMonthlyFee).toBe(500000);
  });

  it('leaves it unset when omitted, so a class without a default is distinguishable', async () => {
    const { token } = await seedAdmin();

    const res = await request(app.getHttpServer())
      .post('/api/class-grades')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody())
      .expect(201);

    expect(res.body.defaultMonthlyFee).toBeNull();
  });

  it('keeps 0 as a real free default, not as "unset"', async () => {
    const { token } = await seedAdmin();

    const res = await request(app.getHttpServer())
      .post('/api/class-grades')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody({ defaultMonthlyFee: 0 }))
      .expect(201);

    expect(res.body.defaultMonthlyFee).toBe(0);
    expect(res.body.defaultMonthlyFee).not.toBeNull();
  });

  it('updates the default, and an explicit null clears it', async () => {
    const { token } = await seedAdmin();
    const created = await request(app.getHttpServer())
      .post('/api/class-grades')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody({ defaultMonthlyFee: 500000 }))
      .expect(201);

    const raised = await request(app.getHttpServer())
      .patch(`/api/class-grades/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ defaultMonthlyFee: 750000 })
      .expect(200);
    expect(raised.body.defaultMonthlyFee).toBe(750000);

    const cleared = await request(app.getHttpServer())
      .patch(`/api/class-grades/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ defaultMonthlyFee: null })
      .expect(200);
    expect(cleared.body.defaultMonthlyFee).toBeNull();
  });

  it('leaves the default alone when the patch does not mention it', async () => {
    const { token } = await seedAdmin();
    const created = await request(app.getHttpServer())
      .post('/api/class-grades')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody({ defaultMonthlyFee: 500000 }))
      .expect(201);

    const renamed = await request(app.getHttpServer())
      .patch(`/api/class-grades/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Renamed only' })
      .expect(200);

    expect(renamed.body.defaultMonthlyFee).toBe(500000);
  });

  it.each([-1, 12.5, 'free'])('rejects %s as a default fee', async (value) => {
    const { token } = await seedAdmin();

    await request(app.getHttpServer())
      .post('/api/class-grades')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody({ defaultMonthlyFee: value }))
      .expect(400);
  });

  it('is visible on the list every admission form reads', async () => {
    const { school, token } = await seedAdmin();
    await request(app.getHttpServer())
      .post('/api/class-grades')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody({ defaultMonthlyFee: 250000 }))
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/class-grades')
      .query({ schoolId: school.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const list = Array.isArray(res.body) ? res.body : res.body.items;
    expect(list).toHaveLength(1);
    expect(list[0].defaultMonthlyFee).toBe(250000);
  });

  it("refuses to change another school's class", async () => {
    const { token } = await seedAdmin();
    const created = await request(app.getHttpServer())
      .post('/api/class-grades')
      .set('Authorization', `Bearer ${token}`)
      .send(createBody({ defaultMonthlyFee: 500000 }))
      .expect(201);

    const other = await createTestSchool();
    const intruder = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: other.id,
    });
    const intruderToken = await tokenFor(app, intruder);

    await request(app.getHttpServer())
      .patch(`/api/class-grades/${created.body.id}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ defaultMonthlyFee: 1 })
      .expect(403);

    const untouched = await prisma.classGrade.findUnique({
      where: { id: created.body.id },
    });
    expect(untouched?.defaultMonthlyFee).toBe(500000);
  });
});

/**
 * Class level: the ladder position that orders classes and their sections
 * everywhere. PG/Nursery/Prep take the negative slots so numeric grades can map
 * to their own number, which is what keeps `ORDER BY level` correct.
 */
describe('Class level ordering (e2e)', () => {
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

  async function seedAdmin() {
    const school = await createTestSchool();
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: school.id,
    });
    return { school, admin, token: await tokenFor(app, admin) };
  }

  /** Created deliberately out of order, so insertion order cannot fake a pass. */
  async function seedLadder(schoolId: string) {
    const spec: Array<[string, number | null]> = [
      ['Ten', 10],
      ['PG', -3],
      ['Two', 2],
      ['Prep', -1],
      ['Unset', null],
      ['Nursery', -2],
      ['One', 1],
    ];
    for (const [name, level] of spec) {
      const grade = await prisma.classGrade.create({
        data: { schoolId, name, level },
      });
      await prisma.section.create({
        data: { schoolId, classGradeId: grade.id, name: 'A' },
      });
    }
  }

  it('accepts every level on the ladder and rejects anything else', async () => {
    const { token } = await seedAdmin();

    for (const level of [-3, -2, -1, 1, 5, 10]) {
      await request(app.getHttpServer())
        .post('/api/class-grades')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `C-${uniq()}`, code: `C${uniq()}`.slice(0, 12), level })
        .expect(201);
    }

    // 11 and 0 are not rungs; neither is a string.
    for (const level of [0, 11, 'five']) {
      await request(app.getHttpServer())
        .post('/api/class-grades')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `C-${uniq()}`, code: `C${uniq()}`.slice(0, 12), level })
        .expect(400);
    }
  });

  it('lists classes in ladder order, with unlevelled ones last', async () => {
    const { school, token } = await seedAdmin();
    await seedLadder(school.id);

    const res = await request(app.getHttpServer())
      .get('/api/class-grades')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const names = (Array.isArray(res.body) ? res.body : res.body.items).map(
      (c: { name: string }) => c.name,
    );
    expect(names).toEqual([
      'PG',
      'Nursery',
      'Prep',
      'One',
      'Two',
      'Ten',
      'Unset',
    ]);
  });

  it('orders sections by their class level, not by creation date', async () => {
    const { school, token } = await seedAdmin();
    await seedLadder(school.id);

    const res = await request(app.getHttpServer())
      .get('/api/sections')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const classes = (Array.isArray(res.body) ? res.body : res.body.items).map(
      (s: { classGradeId: string }) => s.classGradeId,
    );
    const grades = await prisma.classGrade.findMany({
      where: { schoolId: school.id },
      select: { id: true, name: true },
    });
    const nameById = new Map(grades.map((g) => [g.id, g.name]));
    expect(classes.map((id: string) => nameById.get(id))).toEqual([
      'PG',
      'Nursery',
      'Prep',
      'One',
      'Two',
      'Ten',
      'Unset',
    ]);
  });

  it('orders the timetable overview the same way', async () => {
    const { school, token } = await seedAdmin();
    await prisma.academicYear.create({
      data: {
        schoolId: school.id,
        name: `Y-${uniq()}`,
        code: `Y${uniq()}`,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        isActive: true,
      },
    });
    await seedLadder(school.id);

    const res = await request(app.getHttpServer())
      .get('/api/timetable/overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(
      res.body.sections.map((r: { className: string }) => r.className),
    ).toEqual(['PG', 'Nursery', 'Prep', 'One', 'Two', 'Ten', 'Unset']);
  });

  it('keeps -3 (PG) on an update — it must not be read as falsy', async () => {
    const { school, token } = await seedAdmin();
    const grade = await prisma.classGrade.create({
      data: { schoolId: school.id, name: `C-${uniq()}`, level: 5 },
    });

    await request(app.getHttpServer())
      .patch(`/api/class-grades/${grade.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ level: -3 })
      .expect(200);

    expect(
      (await prisma.classGrade.findUnique({ where: { id: grade.id } }))?.level,
    ).toBe(-3);
  });
});
