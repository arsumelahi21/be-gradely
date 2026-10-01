import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

const DAY = 86_400_000;
let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

/**
 * Two currencies, a branch with no session, a cancelled challan and a voided payment:
 * the cases where a careless roll-up would mix money or fake a rate (03-FEES §9).
 */
describe('Director fees insights (e2e)', () => {
  let app: INestApplication;
  const now = new Date();
  const period = {
    periodYear: now.getUTCFullYear(),
    periodMonth: now.getUTCMonth() + 1,
  };
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

  beforeEach(async () => {
    await resetDb();
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function branch(name: string, currency: string, withYear = true) {
    const school = await createTestSchool({ name });
    await prisma.school.update({
      where: { id: school.id },
      data: { currency, feeDueDayOfMonth: 10 },
    });
    if (!withYear) return { school };
    const year = await prisma.academicYear.create({
      data: {
        schoolId: school.id,
        name: `${name} now`,
        code: `NOW${uniq()}`,
        startDate: daysAgo(150),
        endDate: new Date(now.getTime() + 200 * DAY),
      },
    });
    const classGrade = await prisma.classGrade.create({
      data: { schoolId: school.id, name: 'Grade 5' },
    });
    const section = await prisma.section.create({
      data: { schoolId: school.id, classGradeId: classGrade.id, name: 'A' },
    });
    return { school, year, classGrade, section };
  }

  async function student(
    b: Awaited<ReturnType<typeof branch>>,
    fullName: string,
    active = true,
  ) {
    const user = await createTestUser({
      role: Role.STUDENT,
      schoolId: b.school.id,
      isActive: active,
    });
    const profile = await prisma.studentProfile.create({
      data: {
        userId: user.id,
        schoolId: b.school.id,
        fullName,
        rollNo: `R${uniq()}`,
      },
    });
    await prisma.enrollment.create({
      data: {
        studentId: profile.id,
        sectionId: b.section!.id,
        academicYearId: b.year!.id,
        status: 'ACTIVE',
      },
    });
    return profile;
  }

  async function challan(
    b: Awaited<ReturnType<typeof branch>>,
    studentId: string,
    c: {
      gross: number;
      discount?: number;
      paid?: number;
      status: 'PAID' | 'UNPAID' | 'PARTIALLY_PAID' | 'CANCELLED';
      due: Date;
      academicYearId?: string;
      periodYear?: number;
      periodMonth?: number;
    },
  ) {
    return prisma.challan.create({
      data: {
        schoolId: b.school.id,
        challanNo: `CH-${uniq()}`,
        studentId,
        academicYearId: c.academicYearId ?? b.year!.id,
        periodYear: c.periodYear ?? period.periodYear,
        periodMonth: c.periodMonth ?? period.periodMonth,
        classGradeId: b.classGrade!.id,
        sectionId: b.section!.id,
        issueDate: daysAgo(20),
        dueDate: c.due,
        grossAmount: c.gross,
        discountAmount: c.discount ?? 0,
        netAmount: c.gross - (c.discount ?? 0),
        paidAmount: c.paid ?? 0,
        status: c.status,
      },
    });
  }

  const pay = (
    b: Awaited<ReturnType<typeof branch>>,
    challanId: string,
    amount: number,
    method: 'CASH' | 'BANK_TRANSFER',
    paidAt: Date,
    voided = false,
  ) =>
    prisma.payment.create({
      data: {
        schoolId: b.school.id,
        challanId,
        amount,
        method,
        paidAt,
        ...(voided && { voidedAt: now }),
      },
    });

  async function fixture() {
    const a = await branch('Alpha', 'PKR');
    const s1 = await student(a, 'Areeba Ali');
    const s2 = await student(a, 'Sana Javed');
    const s3 = await student(a, 'Gone Student', false);

    const c1 = await challan(a, s1.id, {
      gross: 500_000,
      paid: 500_000,
      status: 'PAID',
      due: daysAgo(5),
    });
    const c2 = await challan(a, s2.id, {
      gross: 500_000,
      discount: 100_000,
      status: 'UNPAID',
      due: daysAgo(5),
    });
    await challan(a, s3.id, {
      gross: 500_000,
      status: 'CANCELLED',
      due: daysAgo(5),
    });
    await pay(a, c1.id, 500_000, 'CASH', daysAgo(2));
    await pay(a, c2.id, 100_000, 'CASH', daysAgo(1), true);

    const older = await prisma.academicYear.create({
      data: {
        schoolId: a.school.id,
        name: 'Alpha before',
        code: `OLD${uniq()}`,
        startDate: daysAgo(550),
        endDate: daysAgo(160),
      },
    });
    const c0 = await challan(a, s1.id, {
      gross: 300_000,
      paid: 300_000,
      status: 'PAID',
      due: daysAgo(300),
      academicYearId: older.id,
      periodYear: 2000,
      periodMonth: 1,
    });
    await pay(a, c0.id, 300_000, 'BANK_TRANSFER', daysAgo(60));

    await prisma.paymentSubmission.createMany({
      data: [
        { status: 'PENDING_VERIFICATION' as const, createdAt: daysAgo(4) },
        { status: 'REJECTED' as const, createdAt: daysAgo(9) },
      ].map((s) => ({
        ...s,
        schoolId: a.school.id,
        challanId: c2.id,
        studentId: s2.id,
        submittedByUserId: s2.userId!,
        amount: 400_000,
        method: 'BANK_TRANSFER' as const,
        paidAt: daysAgo(4),
        receiptS3Key: `x/${uniq()}`,
        receiptMimeType: 'image/png',
        receiptSizeBytes: 1,
      })),
    });

    const b = await branch('Bravo', 'AED');
    const b1 = await student(b, 'Bravo Kid');
    const cb = await challan(b, b1.id, {
      gross: 120_000,
      paid: 60_000,
      status: 'PARTIALLY_PAID',
      due: new Date(now.getTime() + 5 * DAY),
    });
    await pay(b, cb.id, 60_000, 'CASH', daysAgo(3));

    const c = await branch('Charlie', 'PKR', false);
    const foreign = await createTestSchool({ name: 'Delta' });

    const group = await prisma.schoolGroup.create({ data: { name: 'G' } });
    await prisma.school.updateMany({
      where: { id: { in: [a.school.id, b.school.id, c.school.id] } },
      data: { groupId: group.id },
    });
    const director = await createTestUser({
      role: Role.DIRECTOR,
      groupId: group.id,
    });
    const login = await api()
      .post('/api/auth/login')
      .send({ email: director.email, password: director.password });
    return {
      a,
      b,
      c,
      foreign,
      director,
      token: login.body.accessToken as string,
    };
  }

  const fees = (token: string, query = '') =>
    api().get(`/api/director/insights/fees${query}`).set(auth(token));
  const row = (body: any, schoolId: string) =>
    body.branches.find((r: any) => r.schoolId === schoolId);

  it('reports accrual per session, excluding cancelled challans', async () => {
    const { a, token } = await fixture();
    const res = await fees(token);
    expect(res.status).toBe(200);

    const alpha = row(res.body, a.school.id);
    expect(alpha.status).toBe('ok');
    expect(alpha.data.accrual).toMatchObject({
      billed: 900_000,
      gross: 1_000_000,
      discounts: 100_000,
      collected: 500_000,
      outstanding: 400_000,
      collectionRate: { num: 500_000, den: 900_000, value: 0.5556 },
      discountShare: { value: 0.1 },
      overdue: { amount: 400_000, count: 1 },
      challans: { live: 2, cancelled: 1 },
      statusMix: { paid: 1, partiallyPaid: 0, unpaid: 0, overdue: 1 },
      // The deactivated student is billed but not enrolled.
      billedPerStudent: { num: 900_000, den: 2, value: 450_000 },
    });
    expect(alpha.data.billedThisMonth).toBe(2);
    expect(alpha.data.queue).toMatchObject({
      pendingReceipts: 1,
      oldestAgeDays: 4,
    });
  });

  it('counts cash by payment date, never voided payments, separately from accrual', async () => {
    const { a, token } = await fixture();
    const last30 = row((await fees(token)).body, a.school.id).data.cash;
    expect(last30).toMatchObject({ received: 500_000, count: 1 });
    expect(last30.byMethod).toMatchObject({
      CASH: { amount: 500_000, count: 1 },
      BANK_TRANSFER: { amount: 0, count: 0 },
    });

    const last90 = await fees(token, '?preset=90d');
    expect(row(last90.body, a.school.id).data.cash.received).toBe(800_000);
    expect(row(last90.body, a.school.id).data.accrual.collected).toBe(500_000);
    expect(last90.body.window).toMatchObject({ preset: '90d', basis: 'range' });
  });

  it('never adds money across currencies and keeps a branch without a session for cash', async () => {
    const { c, token } = await fixture();
    const res = await fees(token);
    expect(Object.keys(res.body.group.byCurrency).sort()).toEqual([
      'AED',
      'PKR',
    ]);
    expect(res.body.group.byCurrency.PKR).toMatchObject({
      branches: 2,
      billed: 900_000,
      collectionRate: { value: 0.5556 },
      cash: { received: 500_000 },
    });
    expect(res.body.group.byCurrency.AED).toMatchObject({
      branches: 1,
      billed: 120_000,
      collectionRate: { value: 0.5 },
      cash: { received: 60_000 },
    });
    expect(JSON.stringify(res.body)).not.toContain('1020000');
    expect(res.body.coverage).toEqual({ ok: 2, total: 3 });

    const charlie = row(res.body, c.school.id);
    expect(charlie).toMatchObject({ status: 'no_year', academicYear: null });
    expect(charlie.data).toMatchObject({
      accrual: null,
      coverage: null,
      billedThisMonth: 0,
    });
  });

  it('reads the previous session on request, but this month from the current one', async () => {
    const { a, b, token } = await fixture();
    const res = await fees(token, '?ay=previous');
    const alpha = row(res.body, a.school.id);
    expect(alpha.academicYear.name).toBe('Alpha before');
    expect(alpha.data.accrual).toMatchObject({
      billed: 300_000,
      collectionRate: { value: 1 },
    });
    expect(alpha.data.coverage).not.toBeNull();
    expect(row(res.body, b.school.id).status).toBe('no_year');
  });

  it('adds class detail for one branch, and refuses a branch outside the group', async () => {
    const { a, foreign, token } = await fixture();
    const single = await fees(token, `?branch=${a.school.id}`);
    expect(single.body.branches).toHaveLength(1);
    expect(single.body.branches[0].data.byClass).toEqual([
      {
        className: 'Grade 5',
        billed: 900_000,
        collected: 500_000,
        challans: 2,
        collectionRate: { num: 500_000, den: 900_000, value: 0.5556 },
      },
    ]);
    expect(single.body.branches[0].data.coverage.rows[0]).toMatchObject({
      className: 'Grade 5',
      status: 'PARTIAL',
      students: 3,
      challans: 2,
    });

    expect((await fees(token)).body.branches[0].data.byClass).toBeUndefined();
    expect((await fees(token, `?branch=${foreign.id}`)).status).toBe(404);
    expect(
      (await fees(token, '?preset=custom&from=2026-10-08&to=2026-10-01'))
        .status,
    ).toBe(400);
    expect((await fees(token, `?schoolId=${foreign.id}`)).status).toBe(400);
  });

  it('lists the top outstanding students of one branch, names only', async () => {
    const { a, c, foreign, director, token } = await fixture();
    const lists = (q: string) =>
      api().get(`/api/director/insights/fees/lists${q}`).set(auth(token));

    const res = await lists(`?branch=${a.school.id}`);
    expect(res.status).toBe(200);
    expect(res.body.group).toBeNull();
    expect(res.body.branches[0].data.outstanding).toEqual({
      currency: 'PKR',
      rows: [
        {
          fullName: 'Sana Javed',
          className: 'Grade 5',
          sectionName: 'A',
          amount: 400_000,
          overdueCount: 1,
        },
      ],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/studentId|rollNo|R\d{5}/);

    expect((await lists('')).status).toBe(400);
    expect((await lists('?branch=all')).status).toBe(400);
    expect((await lists(`?branch=${foreign.id}`)).status).toBe(404);
    const charlie = await lists(`?branch=${c.school.id}`);
    expect(charlie.body.branches[0]).toMatchObject({
      status: 'no_year',
      data: null,
    });

    let audits = 0;
    for (let i = 0; i < 20 && audits < 2; i++) {
      audits = await prisma.auditLog.count({
        where: { actorUserId: director.id, action: 'DIRECTOR_LIST_VIEW' },
      });
      if (audits < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(audits).toBe(2);
  });

  it('is for directors only', async () => {
    const { a } = await fixture();
    const principal = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: a.school.id,
    });
    const superAdmin = await createTestUser({ role: Role.SUPER_ADMIN });
    for (const user of [principal, superAdmin]) {
      const token = await tokenFor(app, user);
      expect((await fees(token)).status).toBe(403);
      expect(
        (
          await api()
            .get(`/api/director/insights/fees/lists?branch=${a.school.id}`)
            .set(auth(token))
        ).status,
      ).toBe(403);
    }
  });
});
