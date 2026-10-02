import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';
import { ChallansService } from '../src/fees/challans.service';

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

describe('Subject-based fees (e2e)', () => {
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
    jest.restoreAllMocks();
  });

  const http = () => request(app.getHttpServer());

  /**
   * One class whose sections bill by subject, over two sessions:
   * A1 Maths/Physics/Computer, A2 Maths/Chemistry/Biology, A3 Economics/Business.
   */
  async function seedSubjectClass(
    feeBillingMode: 'SUBJECT' | 'MONTHLY' = 'SUBJECT',
  ) {
    const school = await createTestSchool();
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: school.id,
    });
    const token = await tokenFor(app, admin);
    const year = (name: string, from: string, to: string) =>
      prisma.academicYear.create({
        data: {
          schoolId: school.id,
          name,
          code: `${name}-${uniq()}`,
          startDate: new Date(from),
          endDate: new Date(to),
        },
      });
    const y2026 = await year('2026-27', '2026-01-01', '2026-12-31');
    const y2027 = await year('2027-28', '2027-01-01', '2027-12-31');
    const klass = (name: string) =>
      prisma.classGrade.create({
        data: { schoolId: school.id, name: `${name}-${uniq()}` },
      });
    const grade = await klass('A-Level');
    const section = (
      name: string,
      classGradeId = grade.id,
      mode = feeBillingMode,
    ) =>
      prisma.section.create({
        data: { schoolId: school.id, classGradeId, name, feeBillingMode: mode },
      });
    const setMode = (sectionId: string, mode: 'SUBJECT' | 'MONTHLY') =>
      prisma.section.update({
        where: { id: sectionId },
        data: { feeBillingMode: mode },
      });
    const [a1, a2, a3] = [
      await section('A1'),
      await section('A2'),
      await section('A3'),
    ];
    const subject = (name: string, code: string | null) =>
      prisma.subject.create({ data: { schoolId: school.id, name, code } });
    const s = {
      maths: await subject('Mathematics', 'M101'),
      physics: await subject('Physics', 'PHY01'),
      computer: await subject('Computer', 'CS01'),
      chemistry: await subject('Chemistry', 'CHEM01'),
      biology: await subject('Biology', 'BIO01'),
      economics: await subject('Economics', 'ECO01'),
      business: await subject('Business', 'BUS01'),
    };
    const offer = (sectionId: string, subjectId: string) =>
      prisma.sectionSubject.create({
        data: { sectionId, subjectId, isElective: true },
      });
    const o = {
      mathsA1: await offer(a1.id, s.maths.id),
      physicsA1: await offer(a1.id, s.physics.id),
      computerA1: await offer(a1.id, s.computer.id),
      mathsA2: await offer(a2.id, s.maths.id),
      chemistryA2: await offer(a2.id, s.chemistry.id),
      biologyA2: await offer(a2.id, s.biology.id),
      economicsA3: await offer(a3.id, s.economics.id),
      businessA3: await offer(a3.id, s.business.id),
    };

    /** A student placed in `sectionId` who takes `picks` that session. */
    const student = async (
      name: string,
      sectionId: string,
      picks: { id: string }[],
      academicYearId = y2026.id,
    ) => {
      const profile = await prisma.studentProfile.create({
        // A monthly fee that must never appear on a subject-billed challan.
        data: { schoolId: school.id, fullName: name, monthlyFeeAmount: 99999 },
      });
      await prisma.enrollment.create({
        data: {
          studentId: profile.id,
          sectionId,
          academicYearId,
          status: 'ACTIVE',
        },
      });
      await prisma.studentSubject.createMany({
        data: picks.map((p) => ({
          schoolId: school.id,
          studentId: profile.id,
          sectionSubjectId: p.id,
          academicYearId,
        })),
      });
      return profile;
    };

    const auth = { Authorization: `Bearer ${token}` };
    const price = (items: { code: string; amount: number | null }[]) =>
      http().put('/api/fees/subject-fees').set(auth).send({ items });
    const priceAll = () =>
      price([
        { code: 'M101', amount: 3000 },
        { code: 'PHY01', amount: 2500 },
        { code: 'CS01', amount: 1000 },
        { code: 'CHEM01', amount: 2500 },
        { code: 'BIO01', amount: 1800 },
        { code: 'ECO01', amount: 2000 },
        { code: 'BUS01', amount: 1500 },
      ]).expect(200);
    const listFees = async () =>
      (await http().get('/api/fees/subject-fees').set(auth).expect(200)).body;
    const run = (
      body: Record<string, unknown> = {},
      path: 'generate' | 'preview' = 'generate',
    ) =>
      http()
        .post(`/api/fees/challans/${path}`)
        .set(auth)
        .send({
          academicYearId: y2026.id,
          classGradeId: grade.id,
          periodYear: 2026,
          periodMonth: 9,
          ...body,
        });
    const challanOf = (studentId: string, periodMonth = 9) =>
      prisma.challan.findFirstOrThrow({
        where: { studentId, periodMonth },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });
    const lines = (c: { items: { label: string; amount: number }[] }) =>
      c.items.map((i) => [i.label, i.amount]);

    return {
      school,
      token,
      auth,
      y2026,
      y2027,
      klass,
      grade,
      section,
      setMode,
      a1,
      a2,
      a3,
      subject,
      offer,
      s,
      o,
      student,
      price,
      priceAll,
      listFees,
      run,
      challanOf,
      lines,
    };
  }

  describe('configuration', () => {
    it('lists each subject code once, with the subjects using it, and sets many fees in one save', async () => {
      const f = await seedSubjectClass();
      // The same code on two subject rows, typed differently.
      await f.subject('English', 'E123');
      await f.subject('English Language', ' e123 ');

      const before = await f.listFees();
      expect(
        before.codes.filter((c: { code: string }) => c.code === 'E123'),
      ).toEqual([
        { code: 'E123', names: ['English', 'English Language'], amount: null },
      ]);
      expect(before.codes.map((c: { code: string }) => c.code)).toEqual([
        'BIO01',
        'BUS01',
        'CHEM01',
        'CS01',
        'E123',
        'ECO01',
        'M101',
        'PHY01',
      ]);

      await f
        .price([
          { code: 'E123', amount: 3000 },
          { code: 'M101', amount: 5000 },
          { code: 'CHEM01', amount: 0 },
        ])
        .expect(200);
      const priced = Object.fromEntries(
        (await f.listFees()).codes.map(
          (c: { code: string; amount: number | null }) => [c.code, c.amount],
        ),
      );
      expect(priced).toMatchObject({
        E123: 3000,
        M101: 5000,
        CHEM01: 0,
        PHY01: null,
      });

      await f.price([{ code: 'M101', amount: null }]).expect(200);
      const cleared = await f.listFees();
      expect(
        cleared.codes.find((c: { code: string }) => c.code === 'M101').amount,
      ).toBeNull();
      expect(
        await prisma.auditLog.count({
          where: { action: 'FEE_SUBJECT_FEES_UPDATE', schoolId: f.school.id },
        }),
      ).toBe(2);
    });

    it('keeps one fee per code however the code is typed', async () => {
      const f = await seedSubjectClass();
      await f.price([{ code: 'm101', amount: 3000 }]).expect(200);
      await f.price([{ code: ' M101 ', amount: 3500 }]).expect(200);

      expect(
        await prisma.subjectFee.findMany({
          where: { schoolId: f.school.id },
          select: { code: true, amount: true },
        }),
      ).toEqual([{ code: 'M101', amount: 3500 }]);
      await f
        .price([
          { code: 'M101', amount: 1 },
          { code: 'm101', amount: 2 },
        ])
        .expect(400);
    });

    it("rejects a negative fee, a code no subject uses, another school's code and non-admins", async () => {
      const f = await seedSubjectClass();
      const other = await seedSubjectClass();
      await other.subject('Other', 'OTHER1');

      await f.price([{ code: 'M101', amount: -1 }]).expect(400);
      await f.price([{ code: 'ZZZ999', amount: 100 }]).expect(404);
      await f.price([{ code: 'OTHER1', amount: 100 }]).expect(404);

      for (const role of [Role.TEACHER, Role.STUDENT, Role.PARENT]) {
        const user = await createTestUser({ role, schoolId: f.school.id });
        const token = await tokenFor(app, user);
        await http()
          .put('/api/fees/subject-fees')
          .set('Authorization', `Bearer ${token}`)
          .send({ items: [{ code: 'M101', amount: 1 }] })
          .expect(403);
        await http()
          .get('/api/fees/subject-fees')
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
      }
      expect(await prisma.subjectFee.count()).toBe(0);
    });

    // A subject may carry any code, so a cap here would leave its class blocked
    // from billing with no way out in the product; blank is still refused.
    it('prices a code longer than any cap, and refuses a blank one', async () => {
      const f = await seedSubjectClass();
      const long = 'L'.repeat(80);
      await f.subject('Long Coded', long);

      await f.price([{ code: long, amount: 4200 }]).expect(200);
      await f.price([{ code: '   ', amount: 100 }]).expect(400);

      const stored = await prisma.subjectFee.findMany({
        select: { code: true, amount: true },
      });
      expect(stored).toEqual([{ code: long, amount: 4200 }]);
    });

    it('lists subjects without a code apart, since they cannot carry a fee', async () => {
      const f = await seedSubjectClass();
      const art = await f.subject('Art', null);

      expect((await f.listFees()).withoutCode).toEqual([
        { subjectId: art.id, name: 'Art' },
      ]);
    });

    it('sets the billing method per section, and no longer per class', async () => {
      const f = await seedSubjectClass('MONTHLY');
      const res = await http()
        .patch(`/api/sections/${f.a2.id}`)
        .set(f.auth)
        .send({ feeBillingMode: 'SUBJECT' })
        .expect(200);
      expect(res.body.feeBillingMode).toBe('SUBJECT');
      expect(
        (await prisma.section.findUniqueOrThrow({ where: { id: f.a1.id } }))
          .feeBillingMode,
      ).toBe('MONTHLY');
      await http()
        .patch(`/api/sections/${f.a2.id}`)
        .set(f.auth)
        .send({ feeBillingMode: 'WEEKLY' })
        .expect(400);

      const created = await http()
        .post('/api/sections')
        .set(f.auth)
        .send({
          classGradeId: f.grade.id,
          name: 'A4',
          feeBillingMode: 'SUBJECT',
        })
        .expect(201);
      expect(created.body.feeBillingMode).toBe('SUBJECT');
      await http()
        .patch(`/api/class-grades/${f.grade.id}`)
        .set(f.auth)
        .send({ feeBillingMode: 'SUBJECT' })
        .expect(400);
    });

    it("gives a new section its class's billing method, and makes a mixed class choose", async () => {
      const f = await seedSubjectClass('SUBJECT');
      const create = (name: string, classGradeId = f.grade.id) =>
        http().post('/api/sections').set(f.auth).send({ classGradeId, name });

      expect((await create('A4').expect(201)).body.feeBillingMode).toBe(
        'SUBJECT',
      );

      await f.setMode(f.a1.id, 'MONTHLY');
      const mixed = await create('A5').expect(400);
      expect(mixed.body.message).toMatch(/bill differently/);

      const empty = await f.klass('O-Level');
      expect(
        (await create('O1', empty.id).expect(201)).body.feeBillingMode,
      ).toBe('MONTHLY');
    });
  });

  describe('billing', () => {
    it('bills each student only the subjects they take, from any section, instead of the monthly fee', async () => {
      const f = await seedSubjectClass();
      await f.priceAll();
      const a = await f.student('A', f.a1.id, [f.o.mathsA1, f.o.physicsA1]);
      const b = await f.student('B', f.a1.id, [f.o.mathsA1, f.o.chemistryA2]);
      const c = await f.student('C', f.a1.id, [
        f.o.mathsA1,
        f.o.physicsA1,
        f.o.chemistryA2,
      ]);
      const d = await f.student('D', f.a1.id, [
        f.o.mathsA1,
        f.o.chemistryA2,
        f.o.economicsA3,
      ]);

      await f.run().expect(201);

      expect(f.lines(await f.challanOf(a.id))).toEqual([
        ['Mathematics', 3000],
        ['Physics', 2500],
      ]);
      expect(f.lines(await f.challanOf(b.id))).toEqual([
        ['Chemistry', 2500],
        ['Mathematics', 3000],
      ]);
      expect((await f.challanOf(c.id)).netAmount).toBe(8000);
      const dChallan = await f.challanOf(d.id);
      expect(f.lines(dChallan)).toEqual([
        ['Chemistry', 2500],
        ['Economics', 2000],
        ['Mathematics', 3000],
      ]);
      expect(dChallan.netAmount).toBe(7500);
      expect(dChallan.items.map((i) => i.subjectId)).toEqual([
        f.s.chemistry.id,
        f.s.economics.id,
        f.s.maths.id,
      ]);
    });

    it('bills a subject code the same in every class, and once per student', async () => {
      const f = await seedSubjectClass();
      const english = await f.subject('English', 'E123');
      const englishLanguage = await f.subject('English Language', 'e123');
      const class10 = await f.klass('Class 10');
      const x = await f.section('X', class10.id);
      const englishA1 = await f.offer(f.a1.id, english.id);
      const englishLanguageA2 = await f.offer(f.a2.id, englishLanguage.id);
      const englishX = await f.offer(x.id, englishLanguage.id);
      await f.price([{ code: 'E123', amount: 3000 }]).expect(200);

      const aLevel = await f.student('A-Level', f.a1.id, [
        englishA1,
        englishLanguageA2,
      ]);
      const tenth = await f.student('Tenth', x.id, [englishX]);
      await f.run().expect(201);
      await f.run({ classGradeId: class10.id }).expect(201);

      // Two subjects share E123: charged once, at the one fee.
      const aLevelChallan = await f.challanOf(aLevel.id);
      expect(aLevelChallan.items).toHaveLength(1);
      expect(aLevelChallan.netAmount).toBe(3000);
      expect(f.lines(await f.challanOf(tenth.id))).toEqual([
        ['English Language', 3000],
      ]);
    });

    it('bills a compulsory subject the student has no selection row for', async () => {
      const f = await seedSubjectClass();
      await f.priceAll();
      await prisma.sectionSubject.update({
        where: { id: f.o.biologyA2.id },
        data: { isElective: false },
      });
      const e = await f.student('E', f.a2.id, [f.o.chemistryA2]);

      await f.run({ classGradeId: undefined, sectionId: f.a2.id }).expect(201);

      expect(f.lines(await f.challanOf(e.id))).toEqual([
        ['Biology', 1800],
        ['Chemistry', 2500],
      ]);
    });

    it('keeps fee heads, the discount and arrears working on subject lines', async () => {
      const f = await seedSubjectClass();
      await f.priceAll();
      await prisma.feeHead.create({
        data: { schoolId: f.school.id, name: 'Lab', defaultAmount: 1000 },
      });
      const discount = await prisma.discount.create({
        data: {
          schoolId: f.school.id,
          name: 'Sibling',
          type: 'PERCENT',
          value: 10,
        },
      });
      const a = await f.student('A', f.a1.id, [f.o.mathsA1, f.o.physicsA1]);
      await prisma.studentProfile.update({
        where: { id: a.id },
        data: { discountId: discount.id },
      });

      await f.run().expect(201);
      const september = await f.challanOf(a.id);
      expect(f.lines(september)).toEqual([
        ['Mathematics', 3000],
        ['Physics', 2500],
        ['Lab', 1000],
        ['Sibling', 650],
      ]);
      expect(september.netAmount).toBe(5850);

      await f.run({ periodMonth: 10 }).expect(201);
      // The carried balance is not discounted again.
      expect((await f.challanOf(a.id, 10)).netAmount).toBe(5850 + 5850);
    });

    it('previews exactly the lines it then issues', async () => {
      const f = await seedSubjectClass();
      await f.priceAll();
      const d = await f.student('D', f.a1.id, [
        f.o.mathsA1,
        f.o.chemistryA2,
        f.o.economicsA3,
      ]);

      const preview = await f.run({}, 'preview').expect(201);
      const row = preview.body.willGenerate.find(
        (r: { studentId: string }) => r.studentId === d.id,
      );
      await f.run().expect(201);

      const issued = await f.challanOf(d.id);
      expect(
        row.items.map((i: { label: string; amount: number }) => [
          i.label,
          i.amount,
        ]),
      ).toEqual(f.lines(issued));
      expect(row.netAmount).toBe(issued.netAmount);
    });

    it('skips a student whose subject has no fee, bills the rest, and names what to fix', async () => {
      const f = await seedSubjectClass();
      await f.price([{ code: 'M101', amount: 3000 }]).expect(200);
      const priced = await f.student('Priced', f.a1.id, [f.o.mathsA1]);
      const unpriced = await f.student('Unpriced', f.a1.id, [
        f.o.mathsA1,
        f.o.chemistryA2,
      ]);

      const preview = await f.run({}, 'preview').expect(201);
      expect(preview.body.missingSubjectFees).toEqual([
        { code: 'CHEM01', name: 'Chemistry' },
      ]);
      expect(preview.body.blocked).toEqual([
        expect.objectContaining({
          fullName: 'Unpriced',
          reason: 'SUBJECT_FEE_MISSING',
          subjects: ['Chemistry (CHEM01)'],
        }),
      ]);

      const res = await f.run().expect(201);
      expect(res.body).toMatchObject({ generated: 1, skipped: 1 });
      expect(res.body.blocked).toEqual([
        expect.objectContaining({ studentId: unpriced.id }),
      ]);
      expect(f.lines(await f.challanOf(priced.id))).toEqual([
        ['Mathematics', 3000],
      ]);
      expect(
        await prisma.challan.count({ where: { studentId: unpriced.id } }),
      ).toBe(0);

      // Only the blocked student is left, so the rerun says what to fix.
      const rerun = await f.run().expect(400);
      expect(rerun.body.message).toMatch(
        /Subject fee is not set for CHEM01 \(Chemistry\)/,
      );
    });

    it('blocks a subject that has no code', async () => {
      const f = await seedSubjectClass();
      await f.priceAll();
      const art = await f.subject('Art', null);
      const artA1 = await f.offer(f.a1.id, art.id);
      await f.student('Artist', f.a1.id, [f.o.mathsA1, artA1]);

      const preview = await f.run({}, 'preview').expect(201);
      expect(preview.body.uncodedSubjects).toEqual([
        { subjectId: art.id, name: 'Art' },
      ]);
      const res = await f.run().expect(400);
      expect(res.body.message).toMatch(/Art has no subject code/);
      expect(await prisma.challan.count()).toBe(0);
    });

    it('blocks a student who takes no subjects', async () => {
      const f = await seedSubjectClass();
      await f.priceAll();
      await f.student('Nobody', f.a3.id, []);

      const preview = await f.run({}, 'preview').expect(201);
      expect(preview.body.blocked).toEqual([
        expect.objectContaining({ fullName: 'Nobody', reason: 'NO_SUBJECTS' }),
      ]);
      const res = await f.run().expect(400);
      expect(res.body.message).toMatch(/Nobody has no subjects for 2026-27/);
      expect(await prisma.challan.count()).toBe(0);
    });

    it('keeps an issued challan as it was when fees and picks change later', async () => {
      const f = await seedSubjectClass();
      await f.priceAll();
      const c = await f.student('C', f.a1.id, [
        f.o.mathsA1,
        f.o.physicsA1,
        f.o.chemistryA2,
      ]);
      await f.run().expect(201);
      const september = await f.challanOf(c.id);

      await f.price([{ code: 'CHEM01', amount: 3000 }]).expect(200);
      await prisma.studentSubject.deleteMany({
        where: { studentId: c.id, sectionSubjectId: f.o.physicsA1.id },
      });
      await f.run({ periodMonth: 10 }).expect(201);

      expect(f.lines(await f.challanOf(c.id))).toEqual(f.lines(september));
      // September is carried at its issued amount; October bills the new fee.
      expect(f.lines(await f.challanOf(c.id, 10))).toEqual([
        ['Chemistry', 3000],
        ['Mathematics', 3000],
        ['Arrears (September 2026)', september.netAmount],
      ]);
    });

    it("uses only the billed session's picks", async () => {
      const f = await seedSubjectClass();
      await f.priceAll();
      const s = await f.student('S', f.a1.id, [f.o.mathsA1]);
      await prisma.studentSubject.createMany({
        data: [f.o.mathsA1, f.o.physicsA1].map((o) => ({
          schoolId: f.school.id,
          studentId: s.id,
          sectionSubjectId: o.id,
          academicYearId: f.y2027.id,
        })),
      });

      await f.run().expect(201);

      expect(f.lines(await f.challanOf(s.id))).toEqual([['Mathematics', 3000]]);
    });

    it('leaves a monthly-billed class exactly as before', async () => {
      const f = await seedSubjectClass('MONTHLY');
      await f.priceAll();
      const m = await f.student('M', f.a1.id, [f.o.mathsA1, f.o.physicsA1]);

      await f.run().expect(201);

      const challan = await f.challanOf(m.id);
      expect(f.lines(challan)).toEqual([['Monthly Fee', 99999]]);
      expect(challan.items[0].subjectId).toBeNull();
    });

    it('issues one challan per student when two runs race', async () => {
      const f = await seedSubjectClass();
      await f.priceAll();
      const a = await f.student('A', f.a1.id, [f.o.mathsA1]);
      const b = await f.student('B', f.a2.id, [f.o.chemistryA2]);

      await Promise.all([f.run(), f.run()]);

      expect(await prisma.challan.count({ where: { studentId: a.id } })).toBe(
        1,
      );
      expect(await prisma.challan.count({ where: { studentId: b.id } })).toBe(
        1,
      );
    });
  });

  describe('section billing method', () => {
    it('bills a class-wise student their monthly fee plus only the subjects taken from other sections', async () => {
      const f = await seedSubjectClass('MONTHLY');
      await f.priceAll();
      const ali = await f.student('Ali', f.a1.id, [
        f.o.mathsA1,
        f.o.physicsA1,
        f.o.chemistryA2,
        f.o.economicsA3,
      ]);

      await f.run().expect(201);

      const challan = await f.challanOf(ali.id);
      expect(f.lines(challan)).toEqual([
        ['Monthly Fee', 99999],
        ['Chemistry (A2)', 2500],
        ['Economics (A3)', 2000],
      ]);
      expect(challan.items.map((i) => i.subjectId)).toEqual([
        null,
        f.s.chemistry.id,
        f.s.economics.id,
      ]);
      expect(challan.netAmount).toBe(99999 + 2500 + 2000);
    });

    it('ignores the billing method of the section a subject is taken from, in one mixed run', async () => {
      const f = await seedSubjectClass('MONTHLY');
      await f.priceAll();
      await f.setMode(f.a2.id, 'SUBJECT');
      const ali = await f.student('Ali', f.a1.id, [
        f.o.mathsA1,
        f.o.chemistryA2,
      ]);
      const sara = await f.student('Sara', f.a2.id, [
        f.o.mathsA2,
        f.o.chemistryA2,
      ]);

      await f.run().expect(201);

      expect(f.lines(await f.challanOf(ali.id))).toEqual([
        ['Monthly Fee', 99999],
        ['Chemistry (A2)', 2500],
      ]);
      // Sara is placed in the subject-wise section: no monthly fee, no section names.
      expect(f.lines(await f.challanOf(sara.id))).toEqual([
        ['Chemistry', 2500],
        ['Mathematics', 3000],
      ]);
    });

    it('bills a subject-wise student every subject, named plainly, whatever the other sections use', async () => {
      const f = await seedSubjectClass('SUBJECT');
      await f.priceAll();
      await f.setMode(f.a2.id, 'MONTHLY');
      await f.setMode(f.a3.id, 'MONTHLY');
      const d = await f.student('D', f.a1.id, [
        f.o.mathsA1,
        f.o.physicsA1,
        f.o.chemistryA2,
        f.o.economicsA3,
      ]);

      await f.run().expect(201);

      const challan = await f.challanOf(d.id);
      expect(f.lines(challan)).toEqual([
        ['Chemistry', 2500],
        ['Economics', 2000],
        ['Mathematics', 3000],
        ['Physics', 2500],
      ]);
      expect(challan.netAmount).toBe(10000);
    });

    it('charges a code once when two subjects from other sections share it', async () => {
      const f = await seedSubjectClass('MONTHLY');
      const english = await f.subject('English', 'E123');
      const englishLanguage = await f.subject('English Language', ' e123 ');
      const englishA2 = await f.offer(f.a2.id, english.id);
      const englishA3 = await f.offer(f.a3.id, englishLanguage.id);
      await f.price([{ code: 'E123', amount: 3000 }]).expect(200);
      const ali = await f.student('Ali', f.a1.id, [englishA2, englishA3]);

      await f.run().expect(201);

      const challan = await f.challanOf(ali.id);
      expect(challan.items).toHaveLength(2);
      expect(challan.netAmount).toBe(99999 + 3000);
    });

    it('charges a subject taken from another section even when their own section teaches it too', async () => {
      const f = await seedSubjectClass('MONTHLY');
      await f.priceAll();
      await f.offer(f.a1.id, f.s.chemistry.id);
      const ali = await f.student('Ali', f.a1.id, [f.o.chemistryA2]);

      await f.run().expect(201);

      expect(f.lines(await f.challanOf(ali.id))).toEqual([
        ['Monthly Fee', 99999],
        ['Chemistry (A2)', 2500],
      ]);
    });

    it('bills a class-wise student with no subjects their monthly fee, and a free subject at zero', async () => {
      const f = await seedSubjectClass('MONTHLY');
      await f.priceAll();
      await f.price([{ code: 'CHEM01', amount: 0 }]).expect(200);
      const none = await f.student('None', f.a1.id, []);
      const free = await f.student('Free', f.a1.id, [f.o.chemistryA2]);

      await f.run().expect(201);

      expect(f.lines(await f.challanOf(none.id))).toEqual([
        ['Monthly Fee', 99999],
      ]);
      expect(f.lines(await f.challanOf(free.id))).toEqual([
        ['Monthly Fee', 99999],
        ['Chemistry (A2)', 0],
      ]);
    });

    it('blocks a class-wise run when a subject from another section has no fee or no code', async () => {
      const f = await seedSubjectClass('MONTHLY');
      await f.price([{ code: 'M101', amount: 3000 }]).expect(200);
      const art = await f.subject('Art', null);
      const artA3 = await f.offer(f.a3.id, art.id);
      await f.student('Unpriced', f.a1.id, [f.o.mathsA1, f.o.chemistryA2]);
      await f.student('Uncoded', f.a1.id, [artA3]);

      const preview = await f.run({}, 'preview').expect(201);
      expect(preview.body.missingSubjectFees).toEqual([
        { code: 'CHEM01', name: 'Chemistry' },
      ]);
      expect(preview.body.uncodedSubjects).toEqual([
        { subjectId: art.id, name: 'Art' },
      ]);
      expect(
        preview.body.blocked
          .map((b: { fullName: string }) => b.fullName)
          .sort(),
      ).toEqual(['Uncoded', 'Unpriced']);

      await f.run().expect(400);
      expect(await prisma.challan.count()).toBe(0);
    });

    it('keeps an issued class-wise challan as it was when the section switches to subject-wise', async () => {
      const f = await seedSubjectClass('MONTHLY');
      await f.priceAll();
      const ali = await f.student('Ali', f.a1.id, [
        f.o.mathsA1,
        f.o.chemistryA2,
      ]);
      await f.run().expect(201);
      const september = await f.challanOf(ali.id);
      await http()
        .post(`/api/fees/challans/${september.id}/payments`)
        .set(f.auth)
        .send({ amount: september.netAmount, method: 'CASH' })
        .expect(201);

      await f.setMode(f.a1.id, 'SUBJECT');
      await f.price([{ code: 'CHEM01', amount: 4000 }]).expect(200);
      await f.run({ periodMonth: 10 }).expect(201);

      expect(f.lines(await f.challanOf(ali.id))).toEqual(f.lines(september));
      expect((await f.challanOf(ali.id)).netAmount).toBe(september.netAmount);
      expect(f.lines(await f.challanOf(ali.id, 10))).toEqual([
        ['Chemistry', 4000],
        ['Mathematics', 3000],
      ]);
    });
  });

  describe('money safety', () => {
    /** A monthly-billed student with September issued. */
    async function billedStudent() {
      const f = await seedSubjectClass('MONTHLY');
      const m = await f.student('M', f.a1.id, []);
      await f.run().expect(201);
      return { ...f, m, september: await f.challanOf(m.id) };
    }
    const pay = (
      f: { auth: Record<string, string> },
      challanId: string,
      amount: number,
    ) =>
      http()
        .post(`/api/fees/challans/${challanId}/payments`)
        .set(f.auth)
        .send({ amount, method: 'CASH' });

    it('two payments at once cannot overpay a challan', async () => {
      const f = await billedStudent();

      const results = await Promise.all(
        [1, 2, 3].map(() => pay(f, f.september.id, f.september.netAmount)),
      );

      expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400]);
      const after = await prisma.challan.findUniqueOrThrow({
        where: { id: f.september.id },
      });
      expect(after.paidAmount).toBe(f.september.netAmount);
      expect(
        await prisma.payment.count({ where: { challanId: f.september.id } }),
      ).toBe(1);
    });

    it('cancelling a challan that carried arrears reopens the carried ones', async () => {
      const f = await billedStudent();
      await f.run({ periodMonth: 10 }).expect(201);
      const october = await f.challanOf(f.m.id, 10);
      expect((await f.challanOf(f.m.id)).status).toBe('CANCELLED');

      const res = await http()
        .post(`/api/fees/challans/${october.id}/cancel`)
        .set(f.auth)
        .send({ reason: 'Issued by mistake' })
        .expect(201);

      expect(res.body.reopenedChallanNos).toEqual([f.september.challanNo]);
      const september = await f.challanOf(f.m.id);
      expect(september).toMatchObject({
        status: 'UNPAID',
        cancelledAt: null,
        cancelReason: null,
      });
      // The debt is owed again: the next month carries it.
      await f.run({ periodMonth: 11 }).expect(201);
      expect(f.lines(await f.challanOf(f.m.id, 11))).toEqual([
        ['Monthly Fee', 99999],
        ['Arrears (September 2026)', f.september.netAmount],
      ]);
    });

    it('a payment landing while arrears are carried is not billed twice', async () => {
      const f = await billedStudent();
      const service = app.get(ChallansService);
      const buildPlan = (service as any).buildPlan.bind(service);
      let paid = false;
      jest
        .spyOn(service as any, 'buildPlan')
        .mockImplementation(async (...args: unknown[]) => {
          const plan = await buildPlan(...args);
          if (!paid) {
            paid = true;
            await pay(f, f.september.id, 1000).expect(201);
          }
          return plan;
        });

      await f.run({ periodMonth: 10 }).expect(201);

      expect(f.lines(await f.challanOf(f.m.id, 10))).toEqual([
        ['Monthly Fee', 99999],
      ]);
      expect((await f.challanOf(f.m.id)).status).toBe('PARTIALLY_PAID');
    });
  });
});
