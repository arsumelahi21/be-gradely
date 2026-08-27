import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';
import { PrismaService } from '../src/prisma/prisma.service';
import { InstallmentRemindersService } from '../src/fees/installment-reminders.service';

const PERIOD = { periodYear: 2026, periodMonth: 3 };

describe('Fees — challan generation (e2e)', () => {
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

  /** A class with fees set on every student, plus an admin token. */
  async function seedBillableClass(
    opts: { studentCount?: number; fee?: number } = {},
  ) {
    const cls = await seedClass({ studentCount: opts.studentCount ?? 3 });
    await prisma.studentProfile.updateMany({
      where: { schoolId: cls.school.id },
      data: { monthlyFeeAmount: opts.fee ?? 500000 },
    });
    const adminUser = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, adminUser);
    return { ...cls, adminUser, adminToken };
  }

  const generateBody = (cls: {
    academicYear: { id: string };
    section: { id: string };
  }) => ({
    academicYearId: cls.academicYear.id,
    sectionId: cls.section.id,
    ...PERIOD,
  });

  // ---- Admission: the mandatory fee --------------------------------------

  describe('mandatory fee at admission', () => {
    const studentPayload = (overrides: Record<string, unknown> = {}) => {
      const rnd = Math.random().toString(36).slice(2);
      return {
        email: `fee-student-${rnd}@test.local`,
        password: 'Student@123',
        role: 'STUDENT',
        fullName: 'Fee Student',
        gender: 'MALE',
        dob: '2012-05-01',
        dateOfJoining: '2026-01-10',
        city: 'Lahore',
        state: 'Punjab',
        country: 'Pakistan',
        newParent: {
          fullName: 'Fee Guardian',
          email: `fee-parent-${rnd}@test.local`,
          password: 'Parent@123',
          phone: '5550100',
        },
        ...overrides,
      };
    };

    it('rejects a student with no fee, accepts 0, rejects a negative', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };

      // Absent — @IsOptional() would have wrongly allowed this.
      const missing = await http()
        .post('/api/users')
        .set(auth)
        .send(studentPayload())
        .expect(400);
      expect(JSON.stringify(missing.body.message)).toMatch(/monthly fee/i);

      await http()
        .post('/api/users')
        .set(auth)
        .send(studentPayload({ monthlyFeeAmount: -1 }))
        .expect(400);

      // 0 is a VALID fee and must pass.
      const zero = await http()
        .post('/api/users')
        .set(auth)
        .send(studentPayload({ monthlyFeeAmount: 0 }))
        .expect(201);

      const profile = await prisma.studentProfile.findFirstOrThrow({
        where: { userId: zero.body.id },
        select: { monthlyFeeAmount: true },
      });
      expect(profile.monthlyFeeAmount).toBe(0);
    });

    it('does not require a fee for non-student roles', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      await http()
        .post('/api/users')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send({
          email: `fee-teacher-${Math.random().toString(36).slice(2)}@test.local`,
          password: 'Teacher@123',
          role: 'TEACHER',
          fullName: 'No Fee Teacher',
          phone: '5550111',
        })
        .expect(201);
    });

    it("rejects another school's discount at admission", async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const otherSchool = await createTestSchool();
      const foreign = await prisma.discount.create({
        data: {
          schoolId: otherSchool.id,
          name: 'Foreign',
          type: 'PERCENT',
          value: 10,
        },
      });

      await http()
        .post('/api/users')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send(
          studentPayload({ monthlyFeeAmount: 100000, discountId: foreign.id }),
        )
        .expect(400);
    });
  });

  // ---- Allocated fee on the student details view -------------------------

  describe('allocated fee on the student details view', () => {
    const studentPayload = (overrides: Record<string, unknown> = {}) => {
      const rnd = Math.random().toString(36).slice(2);
      return {
        email: `alloc-student-${rnd}@test.local`,
        password: 'Student@123',
        role: 'STUDENT',
        fullName: 'Allocated Fee Student',
        gender: 'MALE',
        dob: '2012-05-01',
        dateOfJoining: '2026-01-10',
        city: 'Lahore',
        state: 'Punjab',
        country: 'Pakistan',
        newParent: {
          fullName: 'Alloc Guardian',
          email: `alloc-parent-${rnd}@test.local`,
          password: 'Parent@123',
          phone: '5550100',
        },
        ...overrides,
      };
    };

    /**
     * The school-admin details view reads the allocated fee straight off the
     * EXISTING user payload — no fee-specific endpoint. Narrowing
     * defaultUserInclude() to a `select` would silently blank the field, so
     * this pins the contract.
     */
    it('exposes monthlyFeeAmount and discountId on GET /users/:id', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };

      const discount = await prisma.discount.create({
        data: {
          schoolId: cls.school.id,
          name: 'Sibling Discount',
          type: 'PERCENT',
          value: 10,
        },
      });

      const created = await http()
        .post('/api/users')
        .set(auth)
        .send(
          studentPayload({ monthlyFeeAmount: 500000, discountId: discount.id }),
        )
        .expect(201);

      const detail = await http()
        .get(`/api/users/${created.body.id}`)
        .set(auth)
        .expect(200);

      expect(detail.body.studentProfile.monthlyFeeAmount).toBe(500000);
      expect(detail.body.studentProfile.discountId).toBe(discount.id);
    });

    it('exposes a zero allocated fee as 0, not as a missing field', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };

      const created = await http()
        .post('/api/users')
        .set(auth)
        .send(studentPayload({ monthlyFeeAmount: 0 }))
        .expect(201);

      const detail = await http()
        .get(`/api/users/${created.body.id}`)
        .set(auth)
        .expect(200);

      // 0 must survive the round-trip — the view renders it, not "Not set".
      expect(detail.body.studentProfile.monthlyFeeAmount).toBe(0);
      expect(detail.body.studentProfile.discountId).toBeNull();
    });

    it('reflects an edit made through the existing user update flow', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };
      const discount = await prisma.discount.create({
        data: {
          schoolId: cls.school.id,
          name: 'Merit',
          type: 'FIXED',
          value: 25000,
        },
      });

      const created = await http()
        .post('/api/users')
        .set(auth)
        .send(studentPayload({ monthlyFeeAmount: 500000 }))
        .expect(201);

      // Editing stays on PATCH /users/:id — the details view is read-only.
      await http()
        .patch(`/api/users/${created.body.id}`)
        .set(auth)
        .send({ monthlyFeeAmount: 750000, discountId: discount.id })
        .expect(200);

      const detail = await http()
        .get(`/api/users/${created.body.id}`)
        .set(auth)
        .expect(200);
      expect(detail.body.studentProfile.monthlyFeeAmount).toBe(750000);
      expect(detail.body.studentProfile.discountId).toBe(discount.id);
    });

    it('serves the currency the view formats with, per school', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };

      await http()
        .patch('/api/fees/settings')
        .set(auth)
        .send({ currency: 'AED' })
        .expect(200);

      const settings = await http()
        .get('/api/fees/settings')
        .set(auth)
        .expect(200);
      expect(settings.body.currency).toBe('AED');
    });

    it("does not expose another school's student to an admin", async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const created = await http()
        .post('/api/users')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send(studentPayload({ monthlyFeeAmount: 500000 }))
        .expect(201);

      const otherSchool = await createTestSchool();
      const otherAdmin = await createTestUser({
        role: Role.SCHOOL_ADMIN,
        schoolId: otherSchool.id,
      });
      const otherToken = await tokenFor(app, otherAdmin);

      await http()
        .get(`/api/users/${created.body.id}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);
    });
  });

  // ---- Individual student fee heads --------------------------------------

  describe('per-student fee heads', () => {
    /** A class with two school heads, plus an admin token. */
    async function headsFixture() {
      const cls = await seedBillableClass({ studentCount: 2 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };
      const transport = await prisma.feeHead.create({
        data: {
          schoolId: cls.school.id,
          name: 'Transport',
          defaultAmount: 10000,
          sortOrder: 1,
        },
      });
      const library = await prisma.feeHead.create({
        data: {
          schoolId: cls.school.id,
          name: 'Library',
          defaultAmount: 2500,
          sortOrder: 2,
        },
      });
      return { cls, auth, transport, library };
    }

    const url = (studentId: string) =>
      `/api/fees/students/${studentId}/fee-heads`;

    it('lists school defaults when the student has no overrides', async () => {
      const { cls, auth, transport } = await headsFixture();
      const res = await http()
        .get(url(cls.students[0].profile.id))
        .set(auth)
        .expect(200);

      const row = res.body.heads.find((h: any) => h.feeHeadId === transport.id);
      expect(row).toMatchObject({
        name: 'Transport',
        defaultAmount: 10000,
        amount: 10000,
        isExcluded: false,
        isOverridden: false,
      });
      expect(res.body.currency).toBeTruthy();
    });

    it('applies an override to that student ONLY', async () => {
      const { cls, auth, transport } = await headsFixture();
      const [a, b] = cls.students;

      await http()
        .put(url(a.profile.id))
        .set(auth)
        .send({ overrides: [{ feeHeadId: transport.id, amount: 30000 }] })
        .expect(200);

      const forA = await http().get(url(a.profile.id)).set(auth).expect(200);
      expect(
        forA.body.heads.find((h: any) => h.feeHeadId === transport.id),
      ).toMatchObject({ amount: 30000, isOverridden: true });

      // The other student is untouched...
      const forB = await http().get(url(b.profile.id)).set(auth).expect(200);
      expect(
        forB.body.heads.find((h: any) => h.feeHeadId === transport.id),
      ).toMatchObject({ amount: 10000, isOverridden: false });

      // ...and so is the school-wide default.
      const head = await prisma.feeHead.findUniqueOrThrow({
        where: { id: transport.id },
      });
      expect(head.defaultAmount).toBe(10000);
    });

    it('excludes a head for one student without removing it school-wide', async () => {
      const { cls, auth, library } = await headsFixture();
      await http()
        .put(url(cls.students[0].profile.id))
        .set(auth)
        .send({
          overrides: [{ feeHeadId: library.id, amount: 0, isExcluded: true }],
        })
        .expect(200);

      const res = await http()
        .get(url(cls.students[0].profile.id))
        .set(auth)
        .expect(200);
      expect(
        res.body.heads.find((h: any) => h.feeHeadId === library.id),
      ).toMatchObject({ isExcluded: true });

      expect(
        await prisma.feeHead.findUnique({ where: { id: library.id } }),
      ).not.toBeNull();
    });

    it('resets to the school default when a head is omitted', async () => {
      const { cls, auth, transport } = await headsFixture();
      const studentId = cls.students[0].profile.id;

      await http()
        .put(url(studentId))
        .set(auth)
        .send({ overrides: [{ feeHeadId: transport.id, amount: 30000 }] })
        .expect(200);
      // Sending an empty set is how "reset to school default" is expressed.
      const reset = await http()
        .put(url(studentId))
        .set(auth)
        .send({ overrides: [] })
        .expect(200);

      expect(
        reset.body.heads.find((h: any) => h.feeHeadId === transport.id),
      ).toMatchObject({ amount: 10000, isOverridden: false });
      expect(
        await prisma.studentFeeHeadOverride.count({ where: { studentId } }),
      ).toBe(0);
    });

    it('rejects a negative amount, a duplicate head, and a foreign head', async () => {
      const { cls, auth, transport } = await headsFixture();
      const studentId = cls.students[0].profile.id;

      await http()
        .put(url(studentId))
        .set(auth)
        .send({ overrides: [{ feeHeadId: transport.id, amount: -1 }] })
        .expect(400);

      await http()
        .put(url(studentId))
        .set(auth)
        .send({
          overrides: [
            { feeHeadId: transport.id, amount: 100 },
            { feeHeadId: transport.id, amount: 200 },
          ],
        })
        .expect(400);

      const otherSchool = await createTestSchool();
      const foreignHead = await prisma.feeHead.create({
        data: { schoolId: otherSchool.id, name: 'Foreign', defaultAmount: 100 },
      });
      await http()
        .put(url(studentId))
        .set(auth)
        .send({ overrides: [{ feeHeadId: foreignHead.id, amount: 100 }] })
        .expect(400);

      expect(
        await prisma.studentFeeHeadOverride.count({ where: { studentId } }),
      ).toBe(0);
    });

    it('bills the overridden amount, leaving classmates on the default', async () => {
      const { cls, auth, transport } = await headsFixture();
      const [a, b] = cls.students;

      await http()
        .put(url(a.profile.id))
        .set(auth)
        .send({ overrides: [{ feeHeadId: transport.id, amount: 30000 }] })
        .expect(200);

      await http()
        .post('/api/fees/challans/generate')
        .set(auth)
        .send(generateBody(cls))
        .expect(201);

      // 500000 monthly + 30000 transport + 2500 library
      const challanA = await prisma.challan.findFirstOrThrow({
        where: { studentId: a.profile.id },
      });
      expect(challanA.grossAmount).toBe(532500);

      // 500000 + 10000 + 2500 — untouched by A's override
      const challanB = await prisma.challan.findFirstOrThrow({
        where: { studentId: b.profile.id },
      });
      expect(challanB.grossAmount).toBe(512500);
    });

    it('omits an excluded head from the generated challan', async () => {
      const { cls, auth, library } = await headsFixture();
      await http()
        .put(url(cls.students[0].profile.id))
        .set(auth)
        .send({
          overrides: [{ feeHeadId: library.id, amount: 0, isExcluded: true }],
        })
        .expect(200);

      await http()
        .post('/api/fees/challans/generate')
        .set(auth)
        .send(generateBody(cls))
        .expect(201);

      const challan = await prisma.challan.findFirstOrThrow({
        where: { studentId: cls.students[0].profile.id },
        include: { items: true },
      });
      expect(challan.items.map((i) => i.label)).not.toContain('Library');
      expect(challan.grossAmount).toBe(510000);
    });

    // THE requirement: a later override edit must not rewrite an issued bill.
    it('SNAPSHOTS the override — editing it later never alters an issued challan', async () => {
      const { cls, auth, transport } = await headsFixture();
      const studentId = cls.students[0].profile.id;

      await http()
        .put(url(studentId))
        .set(auth)
        .send({ overrides: [{ feeHeadId: transport.id, amount: 30000 }] })
        .expect(200);
      await http()
        .post('/api/fees/challans/generate')
        .set(auth)
        .send(generateBody(cls))
        .expect(201);

      const before = await prisma.challan.findFirstOrThrow({
        where: { studentId },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });
      const transportLineBefore = before.items.find(
        (i) => i.label === 'Transport',
      );
      expect(transportLineBefore?.amount).toBe(30000);

      // Change the student's fee AND the school default afterwards.
      await http()
        .put(url(studentId))
        .set(auth)
        .send({ overrides: [{ feeHeadId: transport.id, amount: 99999 }] })
        .expect(200);
      await http()
        .patch(`/api/fees/heads/${transport.id}`)
        .set(auth)
        .send({ defaultAmount: 88888 })
        .expect(200);

      const after = await prisma.challan.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });
      expect(after.grossAmount).toBe(before.grossAmount);
      expect(after.netAmount).toBe(before.netAmount);
      expect(after.items.find((i) => i.label === 'Transport')?.amount).toBe(
        30000,
      );

      // The NEXT month's challan does pick the new amount up.
      await http()
        .post('/api/fees/challans/generate')
        .set(auth)
        .send({ ...generateBody(cls), periodMonth: PERIOD.periodMonth + 1 })
        .expect(201);
      const next = await prisma.challan.findFirstOrThrow({
        where: { studentId, periodMonth: PERIOD.periodMonth + 1 },
        include: { items: true },
      });
      expect(next.items.find((i) => i.label === 'Transport')?.amount).toBe(
        99999,
      );
    });

    it('keeps the endpoints admin-only and tenant-scoped', async () => {
      const { cls, transport } = await headsFixture();
      const studentId = cls.students[0].profile.id;
      const teacherToken = await tokenFor(app, cls.teacherUser);
      const studentToken = await tokenFor(app, cls.students[0].user);

      for (const token of [teacherToken, studentToken]) {
        await http()
          .get(url(studentId))
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
        await http()
          .put(url(studentId))
          .set('Authorization', `Bearer ${token}`)
          .send({ overrides: [{ feeHeadId: transport.id, amount: 1 }] })
          .expect(403);
      }
      await http().get(url(studentId)).expect(401);

      const otherSchool = await createTestSchool();
      const otherAdmin = await createTestUser({
        role: Role.SCHOOL_ADMIN,
        schoolId: otherSchool.id,
      });
      const otherToken = await tokenFor(app, otherAdmin);
      await http()
        .get(url(studentId))
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);
      await http()
        .put(url(studentId))
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ overrides: [] })
        .expect(403);

      expect(
        await prisma.studentFeeHeadOverride.count({ where: { studentId } }),
      ).toBe(0);
    });
  });

  // ---- Generation --------------------------------------------------------

  it('generates one challan per enrolled student, itemised', async () => {
    const cls = await seedBillableClass({ studentCount: 3 });

    const res = await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(generateBody(cls))
      .expect(201);

    expect(res.body.generated).toBe(3);
    expect(res.body.skipped).toBe(0);

    const challans = await prisma.challan.findMany({
      where: { schoolId: cls.school.id },
      include: { items: true },
    });
    expect(challans).toHaveLength(3);
    for (const c of challans) {
      expect(c.netAmount).toBe(500000);
      expect(c.status).toBe('UNPAID');
      // Monthly-fee line is always emitted.
      expect(c.items.length).toBeGreaterThanOrEqual(1);
      // Class/section snapshotted onto the challan.
      expect(c.sectionName).toBe(cls.section.name);
      expect(c.className).toBe(cls.classGrade.name);
    }
  });

  it('includes active fee heads and excludes inactive ones', async () => {
    const cls = await seedBillableClass({ studentCount: 1 });
    await prisma.feeHead.createMany({
      data: [
        {
          schoolId: cls.school.id,
          name: 'Transport',
          defaultAmount: 10000,
          isActive: true,
        },
        {
          schoolId: cls.school.id,
          name: 'Sports',
          defaultAmount: 99900,
          isActive: false,
        },
      ],
    });

    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(generateBody(cls))
      .expect(201);

    const challan = await prisma.challan.findFirstOrThrow({
      where: { schoolId: cls.school.id },
      include: { items: true },
    });
    expect(challan.grossAmount).toBe(510000);
    expect(challan.items.map((i) => i.label)).toContain('Transport');
    expect(challan.items.map((i) => i.label)).not.toContain('Sports');
  });

  it('applies an active discount and ignores an inactive one', async () => {
    const cls = await seedBillableClass({ studentCount: 2 });
    const [active, inactive] = await Promise.all([
      prisma.discount.create({
        data: {
          schoolId: cls.school.id,
          name: 'Sibling',
          type: 'PERCENT',
          value: 10,
          isActive: true,
        },
      }),
      prisma.discount.create({
        data: {
          schoolId: cls.school.id,
          name: 'Retired',
          type: 'PERCENT',
          value: 50,
          isActive: false,
        },
      }),
    ]);
    await prisma.studentProfile.update({
      where: { id: cls.students[0].profile.id },
      data: { discountId: active.id },
    });
    await prisma.studentProfile.update({
      where: { id: cls.students[1].profile.id },
      data: { discountId: inactive.id },
    });

    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(generateBody(cls))
      .expect(201);

    const discounted = await prisma.challan.findFirstOrThrow({
      where: { studentId: cls.students[0].profile.id },
    });
    expect(discounted.discountAmount).toBe(50000);
    expect(discounted.netAmount).toBe(450000);

    const undiscounted = await prisma.challan.findFirstOrThrow({
      where: { studentId: cls.students[1].profile.id },
    });
    expect(undiscounted.discountAmount).toBe(0);
    expect(undiscounted.netAmount).toBe(500000);
  });

  it('settles a zero-fee challan immediately as PAID', async () => {
    const cls = await seedBillableClass({ studentCount: 1, fee: 0 });

    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(generateBody(cls))
      .expect(201);

    const challan = await prisma.challan.findFirstOrThrow({
      where: { schoolId: cls.school.id },
    });
    expect(challan.netAmount).toBe(0);
    expect(challan.status).toBe('PAID');
  });

  it('excludes a student with no ACTIVE enrollment', async () => {
    const cls = await seedBillableClass({ studentCount: 3 });
    await prisma.enrollment.updateMany({
      where: { studentId: cls.students[2].profile.id },
      data: { status: 'INACTIVE' },
    });

    const res = await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(generateBody(cls))
      .expect(201);

    expect(res.body.generated).toBe(2);
    const count = await prisma.challan.count({
      where: { schoolId: cls.school.id },
    });
    expect(count).toBe(2);
  });

  // ---- The duplicate rule ------------------------------------------------

  it('re-running generation creates nothing and reports the students as skipped', async () => {
    const cls = await seedBillableClass({ studentCount: 3 });
    const body = generateBody(cls);

    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(body)
      .expect(201);

    const second = await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(body)
      .expect(201);

    expect(second.body.generated).toBe(0);
    expect(second.body.skipped).toBe(3);
    expect(
      await prisma.challan.count({ where: { schoolId: cls.school.id } }),
    ).toBe(3);
  });

  it('CONCURRENT generation cannot produce a duplicate challan', async () => {
    const cls = await seedBillableClass({ studentCount: 4 });
    const body = generateBody(cls);

    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        http()
          .post('/api/fees/challans/generate')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(body),
      ),
    );

    // Every request succeeds; the losers report their students as skipped.
    for (const r of responses) expect(r.status).toBe(201);
    const totalGenerated = responses.reduce((n, r) => n + r.body.generated, 0);
    expect(totalGenerated).toBe(4);

    // The DB constraint is the real guarantee: 4 students, 4 rows, no dupes.
    const challans = await prisma.challan.findMany({
      where: { schoolId: cls.school.id },
      select: { studentId: true, challanNo: true },
    });
    expect(challans).toHaveLength(4);
    expect(new Set(challans.map((c) => c.studentId)).size).toBe(4);
    expect(new Set(challans.map((c) => c.challanNo)).size).toBe(4);
  });

  it('picks up a student admitted after the first run, without duplicating the rest', async () => {
    const cls = await seedBillableClass({ studentCount: 2 });
    const body = generateBody(cls);

    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(body)
      .expect(201);

    const lateUser = await createTestUser({
      role: Role.STUDENT,
      schoolId: cls.school.id,
    });
    const lateProfile = await prisma.studentProfile.create({
      data: {
        userId: lateUser.id,
        schoolId: cls.school.id,
        fullName: 'Late Admission',
        monthlyFeeAmount: 500000,
      },
    });
    await prisma.enrollment.create({
      data: {
        studentId: lateProfile.id,
        sectionId: cls.section.id,
        academicYearId: cls.academicYear.id,
        status: 'ACTIVE',
      },
    });

    const rerun = await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(body)
      .expect(201);

    expect(rerun.body.generated).toBe(1);
    expect(rerun.body.skipped).toBe(2);
    expect(
      await prisma.challan.count({ where: { schoolId: cls.school.id } }),
    ).toBe(3);
  });

  // ---- The N+1 trap ------------------------------------------------------

  it('issues a CONSTANT number of read queries regardless of roster size', async () => {
    // The most likely performance defect in this module is loading fee heads /
    // discounts per student. Reads must not scale with the roster.
    const READ_CALLS = [
      'feeHead.findMany',
      'enrollment.findMany',
      'challan.findMany',
      'school.findUnique',
      'section.findUnique',
      // Per-student overrides must load in ONE query for the whole roster.
      'studentFeeHeadOverride.findMany',
    ] as const;

    async function countReadsForRoster(studentCount: number) {
      const cls = await seedBillableClass({ studentCount });
      const svc = app.get(PrismaService);

      const counts: Record<string, number> = {};
      const restores: Array<() => void> = [];
      for (const path of READ_CALLS) {
        const [model, method] = path.split('.');
        const original = svc[model][method].bind(svc[model]);
        counts[path] = 0;
        svc[model][method] = (...args: unknown[]) => {
          counts[path] += 1;
          return original(...args);
        };
        restores.push(() => {
          svc[model][method] = original;
        });
      }

      try {
        await http()
          .post('/api/fees/challans/generate')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(generateBody(cls))
          .expect(201);
      } finally {
        restores.forEach((r) => r());
      }

      const created = await prisma.challan.count({
        where: { schoolId: cls.school.id },
      });
      return { counts, created };
    }

    const small = await countReadsForRoster(3);
    await resetDb();
    const large = await countReadsForRoster(12);

    expect(small.created).toBe(3);
    expect(large.created).toBe(12);
    // 4x the students, identical read-query counts.
    expect(large.counts).toEqual(small.counts);
  });

  // ---- Preview -----------------------------------------------------------

  it('preview reports who will be billed and who already is, and writes nothing', async () => {
    const cls = await seedBillableClass({ studentCount: 2 });
    const body = generateBody(cls);

    const first = await http()
      .post('/api/fees/challans/preview')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(body)
      .expect(201);

    expect(first.body.counts.willGenerate).toBe(2);
    expect(first.body.counts.alreadyBilled).toBe(0);
    expect(first.body.totals.netAmount).toBe(1000000);
    expect(await prisma.challan.count()).toBe(0);

    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(body)
      .expect(201);

    const after = await http()
      .post('/api/fees/challans/preview')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(body)
      .expect(201);
    expect(after.body.counts.willGenerate).toBe(0);
    expect(after.body.counts.alreadyBilled).toBe(2);
  });

  // ---- Single-student ----------------------------------------------------

  it('creates a single-student challan and rejects a second for the same month', async () => {
    const cls = await seedBillableClass({ studentCount: 2 });
    const single = {
      studentId: cls.students[0].profile.id,
      academicYearId: cls.academicYear.id,
      ...PERIOD,
    };

    await http()
      .post('/api/fees/challans')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(single)
      .expect(201);

    await http()
      .post('/api/fees/challans')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(single)
      .expect(400);

    expect(
      await prisma.challan.count({ where: { schoolId: cls.school.id } }),
    ).toBe(1);
  });

  // ---- Coverage ----------------------------------------------------------

  it('coverage moves NOT_CREATED -> CREATED, and reports PARTIAL after a late admission', async () => {
    const cls = await seedBillableClass({ studentCount: 2 });
    const coverageUrl =
      `/api/fees/challans/coverage?academicYearId=${cls.academicYear.id}` +
      `&periodYear=${PERIOD.periodYear}&periodMonth=${PERIOD.periodMonth}`;

    const before = await http()
      .get(coverageUrl)
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .expect(200);
    expect(before.body.rows[0]).toMatchObject({
      students: 2,
      challans: 0,
      status: 'NOT_CREATED',
    });

    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(generateBody(cls))
      .expect(201);

    const after = await http()
      .get(coverageUrl)
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .expect(200);
    expect(after.body.rows[0]).toMatchObject({
      students: 2,
      challans: 2,
      status: 'CREATED',
    });

    const lateUser = await createTestUser({
      role: Role.STUDENT,
      schoolId: cls.school.id,
    });
    const lateProfile = await prisma.studentProfile.create({
      data: { userId: lateUser.id, schoolId: cls.school.id, fullName: 'Late' },
    });
    await prisma.enrollment.create({
      data: {
        studentId: lateProfile.id,
        sectionId: cls.section.id,
        academicYearId: cls.academicYear.id,
        status: 'ACTIVE',
      },
    });

    const partial = await http()
      .get(coverageUrl)
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .expect(200);
    expect(partial.body.rows[0]).toMatchObject({
      students: 3,
      challans: 2,
      status: 'PARTIAL',
    });
  });

  // ---- Tenant isolation --------------------------------------------------

  it("blocks another school's admin from generating, listing, or reading", async () => {
    const cls = await seedBillableClass({ studentCount: 1 });
    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(generateBody(cls))
      .expect(201);
    const challan = await prisma.challan.findFirstOrThrow({
      where: { schoolId: cls.school.id },
    });

    const otherSchool = await createTestSchool();
    const otherAdmin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: otherSchool.id,
    });
    const otherToken = await tokenFor(app, otherAdmin);

    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${otherToken}`)
      .send(generateBody(cls))
      .expect(403);

    await http()
      .get(`/api/fees/challans/${challan.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);

    const list = await http()
      .get('/api/fees/challans?page=1&pageSize=50')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
    expect(list.body.items).toHaveLength(0);
  });

  // ---- Role restrictions -------------------------------------------------

  it('keeps generation admin-only', async () => {
    const cls = await seedBillableClass({ studentCount: 1 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const studentToken = await tokenFor(app, cls.students[0].user);

    for (const token of [teacherToken, studentToken]) {
      await http()
        .post('/api/fees/challans/generate')
        .set('Authorization', `Bearer ${token}`)
        .send(generateBody(cls))
        .expect(403);
      await http()
        .get('/api/fees/challans')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    }

    await http()
      .post('/api/fees/challans/generate')
      .send(generateBody(cls))
      .expect(401);
  });

  it("lets a student read their own challan but not another student's", async () => {
    const cls = await seedBillableClass({ studentCount: 2 });
    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(generateBody(cls))
      .expect(201);

    const ownToken = await tokenFor(app, cls.students[0].user);
    const own = await prisma.challan.findFirstOrThrow({
      where: { studentId: cls.students[0].profile.id },
    });
    const other = await prisma.challan.findFirstOrThrow({
      where: { studentId: cls.students[1].profile.id },
    });

    await http()
      .get(`/api/fees/challans/${own.id}`)
      .set('Authorization', `Bearer ${ownToken}`)
      .expect(200);

    await http()
      .get(`/api/fees/challans/${other.id}`)
      .set('Authorization', `Bearer ${ownToken}`)
      .expect(403);
  });

  // ---- Payments ----------------------------------------------------------

  describe('payments', () => {
    /** A generated, unpaid challan of 500000 plus an admin token. */
    async function billedStudent() {
      const cls = await seedBillableClass({ studentCount: 1 });
      await http()
        .post('/api/fees/challans/generate')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send(generateBody(cls))
        .expect(201);
      const challan = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id },
      });
      return {
        cls,
        challan,
        auth: { Authorization: `Bearer ${cls.adminToken}` },
      };
    }

    it('records a partial payment, then settles the balance', async () => {
      const { challan, auth } = await billedStudent();

      const partial = await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 200000, method: 'CASH' })
        .expect(201);
      expect(partial.body.challan).toMatchObject({
        paidAmount: 200000,
        status: 'PARTIALLY_PAID',
      });

      const rest = await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 300000, method: 'BANK_TRANSFER', reference: 'TRX-1' })
        .expect(201);
      expect(rest.body.challan).toMatchObject({
        paidAmount: 500000,
        status: 'PAID',
      });

      // paidAmount must equal the ledger, not a running increment.
      const ledger = await prisma.payment.aggregate({
        where: { challanId: challan.id, voidedAt: null },
        _sum: { amount: true },
      });
      const fresh = await prisma.challan.findUniqueOrThrow({
        where: { id: challan.id },
      });
      expect(fresh.paidAmount).toBe(ledger._sum.amount);
    });

    it('rejects overpayment and names the remaining balance', async () => {
      const { challan, auth } = await billedStudent();
      await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 400000, method: 'CASH' })
        .expect(201);

      const over = await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 200000, method: 'CASH' })
        .expect(400);
      // 100000 minor units remain -> "1,000.00".
      expect(JSON.stringify(over.body.message)).toMatch(/1,000\.00/);

      const fresh = await prisma.challan.findUniqueOrThrow({
        where: { id: challan.id },
      });
      expect(fresh.paidAmount).toBe(400000);
    });

    it('rejects a non-positive payment', async () => {
      const { challan, auth } = await billedStudent();
      for (const amount of [0, -100]) {
        await http()
          .post(`/api/fees/challans/${challan.id}/payments`)
          .set(auth)
          .send({ amount, method: 'CASH' })
          .expect(400);
      }
      expect(
        await prisma.payment.count({ where: { challanId: challan.id } }),
      ).toBe(0);
    });

    it('rejects a payment against a cancelled challan', async () => {
      const { challan, auth } = await billedStudent();
      await http()
        .post(`/api/fees/challans/${challan.id}/cancel`)
        .set(auth)
        .send({ reason: 'Duplicate' })
        .expect(201);

      await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 1000, method: 'CASH' })
        .expect(400);
    });

    it('rejects any payment on a fully-settled challan', async () => {
      const { challan, auth } = await billedStudent();
      await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 500000, method: 'CASH' })
        .expect(201);

      await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 1, method: 'CASH' })
        .expect(400);
    });

    it('voids a payment, restoring the balance without deleting the receipt', async () => {
      const { challan, auth } = await billedStudent();
      const recorded = await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 500000, method: 'CASH' })
        .expect(201);
      const paymentId = recorded.body.payment.id;

      const voided = await http()
        .post(`/api/fees/payments/${paymentId}/void`)
        .set(auth)
        .send({ reason: 'Cheque bounced' })
        .expect(201);
      expect(voided.body).toMatchObject({ paidAmount: 0, status: 'UNPAID' });

      // Append-only: the row survives, flagged rather than removed.
      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(row.amount).toBe(500000);
      expect(row.voidedAt).not.toBeNull();
      expect(row.voidReason).toBe('Cheque bounced');
    });

    it('refuses to void the same payment twice', async () => {
      const { challan, auth } = await billedStudent();
      const recorded = await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 100000, method: 'CASH' })
        .expect(201);
      const paymentId = recorded.body.payment.id;

      await http()
        .post(`/api/fees/payments/${paymentId}/void`)
        .set(auth)
        .send({})
        .expect(201);
      await http()
        .post(`/api/fees/payments/${paymentId}/void`)
        .set(auth)
        .send({})
        .expect(400);
    });

    it('re-sums correctly when one of several payments is voided', async () => {
      const { challan, auth } = await billedStudent();
      const ids: string[] = [];
      for (const amount of [100000, 150000, 250000]) {
        const r = await http()
          .post(`/api/fees/challans/${challan.id}/payments`)
          .set(auth)
          .send({ amount, method: 'CASH' })
          .expect(201);
        ids.push(r.body.payment.id);
      }
      let fresh = await prisma.challan.findUniqueOrThrow({
        where: { id: challan.id },
      });
      expect(fresh).toMatchObject({ paidAmount: 500000, status: 'PAID' });

      await http()
        .post(`/api/fees/payments/${ids[1]}/void`)
        .set(auth)
        .send({})
        .expect(201);

      fresh = await prisma.challan.findUniqueOrThrow({
        where: { id: challan.id },
      });
      expect(fresh).toMatchObject({
        paidAmount: 350000,
        status: 'PARTIALLY_PAID',
      });
    });

    it('blocks cancelling a challan that still has live payments', async () => {
      const { challan, auth } = await billedStudent();
      const recorded = await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 100000, method: 'CASH' })
        .expect(201);

      // Money attached -> cancellation must be explicit about voiding first.
      await http()
        .post(`/api/fees/challans/${challan.id}/cancel`)
        .set(auth)
        .send({})
        .expect(400);

      await http()
        .post(`/api/fees/payments/${recorded.body.payment.id}/void`)
        .set(auth)
        .send({})
        .expect(201);

      await http()
        .post(`/api/fees/challans/${challan.id}/cancel`)
        .set(auth)
        .send({ reason: 'Issued in error' })
        .expect(201);

      const fresh = await prisma.challan.findUniqueOrThrow({
        where: { id: challan.id },
      });
      expect(fresh.status).toBe('CANCELLED');
      expect(fresh.cancelledAt).not.toBeNull();
    });

    it('lists receipts for a challan, keeping voided ones visible', async () => {
      const { challan, auth } = await billedStudent();
      const r = await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 100000, method: 'CHEQUE', reference: 'CHQ-9' })
        .expect(201);
      await http()
        .post(`/api/fees/payments/${r.body.payment.id}/void`)
        .set(auth)
        .send({})
        .expect(201);
      await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 250000, method: 'ONLINE' })
        .expect(201);

      const list = await http()
        .get(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .expect(200);
      expect(list.body).toHaveLength(2);
      expect(list.body.filter((p: any) => p.voidedAt)).toHaveLength(1);
    });

    it('keeps payments admin-only and tenant-scoped', async () => {
      const { cls, challan } = await billedStudent();
      const teacherToken = await tokenFor(app, cls.teacherUser);
      const studentToken = await tokenFor(app, cls.students[0].user);

      for (const token of [teacherToken, studentToken]) {
        await http()
          .post(`/api/fees/challans/${challan.id}/payments`)
          .set('Authorization', `Bearer ${token}`)
          .send({ amount: 1000, method: 'CASH' })
          .expect(403);
        await http()
          .get(`/api/fees/challans/${challan.id}/payments`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
      }

      const otherSchool = await createTestSchool();
      const otherAdmin = await createTestUser({
        role: Role.SCHOOL_ADMIN,
        schoolId: otherSchool.id,
      });
      const otherToken = await tokenFor(app, otherAdmin);
      await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ amount: 1000, method: 'CASH' })
        .expect(403);

      expect(
        await prisma.payment.count({ where: { challanId: challan.id } }),
      ).toBe(0);
    });

    it('deleting a student with challans is blocked, not cascaded', async () => {
      const { cls, challan } = await billedStudent();
      // Restrict on Challan.studentId — financial history outlives cleanup.
      await expect(
        prisma.studentProfile.delete({
          where: { id: cls.students[0].profile.id },
        }),
      ).rejects.toThrow();
      expect(
        await prisma.challan.findUnique({ where: { id: challan.id } }),
      ).not.toBeNull();
    });
  });

  // ---- Batch status ------------------------------------------------------

  it('returns badge status per student, and refuses teachers', async () => {
    const cls = await seedBillableClass({ studentCount: 2 });
    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send(generateBody(cls))
      .expect(201);

    const ids = cls.students.map((s) => s.profile.id);

    const asAdmin = await http()
      .post('/api/fees/students/status')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send({ studentIds: ids })
      .expect(201);
    // PERIOD is in the past, so the derived state is OVERDUE, not UNPAID —
    // overdue is computed from dueDate at read time, never stored.
    expect(asAdmin.body.statuses[ids[0]]).toMatchObject({
      status: 'OVERDUE',
      outstanding: 500000,
      challanCount: 1,
    });

    // The fee module is gone from the teacher portal — not even their OWN
    // students' badge status is theirs to read.
    const teacherToken = await tokenFor(app, cls.teacherUser);
    await http()
      .post('/api/fees/students/status')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ studentIds: ids })
      .expect(403);
  });

  it('reports a not-yet-due challan as UNPAID, not OVERDUE', async () => {
    const cls = await seedBillableClass({ studentCount: 1 });
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);

    await http()
      .post('/api/fees/challans/generate')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send({
        academicYearId: cls.academicYear.id,
        sectionId: cls.section.id,
        periodYear: future.getUTCFullYear(),
        periodMonth: 6,
      })
      .expect(201);

    const id = cls.students[0].profile.id;
    const res = await http()
      .post('/api/fees/students/status')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send({ studentIds: [id] })
      .expect(201);
    expect(res.body.statuses[id].status).toBe('UNPAID');
  });

  // ---- Arrears carry-forward ---------------------------------------------

  describe('arrears carried onto the next challan', () => {
    /** Bill `periodMonth`, returning the one challan produced. */
    const billMonth = async (
      cls: { adminToken: string; academicYear: { id: string }; section: { id: string } },
      periodMonth: number,
    ) => {
      const res = await http()
        .post('/api/fees/challans/generate')
        .set(`Authorization`, `Bearer ${cls.adminToken}`)
        .send({
          academicYearId: cls.academicYear.id,
          sectionId: cls.section.id,
          periodYear: PERIOD.periodYear,
          periodMonth,
        })
        .expect(201);
      return res.body;
    };

    it('folds last month’s unpaid balance in, and supersedes it', async () => {
      const cls = await seedBillableClass({ studentCount: 1, fee: 500000 });
      await billMonth(cls, 3);
      const jan = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id, periodMonth: 3 },
      });

      await billMonth(cls, 4);
      const feb = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id, periodMonth: 4 },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });

      // The new bill is this month PLUS the carried balance.
      expect(feb.netAmount).toBe(1000000);
      const arrearsItem = feb.items.find((i) => i.label.startsWith('Arrears'));
      expect(arrearsItem?.amount).toBe(500000);

      // ...and the old one is superseded, naming its successor.
      const superseded = await prisma.challan.findUniqueOrThrow({
        where: { id: jan.id },
      });
      expect(superseded.status).toBe('CANCELLED');
      expect(superseded.cancelReason).toBe(
        `Carried forward to ${feb.challanNo}`,
      );
    });

    // THE rule: carrying forward must never make a student owe it twice.
    it('does not double-bill — outstanding stays the true figure', async () => {
      const cls = await seedBillableClass({ studentCount: 1, fee: 500000 });
      const studentId = cls.students[0].profile.id;
      await billMonth(cls, 3);
      await billMonth(cls, 4);

      const res = await http()
        .get(`/api/fees/students/${studentId}/challans`)
        .set(`Authorization`, `Bearer ${cls.adminToken}`)
        .expect(200);

      // Two months billed at 500,000 each = 1,000,000 owed. NOT 1,500,000.
      expect(res.body.summary.outstanding).toBe(1000000);
      expect(res.body.summary.totalBilled).toBe(1000000);
    });

    it('accumulates across several unpaid months', async () => {
      const cls = await seedBillableClass({ studentCount: 1, fee: 500000 });
      await billMonth(cls, 3);
      await billMonth(cls, 4);
      await billMonth(cls, 5);

      const may = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id, periodMonth: 5 },
      });
      // 500k own + 1,000k carried (April already carried March).
      expect(may.netAmount).toBe(1500000);

      const live = await prisma.challan.findMany({
        where: { schoolId: cls.school.id, status: { not: 'CANCELLED' } },
      });
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(may.id);
    });

    // Cancelling a part-paid challan would drop its payment out of totalPaid,
    // erasing money the school actually received.
    it('leaves a PART-PAID challan alone', async () => {
      const cls = await seedBillableClass({ studentCount: 1, fee: 500000 });
      await billMonth(cls, 3);
      const jan = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id, periodMonth: 3 },
      });
      await http()
        .post(`/api/fees/challans/${jan.id}/payments`)
        .set(`Authorization`, `Bearer ${cls.adminToken}`)
        .send({ amount: 200000, method: 'CASH' })
        .expect(201);

      await billMonth(cls, 4);
      const feb = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id, periodMonth: 4 },
      });

      // February bills only February; January stays open and part-paid.
      expect(feb.netAmount).toBe(500000);
      const stillOpen = await prisma.challan.findUniqueOrThrow({
        where: { id: jan.id },
      });
      expect(stillOpen.status).toBe('PARTIALLY_PAID');
      expect(stillOpen.paidAmount).toBe(200000);

      const res = await http()
        .get(`/api/fees/students/${cls.students[0].profile.id}/challans`)
        .set(`Authorization`, `Bearer ${cls.adminToken}`)
        .expect(200);
      // The 200,000 received is still counted.
      expect(res.body.summary.totalPaid).toBe(200000);
      expect(res.body.summary.outstanding).toBe(800000);
    });

    it('never discounts the carried amount', async () => {
      const cls = await seedBillableClass({ studentCount: 1, fee: 500000 });
      const discount = await prisma.discount.create({
        data: {
          schoolId: cls.school.id,
          name: 'Sibling 10%',
          type: 'PERCENT',
          value: 10,
        },
      });
      await prisma.studentProfile.update({
        where: { id: cls.students[0].profile.id },
        data: { discountId: discount.id },
      });

      await billMonth(cls, 3);
      await billMonth(cls, 4);
      const feb = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id, periodMonth: 4 },
      });

      // March billed 500k less 10% = 450k, carried whole.
      // April = 500k less 10% = 450k, plus 450k arrears = 900k.
      expect(feb.discountAmount).toBe(50000);
      expect(feb.netAmount).toBe(900000);
    });

    it('carries nothing when the previous challan was paid', async () => {
      const cls = await seedBillableClass({ studentCount: 1, fee: 500000 });
      await billMonth(cls, 3);
      const jan = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id, periodMonth: 3 },
      });
      await http()
        .post(`/api/fees/challans/${jan.id}/payments`)
        .set(`Authorization`, `Bearer ${cls.adminToken}`)
        .send({ amount: 500000, method: 'CASH' })
        .expect(201);

      await billMonth(cls, 4);
      const feb = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id, periodMonth: 4 },
      });
      expect(feb.netAmount).toBe(500000);
      expect(
        (await prisma.challan.findUniqueOrThrow({ where: { id: jan.id } }))
          .status,
      ).toBe('PAID');
    });

    it('shows the carry-forward in the preview before anything is written', async () => {
      const cls = await seedBillableClass({ studentCount: 1, fee: 500000 });
      await billMonth(cls, 3);
      const jan = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id, periodMonth: 3 },
      });

      const res = await http()
        .post('/api/fees/challans/preview')
        .set(`Authorization`, `Bearer ${cls.adminToken}`)
        .send({
          academicYearId: cls.academicYear.id,
          sectionId: cls.section.id,
          periodYear: PERIOD.periodYear,
          periodMonth: 4,
        })
        .expect(201);

      expect(res.body.willGenerate[0].arrearsAmount).toBe(500000);
      expect(res.body.willGenerate[0].supersedes).toEqual([jan.challanNo]);
      expect(res.body.totals.arrearsAmount).toBe(500000);
      // A preview writes nothing.
      expect(
        (await prisma.challan.findUniqueOrThrow({ where: { id: jan.id } }))
          .status,
      ).toBe('UNPAID');
    });

    it('leaves installment students out of it', async () => {
      const cls = await seedBillableClass({ studentCount: 1, fee: 500000 });
      await billMonth(cls, 3);
      await http()
        .put(
          `/api/fees/students/${cls.students[0].profile.id}/installment-plan`,
        )
        .set(`Authorization`, `Bearer ${cls.adminToken}`)
        .send({
          academicYearId: cls.academicYear.id,
          totalAmount: 400000,
          startDate: '2026-09-01',
          installments: [
            { amount: 200000, dueDate: '2026-09-10' },
            { amount: 200000, dueDate: '2026-11-10' },
          ],
        })
        .expect(200);

      // Installment challans bill their plan row exactly — no arrears folded in.
      const res = await http()
        .post('/api/fees/challans/generate')
        .set(`Authorization`, `Bearer ${cls.adminToken}`)
        .send({
          academicYearId: cls.academicYear.id,
          sectionId: cls.section.id,
          generationType: 'INSTALLMENT',
          installmentSeq: 1,
        })
        .expect(201);
      expect(res.body.generated).toBe(1);

      const inst = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id, generationType: 'INSTALLMENT' },
      });
      expect(inst.netAmount).toBe(200000);
    });
  });

  // ---- Class-wide generation + bulk print --------------------------------

  describe('class-wide generation and bulk print', () => {
    /** One class, two sections, students in each. */
    async function twoSections() {
      const cls = await seedBillableClass({ studentCount: 2, fee: 500000 });
      const sectionB = await prisma.section.create({
        data: {
          name: 'B',
          schoolId: cls.school.id,
          classGradeId: cls.classGrade.id,
        },
      });
      const extra = await createTestUser({
        role: Role.STUDENT,
        schoolId: cls.school.id,
      });
      const profile = await prisma.studentProfile.create({
        data: {
          userId: extra.id,
          schoolId: cls.school.id,
          fullName: 'Section B Student',
          rollNo: 'B-1',
          monthlyFeeAmount: 500000,
        },
      });
      await prisma.enrollment.create({
        data: {
          studentId: profile.id,
          sectionId: sectionB.id,
          academicYearId: cls.academicYear.id,
          status: 'ACTIVE',
        },
      });
      return { cls, sectionB, sectionBStudent: profile };
    }

    const genClass = (cls: {
      adminToken: string;
      academicYear: { id: string };
      classGrade: { id: string };
    }) =>
      http()
        .post('/api/fees/challans/generate')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send({
          academicYearId: cls.academicYear.id,
          classGradeId: cls.classGrade.id,
          ...PERIOD,
        });

    it('bills every section of a class in one run', async () => {
      const { cls, sectionB, sectionBStudent } = await twoSections();
      const res = await genClass(cls).expect(201);

      // 2 in section A + 1 in section B.
      expect(res.body.generated).toBe(3);
      const challans = await prisma.challan.findMany({
        where: { schoolId: cls.school.id },
      });
      // Each challan snapshots ITS OWN section, not the batch's first.
      const forB = challans.find((c) => c.studentId === sectionBStudent.id)!;
      expect(forB.sectionId).toBe(sectionB.id);
      expect(forB.sectionName).toBe('B');
      expect(
        challans.filter((c) => c.sectionId === cls.section.id),
      ).toHaveLength(2);
    });

    it('refuses a run with neither a section nor a class', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const res = await http()
        .post('/api/fees/challans/generate')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send({ academicYearId: cls.academicYear.id, ...PERIOD })
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/section|class/i);
    });

    it('resolves a class in a CONSTANT number of queries, however many sections', async () => {
      const svc = app.get(PrismaService);
      async function countFor(sectionCount: number) {
        const cls = await seedBillableClass({ studentCount: 1, fee: 500000 });
        for (let i = 0; i < sectionCount - 1; i++) {
          const sec = await prisma.section.create({
            data: {
              name: `S${i}`,
              schoolId: cls.school.id,
              classGradeId: cls.classGrade.id,
            },
          });
          const u = await createTestUser({
            role: Role.STUDENT,
            schoolId: cls.school.id,
          });
          const prof = await prisma.studentProfile.create({
            data: {
              userId: u.id,
              schoolId: cls.school.id,
              fullName: `S${i} Student`,
              rollNo: `S${i}-1`,
              monthlyFeeAmount: 500000,
            },
          });
          await prisma.enrollment.create({
            data: {
              studentId: prof.id,
              sectionId: sec.id,
              academicYearId: cls.academicYear.id,
              status: 'ACTIVE',
            },
          });
        }

        let calls = 0;
        const original = svc.enrollment.findMany.bind(svc.enrollment);
        svc.enrollment.findMany = (...a: unknown[]) => {
          calls += 1;
          return original(...a);
        };
        try {
          const res = await http()
            .post('/api/fees/challans/preview')
            .set('Authorization', `Bearer ${cls.adminToken}`)
            .send({
              academicYearId: cls.academicYear.id,
              classGradeId: cls.classGrade.id,
              ...PERIOD,
            })
            .expect(201);
          return { calls, willGenerate: res.body.counts.willGenerate };
        } finally {
          svc.enrollment.findMany = original;
        }
      }

      const small = await countFor(2);
      await resetDb();
      const large = await countFor(6);
      expect(small.willGenerate).toBe(2);
      expect(large.willGenerate).toBe(6);
      // 3x the sections, the same single roster query.
      expect(small.calls).toBe(1);
      expect(large.calls).toBe(1);
    });

    it('returns full print detail for a class in one request', async () => {
      const { cls } = await twoSections();
      await genClass(cls).expect(201);

      const res = await http()
        .get(
          `/api/fees/challans/print?classGradeId=${cls.classGrade.id}&periodYear=${PERIOD.periodYear}&periodMonth=${PERIOD.periodMonth}`,
        )
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .expect(200);

      expect(res.body.total).toBe(3);
      // Everything the print layout needs, without a per-challan fetch.
      const first = res.body.items[0];
      expect(first.items.length).toBeGreaterThan(0);
      expect(first.school.currency).toBeTruthy();
      expect(first.academicYear.name).toBeTruthy();
      expect(first).toHaveProperty('balance');
    });

    it('skips settled challans when printing, and says how many', async () => {
      const { cls } = await twoSections();
      await genClass(cls).expect(201);

      // Settle one of the three.
      const paid = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id },
      });
      await http()
        .post(`/api/fees/challans/${paid.id}/payments`)
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send({ amount: paid.netAmount, method: 'CASH' })
        .expect(201);

      const res = await http()
        .get(
          `/api/fees/challans/print?classGradeId=${cls.classGrade.id}&periodYear=${PERIOD.periodYear}&periodMonth=${PERIOD.periodMonth}`,
        )
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .expect(200);

      expect(res.body.total).toBe(2);
      expect(res.body.skippedPaid).toBe(1);
      expect(
        res.body.items.map((i: { id: string }) => i.id),
      ).not.toContain(paid.id);
    });

    // An explicit status=PAID filter must not smuggle settled challans back in.
    it('prints nothing when the filter asks only for paid challans', async () => {
      const { cls } = await twoSections();
      await genClass(cls).expect(201);
      const paid = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id },
      });
      await http()
        .post(`/api/fees/challans/${paid.id}/payments`)
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send({ amount: paid.netAmount, method: 'CASH' })
        .expect(201);

      const res = await http()
        .get(
          `/api/fees/challans/print?classGradeId=${cls.classGrade.id}&status=PAID`,
        )
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .expect(200);
      expect(res.body.total).toBe(0);
      expect(res.body.skippedPaid).toBe(1);
    });

    it('keeps bulk print admin-only and tenant-scoped', async () => {
      const { cls } = await twoSections();
      await genClass(cls).expect(201);

      // A teacher has no business printing the school's bills.
      const teacher = await createTestUser({
        role: Role.TEACHER,
        schoolId: cls.school.id,
      });
      await http()
        .get('/api/fees/challans/print')
        .set('Authorization', `Bearer ${await tokenFor(app, teacher)}`)
        .expect(403);

      // Another school's admin sees none of it.
      const other = await seedClass({ studentCount: 1 });
      const otherAdmin = await createTestUser({
        role: Role.SCHOOL_ADMIN,
        schoolId: other.school.id,
      });
      const res = await http()
        .get(`/api/fees/challans/print?classGradeId=${cls.classGrade.id}`)
        .set('Authorization', `Bearer ${await tokenFor(app, otherAdmin)}`)
        .expect(200);
      expect(res.body.total).toBe(0);
    });
  });

  // ---- Reports -----------------------------------------------------------

  describe('reports', () => {
    /** 3 students billed 500000 each; one fully paid, one partial. */
    async function reportFixture() {
      const cls = await seedBillableClass({ studentCount: 3 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };
      await http()
        .post('/api/fees/challans/generate')
        .set(auth)
        .send(generateBody(cls))
        .expect(201);

      const challans = await prisma.challan.findMany({
        where: { schoolId: cls.school.id },
        orderBy: { challanNo: 'asc' },
      });
      await http()
        .post(`/api/fees/challans/${challans[0].id}/payments`)
        .set(auth)
        .send({ amount: 500000, method: 'CASH' })
        .expect(201);
      await http()
        .post(`/api/fees/challans/${challans[1].id}/payments`)
        .set(auth)
        .send({ amount: 200000, method: 'CASH' })
        .expect(201);

      return { cls, auth, challans };
    }

    it('summarises expected, collected, pending and collection rate', async () => {
      const { auth } = await reportFixture();
      const res = await http()
        .get('/api/fees/reports/summary')
        .set(auth)
        .expect(200);

      expect(res.body).toMatchObject({
        totalExpected: 1500000,
        totalCollected: 700000,
        totalPending: 800000,
        challanCount: 3,
        paidCount: 1,
        partiallyPaidCount: 1,
        unpaidCount: 1,
      });
      // 700000/1500000 = 46.666... -> 46.7
      expect(res.body.collectionRate).toBeCloseTo(46.7, 1);
    });

    it('excludes cancelled challans from the totals', async () => {
      const { auth, challans } = await reportFixture();
      await http()
        .post(`/api/fees/challans/${challans[2].id}/cancel`)
        .set(auth)
        .send({})
        .expect(201);

      const res = await http()
        .get('/api/fees/reports/summary')
        .set(auth)
        .expect(200);
      // The cancelled 500000 drops out of expected entirely.
      expect(res.body.totalExpected).toBe(1000000);
      expect(res.body.challanCount).toBe(2);
      // ...but it is still countable: the dashboard distinguishes "ever issued"
      // from "live", which the old always-zero cancelledCount could not.
      expect(res.body.cancelledCount).toBe(1);
      expect(res.body.totalChallanCount).toBe(3);
    });

    it('counts receipts awaiting verification for the dashboard', async () => {
      const { auth, cls, challans } = await reportFixture();
      expect(
        (await http().get('/api/fees/reports/summary').set(auth).expect(200))
          .body.pendingVerificationCount,
      ).toBe(0);

      // challans[2] is the untouched one; authenticate as whoever owns it.
      const owner = cls.students.find(
        (s) => s.profile.id === challans[2].studentId,
      )!;
      const studentToken = await tokenFor(app, owner.user);
      await http()
        .post(`/api/fees/challans/${challans[2].id}/payment-submissions`)
        .set('Authorization', `Bearer ${studentToken}`)
        .field('amount', '100000')
        .field('method', 'BANK_TRANSFER')
        .field('paidAt', '2026-03-05')
        .attach(
          'receipt',
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
            'base64',
          ),
          { filename: 'r.png', contentType: 'image/png' },
        )
        .expect(201);

      // Submitting busts the report cache, so the count is not stale.
      const after = await http()
        .get('/api/fees/reports/summary')
        .set(auth)
        .expect(200);
      expect(after.body.pendingVerificationCount).toBe(1);
    });

    it('returns a chronological billed-vs-collected trend', async () => {
      const { auth } = await reportFixture();
      const res = await http()
        .get('/api/fees/reports/collection-trend')
        .set(auth)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toMatchObject({
        periodYear: PERIOD.periodYear,
        periodMonth: PERIOD.periodMonth,
        billed: 1500000,
        collected: 700000,
      });
    });

    it('carves overdue out of unpaid/partial so the segments sum to the total', async () => {
      const { auth } = await reportFixture();
      const res = await http()
        .get('/api/fees/reports/status-breakdown')
        .set(auth)
        .expect(200);

      const total = res.body.reduce(
        (n: number, s: { count: number }) => n + s.count,
        0,
      );
      expect(total).toBe(3);
      // PERIOD is in the past, so the two unsettled challans read as OVERDUE.
      const byStatus = Object.fromEntries(
        res.body.map((s: { status: string; count: number }) => [
          s.status,
          s.count,
        ]),
      );
      expect(byStatus.PAID).toBe(1);
      expect(byStatus.OVERDUE).toBe(2);
      expect(byStatus.UNPAID).toBe(0);
      expect(byStatus.PARTIALLY_PAID).toBe(0);
    });

    it('reports expected vs collected per class', async () => {
      const { auth, cls } = await reportFixture();
      const res = await http()
        .get('/api/fees/reports/by-class')
        .set(auth)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        className: cls.classGrade.name,
        expected: 1500000,
        collected: 700000,
        challans: 3,
      });
    });

    it('ranks outstanding balances, excluding settled students', async () => {
      const { auth } = await reportFixture();
      const res = await http()
        .get('/api/fees/reports/outstanding')
        .set(auth)
        .expect(200);

      // The fully-paid student drops off; the rest rank by amount owed.
      expect(res.body).toHaveLength(2);
      expect(res.body[0].outstanding).toBe(500000);
      expect(res.body[1].outstanding).toBe(300000);
      expect(res.body[0].fullName).toBeTruthy();
    });

    it('keeps reports admin-only and tenant-scoped', async () => {
      const { cls } = await reportFixture();
      const teacherToken = await tokenFor(app, cls.teacherUser);
      const studentToken = await tokenFor(app, cls.students[0].user);

      for (const token of [teacherToken, studentToken]) {
        await http()
          .get('/api/fees/reports/summary')
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
      }

      const otherSchool = await createTestSchool();
      const otherAdmin = await createTestUser({
        role: Role.SCHOOL_ADMIN,
        schoolId: otherSchool.id,
      });
      const otherToken = await tokenFor(app, otherAdmin);
      const isolated = await http()
        .get('/api/fees/reports/summary')
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(200);
      // Another tenant sees zeroes, never this school's money.
      expect(isolated.body.totalExpected).toBe(0);
      expect(isolated.body.challanCount).toBe(0);
    });

    // ---- Global report filters -------------------------------------------

    describe('filters', () => {
      const report = (token: string, ep: string, qs = '') =>
        http()
          .get(`/api/fees/reports/${ep}${qs}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

      it('resolves each preset to a window and echoes the boundaries', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        for (const [preset, gran] of [
          ['WEEK', 'DAY'],
          ['FORTNIGHT', 'DAY'],
          ['QUARTER', 'WEEK'],
          ['HALF_YEAR', 'MONTH'],
          ['YEAR', 'MONTH'],
        ] as const) {
          const res = await report(
            cls.adminToken,
            'summary',
            `?preset=${preset}`,
          );
          expect(res.body.window).toMatchObject({ preset, granularity: gran });
          expect(res.body.window.from <= res.body.window.to).toBe(true);
        }
      });

      it('reports no window when nothing date-bound is asked for', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        const res = await report(cls.adminToken, 'summary');
        expect(res.body.window).toBeNull();
      });

      it('a custom range narrows every report, and excludes what falls outside', async () => {
        const cls = await seedBillableClass({ studentCount: 3 });
        await http()
          .post('/api/fees/challans/generate')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(generateBody(cls))
          .expect(201);

        // Park the challans on a known issue date so the window is exact.
        await prisma.challan.updateMany({
          where: { schoolId: cls.school.id },
          data: { issueDate: new Date(Date.UTC(2026, 2, 10)) },
        });

        const inside = await report(
          cls.adminToken,
          'summary',
          '?from=2026-03-01&to=2026-03-31',
        );
        expect(inside.body.challanCount).toBe(3);

        const outside = await report(
          cls.adminToken,
          'summary',
          '?from=2026-04-01&to=2026-04-30',
        );
        expect(outside.body.challanCount).toBe(0);
        expect(outside.body.totalExpected).toBe(0);

        // The same window must reach the other reports too.
        const byClass = await report(
          cls.adminToken,
          'by-class',
          '?from=2026-04-01&to=2026-04-30',
        );
        expect(byClass.body).toHaveLength(0);
        const outstanding = await report(
          cls.adminToken,
          'outstanding',
          '?from=2026-04-01&to=2026-04-30',
        );
        expect(outstanding.body.rows ?? outstanding.body).toHaveLength(0);
      });

      it('a custom range overrides a preset, matching the documented precedence', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        const res = await report(
          cls.adminToken,
          'summary',
          '?preset=YEAR&from=2026-03-01&to=2026-03-31',
        );
        expect(res.body.window).toMatchObject({
          from: '2026-03-01',
          to: '2026-03-31',
          preset: null,
        });
      });

      it('combines class + section + academic year + range', async () => {
        const cls = await seedBillableClass({ studentCount: 2 });
        await http()
          .post('/api/fees/challans/generate')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(generateBody(cls))
          .expect(201);
        await prisma.challan.updateMany({
          where: { schoolId: cls.school.id },
          data: { issueDate: new Date(Date.UTC(2026, 2, 10)) },
        });

        const qs = (sectionId: string) =>
          `?academicYearId=${cls.academicYear.id}` +
          `&classGradeId=${cls.classGrade.id}` +
          `&sectionId=${sectionId}` +
          `&from=2026-03-01&to=2026-03-31`;

        const hit = await report(cls.adminToken, 'summary', qs(cls.section.id));
        expect(hit.body.challanCount).toBe(2);

        // One wrong facet is enough to empty the result. Built as a fresh query
        // rather than appended — a repeated key arrives as an array and 400s.
        const other = await seedClass({ studentCount: 1 });
        const miss = await report(
          cls.adminToken,
          'summary',
          qs(other.section.id),
        );
        expect(miss.body.challanCount).toBe(0);
      });

      it('buckets the trend by day for a short window and by month for a long one', async () => {
        const cls = await seedBillableClass({ studentCount: 2 });
        await http()
          .post('/api/fees/challans/generate')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(generateBody(cls))
          .expect(201);

        const challans = await prisma.challan.findMany({
          where: { schoolId: cls.school.id },
          select: { id: true },
        });
        // Two different days inside one month.
        await prisma.challan.update({
          where: { id: challans[0].id },
          data: { issueDate: new Date(Date.UTC(2026, 2, 10)) },
        });
        await prisma.challan.update({
          where: { id: challans[1].id },
          data: { issueDate: new Date(Date.UTC(2026, 2, 20)) },
        });

        const daily = await report(
          cls.adminToken,
          'collection-trend',
          '?from=2026-03-01&to=2026-03-31',
        );
        expect(daily.body).toHaveLength(2); // one bucket per day
        expect(daily.body[0].granularity).toBe('DAY');
        expect(daily.body[0].bucket < daily.body[1].bucket).toBe(true);

        const monthly = await report(
          cls.adminToken,
          'collection-trend',
          '?from=2025-03-01&to=2026-03-31',
        );
        expect(monthly.body[0].granularity).toBe('MONTH');
        // Both challans collapse into the single March bucket.
        expect(monthly.body).toHaveLength(1);
      });

      it('applies the billing period to the windowed trend, so the chart and the cards agree', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        const gen = (periodMonth: number) =>
          http()
            .post('/api/fees/challans/generate')
            .set('Authorization', `Bearer ${cls.adminToken}`)
            .send({ ...generateBody(cls), periodMonth })
            .expect(201);
        await gen(3);
        // Settle March first: an unpaid March would be carried into April and
        // superseded, leaving only one live challan to compare.
        const march = await prisma.challan.findFirstOrThrow({
          where: { schoolId: cls.school.id, periodMonth: 3 },
        });
        await http()
          .post(`/api/fees/challans/${march.id}/payments`)
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send({ amount: march.netAmount, method: 'CASH' })
          .expect(201);
        await gen(4);

        // Both land inside the same date window, so only the billing period
        // tells them apart — which is exactly what the filter is for.
        await prisma.challan.updateMany({
          where: { schoolId: cls.school.id },
          data: { issueDate: new Date(Date.UTC(2026, 2, 10)) },
        });

        const qs =
          '?from=2026-03-01&to=2026-03-31&periodYear=2026&periodMonth=3';
        const [trend, summary] = await Promise.all([
          report(cls.adminToken, 'collection-trend', qs),
          report(cls.adminToken, 'summary', qs),
        ]);

        expect(summary.body.challanCount).toBe(1);
        // The chart used to ignore the period filter and total both challans,
        // putting a number on screen the cards had already excluded.
        const billed = trend.body.reduce(
          (sum: number, p: { billed: number }) => sum + p.billed,
          0,
        );
        expect(billed).toBe(summary.body.totalExpected);
      });

      it('keeps the original billing-period shape when no window is given', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        await http()
          .post('/api/fees/challans/generate')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(generateBody(cls))
          .expect(201);

        const res = await report(cls.adminToken, 'collection-trend');
        expect(res.body[0]).toMatchObject({
          periodYear: PERIOD.periodYear,
          periodMonth: PERIOD.periodMonth,
        });
        expect(res.body[0].granularity).toBeUndefined();
      });

      it('rejects a malformed date and an unknown preset', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        const auth = { Authorization: `Bearer ${cls.adminToken}` };
        await http()
          .get('/api/fees/reports/summary?from=not-a-date')
          .set(auth)
          .expect(400);
        await http()
          .get('/api/fees/reports/summary?preset=DECADE')
          .set(auth)
          .expect(400);
      });

      it('a filtered report is still tenant-scoped', async () => {
        const cls = await seedBillableClass({ studentCount: 2 });
        await http()
          .post('/api/fees/challans/generate')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(generateBody(cls))
          .expect(201);

        const other = await seedClass({ studentCount: 1 });
        const otherAdmin = await createTestUser({
          role: Role.SCHOOL_ADMIN,
          schoolId: other.school.id,
        });
        const res = await report(
          await tokenFor(app, otherAdmin),
          'summary',
          `?preset=YEAR&classGradeId=${cls.classGrade.id}`,
        );
        // Another tenant's class id must not leak this school's figures.
        expect(res.body.challanCount).toBe(0);
      });
    });
  });

  // ---- Read-only portals -------------------------------------------------

  describe('student / parent / teacher read-only views', () => {
    async function portalFixture() {
      const cls = await seedBillableClass({ studentCount: 2 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };
      await http()
        .post('/api/fees/challans/generate')
        .set(auth)
        .send(generateBody(cls))
        .expect(201);

      // Link a parent to student 0.
      const parentUser = await createTestUser({
        role: Role.PARENT,
        schoolId: cls.school.id,
      });
      const parentProfile = await prisma.parentProfile.create({
        data: { userId: parentUser.id, fullName: 'Portal Parent' },
      });
      await prisma.parentStudent.create({
        data: {
          parentId: parentProfile.id,
          studentId: cls.students[0].profile.id,
        },
      });

      return { cls, auth, parentUser };
    }

    it('lets a student read their own fee history via /fees/me', async () => {
      const { cls } = await portalFixture();
      const token = await tokenFor(app, cls.students[0].user);

      const res = await http()
        .get('/api/fees/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.student.id).toBe(cls.students[0].profile.id);
      expect(res.body.challans).toHaveLength(1);
      expect(res.body.summary).toMatchObject({
        totalBilled: 500000,
        totalPaid: 0,
        outstanding: 500000,
      });
      expect(res.body.currency).toBeTruthy();
    });

    it("lets a parent read their child's fees, and lists their children", async () => {
      const { cls, parentUser } = await portalFixture();
      const token = await tokenFor(app, parentUser);

      const children = await http()
        .get('/api/fees/me/children')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(children.body).toHaveLength(1);
      expect(children.body[0].id).toBe(cls.students[0].profile.id);

      const mine = await http()
        .get(`/api/fees/me?studentId=${cls.students[0].profile.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(mine.body.student.id).toBe(cls.students[0].profile.id);

      // A child they are NOT linked to is refused.
      await http()
        .get(`/api/fees/me?studentId=${cls.students[1].profile.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('refuses a teacher entirely — the fee module is not theirs', async () => {
      const { cls } = await portalFixture();
      const teacherToken = await tokenFor(app, cls.teacherUser);

      // Their OWN section’s student, and still refused.
      await http()
        .get(`/api/fees/students/${cls.students[0].profile.id}/challans`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(403);
    });

    it("blocks a student from reading another student's history", async () => {
      const { cls } = await portalFixture();
      const token = await tokenFor(app, cls.students[0].user);
      await http()
        .get(`/api/fees/students/${cls.students[1].profile.id}/challans`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    // Backs the portal "View Challan" action: the row links carry only a
    // challan id, so GET /fees/challans/:id is the whole authorization.
    it("lets a parent open their child's challan but not another child's", async () => {
      const { cls, parentUser } = await portalFixture();
      const token = await tokenFor(app, parentUser);

      const own = await prisma.challan.findFirstOrThrow({
        where: { studentId: cls.students[0].profile.id },
      });
      const other = await prisma.challan.findFirstOrThrow({
        where: { studentId: cls.students[1].profile.id },
      });

      const ok = await http()
        .get(`/api/fees/challans/${own.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // The read-only detail + print layout need these fields.
      expect(ok.body.items.length).toBeGreaterThan(0);
      expect(ok.body.school.currency).toBeTruthy();
      expect(ok.body.academicYear.name).toBeTruthy();

      // Swapping the id in the URL is the attack this must refuse.
      await http()
        .get(`/api/fees/challans/${other.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('keeps the receipts ledger admin-only for a parent', async () => {
      const { cls, parentUser } = await portalFixture();
      const token = await tokenFor(app, parentUser);
      const own = await prisma.challan.findFirstOrThrow({
        where: { studentId: cls.students[0].profile.id },
      });

      // This is why ChallanReadOnlyView must not fetch receipts.
      await http()
        .get(`/api/fees/challans/${own.id}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('gives students and parents NO write access anywhere', async () => {
      const { cls, parentUser } = await portalFixture();
      const studentToken = await tokenFor(app, cls.students[0].user);
      const parentToken = await tokenFor(app, parentUser);
      const challan = await prisma.challan.findFirstOrThrow({
        where: { studentId: cls.students[0].profile.id },
      });

      for (const token of [studentToken, parentToken]) {
        const h = { Authorization: `Bearer ${token}` };
        await http()
          .post('/api/fees/challans/generate')
          .set(h)
          .send(generateBody(cls))
          .expect(403);
        await http()
          .post(`/api/fees/challans/${challan.id}/payments`)
          .set(h)
          .send({ amount: 1, method: 'CASH' })
          .expect(403);
        await http()
          .post(`/api/fees/challans/${challan.id}/cancel`)
          .set(h)
          .send({})
          .expect(403);
        await http()
          .post('/api/fees/heads')
          .set(h)
          .send({ name: 'X', defaultAmount: 1 })
          .expect(403);
        await http()
          .patch('/api/fees/settings')
          .set(h)
          .send({ feeDueDayOfMonth: 5 })
          .expect(403);
      }
    });
  });

  // ---- Notifications -----------------------------------------------------

  describe('notifications', () => {
    /** The listener writes asynchronously off the event bus. */
    const settle = () => new Promise((r) => setTimeout(r, 500));

    /** A billable class whose FIRST student has a linked guardian. */
    async function notifyFixture(opts: { studentCount?: number } = {}) {
      const cls = await seedBillableClass({
        studentCount: opts.studentCount ?? 1,
      });
      const parentUser = await createTestUser({
        role: Role.PARENT,
        schoolId: cls.school.id,
      });
      const parentProfile = await prisma.parentProfile.create({
        data: { userId: parentUser.id, fullName: 'Notify Parent' },
      });
      await prisma.parentStudent.create({
        data: {
          parentId: parentProfile.id,
          studentId: cls.students[0].profile.id,
        },
      });
      return { cls, parentUser, parentProfile };
    }

    it('notifies the student and their guardian when a challan is issued', async () => {
      const { cls, parentUser } = await notifyFixture({ studentCount: 1 });

      await http()
        .post('/api/fees/challans/generate')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send(generateBody(cls))
        .expect(201);

      await settle();
      const notes = await prisma.notification.findMany({
        where: { type: 'FEE_CHALLAN_ISSUED' },
        select: { userId: true },
      });
      const recipients = new Set(notes.map((n) => n.userId));
      expect(recipients.has(cls.students[0].user.id)).toBe(true);
      expect(recipients.has(parentUser.id)).toBe(true);
    });

    it('notifies on a recorded payment', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };
      await http()
        .post('/api/fees/challans/generate')
        .set(auth)
        .send(generateBody(cls))
        .expect(201);
      const challan = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id },
      });

      await http()
        .post(`/api/fees/challans/${challan.id}/payments`)
        .set(auth)
        .send({ amount: 100000, method: 'CASH' })
        .expect(201);

      await settle();
      const notes = await prisma.notification.findMany({
        where: {
          type: 'FEE_PAYMENT_RECEIVED',
          userId: cls.students[0].user.id,
        },
      });
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0].body).toMatch(challan.challanNo);
      // Deep link to the challan, portal-relative.
      expect(notes[0].link).toBe(`/fees/${challan.id}`);
    });

    it('personalises each challan notification with student, amount and link', async () => {
      const { cls, parentUser } = await notifyFixture({ studentCount: 2 });
      await http()
        .post('/api/fees/challans/generate')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send(generateBody(cls))
        .expect(201);
      await settle();

      const own = await prisma.challan.findFirstOrThrow({
        where: { studentId: cls.students[0].profile.id },
      });
      const note = await prisma.notification.findFirstOrThrow({
        where: { type: 'FEE_CHALLAN_ISSUED', userId: parentUser.id },
      });

      // Names the student, states the amount, and links to THAT challan.
      expect(note.body).toContain(cls.students[0].profile.fullName);
      expect(note.body).toMatch(/5,000\.00/);
      expect(note.link).toBe(`/fees/${own.id}`);
      expect(note.entityType).toBe('Challan');
      expect(note.entityId).toBe(own.id);

      // Each student's own notification carries their own challan.
      const studentNote = await prisma.notification.findFirstOrThrow({
        where: {
          type: 'FEE_CHALLAN_ISSUED',
          userId: cls.students[1].user.id,
        },
      });
      const otherChallan = await prisma.challan.findFirstOrThrow({
        where: { studentId: cls.students[1].profile.id },
      });
      expect(studentNote.link).toBe(`/fees/${otherChallan.id}`);
    });

    it('does NOT duplicate when generation is re-run or raced', async () => {
      const { cls } = await notifyFixture({ studentCount: 2 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };
      const body = generateBody(cls);

      await http()
        .post('/api/fees/challans/generate')
        .set(auth)
        .send(body)
        .expect(201);
      await settle();
      const afterFirst = await prisma.notification.count({
        where: { type: 'FEE_CHALLAN_ISSUED' },
      });

      // A re-run finds everyone already billed -> nothing generated, nobody notified.
      await http()
        .post('/api/fees/challans/generate')
        .set(auth)
        .send(body)
        .expect(201);
      // Three concurrent requests: two lose the race and must stay silent.
      await Promise.all(
        Array.from({ length: 3 }, () =>
          http().post('/api/fees/challans/generate').set(auth).send(body),
        ),
      );
      await settle();

      expect(
        await prisma.notification.count({
          where: { type: 'FEE_CHALLAN_ISSUED' },
        }),
      ).toBe(afterFirst);
    });

    it('notifies student and guardian when the monthly fee changes', async () => {
      const { cls, parentUser } = await notifyFixture({ studentCount: 1 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };
      const userId = cls.students[0].user.id;

      await http()
        .patch(`/api/users/${userId}`)
        .set(auth)
        .send({ monthlyFeeAmount: 750000 })
        .expect(200);
      await settle();

      const notes = await prisma.notification.findMany({
        where: { type: 'FEE_ALLOCATION_UPDATED' },
      });
      const recipients = new Set(notes.map((n) => n.userId));
      expect(recipients.has(userId)).toBe(true);
      expect(recipients.has(parentUser.id)).toBe(true);
      expect(notes[0].body).toMatch(/7,500\.00/);
      expect(notes[0].link).toBe('/fees');
    });

    it('does NOT notify when a fee edit changes nothing', async () => {
      const { cls } = await notifyFixture({ studentCount: 1 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };
      const userId = cls.students[0].user.id;

      // Same value the student already has — a retried save must stay silent.
      await http()
        .patch(`/api/users/${userId}`)
        .set(auth)
        .send({ monthlyFeeAmount: 500000 })
        .expect(200);
      // An unrelated edit must not fire a fee notification either.
      await http()
        .patch(`/api/users/${userId}`)
        .set(auth)
        .send({ bloodGroup: 'O+' })
        .expect(200);
      await settle();

      expect(
        await prisma.notification.count({
          where: { type: 'FEE_ALLOCATION_UPDATED' },
        }),
      ).toBe(0);
    });

    it('notifies when individual fee heads change, but not on an identical save', async () => {
      const { cls, parentUser } = await notifyFixture({ studentCount: 1 });
      const auth = { Authorization: `Bearer ${cls.adminToken}` };
      const studentId = cls.students[0].profile.id;
      const head = await prisma.feeHead.create({
        data: {
          schoolId: cls.school.id,
          name: 'Transport',
          defaultAmount: 10000,
        },
      });
      const url = `/api/fees/students/${studentId}/fee-heads`;

      await http()
        .put(url)
        .set(auth)
        .send({ overrides: [{ feeHeadId: head.id, amount: 30000 }] })
        .expect(200);
      await settle();

      const notes = await prisma.notification.findMany({
        where: { type: 'FEE_ALLOCATION_UPDATED' },
      });
      const recipients = new Set(notes.map((n) => n.userId));
      expect(recipients.has(cls.students[0].user.id)).toBe(true);
      expect(recipients.has(parentUser.id)).toBe(true);
      const countAfterChange = notes.length;

      // Re-submitting the identical configuration is a no-op.
      await http()
        .put(url)
        .set(auth)
        .send({ overrides: [{ feeHeadId: head.id, amount: 30000 }] })
        .expect(200);
      await settle();

      expect(
        await prisma.notification.count({
          where: { type: 'FEE_ALLOCATION_UPDATED' },
        }),
      ).toBe(countAfterChange);
    });

    it('never notifies a parent about a child they are not linked to', async () => {
      const { cls, parentUser } = await notifyFixture({ studentCount: 2 });
      // parentUser is linked to students[0] only.
      await http()
        .post('/api/fees/challans/generate')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send(generateBody(cls))
        .expect(201);
      await settle();

      const unlinkedChallan = await prisma.challan.findFirstOrThrow({
        where: { studentId: cls.students[1].profile.id },
      });
      const leaked = await prisma.notification.count({
        where: { userId: parentUser.id, entityId: unlinkedChallan.id },
      });
      expect(leaked).toBe(0);

      // ...and exactly one notification for the child they ARE linked to.
      expect(
        await prisma.notification.count({
          where: { userId: parentUser.id, type: 'FEE_CHALLAN_ISSUED' },
        }),
      ).toBe(1);
    });

    it('does not leak fee notifications across schools', async () => {
      const { cls } = await notifyFixture({ studentCount: 1 });
      const other = await notifyFixture({ studentCount: 1 });

      await http()
        .post('/api/fees/challans/generate')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send(generateBody(cls))
        .expect(201);
      await settle();

      // Nobody in the other school hears about it.
      const outsiders = [
        other.cls.students[0].user.id,
        other.parentUser.id,
        other.cls.adminUser.id,
      ];
      expect(
        await prisma.notification.count({
          where: { userId: { in: outsiders } },
        }),
      ).toBe(0);
    });

    it('respects the notifyGrades preference', async () => {
      const { cls, parentUser } = await notifyFixture({ studentCount: 1 });
      // The student opts out of grade-category notifications; the parent doesn't.
      await prisma.userSettings.create({
        data: { userId: cls.students[0].user.id, notifyGrades: false },
      });

      await http()
        .post('/api/fees/challans/generate')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send(generateBody(cls))
        .expect(201);
      await settle();

      expect(
        await prisma.notification.count({
          where: { userId: cls.students[0].user.id },
        }),
      ).toBe(0);
      expect(
        await prisma.notification.count({ where: { userId: parentUser.id } }),
      ).toBe(1);
    });

    it('writes a whole class in a CONSTANT number of queries (no N+1)', async () => {
      const svc = app.get(PrismaService);

      async function countWritesFor(studentCount: number) {
        const { cls } = await notifyFixture({ studentCount });
        const calls = { settings: 0, createMany: 0 };
        const origSettings = svc.userSettings.findMany.bind(svc.userSettings);
        const origCreate = svc.notification.createMany.bind(svc.notification);
        svc.userSettings.findMany = (...a: unknown[]) => {
          calls.settings += 1;
          return origSettings(...a);
        };
        svc.notification.createMany = (...a: unknown[]) => {
          calls.createMany += 1;
          return origCreate(...a);
        };
        try {
          await http()
            .post('/api/fees/challans/generate')
            .set('Authorization', `Bearer ${cls.adminToken}`)
            .send(generateBody(cls))
            .expect(201);
          await settle();
        } finally {
          svc.userSettings.findMany = origSettings;
          svc.notification.createMany = origCreate;
        }
        const written = await prisma.notification.count({
          where: { type: 'FEE_CHALLAN_ISSUED' },
        });
        return { calls, written };
      }

      const small = await countWritesFor(2);
      await resetDb();
      const large = await countWritesFor(10);

      // 5x the class, identical query counts — one settings read, one write.
      expect(large.calls).toEqual(small.calls);
      expect(small.calls.settings).toBe(1);
      expect(small.calls.createMany).toBe(1);
      // ...while every recipient still got their own personalised row:
      // one per student, plus the guardian linked to the first student.
      expect(small.written).toBe(2 + 1);
      expect(large.written).toBe(10 + 1);
    });
  });

  it('reports a student with no challans as NO_CHALLANS', async () => {
    const cls = await seedBillableClass({ studentCount: 1 });
    const id = cls.students[0].profile.id;

    const res = await http()
      .post('/api/fees/students/status')
      .set('Authorization', `Bearer ${cls.adminToken}`)
      .send({ studentIds: [id] })
      .expect(201);
    expect(res.body.statuses[id]).toMatchObject({
      status: 'NO_CHALLANS',
      outstanding: 0,
      challanCount: 0,
    });
  });

  // ---- Installment plans -------------------------------------------------

  describe('installment plans', () => {
    const settle = () => new Promise((r) => setTimeout(r, 500));

    /** A plan body totalling 30,000 across 3 monthly installments. */
    const planBody = (
      cls: { academicYear: { id: string } },
      overrides: Record<string, unknown> = {},
    ) => ({
      academicYearId: cls.academicYear.id,
      totalAmount: 30000,
      startDate: '2026-09-01',
      installments: [
        { amount: 10000, dueDate: '2026-09-01' },
        { amount: 10000, dueDate: '2026-10-01' },
        { amount: 10000, dueDate: '2026-11-01' },
      ],
      ...overrides,
    });

    const putPlan = (
      cls: { adminToken: string },
      studentId: string,
      body: Record<string, unknown>,
    ) =>
      http()
        .put(`/api/fees/students/${studentId}/installment-plan`)
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send(body);

    describe('validation', () => {
      it('rejects a schedule that does not sum to the total, naming the shortfall', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        const res = await putPlan(
          cls,
          cls.students[0].profile.id,
          planBody(cls, {
            installments: [
              { amount: 10000, dueDate: '2026-09-01' },
              { amount: 10000, dueDate: '2026-10-01' },
            ],
          }),
        ).expect(400);
        expect(res.body.message).toMatch(/short/i);
      });

      it('rejects a negative installment amount', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        await putPlan(
          cls,
          cls.students[0].profile.id,
          planBody(cls, {
            totalAmount: 20000,
            installments: [
              { amount: 30000, dueDate: '2026-09-01' },
              { amount: -10000, dueDate: '2026-10-01' },
            ],
          }),
        ).expect(400);
      });

      // Deliberately unlike monthlyFeeAmount, where 0 IS valid.
      it('rejects a zero installment amount', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        await putPlan(
          cls,
          cls.students[0].profile.id,
          planBody(cls, {
            totalAmount: 10000,
            installments: [
              { amount: 10000, dueDate: '2026-09-01' },
              { amount: 0, dueDate: '2026-10-01' },
            ],
          }),
        ).expect(400);
      });

      it('rejects out-of-order due dates', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        const res = await putPlan(
          cls,
          cls.students[0].profile.id,
          planBody(cls, {
            installments: [
              { amount: 10000, dueDate: '2026-11-01' },
              { amount: 10000, dueDate: '2026-10-01' },
              { amount: 10000, dueDate: '2026-09-01' },
            ],
          }),
        ).expect(400);
        expect(res.body.message).toMatch(/order/i);
      });

      it('rejects a due date before the academic year starts', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        const res = await putPlan(
          cls,
          cls.students[0].profile.id,
          planBody(cls, {
            installments: [
              { amount: 10000, dueDate: '2025-09-01' },
              { amount: 10000, dueDate: '2026-10-01' },
              { amount: 10000, dueDate: '2026-11-01' },
            ],
          }),
        ).expect(400);
        expect(res.body.message).toMatch(/before the academic year/i);
      });

      it('rejects an empty schedule', async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        await putPlan(
          cls,
          cls.students[0].profile.id,
          planBody(cls, { installments: [] }),
        ).expect(400);
      });

      it("rejects another school's academic year", async () => {
        const cls = await seedBillableClass({ studentCount: 1 });
        const other = await seedClass({ studentCount: 1 });
        await putPlan(
          cls,
          cls.students[0].profile.id,
          planBody(cls, { academicYearId: other.academicYear.id }),
        ).expect(400);
      });
    });

    it('creates a plan and derives the schedule', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const res = await putPlan(
        cls,
        cls.students[0].profile.id,
        planBody(cls),
      ).expect(200);

      expect(res.body.plan.totalAmount).toBe(30000);
      expect(res.body.plan.installmentCount).toBe(3);
      expect(res.body.plan.isActive).toBe(true);
      expect(res.body.plan.installments.map((i: any) => i.seq)).toEqual([
        1, 2, 3,
      ]);
      expect(
        res.body.plan.installments.map((i: any) => i.remainingAmount),
      ).toEqual([10000, 10000, 10000]);
    });

    it('replaces rather than appends, and keeps seq contiguous', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const studentId = cls.students[0].profile.id;
      await putPlan(cls, studentId, planBody(cls)).expect(200);

      const res = await putPlan(
        cls,
        studentId,
        planBody(cls, {
          totalAmount: 20000,
          installments: [
            { amount: 12000, dueDate: '2026-09-15' },
            { amount: 8000, dueDate: '2026-12-15' },
          ],
        }),
      ).expect(200);

      expect(res.body.plan.installmentCount).toBe(2);
      expect(res.body.plan.installments.map((i: any) => i.seq)).toEqual([1, 2]);
      // One plan row, not two — the unique constraint is the idempotence key.
      expect(
        await prisma.feeInstallmentPlan.count({ where: { studentId } }),
      ).toBe(1);
      expect(await prisma.feeInstallment.count()).toBe(2);
    });

    it('switches off without discarding the schedule', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const studentId = cls.students[0].profile.id;
      await putPlan(cls, studentId, planBody(cls)).expect(200);

      const res = await putPlan(
        cls,
        studentId,
        planBody(cls, { isActive: false }),
      ).expect(200);
      expect(res.body.plan.isActive).toBe(false);
      expect(res.body.plan.installments).toHaveLength(3);
    });

    /** The dates live on the rows, so any spacing the admin agreed is storable. */
    it('stores whatever spacing the schedule was given', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const res = await putPlan(
        cls,
        cls.students[0].profile.id,
        planBody(cls, {
          installments: [
            { amount: 10000, dueDate: '2026-09-01' },
            { amount: 10000, dueDate: '2026-09-15' },
            { amount: 10000, dueDate: '2026-09-29' },
          ],
        }),
      ).expect(200);
      expect(
        res.body.plan.installments.map((i: { dueDate: string }) =>
          i.dueDate.slice(0, 10),
        ),
      ).toEqual(['2026-09-01', '2026-09-15', '2026-09-29']);
    });

    it('exposes no cadence fields — a plan is a total, a count and rows', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const res = await putPlan(
        cls,
        cls.students[0].profile.id,
        planBody(cls),
      ).expect(200);
      expect(res.body.plan).not.toHaveProperty('intervalUnit');
      expect(res.body.plan).not.toHaveProperty('intervalCount');
      // Each stored row carries exactly what the schedule is made of.
      expect(Object.keys(res.body.plan.installments[0]).sort()).toEqual(
        ['amount', 'dueDate', 'id', 'paidAmount', 'remainingAmount', 'seq', 'status'].sort(),
      );
    });

    it('rejects a cadence field, which is no longer part of a plan', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      await putPlan(
        cls,
        cls.students[0].profile.id,
        planBody(cls, { intervalUnit: 'WEEK' }),
      ).expect(400);
    });

    it(`rejects more than ${6} installments`, async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const res = await putPlan(
        cls,
        cls.students[0].profile.id,
        planBody(cls, {
          totalAmount: 70000,
          installments: Array.from({ length: 7 }, (_, i) => ({
            amount: 10000,
            dueDate: `2026-0${i + 2}-01`,
          })),
        }),
      ).expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/cannot exceed 6/i);
    });

    it('accepts exactly the maximum', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const res = await putPlan(
        cls,
        cls.students[0].profile.id,
        planBody(cls, {
          totalAmount: 60000,
          installments: Array.from({ length: 6 }, (_, i) => ({
            amount: 10000,
            dueDate: `2026-0${i + 2}-01`,
          })),
        }),
      ).expect(200);
      expect(res.body.plan.installments).toHaveLength(6);
    });

    // ---- Installment challan generation ----------------------------------

    describe('installment challans', () => {
      /** A billable class whose students are on a 3-installment plan. */
      async function planned(studentCount = 1) {
        const cls = await seedBillableClass({ studentCount, fee: 300000 });
        for (const s of cls.students) {
          await putPlan(cls, s.profile.id, {
            academicYearId: cls.academicYear.id,
            totalAmount: 300000,
            startDate: '2026-09-01',
            installments: [
              { amount: 100000, dueDate: '2026-09-10' },
              { amount: 100000, dueDate: '2026-11-10' },
              { amount: 100000, dueDate: '2027-01-10' },
            ],
          }).expect(200);
        }
        return cls;
      }

      const genInstallment = (
        cls: { adminToken: string; academicYear: { id: string }; section: { id: string } },
        installmentSeq: number,
      ) =>
        http()
          .post('/api/fees/challans/generate')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send({
            academicYearId: cls.academicYear.id,
            sectionId: cls.section.id,
            generationType: 'INSTALLMENT',
            installmentSeq,
          });

      it('bills the row amount and due date, not the monthly fee', async () => {
        const cls = await planned();
        const res = await genInstallment(cls, 1).expect(201);
        expect(res.body.generated).toBe(1);

        const challan = await prisma.challan.findFirstOrThrow({
          where: { schoolId: cls.school.id },
          include: { items: true },
        });
        expect(challan.generationType).toBe('INSTALLMENT');
        expect(challan.netAmount).toBe(100000); // the row, not the 300,000 fee
        expect(challan.installmentSeq).toBe(1);
        expect(challan.dueDate.toISOString().slice(0, 10)).toBe('2026-09-10');
        // The period follows the due date, so it slots into the same
        // one-bill-per-month rule as a normal challan.
        expect([challan.periodYear, challan.periodMonth]).toEqual([2026, 9]);
        expect(challan.items).toHaveLength(1);
        expect(challan.items[0].label).toBe('Installment 1 of 3');
      });

      it('links the plan and the row, so the duplicate rule has something to hold', async () => {
        const cls = await planned();
        await genInstallment(cls, 2).expect(201);
        const challan = await prisma.challan.findFirstOrThrow({
          where: { schoolId: cls.school.id },
        });
        const installment = await prisma.feeInstallment.findFirstOrThrow({
          where: { seq: 2, plan: { studentId: cls.students[0].profile.id } },
        });
        expect(challan.installmentId).toBe(installment.id);
        expect(challan.installmentPlanId).toBe(installment.planId);
      });

      // THE rule: same student + same plan + same installment, only once.
      it('refuses to generate the same installment twice', async () => {
        const cls = await planned();
        await genInstallment(cls, 1).expect(201);

        const again = await genInstallment(cls, 1).expect(201);
        expect(again.body.generated).toBe(0);
        expect(again.body.skippedDetail[0].reason).toBe('ALREADY_GENERATED');
        expect(await prisma.challan.count({ where: { schoolId: cls.school.id } })).toBe(1);
      });

      it('holds the rule at the database level, not just the pre-flight check', async () => {
        const cls = await planned();
        await genInstallment(cls, 1).expect(201);
        const challan = await prisma.challan.findFirstOrThrow({
          where: { schoolId: cls.school.id },
        });
        await expect(
          prisma.challan.create({
            data: {
              ...challan,
              id: undefined,
              challanNo: 'DUP-000001',
              createdAt: undefined,
              updatedAt: undefined,
            },
          }),
        ).rejects.toThrow();
      });

      it('does NOT generate a normal challan for a plan student', async () => {
        const cls = await planned();
        await genInstallment(cls, 1).expect(201);
        const challans = await prisma.challan.findMany({
          where: { schoolId: cls.school.id },
          select: { generationType: true },
        });
        expect(challans).toEqual([{ generationType: 'INSTALLMENT' }]);
      });

      it('skips students with no plan, and says so', async () => {
        const cls = await seedBillableClass({ studentCount: 2, fee: 300000 });
        await putPlan(cls, cls.students[0].profile.id, {
          academicYearId: cls.academicYear.id,
          totalAmount: 200000,
          startDate: '2026-09-01',
          installments: [
            { amount: 100000, dueDate: '2026-09-10' },
            { amount: 100000, dueDate: '2026-11-10' },
          ],
        }).expect(200);

        const res = await genInstallment(cls, 1).expect(201);
        expect(res.body.generated).toBe(1);
        expect(res.body.skippedDetail).toEqual([
          expect.objectContaining({ reason: 'NO_PLAN' }),
        ]);
      });

      it('previews eligibility without writing anything', async () => {
        const cls = await planned(2);
        const res = await http()
          .post('/api/fees/challans/preview')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send({
            academicYearId: cls.academicYear.id,
            sectionId: cls.section.id,
            generationType: 'INSTALLMENT',
            installmentSeq: 1,
          })
          .expect(201);
        expect(res.body.counts.willGenerate).toBe(2);
        expect(res.body.generationType).toBe('INSTALLMENT');
        expect(await prisma.challan.count()).toBe(0);
      });

      it('reports per-row eligibility for a section', async () => {
        const cls = await planned(2);
        await genInstallment(cls, 1).expect(201);

        const res = await http()
          .get('/api/fees/challans/installment-options')
          .query({
            academicYearId: cls.academicYear.id,
            sectionId: cls.section.id,
          })
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .expect(200);

        expect(res.body.studentsOnPlan).toBe(2);
        expect(res.body.rows[0]).toMatchObject({
          seq: 1,
          eligible: 0,
          alreadyGenerated: 2,
        });
        expect(res.body.rows[1]).toMatchObject({ seq: 2, eligible: 2 });
      });

      it('lists a student’s rows with the billed ones flagged', async () => {
        const cls = await planned();
        await genInstallment(cls, 1).expect(201);

        const res = await http()
          .get(
            `/api/fees/students/${cls.students[0].profile.id}/installment-options`,
          )
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .expect(200);

        expect(res.body.plans).toHaveLength(1);
        expect(res.body.plans[0].installments.map((i: { status: string }) => i.status))
          .toEqual(['ALREADY_GENERATED', 'AVAILABLE', 'AVAILABLE']);
        expect(res.body.plans[0].installments[0].challanNo).toBeTruthy();
        expect(res.body.student.className).toBeTruthy();
        // The balance rides along, so a billed row can offer to take payment
        // instead of dead-ending at a disabled card.
        expect(res.body.plans[0].installments[0]).toMatchObject({
          challanStatus: 'UNPAID',
          challanBalance: 100000,
        });
        expect(res.body.plans[0].installments[1].challanBalance).toBeNull();
      });

      it('shows a settled installment as having nothing left to pay', async () => {
        const cls = await planned();
        await genInstallment(cls, 1).expect(201);
        const challan = await prisma.challan.findFirstOrThrow({
          where: { schoolId: cls.school.id },
        });
        await http()
          .post(`/api/fees/challans/${challan.id}/payments`)
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send({ amount: 100000, method: 'CASH' })
          .expect(201);

        const res = await http()
          .get(
            `/api/fees/students/${cls.students[0].profile.id}/installment-options`,
          )
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .expect(200);
        expect(res.body.plans[0].installments[0]).toMatchObject({
          status: 'ALREADY_GENERATED',
          challanStatus: 'PAID',
          challanBalance: 0,
        });
      });

      it('bills one student through the single-student route', async () => {
        const cls = await planned();
        const res = await http()
          .post('/api/fees/challans')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send({
            studentId: cls.students[0].profile.id,
            academicYearId: cls.academicYear.id,
            generationType: 'INSTALLMENT',
            installmentSeq: 3,
          })
          .expect(201);
        expect(res.body.generated).toBe(1);

        const challan = await prisma.challan.findFirstOrThrow({
          where: { schoolId: cls.school.id },
        });
        expect(challan.installmentSeq).toBe(3);
        expect(challan.netAmount).toBe(100000);
      });

      it('explains a refused single-student duplicate', async () => {
        const cls = await planned();
        const body = {
          studentId: cls.students[0].profile.id,
          academicYearId: cls.academicYear.id,
          generationType: 'INSTALLMENT',
          installmentSeq: 1,
        };
        await http()
          .post('/api/fees/challans')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(body)
          .expect(201);
        const res = await http()
          .post('/api/fees/challans')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(body)
          .expect(400);
        expect(JSON.stringify(res.body.message)).toMatch(/already been generated/i);
      });

      it('refuses INSTALLMENT with no installment chosen', async () => {
        const cls = await planned();
        await http()
          .post('/api/fees/challans/generate')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send({
            academicYearId: cls.academicYear.id,
            sectionId: cls.section.id,
            generationType: 'INSTALLMENT',
          })
          .expect(400);
      });

      it('refuses to re-shape a schedule whose row is already billed', async () => {
        const cls = await planned();
        await genInstallment(cls, 1).expect(201);

        const res = await putPlan(cls, cls.students[0].profile.id, {
          academicYearId: cls.academicYear.id,
          totalAmount: 300000,
          startDate: '2026-09-01',
          installments: [
            { amount: 150000, dueDate: '2026-09-10' },
            { amount: 150000, dueDate: '2026-11-10' },
          ],
        }).expect(400);
        expect(JSON.stringify(res.body.message)).toMatch(/already been billed/i);
      });

      // THE separation rule: monthly generation must never bill a plan student,
      // or they would be charged twice over for the same year.
      it('skips plan students, and bills everyone else the normal way', async () => {
        const cls = await seedBillableClass({ studentCount: 2, fee: 300000 });
        const planStudent = cls.students[0].profile;
        const plainStudent = cls.students[1].profile;
        await putPlan(cls, planStudent.id, {
          academicYearId: cls.academicYear.id,
          totalAmount: 300000,
          startDate: '2026-09-01',
          installments: [
            { amount: 150000, dueDate: '2026-09-10' },
            { amount: 150000, dueDate: '2026-11-10' },
          ],
        }).expect(200);

        const res = await http()
          .post('/api/fees/challans/generate')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(generateBody(cls))
          .expect(201);

        expect(res.body.generated).toBe(1);
        expect(res.body.skippedOnPlan).toHaveLength(1);
        expect(res.body.skippedOnPlan[0].studentId).toBe(planStudent.id);

        // Exactly one challan, and it belongs to the student WITHOUT a plan.
        const challans = await prisma.challan.findMany({
          where: { schoolId: cls.school.id },
        });
        expect(challans).toHaveLength(1);
        expect(challans[0].studentId).toBe(plainStudent.id);
        // The normal path itself is untouched for them.
        expect(challans[0].generationType).toBe('NORMAL');
        expect(challans[0].installmentId).toBeNull();
        expect(challans[0].netAmount).toBe(300000);
      });

      it('says why, rather than silently billing nobody', async () => {
        const cls = await planned();
        const res = await http()
          .post('/api/fees/challans/preview')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(generateBody(cls))
          .expect(201);
        expect(res.body.counts.willGenerate).toBe(0);
        expect(res.body.counts.onInstallmentPlan).toBe(1);
        expect(res.body.skippedOnPlan[0].reason).toBe('ON_INSTALLMENT_PLAN');
      });

      it('refuses a single normal challan for a plan student, pointing elsewhere', async () => {
        const cls = await planned();
        const res = await http()
          .post('/api/fees/challans')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send({
            studentId: cls.students[0].profile.id,
            academicYearId: cls.academicYear.id,
            ...PERIOD,
          })
          .expect(400);
        expect(JSON.stringify(res.body.message)).toMatch(/installment plan/i);
      });

      it('resolves a whole section in a CONSTANT number of queries', async () => {
        const svc = app.get(PrismaService);
        async function countFor(students: number) {
          const cls = await planned(students);
          let calls = 0;
          const original = svc.challan.findMany.bind(svc.challan);
          svc.challan.findMany = (...a: unknown[]) => {
            calls += 1;
            return original(...a);
          };
          try {
            const res = await genInstallment(cls, 1).expect(201);
            return { calls, generated: res.body.generated };
          } finally {
            svc.challan.findMany = original;
          }
        }
        const small = await countFor(1);
        await resetDb();
        const large = await countFor(8);
        expect(small.generated).toBe(1);
        expect(large.generated).toBe(8);
        expect(large.calls).toBe(small.calls);
      });
    });

    describe('payments move the derived schedule', () => {
      async function planWithChallan() {
        const cls = await seedBillableClass({ studentCount: 1 });
        const studentId = cls.students[0].profile.id;
        // Billed monthly FIRST, then put on a plan — a real sequence, and the
        // only one that yields a monthly challan, since normal generation now
        // skips students who are already on a plan.
        await http()
          .post('/api/fees/challans/generate')
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send(generateBody(cls))
          .expect(201);
        await putPlan(cls, studentId, planBody(cls)).expect(200);
        const challan = await prisma.challan.findFirstOrThrow({
          where: { studentId },
        });
        return { cls, studentId, challan };
      }

      it('waterfalls a payment oldest-due-first, with no installment write', async () => {
        const { cls, studentId, challan } = await planWithChallan();

        await http()
          .post(`/api/fees/challans/${challan.id}/payments`)
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .send({ amount: 15000, method: 'CASH' })
          .expect(201);

        const res = await http()
          .get(`/api/fees/students/${studentId}/installment-plan`)
          .set('Authorization', `Bearer ${cls.adminToken}`)
          .expect(200);

        expect(
          res.body.plan.installments.map((i: any) => i.paidAmount),
        ).toEqual([10000, 5000, 0]);
        expect(res.body.plan.installments[0].status).toBe('PAID');
        expect(res.body.plan.installments[1].status).toBe('PARTIALLY_PAID');
        expect(res.body.plan.paidAmount).toBe(15000);
        expect(res.body.plan.outstandingAmount).toBe(15000);
      });

      it('reverses on void, because nothing was stored to correct', async () => {
        const { cls, studentId, challan } = await planWithChallan();
        const auth = { Authorization: `Bearer ${cls.adminToken}` };

        const pay = await http()
          .post(`/api/fees/challans/${challan.id}/payments`)
          .set(auth)
          .send({ amount: 15000, method: 'CASH' })
          .expect(201);

        await http()
          .post(`/api/fees/payments/${pay.body.payment.id}/void`)
          .set(auth)
          .send({ reason: 'cheque bounced' })
          .expect(201);

        const res = await http()
          .get(`/api/fees/students/${studentId}/installment-plan`)
          .set(auth)
          .expect(200);
        expect(
          res.body.plan.installments.every((i: any) => i.paidAmount === 0),
        ).toBe(true);
        expect(res.body.plan.paidAmount).toBe(0);
      });
    });

    // The requirement that made §2b free: nothing in generation reads a plan.
    it('leaves an ISSUED challan byte-for-byte unchanged when the plan is edited', async () => {
      const cls = await seedBillableClass({ studentCount: 1 });
      const studentId = cls.students[0].profile.id;
      // Issue the monthly challan BEFORE the plan exists; normal generation
      // skips students already on one.
      await http()
        .post('/api/fees/challans/generate')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send(generateBody(cls))
        .expect(201);
      await putPlan(cls, studentId, planBody(cls)).expect(200);

      const before = await prisma.challan.findFirstOrThrow({
        where: { studentId },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });

      await putPlan(
        cls,
        studentId,
        planBody(cls, {
          totalAmount: 999000,
          installments: [{ amount: 999000, dueDate: '2026-09-01' }],
        }),
      ).expect(200);

      const after = await prisma.challan.findFirstOrThrow({
        where: { studentId },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });
      expect(after).toEqual(before);
    });

    it('never touches the school fee heads or another student', async () => {
      const cls = await seedBillableClass({ studentCount: 2 });
      const head = await prisma.feeHead.create({
        data: {
          schoolId: cls.school.id,
          name: 'Transport',
          defaultAmount: 500,
        },
      });

      await putPlan(cls, cls.students[0].profile.id, planBody(cls)).expect(200);

      expect(
        (await prisma.feeHead.findUniqueOrThrow({ where: { id: head.id } }))
          .defaultAmount,
      ).toBe(500);
      expect(
        await prisma.feeInstallmentPlan.count({
          where: { studentId: cls.students[1].profile.id },
        }),
      ).toBe(0);
    });

    describe('roles and object-level scoping', () => {
      /** A plan on student 0, plus student + parent + teacher tokens. */
      async function scopedFixture() {
        const cls = await seedBillableClass({ studentCount: 2 });
        const studentId = cls.students[0].profile.id;
        await putPlan(cls, studentId, planBody(cls)).expect(200);

        const parentUser = await createTestUser({
          role: Role.PARENT,
          schoolId: cls.school.id,
        });
        const parentProfile = await prisma.parentProfile.create({
          data: { userId: parentUser.id, fullName: 'Plan Parent' },
        });
        await prisma.parentStudent.create({
          data: { parentId: parentProfile.id, studentId },
        });

        return {
          cls,
          studentId,
          studentToken: await tokenFor(app, cls.students[0].user),
          otherStudentToken: await tokenFor(app, cls.students[1].user),
          parentToken: await tokenFor(app, parentUser),
          teacherToken: await tokenFor(app, cls.teacherUser),
        };
      }

      it('lets the student and their parent read it, but not a teacher', async () => {
        const f = await scopedFixture();
        for (const token of [f.studentToken, f.parentToken]) {
          const res = await http()
            .get(`/api/fees/students/${f.studentId}/installment-plan`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200);
          expect(res.body.plan.installmentCount).toBe(3);
        }

        // The fee module was removed from the teacher portal.
        await http()
          .get(`/api/fees/students/${f.studentId}/installment-plan`)
          .set('Authorization', `Bearer ${f.teacherToken}`)
          .expect(403);
      });

      it("refuses another student's plan even with a valid id", async () => {
        const f = await scopedFixture();
        await http()
          .get(`/api/fees/students/${f.studentId}/installment-plan`)
          .set('Authorization', `Bearer ${f.otherStudentToken}`)
          .expect(403);
      });

      it('refuses a parent who is not linked to the child', async () => {
        const f = await scopedFixture();
        const stranger = await createTestUser({
          role: Role.PARENT,
          schoolId: f.cls.school.id,
        });
        await prisma.parentProfile.create({
          data: { userId: stranger.id, fullName: 'Unlinked' },
        });
        await http()
          .get(`/api/fees/students/${f.studentId}/installment-plan`)
          .set('Authorization', `Bearer ${await tokenFor(app, stranger)}`)
          .expect(403);
      });

      it('refuses cross-school reads', async () => {
        const f = await scopedFixture();
        const other = await seedClass({ studentCount: 1 });
        const otherAdmin = await createTestUser({
          role: Role.SCHOOL_ADMIN,
          schoolId: other.school.id,
        });
        await http()
          .get(`/api/fees/students/${f.studentId}/installment-plan`)
          .set('Authorization', `Bearer ${await tokenFor(app, otherAdmin)}`)
          .expect(403);
      });

      it('refuses every non-admin WRITE — read-only is @Roles(), not hidden UI', async () => {
        const f = await scopedFixture();
        for (const token of [f.studentToken, f.parentToken, f.teacherToken]) {
          await http()
            .put(`/api/fees/students/${f.studentId}/installment-plan`)
            .set('Authorization', `Bearer ${token}`)
            .send(planBody(f.cls))
            .expect(403);
        }
      });
    });

    it('surfaces the plan on the batch status badge and the fee history', async () => {
      const cls = await seedBillableClass({ studentCount: 2 });
      const studentId = cls.students[0].profile.id;
      await putPlan(cls, studentId, planBody(cls)).expect(200);
      const auth = { Authorization: `Bearer ${cls.adminToken}` };

      const badge = await http()
        .post('/api/fees/students/status')
        .set(auth)
        .send({ studentIds: [studentId, cls.students[1].profile.id] })
        .expect(201);
      expect(badge.body.statuses[studentId].hasInstallmentPlan).toBe(true);
      expect(
        badge.body.statuses[cls.students[1].profile.id].hasInstallmentPlan,
      ).toBe(false);

      const history = await http()
        .get(`/api/fees/students/${studentId}/challans`)
        .set(auth)
        .expect(200);
      expect(history.body.installmentPlan.installmentCount).toBe(3);
    });

    describe('due-date reminders', () => {
      const DUE = '2026-09-20';

      /** A student on a plan due 2026-09-20, with a linked guardian. */
      async function reminderFixture(opts: { studentCount?: number } = {}) {
        const cls = await seedBillableClass({
          studentCount: opts.studentCount ?? 1,
        });
        const parentUser = await createTestUser({
          role: Role.PARENT,
          schoolId: cls.school.id,
        });
        const parentProfile = await prisma.parentProfile.create({
          data: { userId: parentUser.id, fullName: 'Reminder Parent' },
        });

        for (const s of cls.students) {
          await prisma.parentStudent.create({
            data: { parentId: parentProfile.id, studentId: s.profile.id },
          });
          await putPlan(cls, s.profile.id, {
            academicYearId: cls.academicYear.id,
            totalAmount: 10000,
            startDate: DUE,
            installments: [{ amount: 10000, dueDate: DUE }],
          }).expect(200);
        }
        return { cls, parentUser };
      }

      const sweeper = () =>
        app.get<InstallmentRemindersService>(InstallmentRemindersService);

      // The requirement's worked example: due the 20th, 5 days before -> the 15th.
      it('sends on the configured day and only then', async () => {
        const { cls, parentUser } = await reminderFixture();
        await prisma.school.update({
          where: { id: cls.school.id },
          data: { installmentReminderDaysBefore: 5 },
        });

        const early = await sweeper().sweep(new Date('2026-09-14T08:00:00Z'));
        expect(early.reminded).toBe(0);

        const onDay = await sweeper().sweep(new Date('2026-09-15T08:00:00Z'));
        expect(onDay.reminded).toBe(1);

        await settle();
        const notes = await prisma.notification.findMany({
          where: { type: 'FEE_INSTALLMENT_DUE_SOON' },
        });
        const recipients = new Set(notes.map((n) => n.userId));
        expect(recipients.has(cls.students[0].user.id)).toBe(true);
        expect(recipients.has(parentUser.id)).toBe(true);
        expect(notes[0].body).toMatch(DUE);
        expect(notes[0].link).toBe('/fees');
      });

      it('never sends twice for the same installment', async () => {
        const { cls } = await reminderFixture();
        await prisma.school.update({
          where: { id: cls.school.id },
          data: { installmentReminderDaysBefore: 5 },
        });

        const first = await sweeper().sweep(new Date('2026-09-15T08:00:00Z'));
        const second = await sweeper().sweep(new Date('2026-09-16T08:00:00Z'));
        const third = await sweeper().sweep(new Date('2026-09-17T08:00:00Z'));

        expect([first.reminded, second.reminded, third.reminded]).toEqual([
          1, 0, 0,
        ]);
        await settle();
        expect(
          await prisma.notification.count({
            where: { type: 'FEE_INSTALLMENT_DUE_SOON' },
          }),
        ).toBe(2); // student + guardian, once
      });

      // A missed run must not silently drop a day's reminders.
      it('catches up after a skipped day rather than losing the reminder', async () => {
        const { cls } = await reminderFixture();
        await prisma.school.update({
          where: { id: cls.school.id },
          data: { installmentReminderDaysBefore: 5 },
        });
        // Nothing ran on the 15th; the 17th is still inside the window.
        const late = await sweeper().sweep(new Date('2026-09-17T08:00:00Z'));
        expect(late.reminded).toBe(1);
      });

      it('does not chase an installment that is already settled', async () => {
        const { cls } = await reminderFixture();
        await prisma.school.update({
          where: { id: cls.school.id },
          data: { installmentReminderDaysBefore: 5 },
        });
        const auth = { Authorization: `Bearer ${cls.adminToken}` };
        // A plan student is billed by installment, not by month.
        await http()
          .post('/api/fees/challans/generate')
          .set(auth)
          .send({
            academicYearId: cls.academicYear.id,
            sectionId: cls.section.id,
            generationType: 'INSTALLMENT',
            installmentSeq: 1,
          })
          .expect(201);
        const challan = await prisma.challan.findFirstOrThrow({
          where: { studentId: cls.students[0].profile.id },
        });
        await http()
          .post(`/api/fees/challans/${challan.id}/payments`)
          .set(auth)
          .send({ amount: 10000, method: 'CASH' })
          .expect(201);

        const res = await sweeper().sweep(new Date('2026-09-15T08:00:00Z'));
        expect(res.reminded).toBe(0);
      });

      it('respects the school off-switch', async () => {
        const { cls } = await reminderFixture();
        await prisma.school.update({
          where: { id: cls.school.id },
          data: {
            installmentReminderEnabled: false,
            installmentReminderDaysBefore: 5,
          },
        });
        const res = await sweeper().sweep(new Date('2026-09-15T08:00:00Z'));
        expect(res.reminded).toBe(0);
      });

      it('skips an inactive plan', async () => {
        const { cls } = await reminderFixture();
        await prisma.school.update({
          where: { id: cls.school.id },
          data: { installmentReminderDaysBefore: 5 },
        });
        await prisma.feeInstallmentPlan.updateMany({
          data: { isActive: false },
        });
        const res = await sweeper().sweep(new Date('2026-09-15T08:00:00Z'));
        expect(res.reminded).toBe(0);
      });

      it('does not remind for an already-overdue installment', async () => {
        const { cls } = await reminderFixture();
        await prisma.school.update({
          where: { id: cls.school.id },
          data: { installmentReminderDaysBefore: 5 },
        });
        const res = await sweeper().sweep(new Date('2026-09-21T08:00:00Z'));
        expect(res.reminded).toBe(0);
      });

      it('honours each school window independently and never crosses tenants', async () => {
        const a = await reminderFixture();
        const b = await reminderFixture();
        await prisma.school.update({
          where: { id: a.cls.school.id },
          data: { installmentReminderDaysBefore: 5 },
        });
        await prisma.school.update({
          where: { id: b.cls.school.id },
          data: { installmentReminderDaysBefore: 1 },
        });

        // Inside A's 5-day window, outside B's 1-day window.
        const res = await sweeper().sweep(new Date('2026-09-15T08:00:00Z'));
        expect(res.reminded).toBe(1);

        await settle();
        const notes = await prisma.notification.findMany({
          where: { type: 'FEE_INSTALLMENT_DUE_SOON' },
          select: { userId: true },
        });
        const recipients = new Set(notes.map((n) => n.userId));
        expect(recipients.has(a.cls.students[0].user.id)).toBe(true);
        // B's student is in another tenant and must hear nothing.
        expect(recipients.has(b.cls.students[0].user.id)).toBe(false);
      });

      it('sweeps a large cohort in a CONSTANT number of queries (no N+1)', async () => {
        const CALLS = [
          'school.findMany',
          'feeInstallment.findMany',
          'feeInstallment.updateMany',
          'payment.findMany',
          'studentProfile.findMany',
          'parentStudent.findMany',
        ] as const;

        async function countFor(studentCount: number) {
          const { cls } = await reminderFixture({ studentCount });
          await prisma.school.update({
            where: { id: cls.school.id },
            data: { installmentReminderDaysBefore: 5 },
          });

          const svc = app.get(PrismaService);
          const counts: Record<string, number> = {};
          const restores: Array<() => void> = [];
          for (const path of CALLS) {
            const [model, method] = path.split('.');
            const original = svc[model][method].bind(svc[model]);
            counts[path] = 0;
            svc[model][method] = (...args: unknown[]) => {
              counts[path] += 1;
              return original(...args);
            };
            restores.push(() => {
              svc[model][method] = original;
            });
          }

          let reminded = 0;
          try {
            reminded = (await sweeper().sweep(new Date('2026-09-15T08:00:00Z')))
              .reminded;
          } finally {
            restores.forEach((r) => r());
          }
          return { counts, reminded };
        }

        const small = await countFor(2);
        await resetDb();
        const large = await countFor(20);

        expect(small.reminded).toBe(2);
        expect(large.reminded).toBe(20);
        // 10x the cohort, identical query counts.
        expect(large.counts).toEqual(small.counts);
      });
    });
  });

  // ---- Online payment proof + verification -------------------------------

  describe('payment submissions', () => {
    const settle = () => new Promise((r) => setTimeout(r, 500));

    // 1x1 transparent PNG.
    const receipt = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );

    /** A billable class with a generated challan, a student and a linked parent. */
    async function submissionFixture() {
      const cls = await seedBillableClass({ studentCount: 1, fee: 500000 });
      await http()
        .post('/api/fees/challans/generate')
        .set('Authorization', `Bearer ${cls.adminToken}`)
        .send(generateBody(cls))
        .expect(201);
      const challan = await prisma.challan.findFirstOrThrow({
        where: { schoolId: cls.school.id },
      });

      const parentUser = await createTestUser({
        role: Role.PARENT,
        schoolId: cls.school.id,
      });
      const parentProfile = await prisma.parentProfile.create({
        data: { userId: parentUser.id, fullName: 'Proof Parent' },
      });
      await prisma.parentStudent.create({
        data: {
          parentId: parentProfile.id,
          studentId: cls.students[0].profile.id,
        },
      });

      return {
        cls,
        challan,
        parentUser,
        parentToken: await tokenFor(app, parentUser),
        studentToken: await tokenFor(app, cls.students[0].user),
      };
    }

    const submit = (
      token: string,
      challanId: string,
      fields: Record<string, string> = {},
      file: Buffer | null = receipt,
      contentType = 'image/png',
    ) => {
      let req = http()
        .post(`/api/fees/challans/${challanId}/payment-submissions`)
        .set('Authorization', `Bearer ${token}`)
        .field('amount', fields.amount ?? '100000')
        .field('method', fields.method ?? 'BANK_TRANSFER')
        .field('paidAt', fields.paidAt ?? '2026-03-05');
      for (const [k, v] of Object.entries(fields)) {
        if (!['amount', 'method', 'paidAt'].includes(k)) req = req.field(k, v);
      }
      if (file) {
        req = req.attach('receipt', file, {
          filename: 'receipt.png',
          contentType,
        });
      }
      return req;
    };

    it('a parent submits proof and NO payment is created', async () => {
      const f = await submissionFixture();

      const res = await submit(f.parentToken, f.challan.id, {
        reference: 'TXN-77',
        note: 'Bank transfer',
      }).expect(201);

      expect(res.body.status).toBe('PENDING_VERIFICATION');
      expect(res.body.amount).toBe(100000);
      expect(res.body.paymentId).toBeNull();

      // THE rule: a receipt is evidence, not money.
      expect(await prisma.payment.count()).toBe(0);
      const challan = await prisma.challan.findUniqueOrThrow({
        where: { id: f.challan.id },
      });
      expect(challan.paidAmount).toBe(0);
      expect(challan.status).toBe('UNPAID');
    });

    it('a student can submit for themselves', async () => {
      const f = await submissionFixture();
      await submit(f.studentToken, f.challan.id).expect(201);
    });

    it('notifies the school admins that a proof needs verification', async () => {
      const f = await submissionFixture();
      await submit(f.parentToken, f.challan.id).expect(201);
      await settle();

      const notes = await prisma.notification.findMany({
        where: { type: 'FEE_PAYMENT_SUBMITTED' },
        select: { userId: true, body: true },
      });
      expect(notes.map((n) => n.userId)).toContain(f.cls.adminUser.id);
      expect(notes[0].body).toMatch(/not credited until/i);
    });

    // ---- Installment students --------------------------------------------

    describe('installment students', () => {
      /** The same fixture, with the student on a 4-installment plan. */
      async function installmentFixture() {
        const f = await submissionFixture();
        const studentId = f.cls.students[0].profile.id;
        await http()
          .put(`/api/fees/students/${studentId}/installment-plan`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .send({
            academicYearId: f.cls.academicYear.id,
            totalAmount: 500000,
            startDate: '2026-09-01',
            installments: [
              { amount: 125000, dueDate: '2026-09-01' },
              { amount: 125000, dueDate: '2026-10-01' },
              { amount: 125000, dueDate: '2026-11-01' },
              { amount: 125000, dueDate: '2026-12-01' },
            ],
          })
          .expect(200);
        return { ...f, studentId };
      }

      const readPlan = (token: string, studentId: string) =>
        http()
          .get(`/api/fees/students/${studentId}/installment-plan`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

      it('names the payable installment, the challan and the cap', async () => {
        const f = await installmentFixture();
        const { body } = await readPlan(f.studentToken, f.studentId);

        expect(body.plan.payable).toMatchObject({
          installment: { seq: 1, remainingAmount: 125000 },
          challan: { id: f.challan.id, balance: 500000 },
          // The INSTALLMENT caps the receipt, not the year's balance.
          maxAmount: 125000,
          pendingSubmission: null,
        });
        expect(body.plan.payableBlockedReason).toBeNull();
      });

      it('refuses a receipt that does not name an installment', async () => {
        const f = await installmentFixture();
        const res = await submit(f.parentToken, f.challan.id, {
          amount: '125000',
        }).expect(400);
        expect(JSON.stringify(res.body.message)).toMatch(/choose the installment/i);
      });

      // THE test: within the challan balance, over the installment's.
      it('refuses an amount the installment does not owe, though the challan does', async () => {
        const f = await installmentFixture();
        const { body } = await readPlan(f.studentToken, f.studentId);
        const res = await submit(f.parentToken, f.challan.id, {
          amount: '200000',
          installmentId: body.plan.payable.installment.id,
        }).expect(400);
        expect(JSON.stringify(res.body.message)).toMatch(/installment 1/i);
      });

      it('refuses paying a later installment out of order', async () => {
        const f = await installmentFixture();
        const { body } = await readPlan(f.studentToken, f.studentId);
        const third = body.plan.installments[2];
        const res = await submit(f.parentToken, f.challan.id, {
          amount: '125000',
          installmentId: third.id,
        }).expect(400);
        expect(JSON.stringify(res.body.message)).toMatch(/in order/i);
      });

      it('refuses another student’s installment id', async () => {
        const f = await installmentFixture();
        const other = await installmentFixture();
        const { body } = await readPlan(other.studentToken, other.studentId);
        await submit(f.parentToken, f.challan.id, {
          amount: '125000',
          installmentId: body.plan.payable.installment.id,
        }).expect(400);
      });

      it('accepts the due installment and surfaces it as pending', async () => {
        const f = await installmentFixture();
        const before = await readPlan(f.studentToken, f.studentId);
        const res = await submit(f.parentToken, f.challan.id, {
          amount: '125000',
          installmentId: before.body.plan.payable.installment.id,
        }).expect(201);
        expect(res.body.installmentId).toBe(
          before.body.plan.payable.installment.id,
        );

        // Still evidence, not money — and the portal says a receipt is waiting.
        const after = await readPlan(f.studentToken, f.studentId);
        expect(after.body.plan.paidCount).toBe(0);
        expect(after.body.plan.payable.pendingSubmission).toMatchObject({
          amount: 125000,
        });
      });

      it('credits THAT installment on verification and moves the progress', async () => {
        const f = await installmentFixture();
        const before = await readPlan(f.studentToken, f.studentId);
        const sub = await submit(f.parentToken, f.challan.id, {
          amount: '125000',
          installmentId: before.body.plan.payable.installment.id,
        }).expect(201);

        await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(201);

        const after = await readPlan(f.studentToken, f.studentId);
        expect(after.body.plan.installments[0]).toMatchObject({
          seq: 1,
          paidAmount: 125000,
          remainingAmount: 0,
          status: 'PAID',
        });
        expect(after.body.plan.paidCount).toBe(1);
        expect(after.body.plan.paidAmount).toBe(125000);
        expect(after.body.plan.outstandingAmount).toBe(375000);
        // The payable row advances to the next one.
        expect(after.body.plan.payable.installment.seq).toBe(2);
      });

      it('refuses to verify a second receipt for an installment already settled', async () => {
        const f = await installmentFixture();
        const { body } = await readPlan(f.studentToken, f.studentId);
        const id = body.plan.payable.installment.id;

        // Two receipts filed for the same installment before either is reviewed.
        const a = await submit(f.parentToken, f.challan.id, {
          amount: '125000',
          installmentId: id,
        }).expect(201);
        const b = await submit(f.parentToken, f.challan.id, {
          amount: '125000',
          installmentId: id,
        }).expect(201);

        await http()
          .post(`/api/fees/payment-submissions/${a.body.id}/verify`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(201);
        const res = await http()
          .post(`/api/fees/payment-submissions/${b.body.id}/verify`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(400);
        expect(JSON.stringify(res.body.message)).toMatch(/installment 1/i);

        // Exactly one payment, and the plan is not double-credited.
        expect(await prisma.payment.count({ where: { voidedAt: null } })).toBe(1);
        const after = await readPlan(f.studentToken, f.studentId);
        expect(after.body.plan.paidAmount).toBe(125000);
      });

      it('carries the installment and plan onto the verification queue', async () => {
        const f = await installmentFixture();
        const { body } = await readPlan(f.studentToken, f.studentId);
        await submit(f.parentToken, f.challan.id, {
          amount: '125000',
          installmentId: body.plan.payable.installment.id,
        }).expect(201);

        const queue = await http()
          .get('/api/fees/payment-submissions')
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(200);
        expect(queue.body.items[0].installment).toMatchObject({
          seq: 1,
          amount: 125000,
        });
        expect(queue.body.items[0].installmentPlan).toMatchObject({
          totalAmount: 500000,
          installmentCount: 4,
          isActive: true,
        });
      });

      it('resolves plan context for the whole queue in a CONSTANT number of queries', async () => {
        const svc = app.get(PrismaService);

        /** One class, `students` students, each on a plan with one receipt filed. */
        async function countFor(students: number) {
          const cls = await seedBillableClass({ studentCount: students, fee: 500000 });
          await http()
            .post('/api/fees/challans/generate')
            .set('Authorization', `Bearer ${cls.adminToken}`)
            .send(generateBody(cls))
            .expect(201);

          for (const s of cls.students) {
            await http()
              .put(`/api/fees/students/${s.profile.id}/installment-plan`)
              .set('Authorization', `Bearer ${cls.adminToken}`)
              .send({
                academicYearId: cls.academicYear.id,
                totalAmount: 500000,
                startDate: '2026-09-01',
                installments: [
                  { amount: 250000, dueDate: '2026-09-01' },
                  { amount: 250000, dueDate: '2026-10-01' },
                ],
              })
              .expect(200);

            const token = await tokenFor(app, s.user);
            const plan = await http()
              .get(`/api/fees/students/${s.profile.id}/installment-plan`)
              .set('Authorization', `Bearer ${token}`)
              .expect(200);
            await submit(token, plan.body.plan.payable.challan.id, {
              amount: '250000',
              installmentId: plan.body.plan.payable.installment.id,
            }).expect(201);
          }

          let calls = 0;
          const original = svc.feeInstallmentPlan.findMany.bind(
            svc.feeInstallmentPlan,
          );
          svc.feeInstallmentPlan.findMany = (...a: unknown[]) => {
            calls += 1;
            return original(...a);
          };
          try {
            const res = await http()
              .get('/api/fees/payment-submissions')
              .set('Authorization', `Bearer ${cls.adminToken}`)
              .expect(200);
            return { calls, returned: res.body.items.length };
          } finally {
            svc.feeInstallmentPlan.findMany = original;
          }
        }

        const small = await countFor(1);
        await resetDb();
        const large = await countFor(8);

        expect(small.returned).toBe(1);
        expect(large.returned).toBe(8);
        // 8x the rows, one plan query either way.
        expect(small.calls).toBe(1);
        expect(large.calls).toBe(1);
      });

      it('leaves a student with NO plan on the original flow', async () => {
        const f = await submissionFixture();
        // No installment named, amount well over any installment: still fine,
        // because the ordinary challan rules are the only ones that apply.
        await submit(f.parentToken, f.challan.id, { amount: '400000' }).expect(
          201,
        );
      });

      it('refuses an installment id for a student with no plan', async () => {
        const f = await installmentFixture();
        const plain = await submissionFixture();
        const { body } = await readPlan(f.studentToken, f.studentId);
        const res = await submit(plain.parentToken, plain.challan.id, {
          amount: '100000',
          installmentId: body.plan.payable.installment.id,
        }).expect(400);
        expect(JSON.stringify(res.body.message)).toMatch(/not on an installment plan/i);
      });
    });

    describe('validation', () => {
      it('rejects a claim larger than the remaining balance', async () => {
        const f = await submissionFixture();
        const res = await submit(f.parentToken, f.challan.id, {
          amount: '99999999',
        }).expect(400);
        expect(res.body.message).toMatch(/exceeds the remaining balance/i);
      });

      it('rejects a submission with no receipt file', async () => {
        const f = await submissionFixture();
        await submit(f.parentToken, f.challan.id, {}, null).expect(400);
      });

      it('rejects a disallowed receipt type', async () => {
        const f = await submissionFixture();
        await submit(
          f.parentToken,
          f.challan.id,
          {},
          Buffer.from('#!/bin/sh\n'),
          'application/x-sh',
        ).expect(400);
      });

      it('rejects a zero or negative amount', async () => {
        const f = await submissionFixture();
        await submit(f.parentToken, f.challan.id, { amount: '0' }).expect(400);
        await submit(f.parentToken, f.challan.id, { amount: '-500' }).expect(
          400,
        );
      });
    });

    describe('access control', () => {
      it('refuses a parent submitting for an unlinked child', async () => {
        const f = await submissionFixture();
        const stranger = await createTestUser({
          role: Role.PARENT,
          schoolId: f.cls.school.id,
        });
        await prisma.parentProfile.create({
          data: { userId: stranger.id, fullName: 'Unlinked' },
        });
        await submit(await tokenFor(app, stranger), f.challan.id).expect(403);
      });

      it('refuses admins and teachers on the submit route', async () => {
        const f = await submissionFixture();
        await submit(f.cls.adminToken, f.challan.id).expect(403);
        await submit(
          await tokenFor(app, f.cls.teacherUser),
          f.challan.id,
        ).expect(403);
      });

      it('refuses students, parents and teachers on verify and reject', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);
        const teacherToken = await tokenFor(app, f.cls.teacherUser);

        for (const token of [f.studentToken, f.parentToken, teacherToken]) {
          await http()
            .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
            .set('Authorization', `Bearer ${token}`)
            .expect(403);
          await http()
            .post(`/api/fees/payment-submissions/${sub.body.id}/reject`)
            .set('Authorization', `Bearer ${token}`)
            .send({})
            .expect(403);
        }
        // Still untouched, and still no money.
        expect(await prisma.payment.count()).toBe(0);
      });

      it('refuses a cross-school admin on the queue and on verify', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);
        const other = await seedClass({ studentCount: 1 });
        const otherAdmin = await createTestUser({
          role: Role.SCHOOL_ADMIN,
          schoolId: other.school.id,
        });
        const token = await tokenFor(app, otherAdmin);

        await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403);

        const queue = await http()
          .get('/api/fees/payment-submissions')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(queue.body.items).toHaveLength(0);
      });
    });

    describe('verification', () => {
      it('creates the real Payment and updates the challan', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);

        const res = await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(201);

        expect(res.body.status).toBe('VERIFIED');
        expect(res.body.paymentId).toBeTruthy();

        const payments = await prisma.payment.findMany();
        expect(payments).toHaveLength(1);
        expect(payments[0].amount).toBe(100000);

        const challan = await prisma.challan.findUniqueOrThrow({
          where: { id: f.challan.id },
        });
        expect(challan.paidAmount).toBe(100000);
        expect(challan.status).toBe('PARTIALLY_PAID');
      });

      // The rule that matters most for money.
      it('never creates two payments when verify is called twice', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);
        const auth = { Authorization: `Bearer ${f.cls.adminToken}` };

        await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
          .set(auth)
          .expect(201);
        await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
          .set(auth)
          .expect(400);

        expect(await prisma.payment.count()).toBe(1);
        const challan = await prisma.challan.findUniqueOrThrow({
          where: { id: f.challan.id },
        });
        expect(challan.paidAmount).toBe(100000);
      });

      it('absorbs a CONCURRENT double verify without double-charging', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);
        const auth = { Authorization: `Bearer ${f.cls.adminToken}` };

        const results = await Promise.all([
          http()
            .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
            .set(auth),
          http()
            .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
            .set(auth),
        ]);
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect(await prisma.payment.count()).toBe(1);
      });

      it('supports partial payments and settles on the second verify', async () => {
        const f = await submissionFixture();
        const auth = { Authorization: `Bearer ${f.cls.adminToken}` };
        const balance = f.challan.netAmount;

        const a = await submit(f.parentToken, f.challan.id, {
          amount: String(balance - 50000),
        }).expect(201);
        await http()
          .post(`/api/fees/payment-submissions/${a.body.id}/verify`)
          .set(auth)
          .expect(201);

        const b = await submit(f.parentToken, f.challan.id, {
          amount: '50000',
        }).expect(201);
        await http()
          .post(`/api/fees/payment-submissions/${b.body.id}/verify`)
          .set(auth)
          .expect(201);

        const challan = await prisma.challan.findUniqueOrThrow({
          where: { id: f.challan.id },
        });
        expect(challan.paidAmount).toBe(balance);
        expect(challan.status).toBe('PAID');
      });

      // The balance can move between submission and review.
      it('refuses to verify a claim the balance no longer covers', async () => {
        const f = await submissionFixture();
        const auth = { Authorization: `Bearer ${f.cls.adminToken}` };
        const sub = await submit(f.parentToken, f.challan.id, {
          amount: String(f.challan.netAmount),
        }).expect(201);

        // An admin takes cash in the meantime.
        await http()
          .post(`/api/fees/challans/${f.challan.id}/payments`)
          .set(auth)
          .send({ amount: 100000, method: 'CASH' })
          .expect(201);

        const res = await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
          .set(auth)
          .expect(400);
        expect(res.body.message).toMatch(/remaining balance is now/i);

        // Still pending, and only the admin's cash was recorded.
        const row = await prisma.paymentSubmission.findUniqueOrThrow({
          where: { id: sub.body.id },
        });
        expect(row.status).toBe('PENDING_VERIFICATION');
        expect(await prisma.payment.count()).toBe(1);
      });

      it('notifies the student AND guardians once — not twice', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);
        await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(201);
        await settle();

        const verified = await prisma.notification.findMany({
          where: { type: 'FEE_PAYMENT_VERIFIED' },
          select: { userId: true, body: true },
        });
        const recipients = verified.map((n) => n.userId);
        expect(recipients).toContain(f.cls.students[0].user.id);
        expect(recipients).toContain(f.parentUser.id);
        expect(verified[0].body).toMatch(/verified/i);

        // The generic receipt notice is suppressed on this path, so the family
        // gets ONE notification for one event.
        expect(
          await prisma.notification.count({
            where: { type: 'FEE_PAYMENT_RECEIVED' },
          }),
        ).toBe(0);
      });

      it('moves the installment schedule, via the normal waterfall', async () => {
        const f = await submissionFixture();
        const studentId = f.cls.students[0].profile.id;
        await http()
          .put(`/api/fees/students/${studentId}/installment-plan`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .send({
            academicYearId: f.cls.academicYear.id,
            totalAmount: 200000,
            startDate: '2026-09-01',
            installments: [
              { amount: 100000, dueDate: '2026-09-01' },
              { amount: 100000, dueDate: '2026-10-01' },
            ],
          })
          .expect(200);

        // A plan student names the installment they are settling.
        const before = await http()
          .get(`/api/fees/students/${studentId}/installment-plan`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(200);
        const sub = await submit(f.parentToken, f.challan.id, {
          installmentId: before.body.plan.payable.installment.id,
        }).expect(201);
        await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(201);

        const plan = await http()
          .get(`/api/fees/students/${studentId}/installment-plan`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(200);
        expect(plan.body.plan.installments[0].status).toBe('PAID');
        expect(plan.body.plan.paidAmount).toBe(100000);
      });

      it('writes an audit entry', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);
        await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(201);

        const logs = await prisma.auditLog.findMany({
          where: { action: 'FEE_PAYMENT_SUBMISSION_VERIFY' },
        });
        expect(logs).toHaveLength(1);
      });
    });

    describe('rejection', () => {
      it('marks it REJECTED, creates no payment, and tells the submitter', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);

        const res = await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/reject`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .send({ reason: 'Receipt is illegible' })
          .expect(201);

        expect(res.body.status).toBe('REJECTED');
        expect(res.body.rejectionReason).toBe('Receipt is illegible');
        expect(await prisma.payment.count()).toBe(0);

        await settle();
        const notes = await prisma.notification.findMany({
          where: { type: 'FEE_PAYMENT_REJECTED' },
          select: { userId: true, body: true },
        });
        // Rejection is feedback on an action — only the submitter hears it.
        expect(notes.map((n) => n.userId)).toEqual([f.parentUser.id]);
        expect(notes[0].body).toMatch(/illegible/);
      });

      it('accepts a rejection with no reason', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);
        await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/reject`)
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .send({})
          .expect(201);
      });

      it('cannot reject an already-verified submission', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);
        const auth = { Authorization: `Bearer ${f.cls.adminToken}` };
        await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/verify`)
          .set(auth)
          .expect(201);
        await http()
          .post(`/api/fees/payment-submissions/${sub.body.id}/reject`)
          .set(auth)
          .send({ reason: 'too late' })
          .expect(400);
      });
    });

    describe('reads', () => {
      it('lists the pending queue with a pending count', async () => {
        const f = await submissionFixture();
        await submit(f.parentToken, f.challan.id).expect(201);

        const res = await http()
          .get('/api/fees/payment-submissions?status=PENDING_VERIFICATION')
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(200);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.pendingCount).toBe(1);
        expect(res.body.items[0].student.fullName).toBeTruthy();
        expect(res.body.items[0].submittedBy.role).toBe('PARENT');
      });

      it('lets the submitter and the student see the challan submissions', async () => {
        const f = await submissionFixture();
        await submit(f.parentToken, f.challan.id).expect(201);

        for (const token of [f.parentToken, f.studentToken, f.cls.adminToken]) {
          const res = await http()
            .get(`/api/fees/challans/${f.challan.id}/payment-submissions`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200);
          expect(res.body).toHaveLength(1);
        }
      });

      it('filters the queue by submission month and year', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);
        // Backdate it so the month filter has something to exclude.
        await prisma.paymentSubmission.update({
          where: { id: sub.body.id },
          data: { createdAt: new Date(Date.UTC(2026, 2, 15)) }, // 2026-03-15
        });
        const auth = { Authorization: `Bearer ${f.cls.adminToken}` };

        const q = async (query: string) => {
          const res = await http()
            .get(`/api/fees/payment-submissions${query}`)
            .set(auth)
            .expect(200);
          return res.body;
        };

        expect((await q('')).items).toHaveLength(1);
        expect((await q('?year=2026&month=3')).items).toHaveLength(1);
        expect((await q('?year=2026&month=4')).items).toHaveLength(0);
        expect((await q('?year=2026')).items).toHaveLength(1);
        expect((await q('?year=2025')).items).toHaveLength(0);
        // A month with no year is meaningless and must not filter anything out.
        expect((await q('?month=7')).items).toHaveLength(1);
      });

      it('scopes the pending badge to the filtered period', async () => {
        const f = await submissionFixture();
        const sub = await submit(f.parentToken, f.challan.id).expect(201);
        await prisma.paymentSubmission.update({
          where: { id: sub.body.id },
          data: { createdAt: new Date(Date.UTC(2026, 2, 15)) },
        });
        const auth = { Authorization: `Bearer ${f.cls.adminToken}` };

        const march = await http()
          .get('/api/fees/payment-submissions?year=2026&month=3')
          .set(auth)
          .expect(200);
        expect(march.body.pendingCount).toBe(1);

        // A badge of 1 beside an empty list would just look broken.
        const april = await http()
          .get('/api/fees/payment-submissions?year=2026&month=4')
          .set(auth)
          .expect(200);
        expect(april.body.items).toHaveLength(0);
        expect(april.body.pendingCount).toBe(0);
      });

      it('rejects an out-of-range month', async () => {
        const f = await submissionFixture();
        await http()
          .get('/api/fees/payment-submissions?year=2026&month=13')
          .set('Authorization', `Bearer ${f.cls.adminToken}`)
          .expect(400);
      });

      it("refuses another student's submissions", async () => {
        const f = await submissionFixture();
        await submit(f.parentToken, f.challan.id).expect(201);
        const other = await seedBillableClass({ studentCount: 1 });
        const otherStudentToken = await tokenFor(app, other.students[0].user);
        await http()
          .get(`/api/fees/challans/${f.challan.id}/payment-submissions`)
          .set('Authorization', `Bearer ${otherStudentToken}`)
          .expect(403);
      });
    });
  });
});
