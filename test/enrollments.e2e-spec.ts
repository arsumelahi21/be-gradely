import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

describe('Enrollments batch (e2e)', () => {
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

  // A student in `schoolId` with no enrolment yet.
  const freshStudent = async (schoolId: string) => {
    const user = await createTestUser({ role: Role.STUDENT, schoolId });
    return prisma.studentProfile.create({
      data: { userId: user.id, schoolId, fullName: 'Fresh' },
    });
  };

  it('batch-enrols new students in one call and skips already-enrolled ones', async () => {
    const cls = await seedClass({ studentCount: 2 }); // 2 already enrolled
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);
    const a = await freshStudent(cls.school.id);
    const b = await freshStudent(cls.school.id);

    const res = await request(app.getHttpServer())
      .post('/api/enrollments/batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sectionId: cls.section.id,
        academicYearId: cls.academicYear.id,
        studentIds: [
          a.id,
          b.id,
          cls.students[0].profile.id, // duplicate — already enrolled
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: 2, skipped: 1 });

    const rows = await prisma.enrollment.findMany({
      where: { sectionId: cls.section.id },
    });
    expect(rows).toHaveLength(4); // 2 seeded + 2 new
  });

  it('rejects a batch containing a cross-school student and writes nothing', async () => {
    const cls = await seedClass({ studentCount: 0 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);
    const mine = await freshStudent(cls.school.id);
    const otherSchool = await createTestSchool();
    const outsider = await freshStudent(otherSchool.id);

    const res = await request(app.getHttpServer())
      .post('/api/enrollments/batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sectionId: cls.section.id,
        academicYearId: cls.academicYear.id,
        studentIds: [mine.id, outsider.id],
      });

    expect(res.status).toBe(400);
    const rows = await prisma.enrollment.findMany({
      where: { sectionId: cls.section.id },
    });
    expect(rows).toHaveLength(0); // no half-enrolled roster
  });

  it('denies an admin from another school enrolling into this section', async () => {
    const cls = await seedClass({ studentCount: 0 });
    const mine = await freshStudent(cls.school.id);
    const otherSchool = await createTestSchool();
    const adminB = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: otherSchool.id,
    });
    const adminBToken = await tokenFor(app, adminB);

    const res = await request(app.getHttpServer())
      .post('/api/enrollments/batch')
      .set('Authorization', `Bearer ${adminBToken}`)
      .send({
        sectionId: cls.section.id,
        academicYearId: cls.academicYear.id,
        studentIds: [mine.id],
      });

    expect(res.status).toBe(403);
  });
});

/**
 * A student sits in ONE class per academic year.
 *
 * The DB can't enforce it — its unique key is
 * [studentId, sectionId, academicYearId], which stops the same section twice
 * and nothing else. These tests pin the service-level rule, including the two
 * cases it must NOT block: a different year (progression) and a closed prior
 * placement.
 */
describe('One class per student (e2e)', () => {
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

  let seq = 0;
  /** A second section in the same school, so both are candidates in one year. */
  const otherSection = async (schoolId: string, classGradeId: string) =>
    prisma.section.create({
      data: {
        schoolId,
        classGradeId,
        name: `Other-${Date.now()}${seq++}`,
      },
    });

  const adminFor = async (schoolId: string) =>
    tokenFor(app, await createTestUser({ role: Role.SCHOOL_ADMIN, schoolId }));

  it('refuses a second ACTIVE placement in the same year and writes nothing', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    const student = cls.students[0].profile;
    const second = await otherSection(cls.school.id, cls.classGrade.id);

    const res = await request(app.getHttpServer())
      .post('/api/enrollments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        studentId: student.id,
        sectionId: second.id,
        academicYearId: cls.academicYear.id,
      });

    expect(res.status).toBe(409);
    // The message has to name the class the admin must go and free up.
    expect(res.body.message).toContain(cls.section.name);

    const rows = await prisma.enrollment.findMany({
      where: { studentId: student.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].sectionId).toBe(cls.section.id);
  });

  it('allows the same student into a class in a DIFFERENT academic year', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    const student = cls.students[0].profile;
    const nextYear = await prisma.academicYear.create({
      data: {
        schoolId: cls.school.id,
        name: `AY-next-${Date.now()}`,
        code: `AYN${Date.now()}`,
        startDate: new Date('2027-01-01'),
        endDate: new Date('2027-12-31'),
      },
    });
    const second = await otherSection(cls.school.id, cls.classGrade.id);

    const res = await request(app.getHttpServer())
      .post('/api/enrollments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        studentId: student.id,
        sectionId: second.id,
        academicYearId: nextYear.id,
      });

    // Progression would be impossible if the rule spanned years.
    expect(res.status).toBe(201);
  });

  it('ignores a CLOSED prior placement — only ACTIVE rows hold the seat', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    const student = cls.students[0].profile;
    await prisma.enrollment.updateMany({
      where: { studentId: student.id },
      data: { status: 'COMPLETED' },
    });
    const second = await otherSection(cls.school.id, cls.classGrade.id);

    const res = await request(app.getHttpServer())
      .post('/api/enrollments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        studentId: student.id,
        sectionId: second.id,
        academicYearId: cls.academicYear.id,
      });

    expect(res.status).toBe(201);
  });

  it('drops an already-placed student from a batch without failing the rest', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    const placed = cls.students[0].profile;
    const freeUser = await createTestUser({
      role: Role.STUDENT,
      schoolId: cls.school.id,
    });
    const free = await prisma.studentProfile.create({
      data: {
        userId: freeUser.id,
        schoolId: cls.school.id,
        fullName: 'Unplaced',
      },
    });
    const second = await otherSection(cls.school.id, cls.classGrade.id);

    const res = await request(app.getHttpServer())
      .post('/api/enrollments/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sectionId: second.id,
        academicYearId: cls.academicYear.id,
        studentIds: [placed.id, free.id],
      });

    expect(res.status).toBe(201);
    // One good student must not lose their seat to one bad id.
    expect(res.body.created).toBe(1);
    expect(res.body.blocked).toHaveLength(1);
    expect(res.body.blocked[0]).toMatchObject({ studentId: placed.id });
    expect(res.body.blocked[0].className).toContain(cls.section.name);

    const rows = await prisma.enrollment.findMany({
      where: { sectionId: second.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].studentId).toBe(free.id);
  });

  it('refuses to MOVE a row onto a student who already has a class', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const token = await adminFor(cls.school.id);
    const [a, b] = cls.students.map((s) => s.profile);
    const enrollmentOfA = await prisma.enrollment.findFirstOrThrow({
      where: { studentId: a.id },
    });

    // Re-pointing A's row at B would leave B in two classes.
    const res = await request(app.getHttpServer())
      .patch(`/api/enrollments/${enrollmentOfA.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ studentId: b.id });

    expect(res.status).toBe(409);
    const rows = await prisma.enrollment.findMany({
      where: { studentId: b.id },
    });
    expect(rows).toHaveLength(1);
  });

  it('lists placements once per student and never across schools', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const token = await adminFor(cls.school.id);

    const res = await request(app.getHttpServer())
      .get('/api/enrollments/placements')
      .query({ academicYearId: cls.academicYear.id })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ sectionId: cls.section.id });
    expect(res.body[0].label).toContain(cls.section.name);

    // Another school's admin asking about THIS year sees nothing of ours.
    const outsiderToken = await adminFor((await createTestSchool()).id);
    const leak = await request(app.getHttpServer())
      .get('/api/enrollments/placements')
      .query({ academicYearId: cls.academicYear.id })
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(leak.status).toBe(200);
    expect(leak.body).toEqual([]);
  });
});

/**
 * The section roster is the CURRENT roster.
 *
 * Promotion closes the old placement (status COMPLETED) instead of deleting it,
 * which is what preserves academic history. The list had no status filter at
 * all, so a promoted student kept appearing in the class they had left — the
 * roster was drawing closed placements alongside active ones.
 */
describe('Enrollment list status scoping (e2e)', () => {
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

  /** One section holding an ACTIVE student and a COMPLETED (moved-on) one. */
  async function seedMixedRoster() {
    const f = await seedClass();
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: f.school.id,
    });

    const [staying, moved] = f.students;
    await prisma.enrollment.updateMany({
      where: { studentId: moved.profile.id, sectionId: f.section.id },
      data: { status: 'COMPLETED', endDate: new Date() },
    });

    return { ...f, admin, token: await tokenFor(app, admin), staying, moved };
  }

  const list = async (token: string, query: Record<string, string>) => {
    const res = await request(app.getHttpServer())
      .get('/api/enrollments')
      .query(query)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body;
    return Array.isArray(body) ? body : (body.items ?? []);
  };

  it('omits a closed placement from the roster by default', async () => {
    const f = await seedMixedRoster();
    const rows = await list(f.token, { sectionId: f.section.id });

    const ids = rows.map((e: { studentId: string }) => e.studentId);
    expect(ids).toContain(f.staying.profile.id);
    expect(ids).not.toContain(f.moved.profile.id);
    for (const e of rows) expect(e.status).toBe('ACTIVE');
  });

  it('still returns the history when a status is asked for', async () => {
    const f = await seedMixedRoster();
    const rows = await list(f.token, {
      sectionId: f.section.id,
      status: 'COMPLETED',
    });

    const ids = rows.map((e: { studentId: string }) => e.studentId);
    expect(ids).toContain(f.moved.profile.id);
    expect(ids).not.toContain(f.staying.profile.id);
  });

  it('a promoted student leaves the old roster and joins the new one', async () => {
    // The end-to-end shape of the reported bug, through the real endpoint.
    const f = await seedClass();
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: f.school.id,
    });
    const token = await tokenFor(app, admin);

    const nextYear = await prisma.academicYear.create({
      data: {
        schoolId: f.school.id,
        name: `Next-${Date.now()}`,
        code: `NXT-${Date.now()}`,
        startDate: new Date(Date.UTC(2030, 0, 1)),
        endDate: new Date(Date.UTC(2030, 11, 31)),
        isActive: false,
      },
    });
    const nextGrade = await prisma.classGrade.create({
      data: { schoolId: f.school.id, name: `Up-${Date.now()}` },
    });
    const nextSection = await prisma.section.create({
      data: { schoolId: f.school.id, classGradeId: nextGrade.id, name: 'A' },
    });

    const mover = f.students[0];
    await request(app.getHttpServer())
      .post('/api/promotions/execute')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceAcademicYearId: f.academicYear.id,
        targetAcademicYearId: nextYear.id,
        students: [
          {
            studentId: mover.profile.id,
            destinationClassGradeId: nextGrade.id,
            destinationSectionId: nextSection.id,
          },
        ],
      })
      .expect(201);

    const oldRoster = await list(token, { sectionId: f.section.id });
    const newRoster = await list(token, { sectionId: nextSection.id });

    expect(
      oldRoster.map((e: { studentId: string }) => e.studentId),
    ).not.toContain(mover.profile.id);
    expect(newRoster.map((e: { studentId: string }) => e.studentId)).toContain(
      mover.profile.id,
    );

    // Nothing was deleted — the closed placement is still on record.
    expect(
      await prisma.enrollment.count({
        where: {
          studentId: mover.profile.id,
          sectionId: f.section.id,
          status: 'COMPLETED',
        },
      }),
    ).toBe(1);
  });

  it('rejects an unknown status rather than ignoring it', async () => {
    const f = await seedMixedRoster();
    await request(app.getHttpServer())
      .get('/api/enrollments')
      .query({ sectionId: f.section.id, status: 'GRADUATED' })
      .set('Authorization', `Bearer ${f.token}`)
      .expect(400);
  });
});
