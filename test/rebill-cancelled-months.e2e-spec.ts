import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma, resetDb } from './utils/db';
import { createTestSchool } from './utils/factories';

// Challans carried forward before this migration hold the link only in their
// cancel reason. Replays the shipped backfill, read from the file, never retyped.
const BACKFILL = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261002100000_rebill_cancelled_months/migration.sql',
  ),
  'utf8',
).match(/UPDATE "Challan"[\s\S]*?;/)![0];

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

describe('rebill cancelled months (migration backfill)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb();
  });

  it('links a challan carried forward before the migration, and leaves an admin cancel unlinked', async () => {
    const school = await createTestSchool();
    const year = await prisma.academicYear.create({
      data: {
        schoolId: school.id,
        name: 'Now',
        code: `NOW${uniq()}`,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
      },
    });
    const student = await prisma.studentProfile.create({
      data: { schoolId: school.id, fullName: `S-${uniq()}` },
    });
    const challan = (
      periodMonth: number,
      extra: { status?: 'CANCELLED'; cancelReason?: string } = {},
    ) =>
      prisma.challan.create({
        data: {
          schoolId: school.id,
          challanNo: `CH-${uniq()}`,
          studentId: student.id,
          academicYearId: year.id,
          periodYear: 2026,
          periodMonth,
          issueDate: new Date('2026-01-01'),
          dueDate: new Date('2026-01-10'),
          grossAmount: 1000,
          netAmount: 1000,
          ...extra,
        },
      });
    const october = await challan(10);
    const september = await challan(9, {
      status: 'CANCELLED',
      cancelReason: `Carried forward to ${october.challanNo}`,
    });
    const august = await challan(8, {
      status: 'CANCELLED',
      cancelReason: 'Issued by mistake',
    });

    await prisma.$executeRawUnsafe(BACKFILL);

    const linked = await prisma.challan.findMany({
      where: { id: { in: [september.id, august.id, october.id] } },
      select: { id: true, supersededById: true },
    });
    expect(
      Object.fromEntries(linked.map((c) => [c.id, c.supersededById])),
    ).toEqual({
      [september.id]: october.id,
      [august.id]: null,
      [october.id]: null,
    });
  });
});
