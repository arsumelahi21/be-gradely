import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

describe('Parent fee statement (e2e)', () => {
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

  const http = () => request(app.getHttpServer());

  async function seedSchool() {
    const school = await createTestSchool();
    const year = (name: string) =>
      prisma.academicYear.create({
        data: {
          schoolId: school.id,
          name,
          code: `${name}-${uniq()}`,
          startDate: new Date('2026-01-01'),
          endDate: new Date('2026-12-31'),
        },
      });
    const y2026 = await year('2026-27');
    const y2025 = await year('2025-26');
    const child = (fullName: string) =>
      prisma.studentProfile.create({
        data: { schoolId: school.id, fullName, monthlyFeeAmount: 0 },
      });
    /** A challan as generation would leave it; the statement only reads it. */
    const challan = (
      studentId: string,
      netAmount: number,
      paidAmount: number,
      status: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED',
      period: { month?: number; academicYearId?: string } = {},
    ) =>
      prisma.challan.create({
        data: {
          schoolId: school.id,
          challanNo: `CH-${uniq()}`,
          studentId,
          academicYearId: period.academicYearId ?? y2026.id,
          periodYear: 2026,
          periodMonth: period.month ?? 9,
          className: 'A-Level',
          sectionName: 'A1',
          issueDate: new Date('2026-09-01'),
          dueDate: new Date('2026-09-10'),
          grossAmount: netAmount,
          netAmount,
          paidAmount,
          status,
          items: { create: [{ label: 'Monthly Fee', amount: netAmount }] },
        },
      });
    const parentOf = async (...children: { id: string }[]) => {
      const user = await createTestUser({
        role: Role.PARENT,
        schoolId: school.id,
      });
      const profile = await prisma.parentProfile.create({
        data: { userId: user.id, fullName: 'Muhammad Ahmad' },
      });
      await prisma.parentStudent.createMany({
        data: children.map((c) => ({ parentId: profile.id, studentId: c.id })),
      });
      const auth = { Authorization: `Bearer ${await tokenFor(app, user)}` };
      return (query: Record<string, string | number> = {}) =>
        http().get('/api/fees/me/statement').set(auth).query(query);
    };
    return { school, y2026, y2025, child, challan, parentOf };
  }

  it("lists every linked child's challans for a month with shared totals, and a child with none", async () => {
    const f = await seedSchool();
    const [ahmed, ali, ayesha, zara] = [
      await f.child('Ahmed'),
      await f.child('Ali'),
      await f.child('Ayesha'),
      await f.child('Zara'),
    ];
    await f.challan(ahmed.id, 8000, 0, 'UNPAID');
    await f.challan(ali.id, 9500, 9500, 'PAID');
    await f.challan(ayesha.id, 7000, 3000, 'PARTIALLY_PAID');
    await f.challan(ahmed.id, 8000, 0, 'UNPAID', { month: 10 });
    const statement = await f.parentOf(ahmed, ali, ayesha, zara);

    const res = await statement({
      academicYearId: f.y2026.id,
      periodYear: 2026,
      periodMonth: 9,
    }).expect(200);

    expect(
      res.body.children.map(
        (c: { student: { fullName: string }; challans: unknown[] }) => [
          c.student.fullName,
          c.challans.length,
        ],
      ),
    ).toEqual([
      ['Ahmed', 1],
      ['Ali', 1],
      ['Ayesha', 1],
      ['Zara', 0],
    ]);
    expect(res.body.children[2].challans[0]).toMatchObject({
      netAmount: 7000,
      paidAmount: 3000,
      balance: 4000,
      status: 'PARTIALLY_PAID',
      className: 'A-Level',
      sectionName: 'A1',
    });
    expect(res.body.summary).toEqual({
      totalBilled: 24500,
      totalPaid: 12500,
      outstanding: 12000,
    });
    expect(res.body.currency).toBe('PKR');
    expect(res.body.school).toEqual({
      id: f.school.id,
      name: f.school.name,
      logoMimeType: null,
    });
  });

  it('shows every month of the year when no month is chosen, and keeps other years out', async () => {
    const f = await seedSchool();
    const ahmed = await f.child('Ahmed');
    await f.challan(ahmed.id, 8000, 0, 'UNPAID');
    await f.challan(ahmed.id, 8000, 8000, 'PAID', { month: 10 });
    await f.challan(ahmed.id, 5000, 0, 'UNPAID', {
      month: 3,
      academicYearId: f.y2025.id,
    });
    const statement = await f.parentOf(ahmed);

    const res = await statement({ academicYearId: f.y2026.id }).expect(200);

    expect(
      res.body.children[0].challans.map(
        (c: { periodMonth: number }) => c.periodMonth,
      ),
    ).toEqual([10, 9]);
    expect(res.body.summary).toEqual({
      totalBilled: 16000,
      totalPaid: 8000,
      outstanding: 8000,
    });
  });

  it('shows a cancelled challan but never counts it, so carried arrears are not added twice', async () => {
    const f = await seedSchool();
    const ahmed = await f.child('Ahmed');
    await f.challan(ahmed.id, 8000, 0, 'CANCELLED', { month: 8 });
    // September carries August's 8000 as arrears.
    await f.challan(ahmed.id, 16000, 0, 'UNPAID');
    const statement = await f.parentOf(ahmed);

    const res = await statement({ academicYearId: f.y2026.id }).expect(200);

    expect(res.body.children[0].challans).toHaveLength(2);
    expect(res.body.summary).toEqual({
      totalBilled: 16000,
      totalPaid: 0,
      outstanding: 16000,
    });
  });

  it('narrows to one linked child', async () => {
    const f = await seedSchool();
    const [ahmed, ali] = [await f.child('Ahmed'), await f.child('Ali')];
    await f.challan(ahmed.id, 8000, 0, 'UNPAID');
    await f.challan(ali.id, 9500, 0, 'UNPAID');
    const statement = await f.parentOf(ahmed, ali);

    const res = await statement({ studentId: ali.id }).expect(200);

    expect(res.body.children).toHaveLength(1);
    expect(res.body.children[0].student).toEqual({
      id: ali.id,
      fullName: 'Ali',
      rollNo: null,
    });
    expect(res.body.summary.totalBilled).toBe(9500);
  });

  it('refuses an unlinked child, a child of another school, and their challans', async () => {
    const f = await seedSchool();
    const other = await seedSchool();
    const ahmed = await f.child('Ahmed');
    const stranger = await f.child('Stranger');
    const elsewhere = await other.child('Elsewhere');
    const strangerChallan = await f.challan(stranger.id, 7000, 0, 'UNPAID');
    await other.challan(elsewhere.id, 6000, 0, 'UNPAID');
    const statement = await f.parentOf(ahmed);

    await statement({ studentId: stranger.id }).expect(403);
    await statement({ studentId: elsewhere.id }).expect(403);
    const all = await statement().expect(200);
    expect(
      all.body.children.map((c: { student: { id: string } }) => c.student.id),
    ).toEqual([ahmed.id]);
    expect(all.body.summary.totalBilled).toBe(0);

    // The per-challan routes a statement links to hold the same line.
    const parent = await prisma.parentStudent.findFirstOrThrow({
      where: { studentId: ahmed.id },
      select: { parent: { select: { userId: true } } },
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: parent.parent.userId },
    });
    await http()
      .get(`/api/fees/challans/${strangerChallan.id}`)
      .set('Authorization', `Bearer ${await tokenFor(app, user)}`)
      .expect(403);
  });

  it('is for parents only, and needs the year of a billing month', async () => {
    const f = await seedSchool();
    const ahmed = await f.child('Ahmed');
    for (const role of [Role.STUDENT, Role.TEACHER, Role.SCHOOL_ADMIN]) {
      const user = await createTestUser({ role, schoolId: f.school.id });
      await http()
        .get('/api/fees/me/statement')
        .set('Authorization', `Bearer ${await tokenFor(app, user)}`)
        .expect(403);
    }
    await http().get('/api/fees/me/statement').expect(401);

    const statement = await f.parentOf(ahmed);
    await statement({ periodMonth: 9 }).expect(400);
  });
});
