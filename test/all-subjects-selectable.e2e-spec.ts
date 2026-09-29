import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

// global-setup already applied this migration to an empty database, which only
// proves it runs. Replaying the shipped file against seeded data is what proves
// the backfill keeps every roster — so the file is read, never retyped here.
const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20260929061500_all_subjects_selectable/migration.sql',
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
      // One transaction, so the migration's LOCK is legal and the ticks and the
      // flip land together exactly as they will on a live database.
      .map((statement) => prisma.$executeRawUnsafe(statement)),
  );

describe('all subjects selectable (migration)', () => {
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

  /**
   * One compulsory subject with every kind of placement it must keep: two
   * current students, one who left (INACTIVE) and one from last session
   * (COMPLETED) — plus an elective whose choices it must not touch.
   */
  async function seedHistory() {
    const cls = await seedClass({ studentCount: 2 });
    const [current0, current1] = cls.students.map((s) => s.profile.id);
    const lastYear = await prisma.academicYear.create({
      data: {
        schoolId: cls.school.id,
        name: 'Last session',
        code: `LS${Date.now()}`,
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-12-31'),
      },
    });
    const place = async (
      fullName: string,
      academicYearId: string,
      status: 'COMPLETED' | 'INACTIVE',
    ) => {
      const student = await prisma.studentProfile.create({
        data: { schoolId: cls.school.id, fullName },
      });
      await prisma.enrollment.create({
        data: {
          studentId: student.id,
          sectionId: cls.section.id,
          academicYearId,
          status,
        },
      });
      return student.id;
    };
    const graduated = await place('Graduated', lastYear.id, 'COMPLETED');
    const withdrawn = await place('Withdrawn', cls.academicYear.id, 'INACTIVE');

    const electiveSubject = await prisma.subject.create({
      data: { schoolId: cls.school.id, name: `Physics-${Date.now()}` },
    });
    const elective = await prisma.sectionSubject.create({
      data: {
        sectionId: cls.section.id,
        subjectId: electiveSubject.id,
        isElective: true,
      },
    });
    await prisma.studentSubject.create({
      data: {
        schoolId: cls.school.id,
        academicYearId: cls.academicYear.id,
        studentId: current0,
        sectionSubjectId: elective.id,
      },
    });

    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    return {
      ...cls,
      adminToken: await tokenFor(app, admin),
      compulsory: cls.sectionSubject.id,
      elective: elective.id,
      lastYear,
      current: [current0, current1],
      graduated,
      withdrawn,
    };
  }

  const ticksFor = (sectionSubjectId: string) =>
    prisma.studentSubject
      .findMany({
        where: { sectionSubjectId },
        select: { studentId: true, academicYearId: true },
      })
      .then((rows) =>
        rows.map((r) => `${r.studentId}@${r.academicYearId}`).sort(),
      );

  it('makes every subject selectable, ticking every placement in its own session', async () => {
    const f = await seedHistory();
    const rosterOf = async () =>
      (
        await request(app.getHttpServer())
          .get(`/api/attendance/section-subject/${f.compulsory}`)
          .query({ date: '2026-06-01' })
          .set('Authorization', `Bearer ${f.adminToken}`)
      ).body.roster
        .map((r: any) => r.student.id)
        .sort();
    const before = await rosterOf();

    await applyMigration();

    expect(
      await prisma.sectionSubject.count({ where: { isElective: false } }),
    ).toBe(0);
    expect(await ticksFor(f.compulsory)).toEqual(
      [
        `${f.current[0]}@${f.academicYear.id}`,
        `${f.current[1]}@${f.academicYear.id}`,
        `${f.withdrawn}@${f.academicYear.id}`,
        `${f.graduated}@${f.lastYear.id}`,
      ].sort(),
    );
    // Nobody lost the subject: the class list reads exactly as it did.
    expect(await rosterOf()).toEqual(before);
    // An existing choice is left as the admin made it.
    expect(await ticksFor(f.elective)).toEqual([
      `${f.current[0]}@${f.academicYear.id}`,
    ]);
  });

  it('leaves a section nobody is enrolled in alone', async () => {
    const empty = await seedClass({ studentCount: 0 });

    await applyMigration();

    // Selectable like every other subject, but with nobody to tick — an inner
    // join, so it contributes no rows rather than one all-NULL one.
    expect(
      (
        await prisma.sectionSubject.findUniqueOrThrow({
          where: { id: empty.sectionSubject.id },
        })
      ).isElective,
    ).toBe(true);
    expect(await ticksFor(empty.sectionSubject.id)).toEqual([]);
  });

  // It ships as a migration, so it runs once — but a restored database or a
  // hand-run replay must not double-tick anyone.
  it('is safe to apply twice', async () => {
    const f = await seedHistory();
    await applyMigration();
    const once = await ticksFor(f.compulsory);

    await applyMigration();

    expect(await ticksFor(f.compulsory)).toEqual(once);
  });
});
