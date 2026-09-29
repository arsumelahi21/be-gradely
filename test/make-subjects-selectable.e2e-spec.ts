import { INestApplication } from '@nestjs/common';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

// setup-env points DATABASE_URL at this worker's test database, and the child
// inherits it — so the script can never reach any other database from here.
const run = (args = '') =>
  execSync(`node scripts/make-subjects-selectable.mjs ${args}`, {
    cwd: join(__dirname, '..'),
    env: { ...process.env },
    encoding: 'utf8',
  });

describe('make-subjects-selectable script (e2e)', () => {
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

  it('changes nothing on a dry run', async () => {
    const f = await seedHistory();

    const out = run();

    expect(out).toMatch(/1 compulsory subject/);
    expect(out).toMatch(/dry run/i);
    expect(
      (
        await prisma.sectionSubject.findUniqueOrThrow({
          where: { id: f.compulsory },
        })
      ).isElective,
    ).toBe(false);
    expect(await ticksFor(f.compulsory)).toEqual([]);
  });

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

    run('--apply');

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

  it('promises exactly the ticks it writes, empty sections included', async () => {
    await seedHistory();
    // Nobody enrolled here, so this subject earns no ticks — but its LEFT JOIN
    // row was (NULL, id, NULL), which counted, and the dry run over-promised.
    await seedClass({ studentCount: 0 });

    const promised = Number(/· (\d+) student ticks/.exec(run())?.[1]);
    const before = await prisma.studentSubject.count();
    run('--apply');

    expect((await prisma.studentSubject.count()) - before).toBe(promised);
  });

  it('is safe to run twice', async () => {
    const f = await seedHistory();
    run('--apply');
    const once = await ticksFor(f.compulsory);

    expect(run('--apply')).toMatch(/0 compulsory subjects/);
    expect(await ticksFor(f.compulsory)).toEqual(once);
  });
});
