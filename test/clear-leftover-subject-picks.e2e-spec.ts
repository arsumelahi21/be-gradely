import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma, resetDb } from './utils/db';
import { createTestSchool } from './utils/factories';

// Replays the shipped file against seeded data — global-setup only proves it
// runs on an empty database. Read, never retyped here.
const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261002090000_clear_leftover_subject_picks/migration.sql',
  ),
  'utf8',
);

const applyMigration = () =>
  prisma.$transaction(
    MIGRATION_SQL.split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => prisma.$executeRawUnsafe(statement)),
  );

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

describe('clear leftover subject picks (migration)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb();
  });

  /** One class with sections X and Y, each offering one subject, over two sessions. */
  async function seedClassWithSiblings() {
    const school = await createTestSchool();
    const year = (name: string, from: string, to: string) =>
      prisma.academicYear.create({
        data: {
          schoolId: school.id,
          name,
          code: `${name}${uniq()}`,
          startDate: new Date(from),
          endDate: new Date(to),
        },
      });
    const [last, now] = [
      await year('Last', '2025-01-01', '2025-12-31'),
      await year('Now', '2026-01-01', '2026-12-31'),
    ];
    const grade = await prisma.classGrade.create({
      data: { schoolId: school.id, name: `Grade-${uniq()}` },
    });
    const section = (name: string) =>
      prisma.section.create({
        data: { schoolId: school.id, classGradeId: grade.id, name },
      });
    const [x, y] = [await section('X'), await section('Y')];
    const offer = async (sectionId: string, name: string) => {
      const subject = await prisma.subject.create({
        data: { schoolId: school.id, name: `${name}-${uniq()}` },
      });
      return prisma.sectionSubject.create({
        data: { sectionId, subjectId: subject.id, isElective: true },
      });
    };
    const [physicsX, chemistryY] = [
      await offer(x.id, 'Physics'),
      await offer(y.id, 'Chemistry'),
    ];

    /** A student with the given placements and picks, all in one school. */
    const student = async (
      placements: [sectionId: string, yearId: string, status: string][],
      picks: [sectionSubjectId: string, yearId: string][],
    ) => {
      const profile = await prisma.studentProfile.create({
        data: { schoolId: school.id, fullName: `S-${uniq()}` },
      });
      for (const [sectionId, academicYearId, status] of placements) {
        await prisma.enrollment.create({
          data: {
            studentId: profile.id,
            sectionId,
            academicYearId,
            status: status as 'ACTIVE' | 'INACTIVE' | 'COMPLETED',
          },
        });
      }
      await prisma.studentSubject.createMany({
        data: picks.map(([sectionSubjectId, academicYearId]) => ({
          schoolId: school.id,
          studentId: profile.id,
          sectionSubjectId,
          academicYearId,
        })),
      });
      return profile.id;
    };
    return { last, now, x, y, physicsX, chemistryY, student };
  }

  const picksOf = (studentId: string) =>
    prisma.studentSubject
      .findMany({
        where: { studentId },
        select: { sectionSubjectId: true, academicYearId: true },
      })
      .then((rows) =>
        rows.map((r) => `${r.sectionSubjectId}@${r.academicYearId}`).sort(),
      );

  it("deletes a closed placement's picks once the student sits in a sibling section", async () => {
    const f = await seedClassWithSiblings();
    const moved = await f.student(
      [
        [f.x.id, f.now.id, 'INACTIVE'],
        [f.y.id, f.now.id, 'ACTIVE'],
      ],
      [
        [f.physicsX.id, f.now.id],
        [f.chemistryY.id, f.now.id],
      ],
    );

    await applyMigration();

    expect(await picksOf(moved)).toEqual([`${f.chemistryY.id}@${f.now.id}`]);
  });

  it('deletes them too when the student moved on and then finished the session in the sibling', async () => {
    const f = await seedClassWithSiblings();
    const moved = await f.student(
      [
        [f.x.id, f.last.id, 'INACTIVE'],
        [f.y.id, f.last.id, 'COMPLETED'],
      ],
      [[f.physicsX.id, f.last.id]],
    );

    await applyMigration();

    expect(await picksOf(moved)).toEqual([]);
  });

  it('keeps a genuine pick from a sibling section, a withdrawal and last session', async () => {
    const f = await seedClassWithSiblings();
    const picker = await f.student(
      [[f.y.id, f.now.id, 'ACTIVE']],
      [[f.physicsX.id, f.now.id]],
    );
    const withdrawn = await f.student(
      [[f.x.id, f.now.id, 'INACTIVE']],
      [[f.physicsX.id, f.now.id]],
    );
    const graduated = await f.student(
      [
        [f.x.id, f.last.id, 'COMPLETED'],
        [f.y.id, f.last.id, 'COMPLETED'],
      ],
      [[f.physicsX.id, f.last.id]],
    );
    const before = await Promise.all(
      [picker, withdrawn, graduated].map(picksOf),
    );

    await applyMigration();

    expect(
      await Promise.all([picker, withdrawn, graduated].map(picksOf)),
    ).toEqual(before);
  });

  it('is safe to run twice', async () => {
    const f = await seedClassWithSiblings();
    const moved = await f.student(
      [
        [f.x.id, f.now.id, 'INACTIVE'],
        [f.y.id, f.now.id, 'ACTIVE'],
      ],
      [
        [f.physicsX.id, f.now.id],
        [f.chemistryY.id, f.now.id],
      ],
    );
    await applyMigration();
    const once = await picksOf(moved);

    await applyMigration();

    expect(await picksOf(moved)).toEqual(once);
  });
});
